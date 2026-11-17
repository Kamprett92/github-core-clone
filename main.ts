// How this process works with the trial environment.
//
// The environment owns port 8080 and runs the trial there. This process is
// the other side of that conversation: it starts the contest server on a
// port the kernel picks for it, announces that port to the environment, and
// then waits until the environment says the trial is over. The score comes
// entirely from the server (app.ts); this file only has to get the server
// in front of the suite and stay out of the way until the end.
//
// The steps, in order:
//
//   * Find the environment. MAKEFUN_ENV_URL holds its address. If the
//     variable is empty there is nothing to announce to, so the process
//     stops at once with a failure exit.
//   * Start the server on port 0. The kernel assigns a free port, which
//     is never 8080 — that port belongs to the environment.
//   * Announce the chosen port with a POST to /register carrying
//     {"port": <port>}. A 200 means the environment accepted it; a 409
//     means another entry got there first, which is fine — this process
//     just waits like any other. A 400 or 405 means the request was
//     malformed, so retrying is pointless and the process fails. Any
//     other outcome (connection refused, timeout, odd status) is retried
//     with a growing pause, because the environment may still be starting.
//   * Ask /done over and over until the answer is {"done": true}. A
//     failed or "not yet" answer just means asking again a little later.
//   * Close the server and leave with exit code 0. The harness then
//     stops the environment and reads the trial export from it.

import { createApp } from "./app.ts";

/** The longest one env call may run before it is treated as failed. */
const CALL_TIMEOUT_MS = 30_000;
/** First pause between retries, and the longest pause. */
const FIRST_BACKOFF_MS = 250;
const LONGEST_BACKOFF_MS = 2_000;
/** Registration answers that mean "done": accepted, or already registered. */
const REGISTRATION_OK = new Set([200, 409]);
/** Registration answers that mean "the request itself is wrong": give up. */
const REGISTRATION_FATAL = new Set([400, 405]);

/** Print a message and leave with a failure exit; never returns. */
function die(message: string): never {
  process.stderr.write(`github-core-clone entry: ${message}\n`);
  process.exit(1);
}

const pause = (ms: number): Promise<void> =>
  new Promise((wake) => setTimeout(wake, ms));

/** Pause after `failures` consecutive failures: doubles from 250 ms, stops at 2 s. */
function backoffAfter(failures: number): number {
  return Math.min(LONGEST_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.min(failures, 3));
}

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (envOrigin === "") {
  die("MAKEFUN_ENV_URL is not set, so there is no environment to register with");
}

/** Tell the environment which port this process listens on. */
async function announcePort(port: number): Promise<void> {
  const announcement = JSON.stringify({ port });
  let failures = 0;
  for (;;) {
    const response = await fetch(`${envOrigin}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: announcement,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    }).catch(() => null);
    if (response === null) {
      await pause(backoffAfter(failures));
      failures += 1;
      continue;
    }
    if (REGISTRATION_OK.has(response.status)) return;
    if (REGISTRATION_FATAL.has(response.status)) {
      die(`registration rejected with HTTP ${response.status}: ${await response.text()}`);
    }
    await pause(backoffAfter(failures));
    failures += 1;
  }
}

/** Keep asking /done until the environment reports the trial finished. */
async function awaitCompletion(): Promise<void> {
  let failures = 0;
  for (;;) {
    const response = await fetch(`${envOrigin}/done`, {
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    }).catch(() => null);
    if (response !== null && response.ok) {
      const payload = (await response.json().catch(() => null)) as { done?: unknown } | null;
      if (payload !== null && payload.done === true) return;
    }
    await pause(backoffAfter(failures));
    failures += 1;
  }
}

/** Start the server on a kernel-chosen port, register it, and wait for done. */
async function run(): Promise<void> {
  const appServer = createApp();
  await new Promise<void>((ready, failed) => {
    appServer.once("error", failed);
    appServer.listen(0, ready);
  });
  const bound = appServer.address();
  if (bound === null || typeof bound === "string") {
    die("the server did not bind a TCP port");
  }
  process.stdout.write(`github-core-clone entry: serving on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write("github-core-clone entry: registered, waiting for the trial to finish\n");

  await awaitCompletion();
  appServer.close();
  process.stdout.write("github-core-clone entry: trial finished, shutting down\n");
}

run().then(
  () => process.exit(0),
  (problem: unknown) => {
    const detail = problem instanceof Error ? problem.message : String(problem);
    process.stderr.write(`github-core-clone entry: ${detail}\n`);
    process.exit(1);
  },
);
