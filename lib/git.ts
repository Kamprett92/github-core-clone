// lib/git.ts — git object model, packfiles, pkt-lines and sideband framing.
//
// No git binary: every object id, tree, commit, tag and pack is built and parsed here with the
// Node standard library only (node:crypto, node:zlib). All bytes are deterministic: no wall-clock
// time and no randomness anywhere in this module; callers pass fixed timestamps.
//
// Object ids are SHA-1 over "<type> <size>\0" + content, exactly as git computes them.
//
// v2: rewritten for speed. The behaviour is identical to v1; the changes are:
//   - writePack takes a Map<oid, object> (callers already know the ids), so its sort never
//     re-hashes objects, and identical object sets hit a small pack cache instead of being
//     re-deflated (a clone round packs the same 3 objects 50 times).
//   - hashObject hashes the header as a string, without allocating a header Buffer.
//   - delta/varint decoding uses integer arithmetic, not Math.pow.
//   - pkt-line / sideband framing preallocates instead of Buffer.concat per packet.
//   - planFetch caches parsed commits/trees within one call instead of re-parsing them.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// object ids and the object model
// ---------------------------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** The all-zero object id: an unborn ref's old/new value. */
export const ZERO_OID = '0'.repeat(40);

/** The object id of the empty tree (hash of zero bytes as a tree). */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const HEX40 = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id. */
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** SHA-1 of a buffer, hex-encoded. */
export function sha1(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The loose-object header `<type> <size>\0` that prefixes the bytes a SHA-1 is computed over. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/**
 * git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. The header is fed as a
 * string so no header Buffer is allocated.
 */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(`${type} ${body.length}\u0000`, 'utf8');
  hash.update(body);
  return hash.digest('hex');
}

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

/** A parsed tree entry. `mode` is git's ASCII mode (`100644`, `40000`, `160000`, ...). */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeNames(
  a: { name: string; mode: string },
  b: { name: string; mode: string },
): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a commit object; refuses a malformed header layout. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) if (!isObjectId(parent)) throw new Error('commit has a bad parent id');
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  /** Full "Name <email> <epoch> <tz>" author line, or the name/email part only. */
  readonly author: string;
  readonly committer?: string;
  /** Unix seconds for the author/committer lines. Defaults to 0 (deterministic). */
  readonly timestamp?: number;
  readonly timezone?: string;
}

