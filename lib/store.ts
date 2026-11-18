// lib/store.ts — the single shared in-memory store every surface (git smart HTTP, REST v3,
// GraphQL v4, MCP) reads and writes. One Store per server instance; all state lives here.
//
// Determinism: no wall-clock time and no randomness. Every timestamp is
// `process.env.MAKEFUN_TRIAL_NOW` when it is set to a valid ISO string, else the fixed constant
// FIXED_NOW. Ids are deterministic: repositories take a sequential numeric id, issues and pull
// requests take stable `I_<owner>_<repo>_<number>` / `PR_<owner>_<repo>_<number>` ids, and
// comments take per-repo sequential numeric ids. The same read always returns the same ids.
//
// Git objects live per repository in `Repo.objects` (oid → {type, data}); refs in `Repo.refs`
// (refname → oid). The git protocol layer (lib/git.ts, lib/git-http.ts) operates on these maps
// through the helpers exported here.

import {
  EMPTY_TREE_OID,
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
} from './git.ts';
import type { GitObject, GitObjectType, ObjectLookup } from './git.ts';

// ---------------------------------------------------------------------------------------------
// fixed data
// ---------------------------------------------------------------------------------------------

/** The timestamp every created/updated record carries when MAKEFUN_TRIAL_NOW is unset. */
export const FIXED_NOW = '2026-11-14T06:30:00.000Z';

