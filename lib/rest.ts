// lib/rest.ts — the GitHub REST v3 surface (/api/v3).
//
// One handler, `handleRest`, owns every route under /api/v3: repositories,
// git data (refs, branches, commits), contents, labels, issues, pull
// requests. It answers JSON on every reply, carries a non-empty
// X-GitHub-Request-Id on every reply, and maps the store's StoreError
// statuses straight onto HTTP statuses. It never answers HTML and never
// throws out of the handler: a handler throw is a JSON 500, and a body
// that is not JSON is a JSON 400.
//
// Auth: when process.env.MAKEFUN_SHOP_TOKEN is set, every route requires
// `Authorization: Bearer <token>`; a missing or wrong token is a 401 JSON
// reply. When it is unset, all requests are allowed (local development).
// A repository belongs to the login the token names (the store's viewer):
// the same repository name under any other owner is a 404, never a 403.
//
// Determinism: nothing here reads the clock or randomness. Request ids are
// a sequential hex counter; timestamps come from the store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isStoreError,
  Store,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// request ids and small HTTP helpers
// ---------------------------------------------------------------------------

let requestCounter = 0;

/** The next deterministic request id: a sequential hex counter. */
export function nextRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(8, '0');
}

/**
 * The bearer token the suite presents, when one is configured. Read once at
 * module load: the process starts with the variable already set and it never
 * changes, so isAuthorized must not pay a process.env lookup per request.
 */
const CONFIGURED_TOKEN: string | undefined =
  process.env.MAKEFUN_SHOP_TOKEN === undefined || process.env.MAKEFUN_SHOP_TOKEN === ''
    ? undefined
    : process.env.MAKEFUN_SHOP_TOKEN;

export function configuredToken(): string | undefined {
  return CONFIGURED_TOKEN;
}

/** Whether this request carries the configured bearer token. */
export function isAuthorized(req: IncomingMessage): boolean {
  const expected = configuredToken();
  if (expected === undefined) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return header.slice(prefix.length) === expected;
}

function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders?: Readonly<Record<string, string>>,
): void {
  const body = JSON.stringify(value);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    'content-length': String(Buffer.byteLength(body, 'utf8')),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** A 204 with no body (DELETE /repos/{o}/{r}); the request id still rides along. */
function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

const MAX_BODY_BYTES = 1 << 20;

/** Read the request body as text. Rejects on overflow or a read error. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer | string) => {
      if (failed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (!failed) {
        // One chunk is the common case for the small JSON bodies the suite
        // sends: answer from it directly instead of copying through concat.
        if (chunks.length === 1) resolve(chunks[0]!.toString('utf8'));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (err: Error) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/**
 * Parse the request body as a JSON object. An empty body is `{}`; a body
 * that is not JSON, or not an object, is a 400. Returns null when the
 * reply has already been sent (the 400), so callers just return.
 */
async function readJsonObject(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readBody(req);
  } catch {
    sendError(res, 400, 'Could not read request body');
    return null;
  }
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    sendError(res, 400, 'Malformed JSON body');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendError(res, 400, 'Request body must be a JSON object');
    return null;
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// views: the JSON shapes the wire carries
// ---------------------------------------------------------------------------

/** The repository object every repo route reads back. */
export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.owner}_${repo.name}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    clone_url: `/${repo.fullName}.git`,
    has_issues: true,
    has_pull_requests: true,
  };
}

/** The issue object every issue route reads back. */
export function issueView(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => labelView(label)),
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: 0,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
  };
}

/** The pull-request object every pull route reads back. */
export function pullView(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.head.ref,
      sha: pull.head.sha,
      label: `${repo.owner}:${pull.head.ref}`,
      repo: repoView(repo),
    },
    base: {
      ref: pull.base.ref,
      sha: pull.base.sha,
      label: `${repo.owner}:${pull.base.ref}`,
      repo: repoView(repo),
    },
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

/** One pull-request file, as GET /pulls/{n}/files lists it. */
export function pullFileView(file: Pull['files'][number]): Record<string, unknown> {
  return {
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    sha: '',
    raw_url: '',
    blob_url: '',
    patch: '',
  };
}

/** The label object. */
export function labelView(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

/** The comment object. */
export function commentView(comment: Comment, repo: Repo, issueNumber: number): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${repo.owner}_${repo.name}_${issueNumber}_${comment.id}`,
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    user: { login: repo.owner, id: 1000, type: 'User' },
    html_url: `https://github.com/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const perPage = Number.isFinite(rawPerPage) && rawPerPage >= 1 ? Math.min(rawPerPage, 100) : 30;
  return { page, perPage };
}

