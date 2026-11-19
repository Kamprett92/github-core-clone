// main.ts — the entrypoint and harness lifecycle.
//
// The program binds an ephemeral port of its own, registers it with the
// suite (`POST $MAKEFUN_ENV_URL/register {"port": <port>}`), serves the
// forge, and long-polls `GET $MAKEFUN_ENV_URL/done` until the suite
// answers `{"done": true}`, then exits 0.
//
// The lifecycle is tolerant of a dummy environment URL (local runs): a
// register that never answers is retried for a while and then given up
// on, and the server keeps serving either way, so the entry boots cleanly
// with a dummy MAKEFUN_ENV_URL and serves /healthz. In a real trial the
// URL answers, registration succeeds on the first attempt, and the
// done-poll drives the exit.

import { createApp } from './app.ts';

/** The port to bind: $PORT when set, else 0 (the kernel picks one). */
function listenPort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 0;
}

/** The suite's base URL, when the trial provides one. */
function envUrl(): string | undefined {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed === '' ? undefined : trimmed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Register this process's port with the suite. Retries for a while; a
 * register that never answers (a dummy URL in a local run) resolves
 * false and the server simply keeps serving.
 */
async function register(base: string, port: number): Promise<boolean> {
  const url = `${base}/register`;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.status >= 200 && response.status < 300) return true;
      process.stderr.write(`register: ${url} answered HTTP ${response.status} (attempt ${attempt})\n`);
    } catch (err) {
      process.stderr.write(`register: ${url} did not answer (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}\n`);
    }
    await sleep(1000);
  }
  return false;
}

/**
 * Long-poll the suite's /done until it answers {"done": true}, then
 * resolve. A poll that errors (the suite is not there yet) waits and
 * retries; the loop only ends on a true answer.
 */
async function waitForDone(base: string): Promise<void> {
  const url = `${base}/done`;
  for (;;) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as Record<string, unknown>).done === true
      ) {
        return;
      }
    } catch {
      // The suite is not answering yet; wait and try again.
    }
    await sleep(1000);
  }
}

async function main(): Promise<void> {
  const app = createApp();
  const port = listenPort();
  const base = envUrl();

  const listening = new Promise<number>((resolve, reject) => {
    app.once('error', reject);
    app.listen(port, '0.0.0.0', () => {
      const address = app.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      resolve(bound);
    });
  });
  const boundPort = await listening;
  process.stdout.write(`github-core-clone listening on ${boundPort}\n`);

  if (base === undefined) {
    // No suite to register with (a local run): serve until killed.
    // Park forever: main() must not return while the server is serving,
    // or the process.exit(0) below would stop it.
    await new Promise(() => undefined);
    return;
  }

  const registered = await register(base, boundPort);
  if (!registered) {
    process.stderr.write('register: giving up after 30 attempts; serving without the suite\n');
    await new Promise(() => undefined);
    return;
  }
  process.stdout.write('registered with the suite; waiting for done\n');
  await waitForDone(base);
  process.stdout.write('suite is done; exiting\n');
  await new Promise<void>((resolve) => {
    app.close(() => resolve());
  });
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

await main();
process.exit(0);
