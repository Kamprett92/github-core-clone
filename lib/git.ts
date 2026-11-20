// lib/git.ts — the git object model, packfiles, pkt-lines and fetch planning.
//
// No git binary anywhere: every object id, pack entry and protocol frame is
// computed from raw bytes with node:crypto (SHA-1) and node:zlib. The store
// (lib/store.ts) keeps the objects; this module knows how to hash them, pack
// them, walk them and decide what a fetch has to send.
//
// Determinism is a property of the bytes, not of the clock: nothing here
// reads the time or any randomness. The same set of objects always packs to
// the same bytes, so a replayed run exports byte-identical state.
//
// Performance notes (the clone/push workloads live here):
//   - writePack takes the object map directly, so the sort never re-hashes an
//     object to compare it; finished packs are memoised by their sorted ids.
//   - reachability and fetch planning share one parse cache per call instead
//     of re-parsing the same commit or tree on every walk.
//   - mergeBase walks with an index-based queue, never Array.shift().
//   - hashObject feeds the header and the body to the hash separately, so no
//     header Buffer is ever allocated.
//   - pkt-line and sideband encoders measure first and allocate once.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------

/** Forty zeroes: the id of "no object", used for unborn refs and deletes. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The SHA-1 of an empty tree object (the id of "no files"). */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** git's LARGE_PACKET_MAX: the largest pkt-line, header included. */
export const PKT_LINE_MAX = 65520;

/** The largest payload a pkt-line can carry (its length minus the 4-byte header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

/** The three control packets, as their literal four hex digits. */
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** The most object bytes one sideband packet carries (payload minus the band byte). */
export const SIDEBAND_MAX_DATA = PKT_LINE_MAX_PAYLOAD - 1;

// ---------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------

/** The four object kinds git knows. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** One stored object: its kind and its raw bytes (no loose-object header). */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** How callers resolve an id to an object; usually store.objectLookup(repo). */
export type ObjectLookup = (oid: string) => GitObject | undefined;

/** One entry of a tree object: an ASCII mode, a name, and the id it points at. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** A parsed commit: its tree, parents, identities, message, and any headers beyond the four known ones. */
export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

/** A parsed annotated tag. */
export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** The fields buildCommit takes. `author` is a full "Name <mail> <epoch> <tz>" line or a bare "Name <mail>"; a bare identity gains the timestamp and timezone. */
export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer?: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

