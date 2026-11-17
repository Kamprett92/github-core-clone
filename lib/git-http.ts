// lib/git-http.ts — git smart-HTTP handlers: protocol v2 upload-pack, v0 upload-pack and
// v0 receive-pack, served at /{owner}/{repo}.git.
//
// `handleGit(req, res, store)` returns true when the request is a git request (and it has then
// answered it, including error answers), false when the path is not a git path at all (the
// caller should fall through to its own 404). A git request never crashes the server and never
// answers HTML: malformed input gets a pkt-line error report and the server keeps serving.
//
// Auth: when process.env.MAKEFUN_SHOP_TOKEN is set, every git request must carry
// `Authorization: Bearer <token>`; otherwise it is 401 JSON. When the variable is unset,
// requests are accepted without a token (local testing).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_LINE_MAX,
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  encodeSideband,
  hashObject,
  isAncestor,
  isObjectId,
  parseTag,
  planFetch,
  readPack,
  verifyPackChecksum,
  writePack,
} from './git.ts';
import type { GitObject, GitPacket } from './git.ts';
import { Store } from './store.ts';
import type { Repo } from './store.ts';

const AGENT = 'github-core-clone/1.0';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const JSON_TYPE = 'application/json; charset=utf-8';

const UPLOAD_V0_CAPS =
  'side-band-64k thin-pack ofs-delta shallow deepen-relative multi_ack multi_ack_detailed agent=' +
  `${AGENT} symref=HEAD:refs/heads/main`;
const RECEIVE_CAPS =
  `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

// ---------------------------------------------------------------------------------------------
// small HTTP helpers
// ---------------------------------------------------------------------------------------------

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendBuffer(res, status, JSON_TYPE, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 256 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}

/** The bearer check: true when the request may proceed. */
function authorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

// ---------------------------------------------------------------------------------------------
// ref listing
// ---------------------------------------------------------------------------------------------

/** All refs of a repo, sorted with HEAD first, then by name; tags carry their peeled commit. */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip) lines.push({ oid: defaultTip, name: 'HEAD' });
  for (const [name, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const line: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject?.type === 'commit') line.peeled = target;
    }
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// advertisements (GET info/refs)
// ---------------------------------------------------------------------------------------------

function advertiseUploadV2(res: ServerResponse): void {
  const body = encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'server-option\n',
    'flush',
  ]);
  sendBuffer(res, 200, UPLOAD_AD, body);
}

function advertiseV0(res: ServerResponse, service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): void {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const contentType = service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line =
        index === 0
          ? `${ref.oid} ${ref.name}\u0000${caps}\n`
          : `${ref.oid} ${ref.name}\n`;
      parts.push(encodePktLine(line));
      if (ref.peeled) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(Buffer.from('0000', 'ascii'));
  sendBuffer(res, 200, contentType, Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// protocol v2: ls-refs and fetch
// ---------------------------------------------------------------------------------------------

interface V2Args {
  command: string;
  /** Lines before the delim packet (command arguments). */
  head: string[];
  /** Lines after the delim packet, up to the flush. */
  body: string[];
}

function parseV2Request(packets: readonly GitPacket[]): V2Args {
  const head: string[] = [];
  const body: string[] = [];
  let section = 0; // 0 = head, 1 = body
  let command = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      section = 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (command === '' && line.startsWith('command=')) {
      command = line.slice('command='.length).trim();
      continue;
    }
    (section === 0 ? head : body).push(line);
  }
  if (!command) throw new Error('no command= line in the v2 request');
  return { command, head, body };
}

function lsRefsV2(repo: Repo, args: V2Args): Buffer {
  const peel = args.body.some((line) => line.trim() === 'peel');
  const symrefs = args.body.some((line) => line.trim() === 'symrefs');
  const unborn = args.body.some((line) => line.trim() === 'unborn');
  const prefixes = args.body
    .filter((line) => line.startsWith('ref-prefix '))
    .map((line) => line.slice('ref-prefix '.length).trim());
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const out: Array<string | 'flush'> = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (!defaultTip) {
    // Unborn repository: the only ref is the unborn HEAD symref (never a refs/ line: a clone
    // of an empty repo must list zero refs/).
    if (unborn && symrefs && keep('HEAD')) {
      out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
    out.push('flush');
    return encodePktLines(out);
  }
  if (symrefs && keep('HEAD')) {
    out.push(`${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const ref of refLines(repo)) {
    if (ref.name === 'HEAD') continue;
    if (!keep(ref.name)) continue;
    const extra = peel && ref.peeled ? ` peeled:${ref.peeled}` : '';
    out.push(`${ref.oid} ${ref.name}${extra}\n`);
  }
  out.push('flush');
  return encodePktLines(out);
}

