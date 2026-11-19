# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Kamprett92/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Kamprett92/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process, standard
library only. No UI, no outside service, no proxy, no git binary: the
suite is its only client.

## What it serves

One process, one in-memory store, four surfaces — every surface reads and
writes the same objects, so a repo created over MCP reads back over REST
with unchanged ids, an issue created over GraphQL closes over REST, and a
branch pushed over git is the head a PR merges:

- **Git smart HTTP** (`/{owner}/{repo}.git/...`): upload-pack protocol v2
  (and v0 fallback) for clone, fetch and push; receive-pack v0 with
  per-ref fast-forward checks. A non-fast-forward push is refused per ref
  with `ng <ref> non-fast-forward` while the good refs in the same push
  still apply.
- **REST v3** (`/api/v3`): repositories, git data (refs, branches,
  commits), contents, labels, issues, pull requests. Every reply is JSON
  and carries a non-empty `X-GitHub-Request-Id`; unknown routes are JSON
  404s, malformed JSON bodies are 400s, a missing or wrong token is 401,
  and the same repository name under another owner is 404, never 403.
  Merge is squash-only and lands a real commit on the default branch.
- **GraphQL v4** (`POST /api/graphql`): the documents `gh` and
  `github-mcp-server` send — viewer, repository fields, `__type`
  introspection, issue and pull-request reads, the create/close/merge
  mutations, cursor pagination, and operation batching. An unknown field
  is HTTP 200 with an `errors` array naming it; an unknown repository is
  `data.repository = null` with no errors; unauthenticated is exactly 401.
- **MCP** (`POST /mcp`): JSON-RPC 2.0 over Streamable HTTP, revision
  2026-07-28 (`server/discover`, no handshake) with the legacy
  `initialize` handshake also answered. Six tools — `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request` — listed byte-identically on every call. Errors
  are JSON-RPC codes, never HTTP 500.

## Running it

Node 22 or later, nothing to install:

```sh
node --experimental-strip-types main.ts
```

The server binds an ephemeral port, registers it with the suite at
`$MAKEFUN_ENV_URL/register`, serves, and exits 0 when the suite's
`/done` answers `{"done": true}`. With no `MAKEFUN_ENV_URL` it just
serves until killed. `GET /healthz` answers 200 JSON.

The suite presents `Authorization: Bearer <token>` with the token in
`MAKEFUN_SHOP_TOKEN`; a request without it is 401 on every surface that
takes one. With the variable unset, all requests are allowed (local
development).

## Layout

- `main.ts` — entrypoint and harness lifecycle (bind, register, wait for done).
- `app.ts` — wiring: one `Store` per server, the four handlers in
  dispatch order, `/healthz` and the `/api/v3` root, JSON 404/500.
- `lib/store.ts` — the shared in-memory store: repos, objects, refs,
  contents, labels, issues, pull requests, squash merge.
- `lib/git.ts` — git objects, packfiles, pkt-lines, sideband, fetch planning.
- `lib/git-http.ts` — the smart-HTTP git handlers.
- `lib/rest.ts` — the REST v3 surface.
- `lib/graphql.ts` — the GraphQL v4 surface (tokenizer, parser, validator,
  executor).
- `lib/mcp.ts` — the MCP endpoint and its six tools.
- `STORE_API.md` — the API spec every module is derived from.
- `DESIGN.md` — how the forge is built and why it is shaped this way.

## Determinism

The final runs every contender twice (live, then replayed) and the two
state exports must be byte-identical. So the entry contains no wall-clock
time and no randomness anywhere observable: timestamps come from
`MAKEFUN_TRIAL_NOW` or a fixed constant, ids are sequential counters,
request ids are a sequential hex counter, pack entries and tool lists are
emitted in fixed order.

## Verification

The kit's sealed local suite (`sdk/run.ts --perf`) against a fresh server:
**120/120 checks on two clean runs** — git 30/30, repos 15/15, issues
15/15, pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15 — feature
600, agent 200. Perf on this VM measured 89–92/200 (push ~1.2 s,
clone ~0.4 s, read ~3.4–3.8 s, write ~0.36–0.41 s), score 889–892:
the box's per-request HTTP floor is ~2 ms even for a bare `/healthz`,
so the perf column here is floor-bound, not code-bound (the v1 entry
measured 191/200 on the same suite on a quieter day).

---

<sub>Entered on [make.fun](https://make.fun/?ref=t1yg6scf&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
