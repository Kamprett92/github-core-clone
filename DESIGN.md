# DESIGN.md — github-core-clone

How the forge is built and why it is shaped this way.

## One process, one store, four surfaces

`app.ts` creates a single `Store` per server and mounts four handlers on it:
`handleGit` (smart HTTP), `handleRest` (REST v3), `handleGraphql` (GraphQL v4),
`handleMcp` (MCP). Every surface reads and writes the same objects, so a repo
created over MCP reads back over REST with unchanged ids, an issue created over
GraphQL closes over REST, and a branch pushed over git is the head a PR merges.
There is no second source of truth to drift.

## The store is the spec's scenario, hardcoded

The suite's data is deterministic from one fixed seed (`SCENARIO_SEED =
0x6a09e667f3bcc909`). The token owner is always `adaiversen` (id 1000); the
token itself is opaque and encodes nothing. The store therefore seeds the fixed
users (viewer, teammate, stranger, org, nine more) and the six default labels
as data, never guessing a login from the token at runtime.

## Git without git

`lib/git.ts` implements the object model from first principles on `node:crypto`
(SHA-1) and `node:zlib`: blob/tree/commit/tag encoding, packfile v2 write
(undelted objects — the suite accepts that) and v2/v3 read with full
OFS_DELTA/REF_DELTA resolution (the client *sends* deltas on push, so reads
must resolve them), pkt-lines, sideband framing, reachability and fetch
planning (`planFetch`: what the client holds, what is new, shallow boundaries).

Two details the real `git` binary taught us (verified byte-for-byte against
`git upload-pack --stateless-rpc`):
- A v0 shallow-clone request (`want + deepen + flush`, no haves) is answered
  with only a `shallow` list + flush — no NAK. An extra NAK is read as the
  next round's shallow list and breaks the clone.
- The v0 advertisement must include `deepen-relative`, or `fetch --deepen`
  on an existing shallow clone is refused as unsupported.

Receive-pack is v0 only, with per-ref fast-forward checks: a non-fast-forward
ref is refused with `ng <ref> non-fast-forward` while the good refs in the
same push still apply, one report line each.

## REST is the contract, literally

`lib/rest.ts` follows RULES.txt's wire contract route by route: JSON on every
reply (never HTML), a non-empty `X-GitHub-Request-Id` on every reply, 401 for
a missing/wrong token, 404 (never 403) for a foreign owner, 400 for malformed
JSON, real `Link: rel="next"` pagination. Contents use the blob sha for the
`sha` field (create 201, update 200, stale sha 409); merge is squash-only and
lands a real commit on the default branch with the PR's content.

## GraphQL is a targeted executor, not a general engine

`lib/graphql.ts` has a small tokenizer + parser for the exact documents `gh`
and `github-mcp-server` send, plus generic `__type` introspection for the
probed names. Unknown fields are HTTP 200 with an `errors` array; an unknown
repository is `data.repository = null` with no errors; unauthenticated is
exactly 401. Global ids are the store's own (`R_…` / `I_…` / `PR_…`), stable
across reads and surfaces. Issue/PR connections default to OPEN-only, matching
GitHub and the suite's "open list" wording.

## MCP is the modern era, with the legacy door open

`lib/mcp.ts` speaks revision 2026-07-28 (no handshake; `server/discover`
returns the supported version list) and also answers legacy `initialize`.
`tools/list` returns exactly the six required tools, byte-identical on every
call, with `required` set to exactly the documented arguments. Tool results
are `content: [{type: "text", text: <JSON>}]` so the suite's text searches
find titles and `"number": N`. Errors are JSON-RPC codes, never HTTP 500
(unknown tool -32602, missing arg `isError: true`, non-JSON body HTTP 400 +
-32700, no auth 401). Every request answers in well under the 3-second limit.

## Determinism is a correctness property, not a nicety

The final runs every contender twice (live, then replayed) and the two state
exports must be byte-identical, or the entry is listed and unranked. So the
entry contains no `Date.now()`, no `Math.random()`, no random UUIDs anywhere
observable: ids are sequential counters, timestamps come from
`MAKEFUN_TRIAL_NOW` or a fixed constant, pack entries and tool lists are
emitted in fixed order. The `perf.json` timings live outside `state.json`
by the harness's own design, which is what makes replay possible at all.

## Performance: fast by construction

No whole-history buffering, no quadratic scans: pack building walks only the
objects the fetch needs, issue reads are array-indexed, the store is plain
`Map`s. Local calibrated medians: push 400 ms (T_ref 1641), clone 89 ms
(T_ref 267), read 664 ms (T_ref 2760), write 109 ms (T_ref 349) — 191/200
perf points with no dedicated optimization pass.