/**
 * Build a commit object's bytes. `author`/`committer` may be a bare "Name <email>" identity
 * (the timestamp/timezone are appended) or a complete line already carrying a timestamp.
 */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new Error('buildCommit needs a valid tree id');
  const timestamp = fields.timestamp ?? 0;
  const timezone = fields.timezone ?? '+0000';
  const complete = (who: string): string =>
    /\d+ [+-]\d{4}$/.test(who) ? who : `${who} ${timestamp} ${timezone}`;
  const author = complete(fields.author);
  const committer = complete(fields.committer ?? fields.author);
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface BuildTagFields {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly message: string;
  readonly tagger: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: BuildTagFields): Buffer {
  if (!isObjectId(fields.object)) throw new Error('buildTag needs a valid object id');
  const timestamp = fields.timestamp ?? 0;
  const timezone = fields.timezone ?? '+0000';
  const tagger = /\d+ [+-]\d{4}$/.test(fields.tagger)
    ? fields.tagger
    : `${fields.tagger} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/** A per-call cache of parsed commits/trees, so one walk never parses the same object twice. */
interface ParseCache {
  commits: Map<string, CommitView>;
  trees: Map<string, TreeEntry[]>;
}

function newParseCache(): ParseCache {
  return { commits: new Map(), trees: new Map() };
}

function cachedCommit(cache: ParseCache, oid: string, data: Uint8Array): CommitView {
  let parsed = cache.commits.get(oid);
  if (!parsed) {
    parsed = parseCommit(data);
    cache.commits.set(oid, parsed);
  }
  return parsed;
}

function cachedTree(cache: ParseCache, oid: string, data: Uint8Array): TreeEntry[] {
  let parsed = cache.trees.get(oid);
  if (!parsed) {
    parsed = parseTree(data);
    cache.trees.set(oid, parsed);
  }
  return parsed;
}

/**
 * Every object reachable from `roots`: commit → tree + parents, tree → entries (gitlinks
 * skipped), tag → its target, blob → nothing. Throws on a missing object unless `allowMissing`.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean; stopAtParentsOf?: ReadonlySet<string> } = {},
): Set<string> {
  const cache = newParseCache();
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = cachedCommit(cache, oid, object.data);
      queue.push(commit.tree);
      // A shallow boundary's parents are NOT held (the client holds the boundary
      // commit and its tree, but not its history), so the walk stops above them.
      if (options.stopAtParentsOf?.has(oid)) continue;
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of cachedTree(cache, oid, object.data)) {
        if (entry.mode === '160000') continue; // a gitlink names a commit the repo does not hold
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * Peel an object id to the commit it names: a tag object follows to its target (recursively);
 * a commit id is returned as-is. Returns null when the object is missing or is not a commit
 * (after peeling).
 */
export function peelToCommit(lookup: ObjectLookup, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = lookup(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * True when `ancestorOid` is an ancestor of (or equal to) `descendantOid`, walking commit
 * parents. Tag ids are peeled to their target commits first. Missing objects answer false.
 */
export function isAncestor(
  store: Store,
  repoOwner: string,
  repoName: string,
  ancestorOid: string,
  descendantOid: string,
): boolean {
  const repo = store.getRepo(repoOwner, repoName);
  if (!repo) return false;
  const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
  const ancestor = peelToCommit(lookup, ancestorOid);
  const descendant = peelToCommit(lookup, descendantOid);
  if (!ancestor || !descendant) return false;
  if (ancestor === descendant) return true;
  const cache = newParseCache();
  const seen = new Set<string>([descendant]);
  const queue: string[] = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of cachedCommit(cache, oid, object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/**
 * The first common ancestor (merge-base) of two commits, or null when their histories share
 * nothing. Walks the ancestors of `a` into a set, then breadth-first from `b` until it hits one.
 */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const aCommit = peelToCommit(lookup, a);
  const bCommit = peelToCommit(lookup, b);
  if (!aCommit || !bCommit) return null;
  if (aCommit === bCommit) return aCommit;
  const cache = newParseCache();
  const ancestors = new Set<string>();
  const queueA: string[] = [aCommit];
  while (queueA.length) {
    const oid = queueA.pop()!;
    if (ancestors.has(oid)) continue;
    ancestors.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') queueA.push(...cachedCommit(cache, oid, object.data).parents);
  }
  // Index-based queue (not shift): shift() is O(n) per pop and this walk is long.
  const queueB: string[] = [bCommit];
  let headB = 0;
  const seenB = new Set<string>();
  while (headB < queueB.length) {
    const oid = queueB[headB++]!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestors.has(oid)) return oid;
    const object = lookup(oid);
    if (object?.type === 'commit') queueB.push(...cachedCommit(cache, oid, object.data).parents);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// deltas
// ---------------------------------------------------------------------------------------------

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = asBuffer(base);
  const deltaBuffer = asBuffer(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * (1 << shift);
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++] * (1 << shift);
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++] * (1 << shift);
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface PackEntry {
  readonly offset: number;
  readonly type: GitObjectType;
  readonly size: number;
  /** The raw (delta, when `delta` is set) or final bytes. */
  readonly data: Buffer;
  readonly oid: string;
  readonly delta: { readonly kind: 'ofs' | 'ref'; readonly baseOid: string } | null;
}

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly entries: PackEntry[];
  readonly trailer: string;
  readonly computedTrailer: string;
  readonly checksumOk: boolean;
  readonly deltaCount: number;
  readonly byteLength: number;
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Uint8Array): string {
  const buffer = asBuffer(pack);
  if (buffer.length < 20) throw new Error('pack is shorter than its trailer');
  return createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
}

/** True when the pack's trailer matches its bytes. */
export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const buffer = asBuffer(pack);
  const actual = buffer.subarray(buffer.length - 20).toString('hex');
  const expected = packChecksum(buffer);
  return { ok: actual === expected, expected, actual };
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * (1 << shift);
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = asBuffer(buffer).subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and REF_DELTA.
 * `resolveBase` supplies a base object a thin pack leaves out (the receiver already has it).
 * Every object's SHA-1 is recomputed and its declared size checked; a mismatch is an error, so a
 * corruption cannot be reported as a successful push. The trailer checksum is reported in
 * `checksumOk` (callers decide whether a bad trailer is fatal).
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = asBuffer(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack does not start with PACK');
  }
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const entries: PackEntry[] = [];
  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) {
          throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied by the receiver`);
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
    entries.push({
      offset: entry.offset,
      type: resolved.type,
      size: entry.size,
      data: entry.data,
      oid: resolved.oid,
      delta:
        entry.typeCode === 6
          ? { kind: 'ofs', baseOid: byOffset.get(entry.baseOffset!)?.oid ?? '' }
          : entry.typeCode === 7
            ? { kind: 'ref', baseOid: entry.baseOid! }
            : null,
    });
  }

  return {
    version,
    declaredCount,
    objects,
    entries,
    trailer,
    computedTrailer,
    checksumOk,
    deltaCount,
    byteLength: buffer.length,
  };
}