/** The fields buildTag takes; the tagger follows the same bare-or-full rule as a commit identity. */
export interface BuildTagFields {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly message: string;
  readonly tagger: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

// ---------------------------------------------------------------------------------------------
// object ids
// ---------------------------------------------------------------------------------------------

const HEX40 = /^[0-9a-f]{40}$/;

/** True for exactly forty lowercase hex characters — the only id form this forge accepts. */
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** The hex SHA-1 of some bytes. */
export function sha1(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The loose-object header `<type> <size>\0` that prefixes the bytes an id is computed over. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/**
 * git's object id: SHA-1 over the header plus the object's bytes. The header
 * is fed to the hash as a string, so no header Buffer is ever allocated.
 */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\u0000`);
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

/**
 * Parse a tree object into its entries, in the object's stored order. Throws
 * on a truncated entry, a missing separator, or a non-octal mode.
 */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = bytes.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > bytes.length) throw new Error('tree entry has a truncated object id');
    const mode = bytes.subarray(at, space).toString('ascii');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({
      mode,
      name: bytes.subarray(space + 1, nul).toString('utf8'),
      oid: bytes.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return entries;
}

/**
 * git's tree-entry sort: byte order of the name, except a directory compares
 * as if its name ended in '/'. (That is why "foo/" sorts before "foo.txt".)
 */
export function compareTreeNames(a: string, b: string, aIsDir: boolean, bIsDir: boolean): number {
  const left = Buffer.from(aIsDir ? `${a}/` : a, 'utf8');
  const right = Buffer.from(bIsDir ? `${b}/` : b, 'utf8');
  return Buffer.compare(left, right);
}

/**
 * Build a tree object's bytes from entries, sorted the way git sorts them.
 * The entries are copied before sorting, so the caller's array is untouched.
 * Throws on an entry with a bad object id.
 */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((x, y) =>
    compareTreeNames(x.name, y.name, x.mode === '40000', y.mode === '40000'),
  );
  let total = 0;
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    total += Buffer.byteLength(entry.mode) + 1 + Buffer.byteLength(entry.name) + 1 + 20;
  }
  const out = Buffer.allocUnsafe(total);
  let at = 0;
  for (const entry of sorted) {
    at += out.write(`${entry.mode} ${entry.name}\u0000`, at, 'utf8');
    at += Buffer.from(entry.oid, 'hex').copy(out, at);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

/**
 * Split a commit or tag object into its header block and its message. The
 * header ends at the first blank line; an object with no blank line has no
 * message.
 */
function splitHeader(data: Uint8Array): { header: string; message: string } {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = bytes.indexOf('\n\n');
  if (blank < 0) return { header: bytes.toString('utf8'), message: '' };
  return {
    header: bytes.subarray(0, blank).toString('utf8'),
    message: bytes.subarray(blank + 2).toString('utf8'),
  };
}

/**
 * Parse a commit object. The four known headers (tree, parent, author,
 * committer) are pulled out; anything else (gpgsig, encoding, ...) is kept
 * in order as extra headers. Throws when the tree or a parent is not a valid
 * object id.
 */
export function parseCommit(data: Uint8Array): CommitView {
  const { header, message } = splitHeader(data);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<readonly [string, string]> = [];
  for (const line of header.split('\n')) {
    if (line === '') continue;
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
  for (const parent of parents) {
    if (!isObjectId(parent)) throw new Error('commit has a bad parent id');
  }
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

/**
 * Parse an annotated tag object. Throws when the object header is not a
 * valid id, the type header is not one of the four kinds, or a header line
 * has no value.
 */
export function parseTag(data: Uint8Array): TagView {
  const { header, message } = splitHeader(data);
  const seen = new Map<string, string>();
  for (const line of header.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    seen.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = seen.get('object') ?? '';
  const type = seen.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type,
    tag: seen.get('tag') ?? '',
    tagger: seen.get('tagger') ?? '',
    message,
  };
}

/**
 * Finish an identity for a commit or tag line. A full line (already ending
 * in "<epoch> <timezone>") is used as-is; a bare "Name <mail>" gains the
 * timestamp and timezone. The timestamp defaults to 0 and the timezone to
 * +0000, so two builds of the same fields give the same bytes.
 */
function finishIdentity(identity: string, timestamp: number | undefined, timezone: string | undefined): string {
  if (/\s\d+\s[+-]\d{4}$/.test(identity)) return identity;
  return `${identity} ${timestamp ?? 0} ${timezone ?? '+0000'}`;
}

/**
 * Build a commit object's bytes: "tree <oid>", one "parent <oid>" per parent,
 * the author and committer lines, a blank line, then the message exactly as
 * given. Throws on a bad tree or parent id.
 */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new Error('buildCommit needs a valid tree id');
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('buildCommit needs valid parent ids');
  }
  const author = finishIdentity(fields.author, fields.timestamp, fields.timezone);
  const committer =
    fields.committer === undefined
      ? author
      : finishIdentity(fields.committer, fields.timestamp, fields.timezone);
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/**
 * Build an annotated tag object's bytes: object, type, tag and tagger lines,
 * a blank line, then the message exactly as given. Throws on a bad object id.
 */
export function buildTag(fields: BuildTagFields): Buffer {
  if (!isObjectId(fields.object)) throw new Error('buildTag needs a valid object id');
  const tagger = finishIdentity(fields.tagger, fields.timestamp, fields.timezone);
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * The closure of objects reachable from `roots`, through commit trees and
 * parents, tag targets, and tree entries. Gitlinks (mode 160000) are skipped
 * — the submodule's objects are not ours. A root whose parents sit in
 * `stopAtParentsOf` still contributes its tree, but not its parents: that is
 * how a shallow boundary's held closure is computed. Throws on a missing
 * object unless allowMissing is set.
 *
 * The walk uses an index-based queue (never Array.shift()) and a seen set, so
 * a shared subtree is visited once no matter how many commits reach it.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options?: { allowMissing?: boolean; stopAtParentsOf?: ReadonlySet<string> },
): Set<string> {
  const allowMissing = options?.allowMissing ?? false;
  const stopAtParentsOf = options?.stopAtParentsOf;
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++];
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (allowMissing) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (stopAtParentsOf === undefined || !stopAtParentsOf.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
      queue.push(commit.tree);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * Follow annotated tags until a commit, a non-tag object, or a missing id is
 * reached. Returns the commit id, or null for a tag that points at a tree,
 * blob or nothing (and for a tag cycle, which cannot unwind).
 */
export function peelToCommit(lookup: ObjectLookup, oid: string): string | null {
  const visited = new Set<string>();
  let current = oid;
  for (;;) {
    if (visited.has(current)) return null;
    visited.add(current);
    const object = lookup(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
}

/**
 * True when `ancestor` can be reached by following parents from
 * `descendant` — including the case where the two ids are the same. Missing
 * objects are treated as having no parents, never as an error.
 */
export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++];
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/**
 * The merge base of two commits: the first commit found walking from `b`
 * that is also an ancestor of `a`. Returns null when the histories do not
 * meet, or when either tip is not a commit. Missing objects are skipped.
 */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const walkA: string[] = [a];
  let headA = 0;
  while (headA < walkA.length) {
    const oid = walkA[headA++];
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) walkA.push(parent);
  }
  const walkB: string[] = [b];
  const seenB = new Set<string>();
  let headB = 0;
  while (headB < walkB.length) {
    const oid = walkB[headB++];
    if (ancestorsOfA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) walkB.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// packfiles: writing
// ---------------------------------------------------------------------------------------------

/** The three git pack types: commit, tree, blob, tag, OFS delta, REF delta. */
const PACK_TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_DELTA_OFS = 6;
const PACK_DELTA_REF = 7;

/**
 * Write the pack type-and-size header for one object. The size is spread
 * little-endian over 4 bits in the first byte and then 7 bits per byte, with
 * the high bit marking every byte but the last.
 */
function packEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** The pack trailer: SHA-1 over everything before it. */
export function packChecksum(pack: Uint8Array): string {
  if (pack.length < 20) throw new Error('pack is too short for a checksum');
  return sha1(pack.subarray(0, pack.length - 20));
}

/** Check a pack's trailer. `expected` is the hash over the pack's bytes; `actual` is the stored trailer. */
export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const actual = Buffer.from(pack.subarray(pack.length - 20)).toString('hex');
  const expected = packChecksum(pack);
  return { ok: expected === actual, expected, actual };
}

/**
 * A finished pack, memoised by the sorted list of the object ids it holds.
 * The same set always packs to the same bytes, so repeated fetches of the
 * same objects are a cache lookup. Bounded at 64 entries, oldest first out.
 */
const packCache = new Map<string, Buffer>();
const PACK_CACHE_LIMIT = 64;

/**
 * Serialise objects into a packfile (version 2, no deltas): a 12-byte header
 * ("PACK", version 2, count), one zlib-deflated entry per object in oid
 * order, then the SHA-1 trailer. Accepts the object map itself, or any
 * iterable of objects (whose ids are computed once, each). Empty packs are
 * the 32-byte header-plus-trailer. The entries are sorted by id, so the
 * bytes are identical for the same set no matter the input order.
 */
export function writePack(objects: ReadonlyMap<string, GitObject> | Iterable<GitObject>): Buffer {
  let pairs: Array<readonly [string, GitObject]>;
  if (objects instanceof Map) {
    pairs = [...objects.entries()];
  } else {
    pairs = [];
    for (const object of objects) pairs.push([hashObject(object.type, object.data), object]);
  }
  // Sort once on the id strings; the hash is never recomputed inside the sort.
  pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const key = pairs.map((pair) => pair[0]).join(',');
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;

  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(pairs.length, 8);
  parts.push(header);
  for (const [, object] of pairs) {
    parts.push(packEntryHeader(PACK_TYPE_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1(body), 'hex');
  const pack = Buffer.concat([body, trailer]);
  if (packCache.size >= PACK_CACHE_LIMIT) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

// ---------------------------------------------------------------------------------------------
// packfiles: reading
// ---------------------------------------------------------------------------------------------

/** The result of reading one pack: the entries in file order, plus a lookup by id. */
export interface PackReadResult {
  readonly entries: ReadonlyArray<PackEntry>;
  readonly objects: Map<string, GitObject>;
}

/** One entry of a pack: where it sits, what it resolved to, and its raw bytes. */
export interface PackEntry {
  readonly offset: number;
  readonly type: GitObjectType;
  readonly size: number;
  readonly data: Buffer;
  readonly baseOffset?: number;
  readonly baseOid?: string;
  readonly resolved: GitObject;
}

/** Read a varint from a buffer: the first byte's low 4 bits, then 7 bits per byte. Returns the value and the next offset. */
function readVarint(buffer: Buffer, at: number): { value: number; next: number } {
  let value = buffer[at] & 0x0f;
  let cursor = at + 1;
  let shift = 4;
  while ((buffer[cursor - 1] & 0x80) !== 0) {
    value += (buffer[cursor] & 0x7f) * 2 ** shift;
    shift += 7;
    cursor += 1;
  }
  return { value, next: cursor };
}

/** Read an OFS delta's base offset (a varint with the git twist: each byte adds one before shifting). */
function readOffsetVarint(buffer: Buffer, at: number): { value: number; next: number } {
  let value = buffer[at] & 0x7f;
  let cursor = at + 1;
  while ((buffer[cursor - 1] & 0x80) !== 0) {
    value = ((value + 1) << 7) | (buffer[cursor] & 0x7f);
    cursor += 1;
  }
  return { value, next: cursor };
}

/**
 * Inflate the zlib stream that starts at `offset` and say where it ends.
 * The stream length comes from the inflater itself (bytesWritten), so no
 * scan for the stream's end is needed.
 */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!Number.isFinite(written) || written <= 0) {
    throw new Error('zlib stream has no readable length');
  }
  return { data: result.buffer, next: offset + written };
}

/**
 * Apply a git delta to a base object's bytes. The delta is a source-size
 * varint, a target-size varint, then copy and insert ops: copy ops take an
 * offset and a size from the base (a size field of 0 means 0x10000), insert
 * ops take their bytes literally. Throws on a truncated op, a copy that runs
 * past the base, or a result whose length is not the declared target size.
 */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const bytes = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  const source = readVarint(bytes, 0);
  if (source.value !== base.length) {
    throw new Error(`delta source size ${source.value} does not match base length ${base.length}`);
  }
  const target = readVarint(bytes, source.next);
  const out = Buffer.allocUnsafe(target.value);
  let written = 0;
  let at = target.next;
  while (at < bytes.length) {
    const op = bytes[at++];
    if ((op & 0x80) !== 0) {
      // Copy from the base: offset and size are little-endian bitfields.
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit++) {
        if ((op & (1 << bit)) !== 0) {
          if (at >= bytes.length) throw new Error('delta copy op is truncated');
          offset |= bytes[at++] << (8 * bit);
        }
      }
      for (let bit = 0; bit < 3; bit++) {
        if ((op & (0x10 << bit)) !== 0) {
          if (at >= bytes.length) throw new Error('delta copy op is truncated');
          size |= bytes[at++] << (8 * bit);
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) {
        throw new Error('delta copy op runs past the end of the base object');
      }
      base.subarray(offset, offset + size).copy(out, written);
      written += size;
    } else if (op !== 0) {
      // Insert literal bytes.
      if (at + op > bytes.length) throw new Error('delta insert op is truncated');
      bytes.subarray(at, at + op).copy(out, written);
      written += op;
      at += op;
    } else {
      throw new Error('delta has opcode 0');
    }
  }
  if (written !== target.value) {
    throw new Error(`delta produced ${written} bytes, expected ${target.value}`);
  }
  return out;
}

/**
 * Read a whole packfile (v2 or v3): validate the header, check the trailer,
 * inflate every entry, and resolve OFS and REF deltas (recursively, with
 * cycle detection). Thin packs — entries that delta against an object not in
 * the pack — resolve through `resolveBase`. Throws on a bad header, a bad
 * checksum, a truncated entry, a size mismatch, a delta cycle, or a delta
 * whose base cannot be found.
 */
export function readPack(
  pack: Uint8Array,
  options?: { resolveBase?: ObjectLookup },
): PackReadResult {
  const bytes = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (bytes.length < 32) throw new Error('pack is too short');
  if (bytes.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack has no PACK header');
  }
  const version = bytes.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = bytes.readUInt32BE(8);
  const checksum = verifyPackChecksum(bytes);
  if (!checksum.ok) {
    throw new Error(`pack checksum mismatch: expected ${checksum.expected}, got ${checksum.actual}`);
  }
  const trailerStart = bytes.length - 20;

  // First pass: inflate every entry, remembering its raw bytes and base link.
  const raw: Array<{
    offset: number;
    type: GitObjectType | number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }> = [];
  let at = 12;
  for (let index = 0; index < count; index++) {
    const offset = at;
    const first = bytes[at];
    const typeCode = (first >> 4) & 0x07;
    const sizeRead = readVarint(bytes, at);
    const size = sizeRead.value;
    let cursor = sizeRead.next;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === PACK_DELTA_OFS) {
      const offsetRead = readOffsetVarint(bytes, cursor);
      baseOffset = offset - offsetRead.value;
      cursor = offsetRead.next;
    } else if (typeCode === PACK_DELTA_REF) {
      if (cursor + 20 > trailerStart) throw new Error('pack REF delta has no base id');
      baseOid = bytes.subarray(cursor, cursor + 20).toString('hex');
      cursor += 20;
    }
    const inflated = inflateAt(bytes, cursor);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${offset} declares ${size} bytes but inflates to ${inflated.data.length}`);
    }
    raw.push({ offset, type: typeCode, size, data: inflated.data, baseOffset, baseOid });
    at = inflated.next;
  }
  if (at !== trailerStart) {
    throw new Error(`pack entries end at ${at}, but the trailer starts at ${trailerStart}`);
  }

  const typeNames: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

  // Fast path: no entry is a delta, so every entry resolves to itself and
  // the delta machinery (offset index, resolve memo, cycle set) is skipped.
  // The objects and entries built here are identical to the general path's.
  const hasDelta = raw.some((entry) => entry.type === PACK_DELTA_OFS || entry.type === PACK_DELTA_REF);
  if (!hasDelta) {
    const entries: PackEntry[] = [];
    const objects = new Map<string, GitObject>();
    for (let index = 0; index < raw.length; index++) {
      const entry = raw[index]!;
      if (typeof entry.type !== 'number' || typeNames[entry.type] === undefined) {
        throw new Error(`pack entry at ${entry.offset} has bad type code ${entry.type}`);
      }
      const object: GitObject = { type: typeNames[entry.type], data: entry.data };
      entries.push({
        offset: entry.offset,
        type: object.type,
        size: entry.size,
        data: entry.data,
        baseOffset: entry.baseOffset,
        baseOid: entry.baseOid,
        resolved: object,
      });
      objects.set(hashObject(object.type, object.data), object);
    }
    return { entries, objects };
  }

  const byOffset = new Map<number, number>();
  raw.forEach((entry, index) => byOffset.set(entry.offset, index));

  // Second pass: resolve each entry to its final object, memoised by index.
  const resolved = new Map<number, GitObject>();
  const resolving = new Set<number>();
  const resolve = (index: number): GitObject => {
    const done = resolved.get(index);
    if (done !== undefined) return done;
    if (resolving.has(index)) throw new Error('pack delta cycle');
    const entry = raw[index];
    if (entry.type === PACK_DELTA_OFS || entry.type === PACK_DELTA_REF) {
      resolving.add(index);
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex === undefined) {
          throw new Error(`pack OFS delta at ${entry.offset} has no base at ${entry.baseOffset}`);
        }
        base = resolve(baseIndex);
      } else if (entry.baseOid !== undefined) {
        base = options?.resolveBase?.(entry.baseOid);
        if (base === undefined) {
          throw new Error(`pack REF delta at ${entry.offset} has no base ${entry.baseOid}`);
        }
      }
      if (base === undefined) throw new Error(`pack delta at ${entry.offset} has no base`);
      const data = applyDelta(base.data, entry.data);
      const object = { type: base.type, data };
      resolving.delete(index);
      resolved.set(index, object);
      return object;
    }
    if (typeof entry.type !== 'number' || typeNames[entry.type] === undefined) {
      throw new Error(`pack entry at ${entry.offset} has bad type code ${entry.type}`);
    }
    const object = { type: typeNames[entry.type], data: entry.data };
    resolved.set(index, object);
    return object;
  };

  const entries: PackEntry[] = [];
  const objects = new Map<string, GitObject>();
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    const object = resolve(index);
    const oid = hashObject(object.type, object.data);
    entries.push({
      offset: entry.offset,
      type: object.type,
      size: entry.size,
      data: entry.data,
      baseOffset: entry.baseOffset,
      baseOid: entry.baseOid,
      resolved: object,
    });
    objects.set(oid, object);
  }
  return { entries, objects };
}

