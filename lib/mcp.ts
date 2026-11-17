// lib/mcp.ts — Model Context Protocol endpoint (POST /mcp, JSON-RPC 2.0 over
// Streamable HTTP) over the shared store.
//
// Two eras, one tool set:
//  - Modern (preferred): revision 2026-07-28. No handshake/session; every
//    request declares its revision in params._meta
//    ['io.modelcontextprotocol/protocolVersion'] and mirrors it in the
//    MCP-Protocol-Version header. `server/discover` is answered first and
//    lists every supported revision.
//  - Legacy: `initialize` + `notifications/initialized` for revisions
//    2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05.
//
// Rules: no wall-clock time, no randomness, no model calls; every handler is
// fast and linear. Unknown tools are JSON-RPC errors, never HTTP 500.
// Notifications (no `id`) get no response body (202, empty).
//
// Auth: a missing Authorization header is always 401. When
// process.env.MAKEFUN_SHOP_TOKEN is set, the header must be
// `Bearer <token>`; when it is unset, any Bearer header is accepted.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN, isStoreError } from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const LATEST_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const JSON_TYPE = 'application/json; charset=utf-8';

function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function capabilities(): { tools: Record<string, never> } {
  return { tools: {} };
}

// ---------------------------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': '0' });
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Missing Authorization header is always 401; a configured token must match. */
function checkAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  const configured = process.env.MAKEFUN_SHOP_TOKEN;
  if (!configured) return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
  return header === `Bearer ${configured}`;
}

// ---------------------------------------------------------------------------------------------
// REST-shaped views (the same objects /api/v3 returns, so ids round-trip)
// ---------------------------------------------------------------------------------------------

