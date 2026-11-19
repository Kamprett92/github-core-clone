// The shared in-memory store: one Store per server, and every surface — git
// smart HTTP, REST v3, GraphQL v4, MCP — reads and writes the same objects,
// so a repo created over MCP reads back over REST with unchanged ids, an
// issue created over GraphQL closes over REST, and a branch pushed over git
// is the head a PR merges. There is no persistence and no second source of
// truth to drift.
//
// Determinism is a correctness property here, not a nicety: the final runs
// replay the entry and the two state exports must be byte-identical. So this
// file contains no Date.now(), no Math.random(), no random ids anywhere
// observable: ids are sequential counters, timestamps come from
// MAKEFUN_TRIAL_NOW or a fixed constant, and every collection is walked in
// insertion or sorted order.

import {
  buildCommit,
  buildTree,
  collectReachable,
  EMPTY_TREE_OID,
  hashObject,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  ZERO_OID,
} from './git.ts';
import type {
  CommitView,
  GitObject,
  GitObjectType,
  ObjectLookup,
  TreeEntry,
} from './git.ts';

export { EMPTY_TREE_OID, ZERO_OID } from './git.ts';

/** The timestamp every created/updated record carries when MAKEFUN_TRIAL_NOW is unset. */
export const FIXED_NOW = '2026-11-14T06:30:00.000Z';

/** The identity every server-created commit and tag carries. */
export const SERVER_IDENTITY = 'ada iversen <adaiversen@example.invalid>';

/** The one organisation in the scenario. */
export const SCENARIO_ORG = 'faint-meadow-org';

/** The viewer: the login the trial bearer token names. */
export const VIEWER_LOGIN = 'adaiversen';

// ---------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  id: number; // sequential numeric id, starting at 1
  owner: string;
  name: string;
  fullName: string; // "owner/name"
  private: boolean;
  description: string;
  defaultBranch: string; // always "main" at creation
  refs: Map<string, string>; // refname -> oid, e.g. "refs/heads/main" -> commit oid
  objects: Map<string, GitObject>; // oid -> { type, data }
  labels: Map<string, Label>;
  issues: Issue[]; // creation order
  issueSeq: number; // per-repo counter; next issue number is seq + 1
  prSeq: number; // per-repo counter; next pull number is seq + 1
  pulls: Pull[];
  comments: Map<number, Comment[]>; // issue number -> its comments, creation order
  commentSeq: number; // per-repo counter; next comment id is seq (starts at 1)
  createdAt: string;
  updatedAt: string; // ISO, from nowIso()
}

export interface Issue {
  number: number;
  id: string; // stable across reads: `I_<owner>_<repo>_<number>`
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[]; // copies of the repo's labels at creation time
  createdSeq: number; // global creation order (deterministic counter)
  createdAt: string;
  updatedAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  id: string; // stable across reads: `PR_<owner>_<repo>_<number>`
  title: string;
  body: string;
  state: 'open' | 'closed'; // NOTE: a merged PR is 'closed' with merged === true.
  // There is no 'merged' state value — the REST shape only allows
  // open/closed, and merged PRs report 'closed'.
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string }; // branch name + tip at creation (sha refreshed by refreshPullFiles)
  base: { ref: string; sha: string };
  files: PullFile[]; // diff of merge-base tree vs head tree, recomputed on read
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number; // sequential per repo from 1
  body: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------------------------
// constants: the fixed scenario
// ---------------------------------------------------------------------------------------------

/** The six GitHub default labels, kept for reference. They are NOT auto-seeded
 * on repo creation: a fresh repo holds no labels, so POST /labels
 * `{name: 'bug'}` answers 201. */
export const DEFAULT_LABELS: ReadonlyArray<Label> = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'duplicate', color: 'cfd3d7', description: 'This issue or pull request already exists' },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'invalid', color: 'e4e669', description: "This doesn't seem right" },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'wontfix', color: 'ffffff', description: 'This will not be worked on' },
];

/** The fixed scenario users. The store never guesses a login from the token
 * at runtime; the viewer is always adaiversen (id 1000). */
