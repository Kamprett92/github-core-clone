// lib/mcp.ts — the Model Context Protocol endpoint (POST /mcp).
//
// JSON-RPC 2.0 over the Streamable HTTP transport, answering plain JSON.
// It speaks revision 2026-07-28: no handshake, `server/discover` returns
// the server's identity, capabilities and supported versions in one
// request; and it also answers the legacy `initialize` +
// `notifications/initialized` handshake for older clients. Every request
// declares its revision in `_meta`; the server echoes the request's
// JSON-RPC id back verbatim, so concurrent calls keep their own ids and
// their own objects.
//
// The six tools are the ones github-mcp-server documents — create_repo,
// get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request — and they act on the same store as REST, so a
// repository and an issue created over MCP read back over /api/v3 as the
// same objects, their ids unchanged across reads. `tools/list` answers
// the same list, byte for byte, on every call: the tool table is one
// frozen constant.
//
// Errors are JSON-RPC codes, never HTTP 500: an unknown tool is -32602,
// a tools/call missing a required argument is a tool result with
// `isError: true`, a body that is not JSON is HTTP 400 with -32700, and
// a call with no Authorization header is HTTP 401. Every request answers
// well inside the 3-second limit: nothing here does slow work.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthorized, nextRequestId, repoView, issueView, pullView } from './rest.ts';
import { isStoreError, Store, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// the tool table: one frozen constant, so tools/list is byte-identical
// ---------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The name of the repository to create.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The login that owns the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The login that owns the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'The title of the issue.' }),
        body: Object.freeze({ type: 'string', description: 'The body of the issue.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The login that owns the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        state: Object.freeze({ type: 'string', description: 'open, closed or all. Defaults to open.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The login that owns the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'The title of the pull request.' }),
        body: Object.freeze({ type: 'string', description: 'The body of the pull request.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The login that owns the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The number of the pull request to merge.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

const SERVER_INFO = Object.freeze({ name: 'github-core-clone', version: '1.0.0' });

/** Every revision this server speaks, newest first. */
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const LEGACY_VERSIONS: readonly string[] = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  });
  res.end(body);
}

function resultEnvelope(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorEnvelope(id: JsonRpcId, error: JsonRpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error };
}

/** A tool result: `content: [{type: "text", text: <JSON>}]`, optionally `isError`. */
function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const out: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (isError) out.isError = true;
  return out;
}

const MAX_BODY_BYTES = 1 << 20;

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
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err: Error) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// tool dispatch
// ---------------------------------------------------------------------------

/** Which arguments a tool call is missing, by its declared `required` list. */
function missingArguments(tool: ToolDefinition, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

/**
 * Resolve a repository for a tool call. A name under any owner but the
 * viewer is "not found" (the REST surface answers 404 the same way);
 * the viewer is the owner every tool call acts as.
 */
function resolveRepo(store: Store, owner: unknown, repo: unknown): Repo {
  if (typeof owner !== 'string' || typeof repo !== 'string') {
    throw new ToolFailure('owner and repo are required');
  }
  if (owner !== store.viewer().login) throw new ToolFailure('Not Found');
  const found = store.getRepo(owner, repo);
  if (found === undefined) throw new ToolFailure('Not Found');
  return found;
}

/** A tool execution failure: answered as `isError: true`, never HTTP 500. */
class ToolFailure extends Error {}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function booleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  return typeof value === 'boolean' ? value : undefined;
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

/** Run one tool call and return its result object (the `result` field). */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new JsonRpcFailure(-32602, `Unknown tool: ${name}`);
  }
  const missing = missingArguments(tool, args);
  if (missing.length > 0) {
    return toolResult({ error: `Missing required argument: ${missing.join(', ')}` }, true);
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = stringArg(args, 'name')!;
        const repo = store.createRepo(store.viewer().login, repoName, {
          private: booleanArg(args, 'private'),
          description: stringArg(args, 'description'),
        });
        return toolResult(repoView(repo));
      }
      case 'get_repo': {
        const repo = resolveRepo(store, args.owner, args.repo);
        return toolResult(repoView(repo));
      }
      case 'create_issue': {
        const repo = resolveRepo(store, args.owner, args.repo);
        const issue = store.createIssue(repo, {
          title: stringArg(args, 'title')!,
          body: stringArg(args, 'body'),
        });
        return toolResult(issueView(issue, repo));
      }
      case 'list_issues': {
        const repo = resolveRepo(store, args.owner, args.repo);
        const state = stringArg(args, 'state') ?? 'open';
        const filter: 'open' | 'closed' | 'all' =
          state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open';
        const issues = store.listIssues(repo, filter);
        return toolResult(issues.map((issue) => issueView(issue, repo)));
      }
      case 'create_pull_request': {
        const repo = resolveRepo(store, args.owner, args.repo);
        const pull = store.createPull(repo, {
          title: stringArg(args, 'title')!,
          body: stringArg(args, 'body'),
          head: stringArg(args, 'head')!,
          base: stringArg(args, 'base')!,
        });
        return toolResult(pullView(pull, repo));
      }
      case 'merge_pull_request': {
        const repo = resolveRepo(store, args.owner, args.repo);
        const pullNumber = numberArg(args, 'pull_number');
        if (pullNumber === undefined) {
          return toolResult({ error: 'Missing required argument: pull_number' }, true);
        }
        const result = store.mergePullSquash(repo, pullNumber);
        const pull = store.getPull(repo, pullNumber)!;
        return toolResult({
          merged: result.merged,
          sha: result.sha,
          message: result.message,
          number: pull.number,
          state: pull.state,
        });
      }
      default:
        throw new JsonRpcFailure(-32602, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof ToolFailure) {
      return toolResult({ error: err.message }, true);
    }
    if (isStoreError(err)) {
      return toolResult({ error: err.message }, true);
    }
    throw err;
  }
}