function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    default_branch: repo.defaultBranch,
    description: repo.description,
    owner: { login: repo.owner, id: store.viewer().id, type: 'User' },
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueObject(issue: Issue): Record<string, unknown> {
  return {
    number: issue.number,
    id: issue.id,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullObject(pr: Pull): Record<string, unknown> {
  return {
    number: pr.number,
    id: pr.id,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.head.ref, sha: pr.head.sha },
    base: { ref: pr.base.ref, sha: pr.base.sha },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, string>>;
    required: string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, Record<string, string>>,
  required: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const FULL_NAME_PROP = { type: 'string', description: 'Repository "owner/repo" — an alternative to passing owner and repo separately.' };

/**
 * Fixed order, fixed content: two tools/list calls answer the same list
 * byte for byte (no timestamps, no random ids anywhere).
 */
const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the viewer.', {
    name: { type: 'string', description: 'Repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    full_name: FULL_NAME_PROP,
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    full_name: FULL_NAME_PROP,
    title: { type: 'string', description: 'Issue title.' },
    body: { type: 'string', description: 'Issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository, optionally filtered by state.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    full_name: FULL_NAME_PROP,
    state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch onto a base branch.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    full_name: FULL_NAME_PROP,
    title: { type: 'string', description: 'Pull request title.' },
    head: { type: 'string', description: 'Head branch name.' },
    base: { type: 'string', description: 'Base branch name.' },
    body: { type: 'string', description: 'Pull request body.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Squash-merge a pull request.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    full_name: FULL_NAME_PROP,
    pull_number: { type: 'integer', description: 'Pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
];

const TOOL_MAP = new Map(TOOLS.map((entry) => [entry.name, entry]));

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: false };
}

function errorResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Owner/repo from explicit args, falling back to splitting full_name. */
function resolveRepoArgs(args: Record<string, unknown>): { owner: string | undefined; repo: string | undefined } {
  let owner = typeof args.owner === 'string' ? args.owner : undefined;
  let repo = typeof args.repo === 'string' ? args.repo : undefined;
  if ((owner === undefined || repo === undefined) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner ??= parts[0]!;
      repo ??= parts[1]!;
    }
  }
  return { owner, repo };
}

/** First missing required property, honouring the full_name fallback for owner/repo. */
function missingRequired(toolDef: ToolDef, args: Record<string, unknown>): string | null {
  const { owner, repo } = resolveRepoArgs(args);
  for (const name of toolDef.inputSchema.required) {
    if (name === 'owner' && owner !== undefined) continue;
    if (name === 'repo' && repo !== undefined) continue;
    if (args[name] === undefined || args[name] === null) return name;
  }
  return null;
}

function requireRepo(store: Store, owner: string | undefined, repo: string | undefined): Repo {
  if (owner === undefined || repo === undefined) throw new Error('missing required argument: owner');
  const found = store.getRepo(owner, repo);
  if (!found) throw new Error(`Repository not found: ${owner}/${repo}`);
  return found;
}

function callTool(store: Store, name: string, rawArgs: unknown): Record<string, unknown> {
  const toolDef = TOOL_MAP.get(name);
  if (!toolDef) return errorResult(`Unknown tool: ${name}`);
  const args = asRecord(rawArgs);
  const missing = missingRequired(toolDef, args);
  if (missing) return errorResult(`missing required argument: ${missing}`);
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = args.name as string;
        const repo = store.createRepo(VIEWER_LOGIN, repoName, {
          description: typeof args.description === 'string' ? args.description : undefined,
          private: typeof args.private === 'boolean' ? args.private : undefined,
        });
        return textResult(JSON.stringify(repoObject(store, repo), null, 2));
      }
      case 'get_repo': {
        const { owner, repo } = resolveRepoArgs(args);
        const found = requireRepo(store, owner, repo);
        return textResult(JSON.stringify(repoObject(store, found), null, 2));
      }
      case 'create_issue': {
        const { owner, repo } = resolveRepoArgs(args);
        const found = requireRepo(store, owner, repo);
        const issue = store.createIssue(found, {
          title: args.title as string,
          body: typeof args.body === 'string' ? args.body : undefined,
        });
        return textResult(JSON.stringify(issueObject(issue), null, 2));
      }
      case 'list_issues': {
        const { owner, repo } = resolveRepoArgs(args);
        const found = requireRepo(store, owner, repo);
        const stateRaw = typeof args.state === 'string' ? args.state.toLowerCase() : 'all';
        const state = stateRaw === 'open' || stateRaw === 'closed' ? stateRaw : 'all';
        const issues = store.listIssues(found, state).map((issue) => issueObject(issue));
        return textResult(JSON.stringify(issues, null, 2));
      }
      case 'create_pull_request': {
        const { owner, repo } = resolveRepoArgs(args);
        const found = requireRepo(store, owner, repo);
        const pr = store.createPull(found, {
          title: args.title as string,
          head: args.head as string,
          base: args.base as string,
          body: typeof args.body === 'string' ? args.body : undefined,
        });
        return textResult(JSON.stringify(pullObject(pr), null, 2));
      }
      case 'merge_pull_request': {
        const { owner, repo } = resolveRepoArgs(args);
        const found = requireRepo(store, owner, repo);
        const rawNumber = args.pull_number;
        const pullNumber = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' && /^\d+$/.test(rawNumber) ? Number.parseInt(rawNumber, 10) : NaN;
        if (!Number.isFinite(pullNumber)) return errorResult('missing required argument: pull_number');
        store.mergePullSquash(found, pullNumber);
        const merged = store.getPull(found, pullNumber);
        if (!merged) return errorResult(`Pull request not found: ${pullNumber}`);
        return textResult(JSON.stringify(pullObject(merged), null, 2));
      }
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (isStoreError(err)) return errorResult(err.message);
    return errorResult(err instanceof Error ? err.message : 'Tool call failed');
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------------------------

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function metaFor(version: string): Record<string, unknown> {
  return { 'io.modelcontextprotocol/protocolVersion': version, serverInfo: serverInfo() };
}

/**
 * Negotiate the revision for one request. Returns the negotiated version, or
 * an error response object (already shaped) when the declared revision is
 * unsupported (-32022) or the declared revisions disagree (-32020).
 */
function negotiateVersion(
  id: JsonRpcId,
  params: Record<string, unknown>,
  headerVersion: string | undefined,
  paramsVersion: string | undefined,
): { version: string } | { error: Record<string, unknown> } {
  const meta = asRecord(params._meta);
  const metaVersion = typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string'
    ? (meta['io.modelcontextprotocol/protocolVersion'] as string)
    : undefined;
  const declared = [metaVersion, headerVersion, paramsVersion].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  const distinct = [...new Set(declared)];
  if (distinct.length > 1) {
    return {
      error: rpcError(id, -32020, `Protocol version mismatch: ${distinct.join(' vs ')}`, {
        supported: [...SUPPORTED_VERSIONS],
        supportedVersions: [...SUPPORTED_VERSIONS],
      }),
    };
  }
  const version = distinct[0] ?? LATEST_VERSION;
  if (!SUPPORTED_VERSIONS.includes(version)) {
    return {
      error: rpcError(id, -32022, `Unsupported protocol version: ${version}`, {
        supported: [...SUPPORTED_VERSIONS],
        supportedVersions: [...SUPPORTED_VERSIONS],
      }),
    };
  }
  return { version };
}

function handleRequest(store: Store, req: IncomingMessage, body: Record<string, unknown>): { status: number; payload: Record<string, unknown> | null } {
  const id: JsonRpcId = 'id' in body ? (body.id as JsonRpcId) : null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = asRecord(body.params);
  const headerVersion = typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : undefined;

  // A request without a method is an invalid request.
  if (method === '') {
    return { status: 200, payload: rpcError(id, -32600, 'Invalid Request: missing method') };
  }

  if (method === 'server/discover') {
    const negotiated = negotiateVersion(id, params, headerVersion, undefined);
    if ('error' in negotiated) return { status: 200, payload: negotiated.error };
    const version = negotiated.version;
    return {
      status: 200,
      payload: rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        protocolVersion: version,
        serverInfo: serverInfo(),
        capabilities: capabilities(),
        _meta: metaFor(version),
      }),
    };
  }

  if (method === 'initialize') {
    const paramsVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const negotiated = negotiateVersion(id, params, headerVersion, paramsVersion);
    if ('error' in negotiated) return { status: 200, payload: negotiated.error };
    const version = negotiated.version;
    return {
      status: 200,
      payload: rpcResult(id, {
        protocolVersion: version,
        serverInfo: serverInfo(),
        capabilities: capabilities(),
        _meta: metaFor(version),
      }),
    };
  }

  if (method === 'ping') {
    const negotiated = negotiateVersion(id, params, headerVersion, undefined);
    if ('error' in negotiated) return { status: 200, payload: negotiated.error };
    return { status: 200, payload: rpcResult(id, { _meta: metaFor(negotiated.version) }) };
  }

  if (method === 'tools/list') {
    const negotiated = negotiateVersion(id, params, headerVersion, undefined);
    if ('error' in negotiated) return { status: 200, payload: negotiated.error };
    const version = negotiated.version;
    // Deep-copy the fixed list so no caller can mutate the shared table.
    const tools = TOOLS.map((entry) => JSON.parse(JSON.stringify(entry)) as ToolDef);
    return {
      status: 200,
      payload: rpcResult(id, { tools, _meta: metaFor(version) }),
    };
  }

  if (method === 'tools/call') {
    const negotiated = negotiateVersion(id, params, headerVersion, undefined);
    if ('error' in negotiated) return { status: 200, payload: negotiated.error };
    const version = negotiated.version;
    const name = typeof params.name === 'string' ? params.name : '';
    if (name === '') {
      return { status: 200, payload: rpcError(id, -32602, 'Invalid params: tools/call requires a tool name') };
    }
    if (!TOOL_MAP.has(name)) {
      return { status: 200, payload: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    const result = callTool(store, name, params.arguments);
    return { status: 200, payload: rpcResult(id, { ...result, _meta: metaFor(version) }) };
  }

  // Unknown method (including unimplemented notifications sent as requests).
  const negotiated = negotiateVersion(id, params, headerVersion, undefined);
  if ('error' in negotiated) return { status: 200, payload: negotiated.error };
  return { status: 200, payload: rpcError(id, -32601, `Method not found: ${method}`) };
}

// ---------------------------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------------------------

/**
 * Handle POST /mcp. Returns true when the request was ours (and has been
 * answered), false otherwise so the caller falls through.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  if ((req.method ?? 'GET') !== 'POST') return false;
  if (url.pathname !== '/mcp' && url.pathname !== '/mcp/') return false;

  if (!checkAuth(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  const text = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error: request body is not valid JSON'));
    return true;
  }

  // JSON-RPC batch: answer each request in order, dropping notifications.
  if (Array.isArray(parsed)) {
    const responses: Array<Record<string, unknown>> = [];
    for (const item of parsed) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        responses.push(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      if (!('id' in item)) continue; // notification: no response
      const handled = handleRequest(store, req, item as Record<string, unknown>);
      if (handled.payload) responses.push(handled.payload);
    }
    sendJson(res, 200, responses);
    return true;
  }

  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error: request body is not a JSON-RPC object'));
    return true;
  }

  const body = parsed as Record<string, unknown>;
  // Notifications (no `id`) get no response body: 202, empty.
  if (!('id' in body)) {
    sendEmpty(res, 202);
    return true;
  }

  const handled = handleRequest(store, req, body);
  if (handled.payload === null) {
    sendEmpty(res, 202);
    return true;
  }
  const headerVersion = typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : undefined;
  const extraHeaders: Record<string, string> = headerVersion ? { 'mcp-protocol-version': headerVersion } : {};
  sendJson(res, handled.status, handled.payload, extraHeaders);
  return true;
}