// ---------------------------------------------------------------------------------------------
// pkt-lines and sideband
// ---------------------------------------------------------------------------------------------

/** One decoded pkt-line: either a control packet or a payload. */
export type PktLinePacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Encode one payload as a pkt-line: a 4-hex-digit length (payload plus the
 * header itself) followed by the payload. Throws when the payload is too
 * large for one line.
 */
export function encodePktLine(payload: Uint8Array): Buffer {
  const length = payload.length + 4;
  if (length > PKT_LINE_MAX) throw new Error(`pkt-line payload of ${payload.length} bytes is too large`);
  const out = Buffer.allocUnsafe(length);
  out.write(length.toString(16).padStart(4, '0'), 0, 'ascii');
  Buffer.from(payload).copy(out, 4);
  return out;
}

/**
 * Encode a whole sequence of lines: strings or buffers become data lines,
 * and the strings 'flush', 'delim' and 'response-end' become the control
 * packets. Measured first, allocated once — no concatenation of many small
 * buffers.
 */
export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  const pieces: Buffer[] = [];
  let total = 0;
  for (const item of items) {
    let piece: Buffer;
    if (item === 'flush') piece = PKT_FLUSH;
    else if (item === 'delim') piece = PKT_DELIM;
    else if (item === 'response-end') piece = PKT_RESPONSE_END;
    else piece = encodePktLine(typeof item === 'string' ? Buffer.from(item, 'utf8') : item);
    pieces.push(piece);
    total += piece.length;
  }
  const out = Buffer.allocUnsafe(total);
  let at = 0;
  for (const piece of pieces) at += piece.copy(out, at);
  return out;
}