/** Slice one page out of a list, in order. */
function paginate<T>(items: readonly T[], params: PageParams): { page: T[]; hasNext: boolean } {
  const start = (params.page - 1) * params.perPage;
  const page = items.slice(start, start + params.perPage);
  return { page, hasNext: start + params.perPage < items.length };
}

/**
 * The absolute URL of the next page, for the `Link: <url>; rel="next"`
 * header. The query is rebuilt from the request's own query so `per_page`
 * and filters survive the hop.
 */
function nextPageLink(url: URL, query: URLSearchParams, params: PageParams): string {
  const next = new URLSearchParams(query);
  next.set('page', String(params.page + 1));
  next.set('per_page', String(params.perPage));
  return `${url.origin}${url.pathname}?${next.toString()}`;
}

function linkHeader(url: URL, query: URLSearchParams, params: PageParams, hasNext: boolean): Record<string, string> {
  if (!hasNext) return {};
  return { link: `<${nextPageLink(url, query, params)}>; rel="next"` };
}

// ---------------------------------------------------------------------------
// routing helpers
// ---------------------------------------------------------------------------

/** The decoded path segments of a URL pathname, without the /api/v3 prefix. */
function routeSegments(pathname: string): string[] {
  const withoutPrefix = pathname.startsWith('/api/v3') ? pathname.slice('/api/v3'.length) : pathname;
  return withoutPrefix
    .split('/')
    .filter((piece) => piece !== '')
    .map((piece) => {
      // decodeURIComponent is the identity on a segment with no escape, so
      // skip the call (and its try/catch) for the common plain segment.
      if (!piece.includes('%')) return piece;
      try {
        return decodeURIComponent(piece);
      } catch {
        return piece;
      }
    });
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Resolve a repository for a route, enforcing ownership: a name under any
 * owner but the viewer is a 404, and a missing repository is a 404. Sends
 * the 404 itself and returns null when there is nothing to serve.
 */
function resolveRepo(
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
): Repo | null {
  if (owner !== store.viewer().login) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

// ---------------------------------------------------------------------------
// the handler
// ---------------------------------------------------------------------------

/**
 * Answer one REST request. Returns true when the path sits under /api/v3
 * (and the request has been answered, including error answers), false
 * otherwise so the caller falls through to its own 404.
 */
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<boolean> {
  const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
  if (rawPath !== '/api/v3' && !rawPath.startsWith('/api/v3/')) return false;
  try {
    await dispatch(req, res, store);
  } catch (err) {
    if (isStoreError(err)) {
      sendError(res, err.status, err.message);
      return true;
    }
    sendError(res, 500, 'Internal Server Error');
  }
  return true;
}

async function dispatch(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  // One URL parse per request: the pathname feeds routing, the query
  // feeds filters and pagination, and the origin feeds Link headers.
  const host = req.headers.host ?? '127.0.0.1';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const segments = routeSegments(url.pathname);
  const query = url.searchParams;
  const viewer = store.viewer();

  // Auth first: every /api/v3 route needs the bearer token when one is set.
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  // GET /api/v3/meta — the installed version.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }

  // GET /api/v3/user — the token owner.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'user') {
    sendJson(res, 200, {
      login: viewer.login,
      id: viewer.id,
      node_id: `U_${viewer.login}`,
      name: viewer.name,
      email: viewer.email,
      type: 'User',
      html_url: `https://github.com/${viewer.login}`,
      url: '/api/v3/user',
    });
    return;
  }

  // GET /api/v3/user/repos — the viewer's repositories, paginated.
  if (method === 'GET' && segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    const params = pageParams(query);
    const repos = store.listReposByOwner(viewer.login);
    const { page, hasNext } = paginate(repos, params);
    sendJson(res, 200, page.map((repo) => repoView(repo)), linkHeader(url, query, params, hasNext));
    return;
  }

  // POST /api/v3/user/repos — create a repository under the viewer.
  if (method === 'POST' && segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    const body = await readJsonObject(req, res);
    if (body === null) return;
    const name = stringField(body, 'name');
    if (name === undefined || name === '') {
      sendError(res, 422, 'name is required');
      return;
    }
    const repo = store.createRepo(viewer.login, name, {
      private: booleanField(body, 'private'),
      description: stringField(body, 'description'),
    });
    sendJson(res, 201, repoView(repo));
    return;
  }

  // Everything below is /api/v3/repos/{owner}/{name}[/...].
  if (segments.length < 3 || segments[0] !== 'repos') {
    sendError(res, 404, 'Not Found');
    return;
  }
  const owner = segments[1]!;
  const repoName = segments[2]!;
  const tail = segments.slice(3);

  // GET /repos/{o}/{r} — read one repository.
  if (method === 'GET' && tail.length === 0) {
    const repo = resolveRepo(res, store, owner, repoName);
    if (repo === null) return;
    sendJson(res, 200, repoView(repo));
    return;
  }

  // PATCH /repos/{o}/{r} — update description / visibility / default branch.
  if (method === 'PATCH' && tail.length === 0) {
    const repo = resolveRepo(res, store, owner, repoName);
    if (repo === null) return;
    const body = await readJsonObject(req, res);
    if (body === null) return;
    const patch: { description?: string; private?: boolean; defaultBranch?: string } = {};
    const description = stringField(body, 'description');
    if (description !== undefined) patch.description = description;
    const isPrivate = booleanField(body, 'private');
    if (isPrivate !== undefined) patch.private = isPrivate;
    const defaultBranch = stringField(body, 'default_branch');
    if (defaultBranch !== undefined) patch.defaultBranch = defaultBranch;
    const updated = store.updateRepo(owner, repoName, patch);
    sendJson(res, 200, repoView(updated));
    return;
  }

  // DELETE /repos/{o}/{r} — delete it; a later GET is 404.
  if (method === 'DELETE' && tail.length === 0) {
    const repo = resolveRepo(res, store, owner, repoName);
    if (repo === null) return;
    store.deleteRepo(owner, repoName);
    sendNoContent(res);
    return;
  }

  // GET /repos/{o}/{r}/branches — every branch, sorted by name.
  if (method === 'GET' && tail.length === 1 && tail[0] === 'branches') {
    const repo = resolveRepo(res, store, owner, repoName);
    if (repo === null) return;
    sendJson(res, 200, store.listBranches(repo));
    return;
  }

  // GET /repos/{o}/{r}/branches/{branch} — one branch, or 404.
  if (method === 'GET' && tail.length === 2 && tail[0] === 'branches') {
    const repo = resolveRepo(res, store, owner, repoName);
    if (repo === null) return;
    const branch = store.listBranches(repo).find((entry) => entry.name === tail[1]);
    if (branch === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, branch);
    return;
  }

  // GET /repos/{o}/{r}/commits[?sha=<ref>] — newest first.
  if (method === 'GET' && tail.length === 1 && tail[0] === 'commits') {
    const repo = resolveRepo(res, store, owner, repoName);
    if (repo === null) return;
    const sha = query.get('sha') ?? undefined;
    const commits = store.listCommits(repo, sha);
    sendJson(
      res,
      200,
      commits.map((entry) => ({
        sha: entry.sha,
        commit: {
          message: entry.commit.message,
          author: entry.commit.author,
          committer: entry.commit.committer,
          tree: entry.commit.tree,
          parents: entry.commit.parents,
        },
        author: { login: viewer.login },
        committer: { login: viewer.login },
      })),
    );
    return;
  }

  // POST /repos/{o}/{r}/git/refs — create a branch or tag ref.
  if (method === 'POST' && tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
    const repo = resolveRepo(res, store, owner, repoName);
    if (repo === null) return;
    const body = await readJsonObject(req, res);
    if (body === null) return;
    const ref = stringField(body, 'ref');
    const sha = stringField(body, 'sha');
    if (ref === undefined || ref === '' || sha === undefined || sha === '') {
      sendError(res, 422, 'ref and sha are required');
      return;
    }
    const created = store.createRef(repo, ref, sha);
    sendJson(res, 201, created);
    return;
  }

  // GET /repos/{o}/{r}/git/refs[/...] — one ref, or the whole ref list.
  if (method === 'GET' && tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs') {
    const repo = resolveRepo(res, store, owner, repoName);
    if (repo === null) return;
    if (tail.length === 2) {
      sendJson(
        res,
        200,
        store.listRefs(repo).map(([ref, sha]) => ({ ref, object: { sha } })),
      );
      return;
    }
    const ref = tail.slice(2).join('/');
    const found = store.getRef(repo, ref);
    if (found === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, found);
    return;
  }

  // Contents: /repos/{o}/{r}/contents[/{path...}]
  if (tail.length >= 1 && tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'PUT') {
      const repo = resolveRepo(res, store, owner, repoName);
      if (repo === null) return;
      const body = await readJsonObject(req, res);
      if (body === null) return;
      const content = stringField(body, 'content');
      if (content === undefined) {
        sendError(res, 422, 'content is required');
        return;
      }
      const result = store.putContent(repo, {
        path,
        message: stringField(body, 'message') ?? '',
        contentBase64: content,
        sha: stringField(body, 'sha'),
        branch: stringField(body, 'branch'),
      });
      sendJson(res, result.created ? 201 : 200, {
        content: result.content,
        commit: result.commit,
      });
      return;
    }
    if (method === 'GET') {
      const repo = resolveRepo(res, store, owner, repoName);
      if (repo === null) return;
      const ref = query.get('ref') ?? undefined;
      const found = store.getContent(repo, path, ref);
      if (found === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (found.kind === 'file') {
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: found.size,
          name: path.split('/').pop() ?? path,
          path,
          content: found.content.toString('base64'),
          sha: found.sha,
        });
        return;
      }
      sendJson(
        res,
        200,
        found.entries.map((entry) => ({
          type: entry.type,
          name: entry.name,
          path: entry.path,
          sha: entry.sha,
          size: 0,
        })),
      );
      return;
    }
    if (method === 'DELETE') {
      const repo = resolveRepo(res, store, owner, repoName);
      if (repo === null) return;
      const body = await readJsonObject(req, res);
      if (body === null) return;
      const result = store.deleteContent(repo, {
        path,
        message: stringField(body, 'message') ?? '',
        sha: stringField(body, 'sha'),
      });
      sendJson(res, 200, { commit: result.commit });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // GET /repos/{o}/{r}/labels — every label.
  if (method === 'GET' && tail.length === 1 && tail[0] === 'labels') {
    const repo = resolveRepo(res, store, owner, repoName);
    if (repo === null) return;
    sendJson(res, 200, store.listLabels(repo).map((label) => labelView(label)));
    return;
  }

  // POST /repos/{o}/{r}/labels — create a label (an issue may only carry
  // labels created here first).
  if (method === 'POST' && tail.length === 1 && tail[0] === 'labels') {
    const repo = resolveRepo(res, store, owner, repoName);
    if (repo === null) return;
    const body = await readJsonObject(req, res);
    if (body === null) return;
    const name = stringField(body, 'name');
    if (name === undefined || name === '') {
      sendError(res, 422, 'name is required');
      return;
    }
    const label = store.createLabel(repo, {
      name,
      color: stringField(body, 'color'),
      description: stringField(body, 'description'),
    });
    sendJson(res, 201, labelView(label));
    return;
  }

  // Issues: /repos/{o}/{r}/issues[/{n}[/comments]]
  if (tail.length >= 1 && tail[0] === 'issues') {
    const repo = resolveRepo(res, store, owner, repoName);
    if (repo === null) return;

    // GET /issues — list, filtered by state and sorted by creation.
    if (method === 'GET' && tail.length === 1) {
      const params = pageParams(query);
      const state = query.get('state') ?? 'open';
      const stateFilter: 'open' | 'closed' | 'all' =
        state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open';
      let issues = store.listIssues(repo, stateFilter);
      const direction = query.get('direction') ?? 'desc';
      const sort = query.get('sort') ?? 'created';
      if (sort === 'created') {
        issues = [...issues].sort((a, b) =>
          direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq,
        );
      }
      const { page, hasNext } = paginate(issues, params);
      sendJson(res, 200, page.map((issue) => issueView(issue, repo)), linkHeader(url, query, params, hasNext));
      return;
    }

    // POST /issues — create one.
    if (method === 'POST' && tail.length === 1) {
      const body = await readJsonObject(req, res);
      if (body === null) return;
      const title = stringField(body, 'title');
      if (title === undefined || title === '') {
        sendError(res, 422, 'title is required');
        return;
      }
      const labels = Array.isArray(body.labels)
        ? body.labels.filter((entry): entry is string => typeof entry === 'string')
        : undefined;
      const issue = store.createIssue(repo, {
        title,
        body: stringField(body, 'body'),
        labels,
      });
      sendJson(res, 201, issueView(issue, repo));
      return;
    }

    // The rest needs a numeric issue number.
    const number = Number.parseInt(tail[1] ?? '', 10);
    if (tail.length < 2 || !Number.isInteger(number) || number < 1) {
      sendError(res, 404, 'Not Found');
      return;
    }

    // GET /issues/{n} — read one.
    if (method === 'GET' && tail.length === 2) {
      const issue = store.getIssue(repo, number);
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, issueView(issue, repo));
      return;
    }

    // PATCH /issues/{n} — close / reopen / retitle.
    if (method === 'PATCH' && tail.length === 2) {
      const issue = store.requireIssue(repo, number);
      const body = await readJsonObject(req, res);
      if (body === null) return;
      const state = stringField(body, 'state');
      if (state === 'open' || state === 'closed') {
        store.setIssueState(repo, number, state);
      }
      const title = stringField(body, 'title');
      if (title !== undefined && title !== '') issue.title = title;
      const text = stringField(body, 'body');
      if (text !== undefined) issue.body = text;
      issue.updatedAt = store.nowIso();
      sendJson(res, 200, issueView(issue, repo));
      return;
    }

    // POST /issues/{n}/comments — add a comment.
    if (method === 'POST' && tail.length === 3 && tail[2] === 'comments') {
      store.requireIssue(repo, number);
      const body = await readJsonObject(req, res);
      if (body === null) return;
      const text = stringField(body, 'body');
      if (text === undefined || text === '') {
        sendError(res, 422, 'body is required');
        return;
      }
      const comment = store.addComment(repo, number, text);
      sendJson(res, 201, commentView(comment, repo, number));
      return;
    }

    // GET /issues/{n}/comments — the comment list, creation order.
    if (method === 'GET' && tail.length === 3 && tail[2] === 'comments') {
      store.requireIssue(repo, number);
      const comments = store.listComments(repo, number);
      sendJson(res, 200, comments.map((comment) => commentView(comment, repo, number)));
      return;
    }

    sendError(res, 404, 'Not Found');
    return;
  }

  // Pull requests: /repos/{o}/{r}/pulls[/{n}[/files|/merge]]
  if (tail.length >= 1 && tail[0] === 'pulls') {
    const repo = resolveRepo(res, store, owner, repoName);
    if (repo === null) return;

    // GET /pulls — list; the default state is open only.
    if (method === 'GET' && tail.length === 1) {
      const params = pageParams(query);
      const state = query.get('state') ?? 'open';
      const stateFilter: 'open' | 'closed' | 'all' =
        state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open';
      const pulls = store.listPulls(repo, stateFilter);
      const ordered = [...pulls].sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, hasNext } = paginate(ordered, params);
      sendJson(res, 200, page.map((pull) => pullView(store.refreshPullFiles(repo, pull), repo)), linkHeader(url, query, params, hasNext));
      return;
    }

    // POST /pulls — open one from a head branch onto a base branch.
    if (method === 'POST' && tail.length === 1) {
      const body = await readJsonObject(req, res);
      if (body === null) return;
      const title = stringField(body, 'title');
      const head = stringField(body, 'head');
      const base = stringField(body, 'base');
      if (title === undefined || title === '') {
        sendError(res, 422, 'title is required');
        return;
      }
      if (head === undefined || head === '' || base === undefined || base === '') {
        sendError(res, 422, 'head and base are required');
        return;
      }
      const pull = store.createPull(repo, {
        title,
        body: stringField(body, 'body'),
        head,
        base,
      });
      sendJson(res, 201, pullView(pull, repo));
      return;
    }

    const number = Number.parseInt(tail[1] ?? '', 10);
    if (tail.length < 2 || !Number.isInteger(number) || number < 1) {
      sendError(res, 404, 'Not Found');
      return;
    }

    // GET /pulls/{n} — read one, with its files refreshed from the tips.
    if (method === 'GET' && tail.length === 2) {
      const pull = store.requirePull(repo, number);
      sendJson(res, 200, pullView(store.refreshPullFiles(repo, pull), repo));
      return;
    }

    // GET /pulls/{n}/files — the changed paths.
    if (method === 'GET' && tail.length === 3 && tail[2] === 'files') {
      const pull = store.requirePull(repo, number);
      const refreshed = store.refreshPullFiles(repo, pull);
      sendJson(res, 200, refreshed.files.map((file) => pullFileView(file)));
      return;
    }

    // PUT /pulls/{n}/merge — squash-merge onto the base branch.
    if (method === 'PUT' && tail.length === 3 && tail[2] === 'merge') {
      const body = await readJsonObject(req, res);
      if (body === null) return;
      const result = store.mergePullSquash(repo, number);
      sendJson(res, 200, { sha: result.sha, merged: result.merged, message: result.message });
      return;
    }

    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}
