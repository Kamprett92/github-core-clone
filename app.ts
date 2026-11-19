// app.ts — wiring: one process, one store, four surfaces.
//
// `createApp()` creates a single `Store` per server instance and mounts
// the four handlers on it, in dispatch order: GraphQL (POST /api/graphql),
// MCP (POST /mcp), smart-HTTP git (/{owner}/{repo}.git/...), REST v3
// (/api/v3/*). Each handler returns true when it answered, false
// otherwise, before the JSON 404 fallback. `/healthz` and the `/api/v3`
// root live here too, and both carry a deterministic `x-github-request-id`
// (the sequential hex counter from `lib/rest.ts`).
//
// A handler that throws is answered with a JSON 500, so no request hangs
// and a malformed request never takes the server down with it.

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { handleGit } from './lib/git-http.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleRest, isAuthorized, nextRequestId } from './lib/rest.ts';
import { Store } from './lib/store.ts';

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders?: Readonly<Record<string, string>>): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    'content-length': String(Buffer.byteLength(body, 'utf8')),
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * Create the HTTP server for one forge instance. The server is returned
 * unlistened; `main.ts` owns the port and the harness lifecycle.
 */
export function createApp(): http.Server {
  const store = new Store();

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, store).catch(() => {
      try {
        if (!res.writableEnded) sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // The socket is already gone; there is nothing left to answer.
      }
    });
  });
  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const path = (req.url ?? '/').split('?')[0] ?? '/';

  // GET /healthz — the boot probe: 200 JSON, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // GET /api/v3/ — the REST root: 200 JSON with X-OAuth-Scopes, plus the
  // request id the protocol check requires on it. It is a REST route, so
  // it needs the bearer token when one is configured.
  if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_repositories_url: '/api/v3/user/repos',
        meta_url: '/api/v3/meta',
      },
      { 'x-oauth-scopes': 'repo, user' },
    );
    return;
  }

  try {
    // The four surfaces. The path shape picks which handler can own the
    // request, so a REST call never pays for the git handler's URL parse
    // (and vice versa); each handler still re-checks its own match, so
    // the fast path can never claim a path its handler would refuse.
    const segments = path.split('/').filter((piece) => piece !== '');
    if (path === '/api/graphql') {
      if (await handleGraphql(req, res, store)) return;
    } else if (path === '/mcp') {
      if (await handleMcp(req, res, store)) return;
    } else if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (await handleRest(req, res, store)) return;
    } else if (segments.length >= 2 && (segments[1] ?? '').endsWith('.git')) {
      if (await handleGit(req, res, store)) return;
    }
  } catch {
    if (!res.writableEnded) sendJson(res, 500, { message: 'Internal Server Error' });
    return;
  }

  // Nothing claimed the path: a JSON 404, never HTML.
  if (!res.writableEnded) sendJson(res, 404, { message: 'Not Found' });
}
