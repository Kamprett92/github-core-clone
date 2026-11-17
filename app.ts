// The entry's HTTP surface: the starter's health probe and API root, plus the four
// contest surfaces — git smart HTTP, REST v3, GraphQL v4 and MCP — all sharing one
// Store per server instance (created in createApp).
//
// app.ts is deliberately separate from main.ts: this is the server, the file you grow;
// main.ts is the entry <-> env lifecycle and should stay as it is.
//
// Routing order (no surface can shadow another):
//   GET /healthz            -> starter 200 {"ok":true}
//   GET /api/v3[/]          -> starter API root (200, x-oauth-scopes)
//   POST /api/graphql       -> lib/graphql.ts handleGraphql (exact path only)
//   POST /mcp               -> lib/mcp.ts handleMcp (exact path only)
//   /{owner}/{repo}.git/... -> lib/git-http.ts handleGit (*.git paths only)
//   /api/v3/*               -> lib/rest.ts handleRest (never claims the root or /healthz)
//   everything else         -> JSON 404 {"message":"Not Found"} (never HTML)
// Each handler returns true when it answered the request, false otherwise; the
// chain falls through until one claims it. A handler that throws is answered
// with a JSON 500 so a request never hangs.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './lib/git-http.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleRest } from './lib/rest.ts';
import { Store } from './lib/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** Deterministic per-process request id: sequential counter formatted as hex, like lib/rest.ts. */
function nextRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(8, '0');
}

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  // One shared store per server instance: git smart HTTP, REST v3, GraphQL v4 and MCP all
  // read and write this same store.
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      // GraphQL v4, MCP, git smart HTTP and REST v3, in an order where no handler can
      // claim another surface's path: each only answers its own paths and returns
      // false otherwise. handleRest also answers unknown /api/v3 routes with a JSON
      // 404, so the fallback below only sees paths outside every surface.
      if (await handleGraphql(req, res, store)) return;
      if (await handleMcp(req, res, store)) return;
      if (await handleGit(req, res, store)) return;
      if (await handleRest(req, res, store)) return;

      sendJson(res, 404, { message: 'Not Found' });
    })().catch(() => {
      // A handler threw: answer JSON 500 rather than leaving the request hanging.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is already gone; nothing left to answer.
      }
    });
  });
}