function fetchV2(repo: Repo, args: V2Args): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | undefined;
  let done = false;
  for (const line of args.body) {
    const text = line.trim();
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowBoundaries.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const value = Number.parseInt(text.slice(7).trim(), 10);
      if (!Number.isInteger(value) || value < 1) throw new Error(`bad deepen ${JSON.stringify(text)}`);
      depth = value;
    } else if (text === 'done') done = true;
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not: accepted, no-op.
  }
  for (const oid of [...wants, ...haves, ...shallowBoundaries]) {
    if (!isObjectId(oid)) throw new Error(`bad object id ${JSON.stringify(oid)} in fetch`);
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const plan = planFetch(lookup, wants, { haves, shallowBoundaries, depth });
  const pack = writePack(plan.objects.values());

  // The v2 fetch response has an acknowledgments section ONLY for a negotiation round:
  // the client sent at least one `have` and has not sent `done` yet. With `done` present
  // (the kit client's single-round fetches, and real git's final round) the server goes
  // straight to shallow-info/packfile — sending an acknowledgments section then makes
  // real git die with "expected 'packfile', received 'acknowledgments'". With no haves at
  // all there is likewise no section. Sections are delim-separated; the last ends flush.
  // A NAK (no common history) ends the round outright: acknowledgments + NAK + flush, and
  // no further section — sending one after a NAK makes git die with "expected no other
  // sections to be sent after no 'ready'".
  const parts: Buffer[] = [];
  if (haves.length > 0 && !done) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (plan.acks.length) {
      for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
      parts.push(encodePktLine('ready\n'));
    } else {
      parts.push(encodePktLine('NAK\n'));
      parts.push(Buffer.from('0000', 'ascii')); // flush: the round ends here
      return Buffer.concat(parts);
    }
    parts.push(Buffer.from('0001', 'ascii')); // delim
  }
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii')); // delim
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(encodeSideband(2, Buffer.from(`remote: Enumerating objects: ${plan.objects.size}, done.\n`, 'utf8'))[0]!);
  for (const packet of encodeSideband(1, pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii')); // flush
  return Buffer.concat(parts);
}

/** A v2 error answer: an acknowledgments section is not meaningful, so the packfile section
 *  carries a band-3 error packet (the client's parser surfaces it as a protocol error). */
function fetchV2Error(message: string): Buffer {
  return encodePktLines([
    'packfile\n',
    ...encodeSideband(3, Buffer.from(`error: ${message}\n`, 'utf8')),
    'flush',
  ]);
}

// ---------------------------------------------------------------------------------------------
// protocol v0: upload-pack
// ---------------------------------------------------------------------------------------------

function fetchV0(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | undefined;
  let done = false;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    // In a v0 fetch the capabilities ride on the first want line after a SPACE
    // ("want <oid> multi_ack_detailed side-band-64k ..."), not after a NUL: only the
    // first two tokens are the command and the object id.
    const text = line.trim();
    const tokens = text.split(/\s+/);
    if (section === 0) {
      if (tokens[0] === 'want' && tokens[1]) wants.push(tokens[1]);
      else if (tokens[0] === 'shallow' && tokens[1]) shallowBoundaries.push(tokens[1]);
      else if (tokens[0] === 'deepen' && tokens[1]) {
        const value = Number.parseInt(tokens[1], 10);
        if (!Number.isInteger(value) || value < 1) throw new Error(`bad deepen ${JSON.stringify(text)}`);
        depth = value;
      }
    } else if (section === 1) {
      if (tokens[0] === 'have' && tokens[1]) haves.push(tokens[1]);
      else if (tokens[0] === 'done') done = true;
    }
  }
  for (const oid of [...wants, ...haves, ...shallowBoundaries]) {
    if (!isObjectId(oid)) throw new Error(`bad object id ${JSON.stringify(oid)} in fetch`);
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const plan = planFetch(lookup, wants, { haves, shallowBoundaries, depth });
  const pack = writePack(plan.objects.values());

  // v0 framing, as real git sends it: shallow lines first (followed by a flush when any
  // were sent), then NAK or one ACK pair per shared commit (multi_ack_detailed sends both
  // "ACK <oid> common" and "ACK <oid>"), then the pack as sideband band 1, ending flush.
  // Without `done` this is a negotiation round, not the final one: the server answers only
  // the ACKs — "ACK <oid> common" per shared commit, "ACK <last> ready" when there is one,
  // then NAK — and sends no pack and no trailing flush. The client then sends another
  // round (more haves, or `done`).
  //
  // One exception, found by diffing against real git's upload-pack: a shallow clone's
  // first POST is `want + deepen + flush` with NO haves section at all (a single flush,
  // body ends). Real upload-pack answers that with ONLY the shallow list + flush — no
  // trailing NAK. The NAK appears only when the client opened a haves section (sent
  // `have` lines, or a second flush terminating an empty haves section). A trailing NAK
  // after the shallow list would sit in the pipe and be read as the second round's
  // shallow list, killing the clone with "expected shallow list". So the ACK/NAK phase
  // is sent in a no-`done` round only when the client actually negotiated.
  const flushCount = packets.reduce((n, p) => n + (p.kind === 'flush' ? 1 : 0), 0);
  const negotiated = haves.length > 0 || flushCount >= 2;
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.shallow.length || plan.unshallow.length) parts.push(Buffer.from('0000', 'ascii'));
  if (!done) {
    if (negotiated) {
      for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack} common\n`));
      if (plan.acks.length) parts.push(encodePktLine(`ACK ${plan.acks[plan.acks.length - 1]} ready\n`));
      parts.push(encodePktLine('NAK\n'));
    } else if (!plan.shallow.length && !plan.unshallow.length) {
      // No shallow lines and no negotiation: a bare `want` with no `done` and no haves
      // (real git never sends this shape) — answer NAK so the client does not hang.
      parts.push(encodePktLine('NAK\n'));
    }
    return Buffer.concat(parts);
  }
  if (plan.acks.length) {
    for (const ack of plan.acks) {
      parts.push(encodePktLine(`ACK ${ack} common\n`));
      parts.push(encodePktLine(`ACK ${ack}\n`));
    }
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(encodeSideband(2, Buffer.from(`remote: Enumerating objects: ${plan.objects.size}, done.\n`, 'utf8'))[0]!);
  for (const packet of encodeSideband(1, pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// protocol v0: receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

function receivePack(repo: Repo, body: Buffer, store: Store): Buffer {
  const report: PushReportLine[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  try {
    const { packets, consumed } = decodePktLines(body, { allowTrailing: true });
    const commands: PushCommand[] = [];
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8');
      const nul = line.indexOf('\u0000');
      if (nul >= 0) line = line.slice(0, nul); // capabilities on the first command line
      const text = line.trim();
      if (!text) continue;
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
      if (!match) throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 80))}`);
      commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
    }
    if (commands.length === 0) throw new Error('no commands in receive-pack');

    const packBytes = body.subarray(consumed);
    const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
    if (needsPack) {
      if (packBytes.length === 0) throw new Error('a push that creates or updates a ref carries no pack');
      const read = readPack(packBytes, {
        resolveBase: (oid) => repo.objects.get(oid),
      });
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) throw new Error('pack trailer checksum mismatch');
      store.putObjects(repo, read.objects.values());
    }

    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          report.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          report.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        } else {
          repo.refs.delete(command.ref);
          report.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        report.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          report.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        } else {
          repo.refs.set(command.ref, command.newOid);
          report.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (command.oldOid !== current) {
        report.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      if (command.newOid === current) {
        report.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (isAncestor(store, repo.owner, repo.name, command.oldOid, command.newOid)) {
        repo.refs.set(command.ref, command.newOid);
        report.push({ ref: command.ref, ok: true, reason: '' });
      } else {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      }
    }
    repo.updatedAt = store.nowIso();
  } catch (err) {
    unpackOk = false;
    unpackDetail = err instanceof Error ? err.message : 'unpack error';
  }

  // The report-status stream is itself pkt-lined INSIDE band 1: the whole report (its lines
  // plus its own flush) is the payload of band-1 sideband packets. Sending the lines raw
  // inside band 1 makes real git fail with "bad line length character: unpa" — it reads the
  // band-1 bytes as pkt-lines. The response ends with an outer flush packet.
  const reportLines = unpackOk
    ? [`unpack ok\n`, ...report.map((line) => (line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`))]
    : [`unpack ${unpackDetail}\n`];
  const reportStream = encodePktLines([...reportLines, 'flush']);
  const parts: Buffer[] = [];
  for (const packet of encodeSideband(1, reportStream)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

/**
 * Handle one git smart-HTTP request. Returns true when the request is a git request (the
 * response has then been sent, including error responses); false when the path is not a git
 * path at all and the caller should answer it another way.
 */
export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let pathname: string;
  let search: URLSearchParams;
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    search = url.searchParams;
  } catch {
    return false;
  }
  const match = GIT_PATH.exec(pathname);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]!);
  const repoName = decodeURIComponent(match[2]!);
  const rest = match[3] ?? '';
  const method = req.method ?? 'GET';

  try {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return true;
    }

    const repo = store.getRepo(owner, repoName);

    if (method === 'GET' && rest === '/info/refs') {
      const service = search.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').toString().trim() === 'version=2') {
        advertiseUploadV2(res);
      } else {
        advertiseV0(res, service, repo);
      }
      return true;
    }

    if (method === 'POST' && (rest === '/git-upload-pack' || rest === '/git-receive-pack')) {
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const body = await readBody(req);
      if (rest === '/git-upload-pack') {
        const isV2 = (req.headers['git-protocol'] ?? '').toString().trim() === 'version=2';
        try {
          const out = isV2
            ? (() => {
                const { packets } = decodePktLines(body);
                const args = parseV2Request(packets);
                if (args.command === 'ls-refs') return lsRefsV2(repo, args);
                if (args.command === 'fetch') return fetchV2(repo, args);
                throw new Error(`unknown v2 command ${JSON.stringify(args.command)}`);
              })()
            : fetchV0(repo, body);
          sendBuffer(res, 200, UPLOAD_RESULT, out);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'bad request';
          const out = isV2 ? fetchV2Error(message) : encodePktLine(`ERR ${message}\n`);
          sendBuffer(res, 200, UPLOAD_RESULT, out);
        }
        return true;
      }
      // git-receive-pack (v0 only)
      try {
        const out = receivePack(repo, body, store);
        sendBuffer(res, 200, RECEIVE_RESULT, out);
      } catch (err) {
        // receivePack reports its own failures; this is the last-resort guard so a bad
        // request can never crash the server or leave a connection hanging. The report is
        // pkt-lined inside band 1, like every other report-status answer.
        const message = err instanceof Error ? err.message : 'unpack error';
        const reportStream = encodePktLines([`unpack ${message}\n`, 'flush']);
        const out = Buffer.concat([...encodeSideband(1, reportStream), Buffer.from('0000', 'ascii')]);
        sendBuffer(res, 200, RECEIVE_RESULT, out);
      }
      return true;
    }

    // A git path that names no known service: GitHub's 404 JSON, never HTML.
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  } catch (err) {
    // Never let a git request crash the server or hang the connection.
    if (!res.writableEnded) {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } catch {
        res.destroy();
      }
    }
    return true;
  }
}

/** The pkt-line ceiling, re-exported for the REST/GraphQL stages' documentation. */
export { PKT_LINE_MAX };

/** A stable hash helper for callers that need an object id without importing lib/git.ts. */
export function gitHashObject(type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  return hashObject(type, data);
}