const SCENARIO_USERS: ReadonlyArray<User> = Object.freeze([
  { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' },
  { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
  { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
  { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid' },
  { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid' },
  { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid' },
  { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid' },
  { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid' },
  { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid' },
  { id: 1009, login: 'elenaulrich', name: 'elena ulrich', email: 'elenaulrich@example.invalid' },
  { id: 1010, login: 'tesssato', name: 'tess sato', email: 'tesssato@example.invalid' },
  { id: 1011, login: 'svenrossi', name: 'sven rossi', email: 'svenrossi@example.invalid' },
]);

// ---------------------------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------------------------

/** The store's only error type. REST handlers send `err.status` with
 * `{ "message": err.message }`. Statuses used: 404 (repo / issue / pull /
 * file not found), 405 (pull not open, or merge conflict), 409 (stale `sha`
 * on content write/delete), 422 (invalid name, duplicate repo/label/ref,
 * unknown label on issue creation, missing head/base branch, file already
 * exists, branch does not exist). */
export class StoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

export function isStoreError(err: unknown): err is StoreError {
  return err instanceof StoreError;
}

// ---------------------------------------------------------------------------------------------
// deterministic time
// ---------------------------------------------------------------------------------------------

/** The one timestamp for the whole process, computed once: MAKEFUN_TRIAL_NOW
 * when it is set and parses as a date, else FIXED_NOW. Never wall-clock. */
let cachedNowIso: string | undefined;

function computeNowIso(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '' && !Number.isNaN(Date.parse(raw))) return raw;
  return FIXED_NOW;
}

/** The current timestamp, as an ISO string. Cached: it depends only on the
 * environment variable, so it cannot change during the process. */
export function nowIso(): string {
  if (cachedNowIso === undefined) cachedNowIso = computeNowIso();
  return cachedNowIso;
}

/** Unix seconds matching nowIso(), for commit author/committer lines. */
export function nowEpochSec(): number {
  return Math.floor(new Date(nowIso()).getTime() / 1000);
}

// ---------------------------------------------------------------------------------------------
// line-count helpers
// ---------------------------------------------------------------------------------------------

/** Lines in the bytes (a trailing newline does not add a line; empty input is 0). */
export function countLines(data: Uint8Array | undefined): number {
  if (data === undefined || data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] === 0x0a) count += 1;
  }
  // A trailing newline terminates the last line instead of starting a new one.
  return data[data.length - 1] === 0x0a ? count : count + 1;
}

/** Split bytes into lines (without the line terminators), dropping the empty
 * tail a trailing newline leaves. Works on raw bytes, so binary files count
 * exactly too. */
function splitLines(data: Uint8Array): Uint8Array[] {
  if (data.length === 0) return [];
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] === 0x0a) {
      lines.push(data.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < data.length) lines.push(data.subarray(start));
  return lines;
}

function linesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Added/deleted line counts by trimming the common prefix and suffix of
 * lines. Exact for single-hunk changes; a cheap O(n) approximation for
 * multi-hunk ones. */
export function diffLineCounts(
  oldData: Uint8Array,
  newData: Uint8Array,
): { additions: number; deletions: number } {
  const oldLines = splitLines(oldData);
  const newLines = splitLines(newData);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    linesEqual(oldLines[prefix]!, newLines[prefix]!)
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    linesEqual(oldLines[oldLines.length - 1 - suffix]!, newLines[newLines.length - 1 - suffix]!)
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

const REPO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class Store {
  /** The frozen scenario list. */
  readonly users: ReadonlyArray<User> = SCENARIO_USERS;

  private readonly reposByKey = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextCreatedSeq = 1; // global creation order for issues and pulls

  // ---------------------------------------------------------------------------
  // time
  // ---------------------------------------------------------------------------

  /** MAKEFUN_TRIAL_NOW when set and a valid ISO date, else FIXED_NOW. Never wall-clock. */
  nowIso(): string {
    return nowIso();
  }

  /** Unix seconds matching nowIso(), for commit author/committer lines. */
  nowEpochSec(): number {
    return nowEpochSec();
  }

  // ---------------------------------------------------------------------------
  // users
  // ---------------------------------------------------------------------------

  getUser(login: string): User | undefined {
    return this.users.find((user) => user.login === login);
  }

  /** The viewer (adaiversen); falls back to the first scenario user. */
  viewer(): User {
    return this.getUser(VIEWER_LOGIN) ?? this.users[0]!;
  }

  // ---------------------------------------------------------------------------
  // repos
  // ---------------------------------------------------------------------------

  createRepo(
    owner: string,
    name: string,
    options?: { private?: boolean; description?: string },
  ): Repo {
    if (!REPO_NAME_PATTERN.test(name) || name.endsWith('.git')) {
      throw new StoreError(422, 'Invalid repository name');
    }
    const key = `${owner}/${name}`;
    if (this.reposByKey.has(key)) throw new StoreError(422, 'Repository already exists');
    const stamp = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      fullName: key,
      private: options?.private ?? false,
      description: options?.description ?? '',
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      issueSeq: 0,
      prSeq: 0,
      pulls: [],
      comments: new Map(),
      commentSeq: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.nextRepoId += 1;
    this.reposByKey.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.reposByKey.get(`${owner}/${name}`);
  }

  requireRepo(owner: string, name: string): Repo {
    const repo = this.getRepo(owner, name);
    if (repo === undefined) throw new StoreError(404, 'Not Found');
    return repo;
  }

  /** All repos, creation order. */
  listRepos(): Repo[] {
    return [...this.reposByKey.values()];
  }

  listReposByOwner(owner: string): Repo[] {
    return this.listRepos().filter((repo) => repo.owner === owner);
  }

  updateRepo(
    owner: string,
    name: string,
    patch: { description?: string; private?: boolean; defaultBranch?: string },
  ): Repo {
    const repo = this.requireRepo(owner, name);
    if (patch.description !== undefined) repo.description = patch.description;
    if (patch.private !== undefined) repo.private = patch.private;
    if (patch.defaultBranch !== undefined) repo.defaultBranch = patch.defaultBranch;
    repo.updatedAt = this.nowIso();
    return repo;
  }

  /** No-op when absent. */
  deleteRepo(owner: string, name: string): void {
    this.reposByKey.delete(`${owner}/${name}`);
  }

  // ---------------------------------------------------------------------------
  // objects (the git object store inside a repo)
  // ---------------------------------------------------------------------------

  /** (oid) => repo.objects.get(oid); pass to lib/git.ts helpers. */
  objectLookup(repo: Repo): ObjectLookup {
    return (oid: string) => repo.objects.get(oid);
  }

  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Stores the object, returns its SHA-1 id. Idempotent: storing the same
   * bytes twice is a no-op. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Stores many at once (a received pack). Returns the ids, in input order. */
  putObjects(repo: Repo, objects: Iterable<GitObject>): string[] {
    const ids: string[] = [];
    for (const object of objects) ids.push(this.putObject(repo, object.type, object.data));
    return ids;
  }

  // ---------------------------------------------------------------------------
  // refs, branches, commits
  // ---------------------------------------------------------------------------

  /** Tip of refs/heads/<branch>. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Tip of the default branch; undefined when unborn. */
  defaultTip(repo: Repo): string | undefined {
    return this.branchTip(repo, repo.defaultBranch);
  }

  /** A branch name, a full ref ("refs/heads/main", "refs/tags/v1"), or a
   * 40-hex commit id. Peels annotated tags to their commit. Undefined when
   * it does not resolve (answer 404). */
  resolveRefToCommit(repo: Repo, ref: string): string | undefined {
    const lookup = this.objectLookup(repo);
    if (isObjectId(ref)) return peelToCommit(lookup, ref) ?? undefined;
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      if (oid === undefined) return undefined;
      return peelToCommit(lookup, oid) ?? undefined;
    }
    const headOid = repo.refs.get(`refs/heads/${ref}`);
    if (headOid !== undefined) return peelToCommit(lookup, headOid) ?? undefined;
    const tagOid = repo.refs.get(`refs/tags/${ref}`);
    if (tagOid !== undefined) return peelToCommit(lookup, tagOid) ?? undefined;
    return undefined;
  }

  /** [refname, oid] pairs, sorted by refname. */
  listRefs(repo: Repo): Array<readonly [string, string]> {
    return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  /** Branches only (refs/heads/*), sorted by name. */
  listBranches(repo: Repo): Array<{ name: string; commit: { sha: string } }> {
    const out: Array<{ name: string; commit: { sha: string } }> = [];
    for (const [ref, sha] of this.listRefs(repo)) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
    }
    return out;
  }

  /** 422 when the ref already exists, the object is missing, or a branch ref
   * does not point at a commit. */
  createRef(repo: Repo, ref: string, sha: string): { ref: string; object: { sha: string } } {
    if (repo.refs.has(ref)) throw new StoreError(422, 'Reference already exists');
    const object = repo.objects.get(sha);
    if (object === undefined) throw new StoreError(422, 'Object not found');
    if (ref.startsWith('refs/heads/') && object.type !== 'commit') {
      throw new StoreError(422, 'Reference must point to a commit');
    }
    repo.refs.set(ref, sha);
    repo.updatedAt = this.nowIso();
    return { ref, object: { sha } };
  }

  /** Accepts "heads/main" or "refs/heads/main". Null when absent. */
  getRef(repo: Repo, ref: string): { ref: string; object: { sha: string } } | null {
    const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
    const sha = repo.refs.get(full);
    if (sha === undefined) return null;
    return { ref: full, object: { sha } };
  }

  /** Builds the commit object (author/committer default to SERVER_IDENTITY
   * with nowEpochSec()) and stores it; returns its oid. Does NOT move any
   * ref. The message gains one trailing newline in the object bytes, the
   * way git writes it; listCommits strips it back when presenting. */
  createCommit(
    repo: Repo,
    fields: {
      tree: string;
      parents?: readonly string[];
      message: string;
      author?: string;
      committer?: string;
    },
  ): string {
    const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
    const data = buildCommit({
      tree: fields.tree,
      parents: fields.parents ?? [],
      message,
      author: fields.author ?? SERVER_IDENTITY,
      committer: fields.committer,
      timestamp: this.nowEpochSec(),
    });
    return this.putObject(repo, 'commit', data);
  }

  /** Commits reachable from `branch` (branch name, full ref or commit id;
   * default: default branch), newest first (parents after children). []
   * for an unborn repo. Each commit message is presented with one trailing
   * newline stripped — the object bytes keep the newline createCommit adds,
   * the REST view echoes the message as submitted. */
  listCommits(
    repo: Repo,
    branch?: string,
  ): Array<{
    sha: string;
    commit: { message: string; author: string; committer: string; tree: string; parents: string[] };
  }> {
    const tip = branch === undefined ? this.defaultTip(repo) : this.resolveRefToCommit(repo, branch);
    if (tip === undefined) return [];
    const lookup = this.objectLookup(repo);
    const out: Array<{
      sha: string;
      commit: { message: string; author: string; committer: string; tree: string; parents: string[] };
    }> = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    let head = 0;
    while (head < queue.length) {
      const oid = queue[head]!;
      head += 1;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      let view: CommitView;
      try {
        view = parseCommit(object.data);
      } catch {
        continue; // a malformed pushed commit is skipped, never a 500
      }
      const message = view.message.endsWith('\n') ? view.message.slice(0, -1) : view.message;
      out.push({
        sha: oid,
        commit: {
          message,
          author: view.author,
          committer: view.committer,
          tree: view.tree,
          parents: [...view.parents],
        },
      });
      for (const parent of view.parents) queue.push(parent);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // trees and content (the REST contents surface)
  // ---------------------------------------------------------------------------

  /** path -> { mode, blob oid } for every file in the tree (recursive;
   * gitlinks skipped). */
  flattenTree(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const lookup = this.objectLookup(repo);
    const walk = (oid: string, prefix: string): void => {
      const object = lookup(oid);
      if (object === undefined || object.type !== 'tree') return;
      let entries: TreeEntry[];
      try {
        entries = parseTree(object.data);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.mode === '160000') continue; // gitlink: the submodule's objects are not ours
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Builds (and stores) the tree for path -> blob-oid; returns the tree oid.
   * Intermediate directory trees are created as needed. The flat map must
   * hold no file/directory conflict (putContent resolves those before
   * calling); a leaf file at a segment shadows any subtree below it. */
  buildTreeFromMap(repo: Repo, files: ReadonlyMap<string, string>): string {
    interface Node {
      blob?: string;
      dir?: Map<string, Node>;
    }
    const root: Map<string, Node> = new Map();
    for (const path of [...files.keys()].sort()) {
      const oid = files.get(path)!;
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i]!;
        let child = node.get(part);
        if (child === undefined) {
          child = {};
          node.set(part, child);
        }
        if (i === parts.length - 1) {
          child.blob = oid;
          child.dir = undefined;
        } else {
          if (child.dir === undefined) {
            child.dir = new Map();
            child.blob = undefined;
          }
          node = child.dir;
        }
      }
    }
    const build = (node: Map<string, Node>): string => {
      const entries: TreeEntry[] = [];
      for (const [name, child] of node) {
        if (child.dir !== undefined) entries.push({ mode: '40000', name, oid: build(child.dir) });
        else if (child.blob !== undefined) entries.push({ mode: '100644', name, oid: child.blob });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The tree oid of a commit, or EMPTY_TREE_OID when the commit is undefined
   * (unborn repo). */
  treeAtCommit(repo: Repo, commitOid: string | undefined): string {
    if (commitOid === undefined) return EMPTY_TREE_OID;
    const object = this.getObject(repo, commitOid);
    if (object === undefined || object.type !== 'commit') return EMPTY_TREE_OID;
    try {
      return parseCommit(object.data).tree;
    } catch {
      return EMPTY_TREE_OID;
    }
  }

  /** A path is bad when it is empty, absolute, ends in a slash, or holds an
   * empty, "." or ".." segment. */
  private isBadPath(path: string): boolean {
    if (path === '' || path.startsWith('/') || path.endsWith('/')) return true;
    return path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
  }

  /** The immediate children of one tree, in the tree's stored (git) order. */
  private listTreeEntries(
    repo: Repo,
    treeOid: string,
    prefix: string,
  ): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir' }> {
    const object = this.getObject(repo, treeOid);
    if (object === undefined || object.type !== 'tree') return [];
    let entries: TreeEntry[];
    try {
      entries = parseTree(object.data);
    } catch {
      return [];
    }
    const out: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir' }> = [];
    for (const entry of entries) {
      if (entry.mode === '160000') continue;
      const isDir = entry.mode === '40000' || entry.mode === '040000';
      out.push({
        name: entry.name,
        path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
        sha: entry.oid,
        type: isDir ? 'dir' : 'file',
      });
    }
    return out;
  }

  /** Creates blob + tree + commit and advances refs/heads/<branch> (default:
   * default branch). Works on an unborn repo. `created` is true on create,
   * false on update — REST maps it to 201 / 200. Rules: `sha` given but not
   * matching the current file -> 409; file exists and no `sha` given -> 422;
   * branch missing while the repo has refs -> 422; bad path -> 422. */
  putContent(
    repo: Repo,
    input: { path: string; message: string; contentBase64: string; sha?: string; branch?: string },
  ): { created: boolean; content: { sha: string; encoding: 'base64' }; commit: { sha: string } } {
    if (this.isBadPath(input.path)) throw new StoreError(422, 'Invalid path');
    const branch = input.branch ?? repo.defaultBranch;
    const tip = this.branchTip(repo, branch);
    if (tip === undefined && repo.refs.size > 0) {
      throw new StoreError(422, 'Branch does not exist');
    }
    const files = this.flattenTree(repo, this.treeAtCommit(repo, tip));
    const existing = files.get(input.path);
    if (input.sha !== undefined) {
      if (existing === undefined || existing.oid !== input.sha) {
        throw new StoreError(409, 'sha does not match the current file');
      }
    } else if (existing !== undefined) {
      throw new StoreError(422, 'File already exists');
    }
    const blobOid = this.putObject(repo, 'blob', Buffer.from(input.contentBase64, 'base64'));
    // The new path wins over anything it collides with: a file at this path
    // drops deeper paths below it, and a deeper path under a file at a
    // prefix of this path drops that file.
    for (const key of [...files.keys()]) {
      if (key === input.path || key.startsWith(`${input.path}/`) || input.path.startsWith(`${key}/`)) {
        files.delete(key);
      }
    }
    files.set(input.path, { mode: '100644', oid: blobOid });
    const oidMap = new Map<string, string>();
    for (const [path, entry] of files) oidMap.set(path, entry.oid);
    const treeOid = this.buildTreeFromMap(repo, oidMap);
    const commitOid = this.createCommit(repo, {
      tree: treeOid,
      parents: tip === undefined ? [] : [tip],
      message: input.message,
    });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = this.nowIso();
    return {
      created: existing === undefined,
      content: { sha: blobOid, encoding: 'base64' },
      commit: { sha: commitOid },
    };
  }

  /** `ref` is a branch name, full ref or commit id (default: default branch).
   * `path: ''` lists the root directory. Returns null when the ref or the
   * path does not exist. */
  getContent(
    repo: Repo,
    path: string,
    ref?: string,
  ):
    | { kind: 'file'; sha: string; content: Buffer; size: number }
    | { kind: 'dir'; entries: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir' }> }
    | null {
    const commitOid = ref === undefined ? this.defaultTip(repo) : this.resolveRefToCommit(repo, ref);
    if (commitOid === undefined) return null;
    const treeOid = this.treeAtCommit(repo, commitOid);
    if (path === '') return { kind: 'dir', entries: this.listTreeEntries(repo, treeOid, '') };
    const parts = path.split('/');
    let currentTree = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      const object = this.getObject(repo, currentTree);
      if (object === undefined || object.type !== 'tree') return null;
      let entries: TreeEntry[];
      try {
        entries = parseTree(object.data);
      } catch {
        return null;
      }
      const entry = entries.find((candidate) => candidate.name === part);
      if (entry === undefined || entry.mode === '160000') return null;
      const isLast = i === parts.length - 1;
      const isDir = entry.mode === '40000' || entry.mode === '040000';
      if (isLast) {
        if (isDir) return { kind: 'dir', entries: this.listTreeEntries(repo, entry.oid, path) };
        const blob = this.getObject(repo, entry.oid);
        if (blob === undefined || blob.type !== 'blob') return null;
        return { kind: 'file', sha: entry.oid, content: blob.data, size: blob.data.length };
      }
      if (!isDir) return null;
      currentTree = entry.oid;
    }
    return null;
  }

  /** Removes the file on the default branch and commits. 404 when the file
   * is missing, 409 when `sha` is given and stale. */
  deleteContent(
    repo: Repo,
    input: { path: string; message: string; sha?: string },
  ): { commit: { sha: string } } {
    const tip = this.defaultTip(repo);
    if (tip === undefined) throw new StoreError(404, 'Not Found');
    const files = this.flattenTree(repo, this.treeAtCommit(repo, tip));
    const existing = files.get(input.path);
    if (existing === undefined) throw new StoreError(404, 'Not Found');
    if (input.sha !== undefined && input.sha !== existing.oid) {
      throw new StoreError(409, 'sha does not match the current file');
    }
    files.delete(input.path);
    const oidMap = new Map<string, string>();
    for (const [path, entry] of files) oidMap.set(path, entry.oid);
    const treeOid = this.buildTreeFromMap(repo, oidMap);
    const commitOid = this.createCommit(repo, {
      tree: treeOid,
      parents: [tip],
      message: input.message,
    });
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitOid);
    repo.updatedAt = this.nowIso();
    return { commit: { sha: commitOid } };
  }

  // ---------------------------------------------------------------------------
  // labels
  // ---------------------------------------------------------------------------

  /** 422 on a duplicate name. Defaults: color '000000', description ''. */
  createLabel(repo: Repo, input: { name: string; color?: string; description?: string }): Label {
    if (repo.labels.has(input.name)) throw new StoreError(422, 'Label already exists');
    const label: Label = {
      name: input.name,
      color: input.color ?? '000000',
      description: input.description ?? '',
    };
    repo.labels.set(label.name, label);
    return label;
  }

  listLabels(repo: Repo): Label[] {
    return [...repo.labels.values()];
  }

  getLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.get(name);
  }

  // ---------------------------------------------------------------------------
  // issues and comments
  // ---------------------------------------------------------------------------

  /** Numbers increment per repo from 1. 422 when the title is empty or a
   * named label does not exist. Labels are copies of the repo's labels at
   * creation time. */
  createIssue(
    repo: Repo,
    input: { title: string; body?: string; labels?: readonly string[] },
  ): Issue {
    if (input.title.trim() === '') throw new StoreError(422, 'Title is required');
    const labels: Label[] = [];
    for (const name of input.labels ?? []) {
      const label = repo.labels.get(name);
      if (label === undefined) throw new StoreError(422, `Label does not exist: ${name}`);
      labels.push({ ...label });
    }
    const number = repo.issueSeq + 1;
    repo.issueSeq = number;
    const stamp = this.nowIso();
    const issue: Issue = {
      number,
      id: `I_${repo.owner}_${repo.name}_${number}`,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      createdSeq: this.nextCreatedSeq,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.nextCreatedSeq += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  requireIssue(repo: Repo, number: number): Issue {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) throw new StoreError(404, 'Not Found');
    return issue;
  }

  listIssues(repo: Repo, state: 'open' | 'closed' | 'all' = 'all'): Issue[] {
    if (state === 'all') return [...repo.issues];
    return repo.issues.filter((issue) => issue.state === state);
  }

  setIssueState(repo: Repo, number: number, state: 'open' | 'closed'): Issue {
    const issue = this.requireIssue(repo, number);
    issue.state = state;
    issue.updatedAt = this.nowIso();
    return issue;
  }

  /** setIssueState(..., 'closed'); persists. */
  closeIssue(repo: Repo, number: number): Issue {
    return this.setIssueState(repo, number, 'closed');
  }

  /** Comment ids increment per repo from 1. 404 when the issue does not exist. */
  addComment(repo: Repo, issueNumber: number, body: string): Comment {
    this.requireIssue(repo, issueNumber);
    const comment: Comment = { id: repo.commentSeq, body, createdAt: this.nowIso() };
    repo.commentSeq += 1;
    const list = repo.comments.get(issueNumber);
    if (list === undefined) repo.comments.set(issueNumber, [comment]);
    else list.push(comment);
    return comment;
  }

  /** Creation order; [] for unknown issues. */
  listComments(repo: Repo, issueNumber: number): Comment[] {
    return [...(repo.comments.get(issueNumber) ?? [])];
  }

  // ---------------------------------------------------------------------------
  // pull requests
  // ---------------------------------------------------------------------------

  /** head/base are branch names, resolved to their current tip shas. 422
   * when the title is empty or a branch does not exist. `files` is computed
   * at creation (see computePullFiles). */
  createPull(
    repo: Repo,
    input: { title: string; body?: string; head: string; base: string },
  ): Pull {
    if (input.title.trim() === '') throw new StoreError(422, 'Title is required');
    const headSha = this.branchTip(repo, input.head);
    const baseSha = this.branchTip(repo, input.base);
    if (headSha === undefined || baseSha === undefined) {
      throw new StoreError(422, 'Branch does not exist');
    }
    const number = repo.prSeq + 1;
    repo.prSeq = number;
    const stamp = this.nowIso();
    const pr: Pull = {
      number,
      id: `PR_${repo.owner}_${repo.name}_${number}`,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ref: input.head, sha: headSha },
      base: { ref: input.base, sha: baseSha },
      files: this.computePullFiles(repo, headSha, baseSha),
      createdSeq: this.nextCreatedSeq,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.nextCreatedSeq += 1;
    repo.pulls.push(pr);
    return pr;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  requirePull(repo: Repo, number: number): Pull {
    const pull = this.getPull(repo, number);
    if (pull === undefined) throw new StoreError(404, 'Not Found');
    return pull;
  }

  listPulls(repo: Repo, state: 'open' | 'closed' | 'all' = 'open'): Pull[] {
    if (state === 'all') return [...repo.pulls];
    return repo.pulls.filter((pull) => pull.state === state);
  }

  /** Diff of the merge-base tree vs the head tree. Line counts by common
   * prefix/suffix trim (see diffLineCounts). A file present only in head is
   * 'added' (additions = its line count), only in base is 'removed', in
   * both with a different blob is 'modified'. */
  computePullFiles(repo: Repo, headSha: string, baseSha: string): PullFile[] {
    const lookup = this.objectLookup(repo);
    const baseCommit = mergeBase(lookup, headSha, baseSha);
    const baseFiles = this.flattenTree(repo, this.treeAtCommit(repo, baseCommit ?? undefined));
    const headFiles = this.flattenTree(repo, this.treeAtCommit(repo, headSha));
    const out: PullFile[] = [];
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      if (inBase === undefined && inHead !== undefined) {
        const blob = this.getObject(repo, inHead.oid);
        const additions = countLines(blob?.data);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (inBase !== undefined && inHead === undefined) {
        const blob = this.getObject(repo, inBase.oid);
        const deletions = countLines(blob?.data);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (inBase !== undefined && inHead !== undefined && inBase.oid !== inHead.oid) {
        const oldBlob = this.getObject(repo, inBase.oid);
        const newBlob = this.getObject(repo, inHead.oid);
        const { additions, deletions } = diffLineCounts(
          oldBlob?.data ?? new Uint8Array(0),
          newBlob?.data ?? new Uint8Array(0),
        );
        out.push({
          filename: path,
          status: 'modified',
          additions,
          deletions,
          changes: additions + deletions,
        });
      }
    }
    return out;
  }

  /** Three-way merge of the PR head onto the current base tip, with the
   * merge-base as ancestor. Conflict when both sides changed the same path
   * to different contents (or one side deleted a path the other modified),
   * or when there is no merge-base (unrelated histories). */
  computeSquashTree(repo: Repo, pr: Pull): { conflict: true } | { conflict: false; tree: string } {
    const lookup = this.objectLookup(repo);
    const headSha = pr.head.sha;
    const baseTip = this.branchTip(repo, pr.base.ref) ?? pr.base.sha;
    if (baseTip === undefined) return { conflict: true };
    const ancestor = mergeBase(lookup, headSha, baseTip);
    if (ancestor === null) return { conflict: true };
    const ancestorFiles = this.flattenTree(repo, this.treeAtCommit(repo, ancestor));
    const headFiles = this.flattenTree(repo, this.treeAtCommit(repo, headSha));
    const baseFiles = this.flattenTree(repo, this.treeAtCommit(repo, baseTip));
    const merged = new Map<string, string>();
    const paths = new Set<string>([
      ...ancestorFiles.keys(),
      ...headFiles.keys(),
      ...baseFiles.keys(),
    ]);
    for (const path of paths) {
      const a = ancestorFiles.get(path)?.oid;
      const h = headFiles.get(path)?.oid;
      const b = baseFiles.get(path)?.oid;
      if (h === a) {
        // Head unchanged: the base version stands (absent when base deleted it).
        if (b !== undefined) merged.set(path, b);
      } else if (b === a) {
        // Base unchanged: the head version stands (absent when head deleted it).
        if (h !== undefined) merged.set(path, h);
      } else if (h === b) {
        // Both sides made the same change.
        if (h !== undefined) merged.set(path, h);
      } else {
        return { conflict: true };
      }
    }
    return { conflict: false, tree: this.buildTreeFromMap(repo, merged) };
  }

  /** 'MERGEABLE' when the three-way squash tree builds without conflict,
   * 'CONFLICTING' otherwise. */
  prMergeable(repo: Repo, pr: Pull): 'MERGEABLE' | 'CONFLICTING' {
    return this.computeSquashTree(repo, pr).conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Recomputes pr.files from the current head/base tips (the head branch
   * may have advanced) and refreshes pr.head.sha; returns the same Pull
   * object. */
  refreshPullFiles(repo: Repo, pr: Pull): Pull {
    const headTip = this.branchTip(repo, pr.head.ref);
    const baseTip = this.branchTip(repo, pr.base.ref);
    if (headTip !== undefined) pr.head.sha = headTip;
    pr.files = this.computePullFiles(repo, pr.head.sha, baseTip ?? pr.base.sha);
    return pr;
  }

  /** Creates the squash commit on the base branch (parent = base tip,
   * message "<title> (#<n>)", tree = computeSquashTree), advances the base
   * ref, and sets merged = true, state = 'closed', mergedAt = nowIso(),
   * mergeCommitSha = the squash commit sha. Returns the squash commit.
   * Throws 404 (unknown PR), 405 "Pull request is not open" (already
   * merged/closed), 405 "Merge conflict". */
  mergePullSquash(repo: Repo, prNumber: number): { merged: true; sha: string; message: string } {
    const pr = this.requirePull(repo, prNumber);
    if (pr.state !== 'open') throw new StoreError(405, 'Pull request is not open');
    const squash = this.computeSquashTree(repo, pr);
    if (squash.conflict) throw new StoreError(405, 'Merge conflict');
    const baseTip = this.branchTip(repo, pr.base.ref);
    if (baseTip === undefined) throw new StoreError(405, 'Merge conflict');
    const message = `${pr.title} (#${pr.number})`;
    const sha = this.createCommit(repo, {
      tree: squash.tree,
      parents: [baseTip],
      message,
    });
    repo.refs.set(`refs/heads/${pr.base.ref}`, sha);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = this.nowIso();
    pr.mergeCommitSha = sha;
    pr.updatedAt = this.nowIso();
    repo.updatedAt = this.nowIso();
    return { merged: true, sha, message };
  }

  // ---------------------------------------------------------------------------
  // cross-surface lookups (GraphQL `node(id:)` and MCP share these)
  // ---------------------------------------------------------------------------

  /** id = I_<owner>_<repo>_<number>. Matched against the ids the store
   * itself issued, so owner/repo names holding underscores parse exactly. */
  findIssueById(id: string): { repo: Repo; issue: Issue } | null {
    for (const repo of this.listRepos()) {
      for (const issue of repo.issues) {
        if (issue.id === id) return { repo, issue };
      }
    }
    return null;
  }

  /** id = PR_<owner>_<repo>_<number>. */
  findPullById(id: string): { repo: Repo; pull: Pull } | null {
    for (const repo of this.listRepos()) {
      for (const pull of repo.pulls) {
        if (pull.id === id) return { repo, pull };
      }
    }
    return null;
  }

  /** id = R_<owner>_<repo>. */
  findRepoById(id: string): Repo | null {
    for (const repo of this.listRepos()) {
      if (this.repoId(repo) === id) return repo;
    }
    return null;
  }

  /** `R_<owner>_<repo>` — a repo's Relay id (GraphQL `node(id:)`). */
  repoId(repo: Repo): string {
    return `R_${repo.owner}_${repo.name}`;
  }

  /** Every oid reachable from all refs. Missing objects are skipped rather
   * than thrown: a ref always points at a stored object, but a state export
   * must never crash on a dangling one. */
  reachableObjects(repo: Repo): Set<string> {
    return collectReachable([...repo.refs.values()], this.objectLookup(repo), {
      allowMissing: true,
    });
  }
}