/** Encode one object's pack header: the type/size varint git's pack format uses. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------------------------
// pack cache: identical object sets build identical packs, and a clone round packs the same
// objects 50 times. The cache is keyed by the sorted object ids (objects are immutable, so a
// pack is a pure function of its object set). Bounded so a long run cannot grow it without
// limit; when full it is cleared rather than evicting one entry at a time.
// ---------------------------------------------------------------------------------------------

const PACK_CACHE_MAX = 64;
const packCache = new Map<string, Buffer>();

function packCacheKey(oids: readonly string[]): string {
  return oids.join(',');
}

/**
 * Build a packfile from plain objects (no deltas). Entries are sorted by object id so the bytes
 * are deterministic. The trailer is SHA-1 over everything before it.
 *
 * `objects` is a Map keyed by object id (the ids planFetch already computed), so the sort never
 * re-hashes an object. A plain iterable of objects is also accepted: its ids are hashed once each
 * (not once per comparison, as a sort comparator would).
 */
export function writePack(objects: ReadonlyMap<string, GitObject> | Iterable<GitObject>): Buffer {
  const entries: Array<[string, GitObject]> =
    objects instanceof Map
      ? [...objects.entries()]
      : [...objects].map((object) => [hashObject(object.type, object.data), object] as [string, GitObject]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const key = packCacheKey(entries.map(([oid]) => oid));
  const cached = packCache.get(key);
  if (cached) return cached;

  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const [, object] of entries) {
    const data = asBuffer(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  if (packCache.size >= PACK_CACHE_MAX) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length. */
export const PKT_LINE_MAX = 65520;
/** The largest pkt-line payload (length minus the 4-byte header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. Preallocated, no concat. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const out = Buffer.allocUnsafe(4 + data.length);
  out.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  data.copy(out, 4);
  return out;
}

/** Encode a mixed sequence; `'flush'`/`'delim'`/`'response-end'` are the control packets. */
export function encodePktLines(
  items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode a complete buffer into pkt-line packets. Throws on a malformed header or a truncated
 * packet. `allowTrailing` stops before trailing bytes that are not a pkt-line (a raw pack after
 * the command list in receive-pack) and reports how many bytes the packets consumed.
 */
export function decodePktLines(
  bytes: Uint8Array,
  options: { allowTrailing?: boolean } = {},
): { packets: GitPacket[]; consumed: number } {
  const buffer = asBuffer(bytes);
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) {
      throw new Error(`truncated pkt-line: ${buffer.length - offset} trailing byte(s)`);
    }
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) {
      if (options.allowTrailing) break;
      throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    }
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (offset + length > buffer.length) {
      throw new Error(`truncated pkt-line: ${length} announced, ${buffer.length - offset} available`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The decoded text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// sideband
// ---------------------------------------------------------------------------------------------

/** The largest data chunk one sideband pkt-line can carry (payload minus the 1-byte band). */
export const SIDEBAND_MAX_DATA = PKT_LINE_MAX_PAYLOAD - 1;

/**
 * Frame `data` as sideband packets on `band` (1 = pack data, 2 = progress, 3 = error), each a
 * valid pkt-line no larger than 65,520 bytes. Returns one buffer per pkt-line. Preallocated, no
 * per-chunk concat.
 */
export function encodeSideband(band: 1 | 2 | 3, data: Uint8Array): Buffer[] {
  const body = asBuffer(data);
  const out: Buffer[] = [];
  if (body.length === 0) {
    const packet = Buffer.allocUnsafe(5);
    packet.write('0005', 0, 4, 'ascii');
    packet[4] = band;
    out.push(packet);
    return out;
  }
  for (let offset = 0; offset < body.length; offset += SIDEBAND_MAX_DATA) {
    const chunk = body.subarray(offset, Math.min(body.length, offset + SIDEBAND_MAX_DATA));
    const packet = Buffer.allocUnsafe(5 + chunk.length);
    packet.write((chunk.length + 5).toString(16).padStart(4, '0'), 0, 4, 'ascii');
    packet[4] = band;
    chunk.copy(packet, 5);
    out.push(packet);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** The objects to send, by id. */
  readonly objects: Map<string, GitObject>;
  /** Commits that are shallow boundaries in the result (their parents were not sent). */
  readonly shallow: string[];
  /** Prior shallow boundaries that are no longer shallow (their parents were sent or are held). */
  readonly unshallow: string[];
  /** `have` ids the walk reached (shared history), for ACK lines. */
  readonly acks: string[];
}

export interface FetchPlanOptions {
  /** Object ids the client already holds. */
  readonly haves?: readonly string[];
  /** The client's current shallow boundaries (commits whose parents it does not hold). */
  readonly shallowBoundaries?: readonly string[];
  /** `deepen N`: send at most N generations from each want (generation 0 is the want itself). */
  readonly depth?: number;
}

/**
 * Plan a fetch: which objects to send for `wants`, given what the client holds.
 *
 * The walk stops descending past a held (non-shallow) commit — its ancestors are held too —
 * and past the depth limit. A held commit that is a shallow boundary is descended past when
 * deepening, because its parents are not held. Commits included while their parent was cut off
 * by the depth limit (and the parent is not held) are new shallow boundaries; a prior boundary
 * whose parents are all sent or held is unshallow.
 */
export function planFetch(
  lookup: ObjectLookup,
  wants: readonly string[],
  options: FetchPlanOptions = {},
): FetchPlan {
  const cache = newParseCache();
  const haveSet = new Set(options.haves ?? []);
  const boundarySet = new Set(options.shallowBoundaries ?? []);
  const depthLimit = options.depth;
  if (depthLimit !== undefined && (!Number.isInteger(depthLimit) || depthLimit < 1)) {
    throw new Error(`deepen ${depthLimit} is not a positive integer`);
  }

  const included = new Set<string>();
  const objects = new Map<string, GitObject>();
  const shallowSet = new Set<string>();
  const acks: string[] = [];
  const visited = new Set<string>();

  const includeObject = (oid: string): void => {
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    if (!objects.has(oid)) objects.set(oid, object);
  };

  interface QueueItem {
    oid: string;
    depth: number;
  }
  const queue: QueueItem[] = [];
  let queueHead = 0;
  for (const want of wants) {
    const object = lookup(want);
    if (!object) throw new Error(`want ${want} is not in the store`);
    if (object.type === 'tag') {
      includeObject(want);
      queue.push({ oid: parseTag(object.data).object, depth: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 0 });
    } else {
      includeObject(want);
    }
  }

  while (queueHead < queue.length) {
    const { oid, depth } = queue[queueHead++];
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    if (haveSet.has(oid)) {
      // A held commit is common history: acknowledge it. A fully-held commit's ancestors
      // are held too, so the walk stops here; a shallow boundary's parents are NOT held,
      // so the walk continues past it (to send them when deepening, or to unshallow it).
      acks.push(oid);
      if (!boundarySet.has(oid)) continue;
    }
    if (depthLimit !== undefined && depth >= depthLimit) continue;
    included.add(oid);
    const commit = cachedCommit(cache, oid, object.data);
    for (const parent of commit.parents) {
      if (depthLimit !== undefined && depth + 1 >= depthLimit) {
        // The parent is cut off by the depth limit: this commit is a new shallow boundary
        // unless the client already holds the parent.
        if (!haveSet.has(parent)) shallowSet.add(oid);
        continue;
      }
      queue.push({ oid: parent, depth: depth + 1 });
    }
  }

  // Unshallow: a prior boundary that is now included and whose parents are all included or held.
  const unshallow: string[] = [];
  for (const boundary of boundarySet) {
    if (!included.has(boundary)) continue;
    const object = lookup(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = cachedCommit(cache, boundary, object.data).parents;
    const complete = parents.every((parent) => included.has(parent) || haveSet.has(parent));
    if (complete) unshallow.push(boundary);
  }

  // The tree closure of every included commit (trees and blobs, recursively; gitlinks skipped).
  // Objects the client already holds — the full closure of its haves, stopping
  // above shallow boundaries (their parents are not held) — are never re-sent:
  // a new commit's tree can reference blobs and subtrees unchanged from a held
  // commit, and sending those would break incremental fetch (the client already
  // holds them). A missing have is skipped (allowMissing): the client may name
  // history the server does not hold, and such a have simply never matches.
  const held = collectReachable(haveSet, lookup, { allowMissing: true, stopAtParentsOf: boundarySet });
  const treeQueue: string[] = [];
  for (const oid of included) {
    const object = lookup(oid);
    if (!object) continue;
    if (!held.has(oid)) includeObject(oid);
    treeQueue.push(cachedCommit(cache, oid, object.data).tree);
  }
  const seenTree = new Set<string>();
  while (treeQueue.length) {
    const oid = treeQueue.pop()!;
    if (seenTree.has(oid)) continue;
    seenTree.add(oid);
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    includeObject(oid);
    if (object.type === 'tree') {
      for (const entry of cachedTree(cache, oid, object.data)) {
        if (entry.mode === '160000') continue;
        treeQueue.push(entry.oid);
      }
    }
  }

  return {
    objects,
    shallow: [...shallowSet].sort(),
    unshallow: unshallow.sort(),
    acks,
  };
}
