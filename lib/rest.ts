// lib/rest.ts — GitHub REST v3 API under /api/v3, backed by the shared Store.
//
// Stage-2 deliverable for github-core-clone-01. Node 22, stdlib only, no
// dependencies. Deterministic: no wall-clock time, no randomness in anything
// observable — timestamps come from the store, request ids are a per-process
// sequential counter formatted as hex.
//
// Contract: handleRest(req, res, store) returns true when the request was
// answered here (including error answers), false when it is not a REST route
// (the caller falls through to its own handling). It never claims the
// starter's GET /api/v3 root or GET /healthz.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, isStoreError, VIEWER_LOGIN } from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------------------------------------
// request ids + JSON replies
// ---------------------------------------------------------------------------------------------

let requestCounter = 0;

/** Deterministic per-process request id: sequential counter formatted as hex. */
function nextRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(8, '0');
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

// ---------------------------------------------------------------------------------------------
// request body
// ---------------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

async function readBody(req: IncomingMessage): Promise<{ ok: true; body: JsonObject } | { ok: false }> {
  // Event-based read (not `for await`): the async iterator's per-chunk setup is measurable
  // across thousands of small bodies.
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
    req.on('error', reject);
  });
  if (text === '') return { ok: true, body: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
  return { ok: true, body: parsed as JsonObject };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as JsonObject).name === 'string') {
      out.push((item as JsonObject).name as string);
    } else {
      return undefined;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userObject(store: Store): Record<string, unknown> {
  const viewer = store.viewer();
  return { login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email, type: 'User' };
}

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    default_branch: repo.defaultBranch,
    description: repo.description,
    owner: { login: repo.owner, id: 1000, type: 'User' },
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
// routing helpers
// ---------------------------------------------------------------------------------------------

function decodeSegment(segment: string): string {
  // Most segments carry no escapes; decodeURIComponent on a plain string is pure overhead.
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseIssueNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return parsed >= 1 ? parsed : null;
}

// ---------------------------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------------------------

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  pathname?: string,
): Promise<boolean> {
  // `pathname` may be supplied by the caller (already split from the URL); when omitted
  // it is parsed here. The query string is read with URLSearchParams (cheaper than a
  // full `new URL`): REST routes need per_page/page/state/sort/direction/sha/ref.
  const rawUrl = req.url ?? '/';
  const path = pathname ?? (() => {
    const q = rawUrl.indexOf('?');
    return q < 0 ? rawUrl : rawUrl.slice(0, q);
  })();
  const qAt = rawUrl.indexOf('?');
  const searchParams = new URLSearchParams(qAt < 0 ? '' : rawUrl.slice(qAt + 1));
  const method = req.method ?? 'GET';

  // Only /api/v3 paths are ours at all.
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;
  // The starter already handles the API root (and /healthz is not under /api/v3).
  if (path === '/api/v3' || path === '/api/v3/') return false;

  const segments = path
    .slice('/api/v3/'.length)
    .split('/')
    .filter((segment) => segment !== '')
    .map(decodeSegment);

  // Route matching (method + shape) happens before auth so an unknown /api/v3
  // path is a 404 JSON whether or not a token is present.
  type Route = { auth: boolean; run: () => Promise<void> };
  let route: Route | null = null;

  const fail = (status: number, message: string): Route => ({
    auth: false,
    run: async () => sendError(res, status, message),
  });

  // -- helpers that close over req/res/store -----------------------------------------------
  const readJsonBody = async (): Promise<JsonObject | null> => {
    const result = await readBody(req);
    if (!result.ok) {
      sendError(res, 400, 'Malformed JSON in request body');
      return null;
    }
    return result.body;
  };

  /** The repo for {owner}/{repo}, or null after answering 404. Owner mismatch is 404, never 403. */
  const requireOwnedRepo = (owner: string, name: string): Repo | null => {
    if (owner !== VIEWER_LOGIN) {
      sendError(res, 404, 'Not Found');
      return null;
    }
    const repo = store.getRepo(owner, name);
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return null;
    }
    return repo;
  };

  const storeGuard = (fn: () => void, mapMessage?: (err: { status: number; message: string }) => string): void => {
    try {
      fn();
    } catch (err) {
      if (isStoreError(err)) {
        sendError(res, err.status, mapMessage ? mapMessage(err) : err.message);
      } else sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
    }
  };

  // -- route table --------------------------------------------------------------------------
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    route = { auth: true, run: async () => sendJson(res, 200, { installed_version: '1.0.0' }) };
  } else if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    route = { auth: true, run: async () => sendJson(res, 200, userObject(store)) };
  } else if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      route = {
        auth: true,
        run: async () => {
          const perPage = Math.min(parsePositiveInt(searchParams.get('per_page'), 30), 100);
          const page = parsePositiveInt(searchParams.get('page'), 1);
          const all = store.listReposByOwner(VIEWER_LOGIN);
          const totalPages = Math.max(1, Math.ceil(all.length / perPage));
          const start = (page - 1) * perPage;
          const slice = all.slice(start, start + perPage);
          const headers: Record<string, string> = {};
          if (page < totalPages) {
            const host = req.headers.host ?? 'localhost';
            const base = `http://${host}/api/v3/user/repos?per_page=${perPage}`;
            headers.link = `<${base}&page=${page + 1}>; rel="next", <${base}&page=${totalPages}>; rel="last"`;
          }
          sendJson(res, 200, slice.map(repoObject), headers);
        },
      };
    } else if (method === 'POST') {
      route = {
        auth: true,
        run: async () => {
          const body = await readJsonBody();
          if (body === null) return;
          const name = asString(body.name);
          if (!name) {
            sendError(res, 422, 'Repository name is required');
            return;
          }
          storeGuard(() => {
            const repo = store.createRepo(VIEWER_LOGIN, name, {
              private: typeof body.private === 'boolean' ? body.private : undefined,
              description: asString(body.description),
            });
            sendJson(res, 201, repoObject(repo));
          }, (err) => (err.message === 'Repository already exists' ? 'repository already exists' : err.message));
        },
      };
    }
  } else if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const repoName = segments[2]!;
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        route = {
          auth: true,
          run: async () => {
            const repo = requireOwnedRepo(owner, repoName);
            if (repo) sendJson(res, 200, repoObject(repo));
          },
        };
      } else if (method === 'PATCH') {
        route = {
          auth: true,
          run: async () => {
            const body = await readJsonBody();
            if (body === null) return;
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            storeGuard(() => {
              const updated = store.updateRepo(owner, repoName, {
                description: asString(body.description),
                private: typeof body.private === 'boolean' ? body.private : undefined,
              });
              const out = repoObject(updated) as Record<string, unknown>;
              if (asString(body.description) !== undefined) out.descriptionAlt = body.description;
              sendJson(res, 200, out);
            });
          },
        };
      } else if (method === 'DELETE') {
        route = {
          auth: true,
          run: async () => {
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            storeGuard(() => {
              store.deleteRepo(owner, repoName);
              res.writeHead(204, { 'x-github-request-id': nextRequestId() });
              res.end();
            });
          },
        };
      }
    } else if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      route = {
        auth: true,
        run: async () => {
          const repo = requireOwnedRepo(owner, repoName);
          if (repo) sendJson(res, 200, store.listBranches(repo));
        },
      };
    } else if (rest[0] === 'branches' && rest.length >= 2 && method === 'GET') {
      route = {
        auth: true,
        run: async () => {
          const repo = requireOwnedRepo(owner, repoName);
          if (!repo) return;
          const branch = rest.slice(1).join('/');
          const tip = store.branchTip(repo, branch);
          if (tip === undefined) sendError(res, 404, 'Not Found');
          else sendJson(res, 200, { name: branch, commit: { sha: tip } });
        },
      };
    } else if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      route = {
        auth: true,
        run: async () => {
          const repo = requireOwnedRepo(owner, repoName);
          if (!repo) return;
          const sha = searchParams.get('sha') ?? undefined;
          const commits = store.listCommits(repo, sha);
          sendJson(
            res,
            200,
            commits.map((entry) => ({
              sha: entry.sha,
              commit: { message: entry.commit.message, author: entry.commit.author, committer: entry.commit.committer },
            })),
          );
        },
      };
    } else if (rest.length === 1 && rest[0] === 'refs' && method === 'POST') {
      // POST /repos/{owner}/{repo}/git/refs — handled below under rest[0]==='git'
      route = null;
    } else if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
      route = {
        auth: true,
        run: async () => {
          const body = await readJsonBody();
          if (body === null) return;
          const repo = requireOwnedRepo(owner, repoName);
          if (!repo) return;
          const ref = asString(body.ref);
          const sha = asString(body.sha);
          if (!ref || !sha) {
            sendError(res, 422, 'ref and sha are required');
            return;
          }
          storeGuard(() => {
            const created = store.createRef(repo, ref, sha);
            sendJson(res, 201, created);
          });
        },
      };
    } else if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && rest.length >= 4 && method === 'GET') {
      route = {
        auth: true,
        run: async () => {
          const repo = requireOwnedRepo(owner, repoName);
          if (!repo) return;
          const branch = rest.slice(3).join('/');
          const found = store.getRef(repo, `refs/heads/${branch}`);
          if (!found) sendError(res, 404, 'Not Found');
          else sendJson(res, 200, found);
        },
      };
    } else if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      if (method === 'GET') {
        route = {
          auth: true,
          run: async () => {
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            const ref = searchParams.get('ref') ?? undefined;
            const found = store.getContent(repo, contentPath, ref);
            if (!found) {
              sendError(res, 404, 'Not Found');
              return;
            }
            if (found.kind === 'file') {
              sendJson(res, 200, {
                type: 'file',
                encoding: 'base64',
                content: found.content.toString('base64'),
                sha: found.sha,
                size: found.size,
                name: contentPath.split('/').pop() ?? '',
                path: contentPath,
              });
            } else {
              sendJson(
                res,
                200,
                found.entries.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.sha })),
              );
            }
          },
        };
      } else if (method === 'PUT') {
        route = {
          auth: true,
          run: async () => {
            const body = await readJsonBody();
            if (body === null) return;
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            if (contentPath === '') {
              sendError(res, 422, 'Invalid path');
              return;
            }
            const content = asString(body.content);
            if (content === undefined) {
              sendError(res, 422, 'content is required');
              return;
            }
            storeGuard(() => {
              const result = store.putContent(repo, {
                path: contentPath,
                message: asString(body.message) ?? '',
                contentBase64: content,
                sha: asString(body.sha),
                branch: asString(body.branch),
              });
              sendJson(res, result.created ? 201 : 200, {
                content: {
                  name: contentPath.split('/').pop() ?? '',
                  path: contentPath,
                  sha: result.content.sha,
                  size: Buffer.from(content, 'base64').length,
                  encoding: 'base64',
                },
                commit: { sha: result.commit.sha },
              });
            });
          },
        };
      } else if (method === 'DELETE') {
        route = {
          auth: true,
          run: async () => {
            const body = await readJsonBody();
            if (body === null) return;
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            if (contentPath === '') {
              sendError(res, 422, 'Invalid path');
              return;
            }
            storeGuard(() => {
              const result = store.deleteContent(repo, {
                path: contentPath,
                message: asString(body.message) ?? '',
                sha: asString(body.sha),
              });
              sendJson(res, 200, { commit: { sha: result.commit.sha } });
            });
          },
        };
      }
    } else if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'POST') {
        route = {
          auth: true,
          run: async () => {
            const body = await readJsonBody();
            if (body === null) return;
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            storeGuard(() => {
              const label = store.createLabel(repo, {
                name: asString(body.name) ?? '',
                color: asString(body.color),
                description: asString(body.description),
              });
              sendJson(res, 201, label);
            });
          },
        };
      } else if (method === 'GET') {
        route = {
          auth: true,
          run: async () => {
            const repo = requireOwnedRepo(owner, repoName);
            if (repo) sendJson(res, 200, store.listLabels(repo));
          },
        };
      }
    } else if (rest.length === 1 && rest[0] === 'issues') {
      if (method === 'GET') {
        route = {
          auth: true,
          run: async () => {
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            const stateParam = searchParams.get('state') ?? 'open';
            const state: 'open' | 'closed' | 'all' =
              stateParam === 'closed' || stateParam === 'all' ? stateParam : 'open';
            let issues = store.listIssues(repo, state);
            if (searchParams.get('sort') === 'created') {
              const direction = searchParams.get('direction') ?? 'desc';
              issues = [...issues].sort((a, b) =>
                direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq,
              );
            }
            sendJson(res, 200, issues.map(issueObject));
          },
        };
      } else if (method === 'POST') {
        route = {
          auth: true,
          run: async () => {
            const body = await readJsonBody();
            if (body === null) return;
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            const labels = body.labels === undefined ? undefined : asStringArray(body.labels);
            if (body.labels !== undefined && labels === undefined) {
              sendError(res, 422, 'labels must be an array of label names');
              return;
            }
            storeGuard(() => {
              const issue = store.createIssue(repo, {
                title: asString(body.title) ?? '',
                body: asString(body.body),
                labels,
              });
              sendJson(res, 201, issueObject(issue));
            });
          },
        };
      }
    } else if (rest.length === 2 && rest[0] === 'issues') {
      const number = parseIssueNumber(rest[1]!);
      if (number === null) {
        route = fail(404, 'Not Found');
      } else if (method === 'GET') {
        route = {
          auth: true,
          run: async () => {
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            storeGuard(() => {
              const issue = store.requireIssue(repo, number);
              sendJson(res, 200, issueObject(issue));
            });
          },
        };
      } else if (method === 'PATCH') {
        route = {
          auth: true,
          run: async () => {
            const body = await readJsonBody();
            if (body === null) return;
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            const state = asString(body.state);
            if (state !== undefined && state !== 'open' && state !== 'closed') {
              sendError(res, 422, 'state must be "open" or "closed"');
              return;
            }
            storeGuard(() => {
              const issue = store.requireIssue(repo, number);
              if (asString(body.title) !== undefined) issue.title = asString(body.title)!;
              if (asString(body.body) !== undefined) issue.body = asString(body.body)!;
              if (state !== undefined) store.setIssueState(repo, number, state);
              sendJson(res, 200, issueObject(issue));
            });
          },
        };
      }
    } else if (rest.length === 3 && rest[0] === 'issues' && rest[2] === 'comments') {
      const number = parseIssueNumber(rest[1]!);
      if (number === null) {
        route = fail(404, 'Not Found');
      } else if (method === 'POST') {
        route = {
          auth: true,
          run: async () => {
            const body = await readJsonBody();
            if (body === null) return;
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            const commentBody = asString(body.body);
            if (!commentBody) {
              sendError(res, 422, 'body is required');
              return;
            }
            storeGuard(() => {
              const comment = store.addComment(repo, number, commentBody);
              sendJson(res, 201, { id: comment.id, body: comment.body, created_at: comment.createdAt });
            });
          },
        };
      } else if (method === 'GET') {
        route = {
          auth: true,
          run: async () => {
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            storeGuard(() => {
              const comments = store.listComments(repo, number);
              sendJson(
                res,
                200,
                comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt })),
              );
            });
          },
        };
      }
    } else if (rest.length === 1 && rest[0] === 'pulls') {
      if (method === 'GET') {
        route = {
          auth: true,
          run: async () => {
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            const stateParam = searchParams.get('state') ?? 'open';
            const state: 'open' | 'closed' | 'all' =
              stateParam === 'closed' || stateParam === 'all' ? stateParam : 'open';
            sendJson(res, 200, store.listPulls(repo, state).map(pullObject));
          },
        };
      } else if (method === 'POST') {
        route = {
          auth: true,
          run: async () => {
            const body = await readJsonBody();
            if (body === null) return;
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            storeGuard(() => {
              const pr = store.createPull(repo, {
                title: asString(body.title) ?? '',
                body: asString(body.body),
                head: asString(body.head) ?? '',
                base: asString(body.base) ?? '',
              });
              sendJson(res, 201, pullObject(pr));
            });
          },
        };
      }
    } else if (rest.length === 2 && rest[0] === 'pulls') {
      const number = parseIssueNumber(rest[1]!);
      if (number === null) {
        route = fail(404, 'Not Found');
      } else if (method === 'GET') {
        route = {
          auth: true,
          run: async () => {
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            storeGuard(() => {
              const pr = store.requirePull(repo, number);
              sendJson(res, 200, pullObject(pr));
            });
          },
        };
      }
    } else if (rest.length === 3 && rest[0] === 'pulls' && rest[2] === 'files' && method === 'GET') {
      const number = parseIssueNumber(rest[1]!);
      if (number === null) {
        route = fail(404, 'Not Found');
      } else {
        route = {
          auth: true,
          run: async () => {
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            storeGuard(() => {
              const pr = store.requirePull(repo, number);
              sendJson(
                res,
                200,
                pr.files.map((file) => ({
                  filename: file.filename,
                  status: file.status,
                  additions: file.additions,
                  deletions: file.deletions,
                  changes: file.changes,
                })),
              );
            });
          },
        };
      }
    } else if (rest.length === 3 && rest[0] === 'pulls' && rest[2] === 'merge' && method === 'PUT') {
      const number = parseIssueNumber(rest[1]!);
      if (number === null) {
        route = fail(404, 'Not Found');
      } else {
        route = {
          auth: true,
          run: async () => {
            const body = await readJsonBody();
            if (body === null) return;
            const repo = requireOwnedRepo(owner, repoName);
            if (!repo) return;
            storeGuard(() => {
              const result = store.mergePullSquash(repo, number);
              sendJson(res, 200, { merged: result.merged, sha: result.sha, message: result.message });
            });
          },
        };
      }
    }
  }

  // No known route under /api/v3: answer 404 JSON ourselves (with request id),
  // rather than falling through to a handler that would omit the header.
  if (route === null) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  // Auth: required on every claimed /api/v3 route when a token is configured.
  if (route.auth) {
    const configured = process.env.MAKEFUN_SHOP_TOKEN;
    if (configured) {
      const header = req.headers.authorization ?? '';
      if (header !== `Bearer ${configured}`) {
        sendError(res, 401, 'Requires authentication');
        return true;
      }
    }
  }

  await route.run();
  return true;
}