/**
 * Decode a whole buffer of pkt-lines. Returns the packets and how many bytes
 * were consumed. Throws on a bad header or a line that runs past the buffer.
 * With allowTrailing, stops cleanly before bytes that are not a pkt-line at
 * all (a raw packfile after a command list) and reports where it stopped.
 */
export function decodePktLines(
  bytes: Uint8Array,
  options?: { allowTrailing?: boolean },
): { packets: PktLinePacket[]; consumed: number } {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const packets: PktLinePacket[] = [];
  let at = 0;
  while (at < buffer.length) {
    if (at + 4 > buffer.length) {
      throw new Error('pkt-line header is truncated');
    }
    const lengthText = buffer.subarray(at, at + 4).toString('ascii');
    const length = Number.parseInt(lengthText, 16);
    if (lengthText === '0000') {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (lengthText === '0001') {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (lengthText === '0002') {
      packets.push({ kind: 'response-end' });
      at += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText) || !Number.isInteger(length) || length < 4 || length > PKT_LINE_MAX) {
      if (options?.allowTrailing) return { packets, consumed: at };
      throw new Error(`bad pkt-line length ${JSON.stringify(lengthText)}`);
    }
    if (at + length > buffer.length) {
      throw new Error('pkt-line runs past the end of the buffer');
    }
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, consumed: at };
}

/** Turn decoded packets into the text lines they carry, dropping the control packets. */
export function packetsToLines(packets: ReadonlyArray<PktLinePacket>): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

/**
 * Frame bytes as sideband packets on one band (1 = pack data, 2 = progress,
 * 3 = fatal error). Each packet is a pkt-line holding one band byte plus up
 * to SIDEBAND_MAX_DATA bytes of payload. Empty input still yields one packet
 * (band byte only).
 */
export function encodeSideband(band: 1 | 2 | 3, data: Uint8Array): Buffer[] {
  const frames: Buffer[] = [];
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (let at = 0; at < bytes.length; at += SIDEBAND_MAX_DATA) {
    const chunk = bytes.subarray(at, Math.min(bytes.length, at + SIDEBAND_MAX_DATA));
    const payload = Buffer.allocUnsafe(1 + chunk.length);
    payload[0] = band;
    chunk.copy(payload, 1);
    frames.push(encodePktLine(payload));
  }
  if (frames.length === 0) {
    const payload = Buffer.from([band]);
    frames.push(encodePktLine(payload));
  }
  return frames;
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

/** The inputs to planFetch: what the client wants, has, and already knows as shallow. */
export interface PlanFetchOptions {
  readonly haves?: ReadonlySet<string>;
  readonly shallowBoundaries?: ReadonlySet<string>;
  /** How many generations of commits to send; absent means the full history. */
  readonly depth?: number;
}

/** The result of planFetch: the objects to pack, and the shallow/ack bookkeeping for the reply. */
export interface PlanFetchResult {
  readonly objects: Map<string, GitObject>;
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly acks: string[];
}

/**
 * Decide what a fetch has to send. The walk starts from each wanted commit
 * and climbs its parents, generation by generation:
 *
 *   - a commit the client already holds stops the climb — unless it is a
 *     shallow boundary, whose parents the client does NOT hold, so the climb
 *     continues past it;
 *   - a commit at generation == depth is not sent (depth N means N commits
 *     deep: generations 0..N-1);
 *   - a sent commit whose parents were cut off by the depth limit becomes a
 *     new shallow boundary, unless every parent is already held;
 *   - every wanted commit that is also held is acknowledged.
 *
 * The objects to send are the sent commits, their trees and blobs, any wanted
 * tags and their targets, and any wanted trees or blobs directly — minus
 * everything the client already holds. A prior shallow boundary whose parents
 * are all now sent or held is unshallowed. Parsing is shared through one
 * cache for the whole call, so a commit or tree that many walks touch is
 * parsed once.
 */
export function planFetch(
  lookup: ObjectLookup,
  wants: Iterable<string>,
  options?: PlanFetchOptions,
): PlanFetchResult {
  const haves = options?.haves ?? new Set<string>();
  const shallowSet = options?.shallowBoundaries ?? new Set<string>();
  const depth = options?.depth;

  // The objects the client already has: the closure of its haves, stopping
  // before the parents of its shallow boundaries.
  const held = collectReachable(haves, lookup, { allowMissing: true, stopAtParentsOf: shallowSet });

  // One parse cache for the whole call, keyed by object id.
  const commitCache = new Map<string, CommitView>();
  const treeCache = new Map<string, TreeEntry[]>();
  const commitOf = (oid: string): CommitView => {
    const hit = commitCache.get(oid);
    if (hit !== undefined) return hit;
    const parsed = parseCommit(lookup(oid)?.data ?? Buffer.alloc(0));
    commitCache.set(oid, parsed);
    return parsed;
  };
  const treeOf = (oid: string): TreeEntry[] => {
    const hit = treeCache.get(oid);
    if (hit !== undefined) return hit;
    const parsed = parseTree(lookup(oid)?.data ?? Buffer.alloc(0));
    treeCache.set(oid, parsed);
    return parsed;
  };

  const included = new Set<string>();
  const includedTags = new Set<string>();
  const directObjects = new Set<string>();
  const acks: string[] = [];
  const newShallow: string[] = [];
  const visited = new Map<string, number>();
  const queue: Array<readonly [string, number]> = [];
  let head = 0;

  for (const want of wants) {
    const object = lookup(want);
    if (object === undefined) throw new Error(`fetch want ${want} is not in the store`);
    if (object.type === 'tag') {
      includedTags.add(want);
      const target = parseTag(object.data).object;
      const targetObject = lookup(target);
      if (targetObject === undefined) throw new Error(`fetch tag ${want} points at missing object ${target}`);
      if (targetObject.type === 'commit') queue.push([target, 0]);
      else directObjects.add(target);
    } else if (object.type === 'commit') {
      queue.push([want, 0]);
    } else {
      directObjects.add(want);
    }
  }

  while (head < queue.length) {
    const [oid, generation] = queue[head++];
    const seenAt = visited.get(oid);
    if (seenAt !== undefined && seenAt <= generation) continue;
    visited.set(oid, generation);
    if (haves.has(oid)) acks.push(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = commitOf(oid);
    const isHeld = held.has(oid);
    if (isHeld) {
      // Held and not a boundary: the client's history covers everything above.
      // Held and a boundary: its parents are NOT held, so keep climbing.
      if (shallowSet.has(oid)) {
        for (const parent of commit.parents) queue.push([parent, generation + 1]);
      }
      continue;
    }
    if (depth !== undefined && generation >= depth) continue;
    included.add(oid);
    if (depth !== undefined && generation === depth - 1) {
      // Deepest sent generation: a parent cut off by the depth limit makes
      // this commit a new shallow boundary (unless every parent is held).
      if (commit.parents.some((parent) => !held.has(parent))) newShallow.push(oid);
      continue;
    }
    for (const parent of commit.parents) queue.push([parent, generation + 1]);
  }

  // Gather the objects to send. Trees are walked once each; a held tree's
  // contents are held too, so its walk stops there.
  const send = new Map<string, GitObject>();
  const walkedTrees = new Set<string>();
  const addTree = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (walkedTrees.has(current) || held.has(current)) continue;
      walkedTrees.add(current);
      const object = lookup(current);
      if (object === undefined || object.type !== 'tree') continue;
      send.set(current, object);
      for (const entry of treeOf(current)) {
        if (entry.mode === '160000') continue;
        const child = lookup(entry.oid);
        if (child === undefined) continue;
        if (child.type === 'tree') stack.push(entry.oid);
        else if (!held.has(entry.oid)) send.set(entry.oid, child);
      }
    }
  };
  for (const oid of included) {
    const object = lookup(oid);
    if (object === undefined) continue;
    send.set(oid, object);
    addTree(commitOf(oid).tree);
  }
  for (const oid of includedTags) {
    const object = lookup(oid);
    if (object !== undefined) send.set(oid, object);
  }
  for (const oid of directObjects) {
    const object = lookup(oid);
    if (object !== undefined) send.set(oid, object);
  }
  for (const oid of held) send.delete(oid);

  // A prior boundary is unshallowed once every parent is sent or held.
  const unshallow: string[] = [];
  for (const boundary of shallowSet) {
    const object = lookup(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    if (commitOf(boundary).parents.every((parent) => send.has(parent) || held.has(parent))) {
      unshallow.push(boundary);
    }
  }

  return { objects: send, shallow: newShallow, unshallow, acks };
}