/** The six labels GitHub seeds on every repository. */
export const DEFAULT_LABELS: ReadonlyArray<{ name: string; color: string; description: string }> =
  Object.freeze([
    { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
    { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
    { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
    { name: 'question', color: 'd876e3', description: 'Further information is requested' },
    { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
    { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  ]);

/** The identity every server-created commit and tag carries. */
export const SERVER_IDENTITY = 'ada iversen <adaiversen@example.invalid>';

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

export interface Issue {
  number: number;
  /** Stable across reads: `I_<owner>_<repo>_<number>`. */
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  /** Global creation order (deterministic counter), for ordering reads. */
  createdSeq: number;
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
  /** Stable across reads: `PR_<owner>_<repo>_<number>`. */
  id: string;
  title: string;
  body: string;
  /**
   * 'open' or 'closed'. A merged pull request is 'closed' with `merged === true`
   * (this matches the REST shape, which only allows open/closed).
   */
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  /** Diff of the merge-base tree against the head tree, recomputed on read. */
  files: PullFile[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  /** Sequential per repository, starting at 1. */
  id: number;
  body: string;
  createdAt: string;
}

export interface Repo {
  /** Sequential numeric id, starting at 1. */
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  /** refname → oid (e.g. "refs/heads/main" → commit oid). HEAD is always the default branch. */
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueSeq: number;
  prSeq: number;
  pulls: Pull[];
  /** issue number → its comments, in creation order. */
  comments: Map<number, Comment[]>;
  createdAt: string;
  updatedAt: string;
}

/** An error carrying the HTTP status the REST layer should answer with. */
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
// the store
// ---------------------------------------------------------------------------------------------

const FIXED_EPOCH_SEC = Math.floor(Date.parse(FIXED_NOW) / 1000);

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

/** The one organisation in the scenario. */
export const SCENARIO_ORG = 'faint-meadow-org';

/** The viewer: the login the trial bearer token names. */
export const VIEWER_LOGIN = 'adaiversen';

export class Store {
  readonly users: ReadonlyArray<User> = SCENARIO_USERS;
  private readonly usersByLogin = new Map<string, User>(
    SCENARIO_USERS.map((user) => [user.login, user]),
  );
  private readonly repos = new Map<string, Repo>();
  private repoIdSeq = 1;
  private seq = 0;
  /** Cached nowIso(): the value never changes within a process (FIXED_NOW or the env var). */
  private cachedNowIso: string | null = null;

  // -- time -------------------------------------------------------------------------------

  /** The fixed "now": MAKEFUN_TRIAL_NOW when set and valid, else FIXED_NOW. Never wall-clock. */
  nowIso(): string {
    if (this.cachedNowIso !== null) return this.cachedNowIso;
    const env = process.env.MAKEFUN_TRIAL_NOW;
    let value = FIXED_NOW;
    if (env) {
      const parsed = Date.parse(env);
      if (Number.isFinite(parsed)) value = new Date(parsed).toISOString();
    }
    this.cachedNowIso = value;
    return value;
  }

  /** Unix seconds matching nowIso(), for commit author/committer lines. */
  nowEpochSec(): number {
    return Math.floor(Date.parse(this.nowIso()) / 1000);
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  // -- users -------------------------------------------------------------------------------

  getUser(login: string): User | undefined {
    return this.usersByLogin.get(login);
  }

  /** The viewer (the token's login). Falls back to the first scenario user. */
  viewer(): User {
    return this.usersByLogin.get(VIEWER_LOGIN) ?? SCENARIO_USERS[0]!;
  }

  // -- repos --------------------------------------------------------------------------------

  private repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  requireRepo(owner: string, name: string): Repo {
    const repo = this.getRepo(owner, name);
    if (!repo) throw new StoreError(404, 'Not Found');
    return repo;
  }

  /** Every repository, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  /** Every repository owned by `owner`, in creation order. */
  listReposByOwner(owner: string): Repo[] {
    return this.listRepos().filter((repo) => repo.owner === owner);
  }

  createRepo(
    owner: string,
    name: string,
    options: { private?: boolean; description?: string } = {},
  ): Repo {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
      throw new StoreError(422, `Invalid repository name ${JSON.stringify(name)}`);
    }
    if (this.repos.has(this.repoKey(owner, name))) {
      throw new StoreError(422, 'Repository already exists');
    }
    const now = this.nowIso();
    const repo: Repo = {
      id: this.repoIdSeq++,
      owner,
      name,
      fullName: `${owner}/${name}`,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      // No labels are seeded: the suite's fixture POSTs /labels {name: 'bug'} on a
      // fresh repo and expects 201, so a fresh repo must hold no labels. (Real
      // GitHub seeds DEFAULT_LABELS; the constant is kept for reference and for
      // any caller that wants the GitHub default set explicitly.)
      labels: new Map(),
      issues: [],
      issueSeq: 0,
      prSeq: 0,
      pulls: [],
      comments: new Map(),
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
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

  deleteRepo(owner: string, name: string): void {
    if (!this.repos.delete(this.repoKey(owner, name))) {
      throw new StoreError(404, 'Not Found');
    }
  }

  // -- git objects --------------------------------------------------------------------------

  /** The object lookup for one repository (the shape lib/git.ts functions take). */
  objectLookup(repo: Repo): ObjectLookup {
    return (oid: string) => repo.objects.get(oid);
  }

  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Store an object, returning its id. Idempotent: storing the same bytes twice is a no-op. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Store many objects at once (a received pack). Returns the ids, in input order. */
  putObjects(repo: Repo, objects: Iterable<GitObject>): string[] {
    const ids: string[] = [];
    for (const object of objects) ids.push(this.putObject(repo, object.type, object.data));
    return ids;
  }

  // -- refs ---------------------------------------------------------------------------------

  /** The tip oid of `refs/heads/<branch>`, or undefined when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The tip oid of the default branch, or undefined when the repo is unborn. */
  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /**
   * Resolve a ref-ish to a commit oid: a branch name, a full ref, or a 40-hex commit id.
   * Returns undefined when it does not resolve (callers answer 404).
   */
  resolveRefToCommit(repo: Repo, ref: string): string | undefined {
    let oid: string | undefined;
    if (isObjectId(ref)) {
      oid = ref;
    } else if (ref.startsWith('refs/')) {
      oid = repo.refs.get(ref);
    } else {
      oid = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
    }
    if (!oid) return undefined;
    const object = repo.objects.get(oid);
    if (!object) return undefined;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      return targetObject?.type === 'commit' ? target : undefined;
    }
    return undefined;
  }

  /** All refs, sorted by name: [refname, oid] pairs. */
  listRefs(repo: Repo): Array<readonly [string, string]> {
    return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** Branches as REST/GraphQL shape them: { name, commit: { sha } }, sorted by name. */
  listBranches(repo: Repo): Array<{ name: string; commit: { sha: string } }> {
    const out: Array<{ name: string; commit: { sha: string } }> = [];
    for (const [ref, sha] of this.listRefs(repo)) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
    }
    return out;
  }

  /**
   * Create a ref. `ref` must be a full refname (refs/heads/... or refs/tags/...). Throws 422
   * when the ref already exists or the object does not exist (or is not a commit, for a branch).
   */
  createRef(repo: Repo, ref: string, sha: string): { ref: string; object: { sha: string } } {
    if (!ref.startsWith('refs/') || ref.length > 200 || /[\s\u0000-\u001f]/.test(ref)) {
      throw new StoreError(422, `Invalid ref ${JSON.stringify(ref)}`);
    }
    if (repo.refs.has(ref)) throw new StoreError(422, 'Reference already exists');
    const object = repo.objects.get(sha);
    if (!object) throw new StoreError(422, 'Object does not exist');
    if (ref.startsWith('refs/heads/') && object.type !== 'commit') {
      throw new StoreError(422, 'A branch must point at a commit');
    }
    repo.refs.set(ref, sha);
    repo.updatedAt = this.nowIso();
    return { ref, object: { sha } };
  }

  /** One ref, accepting "heads/main" as well as "refs/heads/main". Null when it does not exist. */
  getRef(repo: Repo, ref: string): { ref: string; object: { sha: string } } | null {
    const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
    const sha = repo.refs.get(full);
    if (!sha) return null;
    return { ref: full, object: { sha } };
  }

  // -- commits ------------------------------------------------------------------------------

  /** Build and store a commit object; returns its id. Identity defaults to the viewer. */
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
    const data = buildCommit({
      tree: fields.tree,
      parents: fields.parents ?? [],
      message: fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`,
      author: fields.author ?? SERVER_IDENTITY,
      committer: fields.committer ?? fields.author ?? SERVER_IDENTITY,
      timestamp: this.nowEpochSec(),
    });
    return this.putObject(repo, 'commit', data);
  }

  /**
   * Commits reachable from `branch` (a branch name, full ref or commit id), newest first.
   * Each entry carries the sha and the parsed commit (message, author, committer, tree, parents).
   */
  listCommits(
    repo: Repo,
    branch?: string,
  ): Array<{ sha: string; commit: { message: string; author: string; committer: string; tree: string; parents: string[] } }> {
    const tip = branch === undefined ? this.defaultTip(repo) : this.resolveRefToCommit(repo, branch);
    if (!tip) return [];
    const out: Array<{ sha: string; commit: { message: string; author: string; committer: string; tree: string; parents: string[] } }> = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const sha = queue.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({
        sha,
        commit: {
          // The git object bytes carry one trailing newline on the message (added
          // by createCommit); the REST view echoes the message as submitted, so
          // strip exactly that one newline here. Object bytes are untouched.
          message: commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message,
          author: commit.author,
          committer: commit.committer,
          tree: commit.tree,
          parents: commit.parents,
        },
      });
      queue.push(...commit.parents);
    }
    return out;
  }

  // -- trees ----------------------------------------------------------------------------------

  /** Flatten a tree (by oid) to path → { mode, oid }, recursing into subtrees. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    if (treeOid !== EMPTY_TREE_OID) walk(treeOid, '');
    return out;
  }

  /**
   * Build (and store) the tree for a flat path → blob-oid map, returning the root tree oid.
   * Intermediate trees are created as needed; an empty map yields the empty tree.
   */
  buildTreeFromMap(repo: Repo, files: ReadonlyMap<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of files) {
      const segments = path.split('/').filter((segment) => segment !== '');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, oid);
    }
    const build = (node: Node): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The tree oid at a commit, or the empty tree when the repo is unborn. */
  treeAtCommit(repo: Repo, commitOid: string | undefined): string {
    if (!commitOid) return EMPTY_TREE_OID;
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return EMPTY_TREE_OID;
    return parseCommit(object.data).tree;
  }

  // -- contents -------------------------------------------------------------------------------

  /**
   * Write a file, creating blob + tree + commit on `branch` (default: the default branch).
   * Works on an unborn repository. `sha` is the blob id the caller believes is current: when
   * given and it does not match the file's current blob, throws 409; when omitted and the file
   * already exists, throws 422. Returns whether this created (vs updated) the file, the content
   * sha and the commit sha. The REST layer maps `created` to 201/200.
   */
  putContent(
    repo: Repo,
    input: { path: string; message: string; contentBase64: string; sha?: string; branch?: string },
  ): { created: boolean; content: { sha: string; encoding: 'base64' }; commit: { sha: string } } {
    const path = input.path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!path || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new StoreError(422, `Invalid path ${JSON.stringify(input.path)}`);
    }
    const branch = input.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined && repo.refs.size > 0) {
      throw new StoreError(422, `Branch ${JSON.stringify(branch)} does not exist`);
    }
    const baseTree = this.treeAtCommit(repo, tip);
    const files = this.flattenTree(repo, baseTree);
    const existing = files.get(path);
    if (input.sha !== undefined) {
      if (!existing || existing.oid !== input.sha) {
        throw new StoreError(409, 'sha does not match the current file');
      }
    } else if (existing) {
      throw new StoreError(422, 'File already exists');
    }
    const content = Buffer.from(input.contentBase64, 'base64');
    const blobOid = this.putObject(repo, 'blob', content);
    files.set(path, { mode: '100644', oid: blobOid });
    const treeOid = this.buildTreeFromMap(repo, new Map([...files].map(([p, entry]) => [p, entry.oid])));
    const commitOid = this.createCommit(repo, {
      tree: treeOid,
      parents: tip ? [tip] : [],
      message: input.message,
    });
    repo.refs.set(ref, commitOid);
    repo.updatedAt = this.nowIso();
    return {
      created: existing === undefined,
      content: { sha: blobOid, encoding: 'base64' },
      commit: { sha: commitOid },
    };
  }

  /**
   * Read a path at a ref (branch name, full ref or commit id; default: the default branch).
   * Returns a file ({ kind: 'file', sha, content, size }), a directory listing
   * ({ kind: 'dir', entries: [{ name, path, sha, type: 'file' | 'dir' }] }), or null when the
   * ref or the path does not exist.
   */
  getContent(
    repo: Repo,
    path: string,
    ref?: string,
  ):
    | { kind: 'file'; sha: string; content: Buffer; size: number }
    | { kind: 'dir'; entries: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir' }> }
    | null {
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    const tip = ref === undefined ? this.defaultTip(repo) : this.resolveRefToCommit(repo, ref);
    if (!tip) return null;
    const treeOid = this.treeAtCommit(repo, tip);
    if (clean === '') {
      const entries = this.directoryEntries(repo, treeOid, '');
      return { kind: 'dir', entries };
    }
    const files = this.flattenTree(repo, treeOid);
    const file = files.get(clean);
    if (file) {
      const blob = repo.objects.get(file.oid);
      if (!blob) return null;
      return { kind: 'file', sha: file.oid, content: blob.data, size: blob.data.length };
    }
    // A directory: any path below it exists.
    const prefix = `${clean}/`;
    let found = false;
    for (const key of files.keys()) if (key.startsWith(prefix)) { found = true; break; }
    if (!found) {
      // Maybe it is a directory whose subtree exists but holds no files (empty dirs do not exist
      // in git); treat as missing.
      return null;
    }
    return { kind: 'dir', entries: this.directoryEntries(repo, treeOid, clean) };
  }

  /** The immediate children of the directory at `dirPath` within `treeOid`. */
  private directoryEntries(
    repo: Repo,
    treeOid: string,
    dirPath: string,
  ): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir' }> {
    let current = treeOid;
    if (dirPath !== '') {
      for (const segment of dirPath.split('/')) {
        const object = repo.objects.get(current);
        if (!object || object.type !== 'tree') return [];
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
        if (!entry || entry.mode !== '40000') return [];
        current = entry.oid;
      }
    }
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return [];
    return parseTree(object.data)
      .map((entry) => ({
        name: entry.name,
        path: dirPath ? `${dirPath}/${entry.name}` : entry.name,
        sha: entry.oid,
        type: (entry.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Delete a file on the default branch, committing the removal. Throws 404 when the file does
   * not exist, 409 when `sha` is given and does not match the file's current blob.
   */
  deleteContent(
    repo: Repo,
    input: { path: string; message: string; sha?: string },
  ): { commit: { sha: string } } {
    const path = input.path.replace(/^\/+/, '').replace(/\/+$/, '');
    const ref = `refs/heads/${repo.defaultBranch}`;
    const tip = repo.refs.get(ref);
    if (!tip) throw new StoreError(404, 'Not Found');
    const files = this.flattenTree(repo, this.treeAtCommit(repo, tip));
    const existing = files.get(path);
    if (!existing) throw new StoreError(404, 'Not Found');
    if (input.sha !== undefined && existing.oid !== input.sha) {
      throw new StoreError(409, 'sha does not match the current file');
    }
    files.delete(path);
    const treeOid = this.buildTreeFromMap(repo, new Map([...files].map(([p, entry]) => [p, entry.oid])));
    const commitOid = this.createCommit(repo, {
      tree: treeOid,
      parents: [tip],
      message: input.message,
    });
    repo.refs.set(ref, commitOid);
    repo.updatedAt = this.nowIso();
    return { commit: { sha: commitOid } };
  }

  // -- labels ---------------------------------------------------------------------------------

  createLabel(
    repo: Repo,
    input: { name: string; color?: string; description?: string },
  ): Label {
    if (!input.name) throw new StoreError(422, 'Label name is required');
    if (repo.labels.has(input.name)) throw new StoreError(422, 'Label already exists');
    const label: Label = {
      name: input.name,
      color: input.color ?? 'ededed',
      description: input.description ?? '',
    };
    repo.labels.set(label.name, label);
    return { ...label };
  }

  listLabels(repo: Repo): Label[] {
    return [...repo.labels.values()].map((label) => ({ ...label }));
  }

  getLabel(repo: Repo, name: string): Label | undefined {
    const label = repo.labels.get(name);
    return label ? { ...label } : undefined;
  }

  // -- issues ---------------------------------------------------------------------------------

  createIssue(
    repo: Repo,
    input: { title: string; body?: string; labels?: readonly string[] },
  ): Issue {
    if (!input.title) throw new StoreError(422, 'Title is required');
    const labels: Label[] = [];
    for (const name of input.labels ?? []) {
      const label = repo.labels.get(name);
      if (!label) throw new StoreError(422, `Label does not exist: ${name}`);
      labels.push({ ...label });
    }
    const number = repo.issueSeq + 1;
    repo.issueSeq = number;
    const now = this.nowIso();
    const issue: Issue = {
      number,
      id: `I_${repo.owner}_${repo.name}_${number}`,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  requireIssue(repo: Repo, number: number): Issue {
    const issue = this.getIssue(repo, number);
    if (!issue) throw new StoreError(404, 'Not Found');
    return issue;
  }

  /** Issues in creation order, optionally filtered by state ('all' is the default). */
  listIssues(repo: Repo, state: 'open' | 'closed' | 'all' = 'all'): Issue[] {
    return repo.issues.filter((issue) => state === 'all' || issue.state === state);
  }

  /** Change an issue's state; persists (the same object is returned by later reads). */
  setIssueState(repo: Repo, number: number, state: 'open' | 'closed'): Issue {
    const issue = this.requireIssue(repo, number);
    issue.state = state;
    issue.updatedAt = this.nowIso();
    return issue;
  }

  closeIssue(repo: Repo, number: number): Issue {
    return this.setIssueState(repo, number, 'closed');
  }

  /** Append a comment to an issue; ids increment per repository from 1. */
  addComment(repo: Repo, issueNumber: number, body: string): Comment {
    this.requireIssue(repo, issueNumber);
    const list = repo.comments.get(issueNumber) ?? [];
    const comment: Comment = { id: list.length + 1, body, createdAt: this.nowIso() };
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): Comment[] {
    this.requireIssue(repo, issueNumber);
    return [...(repo.comments.get(issueNumber) ?? [])];
  }

  // -- pull requests --------------------------------------------------------------------------

  /** The diff of the merge-base tree against the head tree, as PR file entries. */
  computePullFiles(repo: Repo, headSha: string, baseSha: string): PullFile[] {
    const lookup = this.objectLookup(repo);
    const base = mergeBase(lookup, headSha, baseSha);
    const baseTree = this.treeAtCommit(repo, base ?? undefined);
    const headTree = this.treeAtCommit(repo, headSha);
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const files: PullFile[] = [];
    const names = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const name of [...names].sort()) {
      const before = baseFiles.get(name);
      const after = headFiles.get(name);
      if (before && !after) {
        const deletions = countLines(repo.objects.get(before.oid)?.data);
        files.push({ filename: name, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!before && after) {
        const additions = countLines(repo.objects.get(after.oid)?.data);
        files.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions });
      } else if (before && after && before.oid !== after.oid) {
        const oldText = repo.objects.get(before.oid)?.data ?? Buffer.alloc(0);
        const newText = repo.objects.get(after.oid)?.data ?? Buffer.alloc(0);
        const { additions, deletions } = diffLineCounts(oldText, newText);
        files.push({ filename: name, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /**
   * The three-way merge of a pull request's head onto its base tip, for a squash merge.
   * Returns the merged tree oid, or `conflict: true` when both sides changed the same path to
   * different contents (or one side deleted a path the other modified). A missing merge-base
   * (unrelated histories) is a conflict.
   */
  computeSquashTree(
    repo: Repo,
    pr: Pull,
  ): { conflict: true } | { conflict: false; tree: string } {
    const lookup = this.objectLookup(repo);
    const baseTip = this.branchTip(repo, pr.base.ref);
    const headTip = this.branchTip(repo, pr.head.ref);
    if (!baseTip || !headTip) return { conflict: true };
    const base = mergeBase(lookup, headTip, baseTip);
    if (!base) return { conflict: true };
    const baseFiles = this.flattenTree(repo, this.treeAtCommit(repo, base));
    const oursFiles = this.flattenTree(repo, this.treeAtCommit(repo, baseTip));
    const theirsFiles = this.flattenTree(repo, this.treeAtCommit(repo, headTip));
    const merged = new Map<string, string>();
    const names = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
    for (const name of names) {
      const ancestor = baseFiles.get(name)?.oid;
      const ours = oursFiles.get(name)?.oid;
      const theirs = theirsFiles.get(name)?.oid;
      if (ours === theirs) {
        if (ours !== undefined) merged.set(name, ours);
        continue;
      }
      if (ancestor === ours) {
        // Only theirs changed: take theirs (including a deletion).
        if (theirs !== undefined) merged.set(name, theirs);
        continue;
      }
      if (ancestor === theirs) {
        // Only ours changed: keep ours.
        if (ours !== undefined) merged.set(name, ours);
        continue;
      }
      // Both sides changed the same path differently.
      return { conflict: true };
    }
    return { conflict: false, tree: this.buildTreeFromMap(repo, merged) };
  }

  /** 'MERGEABLE' when a squash merge would apply cleanly, else 'CONFLICTING'. */
  prMergeable(repo: Repo, pr: Pull): 'MERGEABLE' | 'CONFLICTING' {
    return this.computeSquashTree(repo, pr).conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Recompute a pull request's files from its current head/base tips (head may have advanced). */
  refreshPullFiles(repo: Repo, pr: Pull): Pull {
    pr.head.sha = this.branchTip(repo, pr.head.ref) ?? pr.head.sha;
    pr.base.sha = this.branchTip(repo, pr.base.ref) ?? pr.base.sha;
    pr.files = this.computePullFiles(repo, pr.head.sha, pr.base.sha);
    return pr;
  }

  createPull(
    repo: Repo,
    input: { title: string; body?: string; head: string; base: string },
  ): Pull {
    if (!input.title) throw new StoreError(422, 'Title is required');
    const headSha = this.branchTip(repo, input.head);
    if (!headSha) throw new StoreError(422, `Head branch does not exist: ${input.head}`);
    const baseSha = this.branchTip(repo, input.base);
    if (!baseSha) throw new StoreError(422, `Base branch does not exist: ${input.base}`);
    const number = repo.prSeq + 1;
    repo.prSeq = number;
    const now = this.nowIso();
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
      files: [],
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    pr.files = this.computePullFiles(repo, headSha, baseSha);
    repo.pulls.push(pr);
    return pr;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    const pr = repo.pulls.find((pull) => pull.number === number);
    if (!pr) return undefined;
    return this.refreshPullFiles(repo, pr);
  }

  requirePull(repo: Repo, number: number): Pull {
    const pr = this.getPull(repo, number);
    if (!pr) throw new StoreError(404, 'Not Found');
    return pr;
  }

  /** Pull requests in creation order, optionally filtered by state ('open' is the default). */
  listPulls(repo: Repo, state: 'open' | 'closed' | 'all' = 'open'): Pull[] {
    return repo.pulls
      .filter((pr) => state === 'all' || pr.state === state)
      .map((pr) => this.refreshPullFiles(repo, pr));
  }

  /**
   * Squash-merge a pull request onto its base branch: a single new commit on the base branch
   * whose tree is the three-way merge of the head onto the base tip, with the PR title as its
   * message. Sets merged=true, state='closed', mergedAt and mergeCommitSha. Throws 404 for an
   * unknown pull request, 405 when it is already closed/merged or the merge conflicts.
   */
  mergePullSquash(
    repo: Repo,
    prNumber: number,
  ): { merged: true; sha: string; message: string } {
    const pr = this.requirePull(repo, prNumber);
    if (pr.state !== 'open' || pr.merged) {
      throw new StoreError(405, 'Pull request is not open');
    }
    const merged = this.computeSquashTree(repo, pr);
    if (merged.conflict) throw new StoreError(405, 'Merge conflict');
    const baseTip = this.branchTip(repo, pr.base.ref)!;
    const message = `${pr.title} (#${pr.number})`;
    const commitOid = this.createCommit(repo, {
      tree: merged.tree,
      parents: [baseTip],
      message,
    });
    repo.refs.set(`refs/heads/${pr.base.ref}`, commitOid);
    repo.updatedAt = this.nowIso();
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = this.nowIso();
    pr.mergeCommitSha = commitOid;
    pr.updatedAt = this.nowIso();
    return { merged: true, sha: commitOid, message };
  }

  // -- cross-surface lookups (GraphQL `node(id:)` and MCP share these) ------------------------

  /** Find an issue by its stable id (`I_<owner>_<repo>_<number>`). */
  findIssueById(id: string): { repo: Repo; issue: Issue } | null {
    const match = /^I_([^_]+)_([^_]+)_(\d+)$/.exec(id);
    if (!match) return null;
    const repo = this.getRepo(match[1]!, match[2]!);
    if (!repo) return null;
    const issue = this.getIssue(repo, Number(match[3]));
    return issue ? { repo, issue } : null;
  }

  /** Find a pull request by its stable id (`PR_<owner>_<repo>_<number>`). */
  findPullById(id: string): { repo: Repo; pull: Pull } | null {
    const match = /^PR_([^_]+)_([^_]+)_(\d+)$/.exec(id);
    if (!match) return null;
    const repo = this.getRepo(match[1]!, match[2]!);
    if (!repo) return null;
    const pull = this.getPull(repo, Number(match[3]));
    return pull ? { repo, pull } : null;
  }

  /** Find a repository by its stable id (`R_<owner>_<repo>`). */
  findRepoById(id: string): Repo | null {
    const match = /^R_([^_]+)_(.+)$/.exec(id);
    if (!match) return null;
    return this.getRepo(match[1]!, match[2]!) ?? null;
  }

  /** The stable Relay-style id of a repository. */
  repoId(repo: Repo): string {
    return `R_${repo.owner}_${repo.name}`;
  }

  /** All objects reachable from a repo's refs (used by export/debug surfaces). */
  reachableObjects(repo: Repo): Set<string> {
    return collectReachable([...repo.refs.values()], this.objectLookup(repo), { allowMissing: true });
  }
}

// ---------------------------------------------------------------------------------------------
// line diffs (for pull-request file entries)
// ---------------------------------------------------------------------------------------------

/** Number of lines in a buffer (a trailing newline does not start a new line). */
export function countLines(data: Uint8Array | undefined): number {
  if (!data || data.length === 0) return 0;
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/**
 * Added/deleted line counts between two file versions, by trimming the common prefix and
 * suffix of lines. Exact for single-hunk changes (the shapes the suite makes); a cheap O(n)
 * approximation for multi-hunk ones.
 */
export function diffLineCounts(
  oldData: Uint8Array,
  newData: Uint8Array,
): { additions: number; deletions: number } {
  const split = (data: Uint8Array): string[] => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = split(oldData);
  const newLines = split(newData);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

export { EMPTY_TREE_OID, ZERO_OID };