/** A failure answered as a JSON-RPC error (unknown tool / bad method). */
class JsonRpcFailure extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// method dispatch
// ---------------------------------------------------------------------------

/**
 * Answer one JSON-RPC request object and return its envelope (or null for
 * a notification, which gets no envelope).
 */
function handleRpc(store: Store, request: JsonRpcRequest): Record<string, unknown> | null {
  const id: JsonRpcId = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  // A notification (no id) is acknowledged with no envelope.
  const isNotification = request.id === undefined;

  switch (method) {
    case 'server/discover': {
      const result = {
        resultType: 'discover',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      };
      return isNotification ? null : resultEnvelope(id, result);
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = LEGACY_VERSIONS.includes(requested) ? requested : '2025-11-25';
      const result = {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      };
      return isNotification ? null : resultEnvelope(id, result);
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return null;
    case 'ping':
      return isNotification ? null : resultEnvelope(id, {});
    case 'tools/list': {
      // The same frozen table every time, stringified once by the sender:
      // byte-identical across calls.
      const result = { tools: TOOLS };
      return isNotification ? null : resultEnvelope(id, result);
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      try {
        const result = callTool(store, name, args);
        return isNotification ? null : resultEnvelope(id, result);
      } catch (err) {
        if (err instanceof JsonRpcFailure) {
          return isNotification ? null : errorEnvelope(id, { code: err.code, message: err.message });
        }
        throw err;
      }
    }
    default:
      return isNotification ? null : errorEnvelope(id, { code: -32601, message: `Method not found: ${method}` });
  }
}

// ---------------------------------------------------------------------------
// the HTTP handler
// ---------------------------------------------------------------------------

/**
 * Answer one MCP request. Returns true when the path is /mcp (and the
 * request has been answered, including error answers), false otherwise so
 * the caller falls through to its own 404.
 */
export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (path !== '/mcp') return false;
  const method = (req.method ?? 'GET').toUpperCase();

  // A legacy session's goodbye: acknowledge and forget it.
  if (method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }
  if (method !== 'POST') return false;

  try {
    // Auth is decided before any tool exists: no token is a 401.
    if (!isAuthorized(req)) {
      sendJson(res, 401, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Requires authentication' },
      });
      return true;
    }
    let text: string;
    try {
      text = await readBody(req);
    } catch {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return true;
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // A body that is not JSON is HTTP 400 with JSON-RPC -32700.
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return true;
    }

    // A JSON array is a batch: one envelope per request, in order.
    if (Array.isArray(body)) {
      const envelopes: Array<Record<string, unknown>> = [];
      for (const entry of body) {
        if (!isRecord(entry)) {
          envelopes.push(errorEnvelope(null, { code: -32600, message: 'Invalid Request' }));
          continue;
        }
        const envelope = handleRpc(store, entry as JsonRpcRequest);
        if (envelope !== null) envelopes.push(envelope);
      }
      sendJson(res, 200, envelopes);
      return true;
    }
    if (!isRecord(body)) {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      });
      return true;
    }
    const envelope = handleRpc(store, body as JsonRpcRequest);
    if (envelope === null) {
      // A lone notification: 202, no body.
      res.writeHead(202, { 'x-github-request-id': nextRequestId() });
      res.end();
      return true;
    }
    sendJson(res, 200, envelope);
  } catch {
    sendJson(res, 500, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal error' },
    });
  }
  return true;
}
