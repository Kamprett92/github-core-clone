# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Kamprett92/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Kamprett92/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process, no UI, no outside service, no `git` binary: git smart HTTP (upload-pack protocol v2, receive-pack v0), REST v3, GraphQL v4, and MCP over streamable HTTP — all served from one in-memory store. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The program binds an ephemeral port, registers it with the harness env (`POST $MAKEFUN_ENV_URL/register {"port": N}`), serves until the env says done (`GET $MAKEFUN_ENV_URL/done`), then exits 0. It needs `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` in its environment. Node 22.18 or later, standard library only — there is nothing to install.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll done, exit 0). Kept as the harness defines it.
- `app.ts` — the HTTP server: one `Store` per server, routes `/healthz`, `/api/v3/`, `/api/graphql`, `/mcp`, `/{owner}/{repo}.git/...`, `/api/v3/*`, else a JSON 404.
- `lib/store.ts` — the shared in-memory store: fixed scenario users (viewer `adaiversen`, id 1000), repos, refs, objects, labels, issues, comments, pull requests with squash merge.
- `lib/git.ts` — the git protocol core: SHA-1 objects, packfile v2 write + v2/v3 read with OFS/REF delta resolution, pkt-lines, sideband framing, reachability, fetch planning.
- `lib/git-http.ts` — smart HTTP: v2 upload-pack advertisement + `ls-refs`/`fetch`, v0 receive-pack with per-ref fast-forward checks and mixed-push reports.
- `lib/rest.ts` — REST v3: repos, branches, commits, refs, contents, labels, issues, comments, pulls, squash merge. Every reply is JSON with a non-empty `X-GitHub-Request-Id`.
- `lib/graphql.ts` — GraphQL v4: the documents `gh` and `github-mcp-server` send, introspection for Issue/PullRequest/Repository/SearchType, batched operations, stable global ids.
- `lib/mcp.ts` — MCP over streamable HTTP (revision 2026-07-28, legacy `initialize` also supported): `server/discover`, `tools/list`, and the six tools `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.
- `STORE_API.md` — the documented API of every lib module.
- `DESIGN.md` — the design notes behind the forge.
- `LICENSE` — MIT.

## Local verification

The kit's sealed suite runs locally against a running entry (no Docker needed):

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:1 MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types main.ts
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:<PORT> --token test-token-123 --perf --json
```

Local result, 2026-11-17: **120/120 checks pass — feature 600, agent 200, perf 191, score 991/1000** (push 50, clone 45, read 50, write 46 points). No wall-clock time or unseeded randomness anywhere in the entry: ids are sequential counters and timestamps come from `MAKEFUN_TRIAL_NOW` or a fixed constant, so a replayed run exports byte-identical state.

Local result, v3 (2026-11-18): `lib/git.ts`, `lib/git-http.ts`, `main.ts` and `tsconfig.json` were rewritten fresh from `STORE_API.md`, without reading the earlier implementations — the previous replacement was rejected at intake because its build session had read the old files first, so almost none of its lines counted as authored. Same behaviour, same wire bytes. Two clean runs against a fresh server each time, `MAKEFUN_SHOP_TOKEN=test-token-123` set: **120/120 checks pass both times — perf 189 then 190/200** (push 50, clone 44 then 45, read 50, write 45), i.e. score ~990/1000, the same level as v1. Honest caveat: perf 200/200 cannot be verified from this VM — the remaining clone/write time is the VM's per-request HTTP floor (a bare `/healthz` already costs ~1 ms/request), not handler CPU, and the clone/write medians move ±30–50% between runs on this machine.

---

<sub>Entered on [make.fun](https://make.fun/?ref=t1yg6scf&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
