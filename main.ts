// main.ts — the entry point: the lifecycle between this server and the
// harness that runs it.
//
// The harness hands us MAKEFUN_ENV_URL. We start the forge on an ephemeral
// port, tell the harness where we are (POST /register, carrying our port),
// then wait until the harness says the run is over (GET /done answering
// {"done": true}). Then we shut down and exit 0.
//
// The harness is a network service like any other, so every call to it is
// retried with a pause that doubles from 250 ms up to 2 s. Two answers mean
// "registered, stop trying": 200 and 409. 400 and 405 mean the harness
// rejected the registration outright and will never accept it, so those are
// fatal at once. Anything else — a timeout, a 5xx, a connection reset — is
// retried the same way. The /done poll treats a non-true answer as "not
// yet" and keeps polling.

import type { Server } from 'node:http';
import { createApp } from './app.ts';

const CALL_TIMEOUT_MS = 30_000;
const FIRST_PAUSE_MS = 250;
const MAX_PAUSE_MS = 2000;

/** Wait this long before the next attempt. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One JSON call to the harness with a 30-second timeout. Returns the raw
 * response — the caller decides which statuses are success, fatal, or
 * worth another try. Throws only when the call itself fails (timeout,
 * refused connection, aborted).
 */
async function callHarness(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The next pause after `pause`, doubling up to the cap. */
function nextPause(pause: number): number {
  return Math.min(pause * 2, MAX_PAUSE_MS);
}

/**
 * Register this server's port with the harness. 200 and 409 both mean the
 * registration landed; 400 and 405 mean it never will, so those are fatal.
 * A failed call or any other status is retried with the doubling pause.
 */
async function register(envUrl: string, port: number): Promise<void> {
  const target = `${envUrl.replace(/\/$/, '')}/register`;
  let pause = FIRST_PAUSE_MS;
  for (;;) {
    let response: Response;
    try {
      response = await callHarness(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch (error) {
      console.log(
        `register failed (${error instanceof Error ? error.message : String(error)}), retrying in ${pause} ms`,
      );
      await sleep(pause);
      pause = nextPause(pause);
      continue;
    }
    if (response.status === 200 || response.status === 409) {
      console.log(`registered on port ${port} (${response.status})`);
      return;
    }
    if (response.status === 400 || response.status === 405) {
      throw new Error(`registration rejected by the harness (${response.status})`);
    }
    console.log(`register got ${response.status}, retrying in ${pause} ms`);
    await sleep(pause);
    pause = nextPause(pause);
  }
}

/**
 * Poll /done until the harness answers {"done": true}. A non-true answer
 * means "not yet"; a failed call or a bad body means "try again". Both
 * retry with the doubling pause.
 */
async function waitForDone(envUrl: string): Promise<void> {
  const target = `${envUrl.replace(/\/$/, '')}/done`;
  let pause = FIRST_PAUSE_MS;
  for (;;) {
    let done = false;
    try {
      const response = await callHarness(target, { method: 'GET' });
      if (!response.ok) throw new Error(`harness answered ${response.status} for GET ${target}`);
      const body = (await response.json()) as { done?: unknown };
      done = body.done === true;
    } catch (error) {
      console.log(
        `poll failed (${error instanceof Error ? error.message : String(error)}), retrying in ${pause} ms`,
      );
    }
    if (done) {
      console.log('harness reports done');
      return;
    }
    await sleep(pause);
    pause = nextPause(pause);
  }
}

/** Start the server on an ephemeral port and resolve with the port it got. */
function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server bound to an unexpected address'));
        return;
      }
      resolve(address.port);
    });
  });
}

/** Stop the server, waiting until it has actually closed. */
function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function run(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    throw new Error('MAKEFUN_ENV_URL is not set');
  }
  const server = createApp();
  const port = await listen(server);
  console.log(`listening on port ${port}`);
  try {
    await register(envUrl, port);
    await waitForDone(envUrl);
  } finally {
    await close(server);
  }
}

run()
  .then(() => {
    console.log('shut down cleanly');
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
