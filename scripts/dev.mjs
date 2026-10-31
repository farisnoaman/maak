/**
 * One command that brings up the whole local stack: PostgreSQL + the dev API, then the web app.
 *
 * The reason this exists: the database, the API and Next are three processes, and the preview only
 * survives if *all* of them are alive. Starting them separately meant a resumed sandbox could show a
 * working site that quietly could not sign anyone in — "maybe the database is not found" is exactly
 * what that looks like from the outside.
 *
 *   npm run dev          # database + API + web, Ctrl-C stops all three
 *   npm run dev -- --web-only
 */

import { spawn } from 'node:child_process';
import { ensureWebEnv } from './dev-backend/setup-env.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webOnly = process.argv.includes('--web-only');
/**
 * `--reset` drops the dev database and replays every migration. Editing an already-applied migration
 * is otherwise invisible: the ledger records file *names*, so a changed file is neither re-run nor
 * noticed — and schema and code silently disagree.
 */
const reset = process.argv.includes('--reset');
const children = [];
let shuttingDown = false;

function run(label, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const forward = (stream, out) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(`[${label}] ${line}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${label}] exited (${signal ?? code}) — stopping the stack`);
    shutdown(code ?? 1);
  });

  children.push({ label, child });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** Waits for a TCP port to accept a connection. */
async function waitForPort(port, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const reachable = await new Promise((resolve) => {
      import('node:net').then(({ connect }) => {
        const socket = connect({ host: '127.0.0.1', port }, () => {
          socket.end();
          resolve(true);
        });
        socket.on('error', () => resolve(false));
        socket.setTimeout(1000, () => {
          socket.destroy();
          resolve(false);
        });
      });
    });
    if (reachable) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

if (!webOnly) {
  console.log('▸ starting the dev database and API …');
  run('db', process.execPath, ['scripts/dev-backend/server.mjs', ...(reset ? ['--reset'] : [])]);

  // Next must not compile before the API exists, or the first sign-in is the thing that discovers it.
  const ready = await waitForPort(54321);
  if (!ready) {
    console.error('✖ the dev API did not start — see the [db] lines above');
    shutdown(1);
  }
  console.log('▸ API ready on http://0.0.0.0:54321');
}

// Next reads `apps/web/.env.local` at boot. It is git-ignored, so a resumed sandbox or a fresh clone
// has no Supabase URL — and an app with no backend is an app whose sign-in does nothing. Write it here,
// in the one place that starts the web app.
await ensureWebEnv({ quiet: true });

console.log('▸ starting the web app …');

/**
 * A stamp for *this* dev process, baked into the HTML and served by `/api/version`.
 *
 * A tab that stays open across an edit can hold a document rendered by a build that no longer exists,
 * and hydrate it with chunks from the new one — which React reports as a hydration mismatch and refuses
 * to patch up. Nothing in the render can prevent that; the tab has to notice and reload itself. The
 * stamp is what lets it notice.
 */
const build = Date.now().toString(36);
run('web', 'npm', ['--workspace', '@maak/web', 'run', 'dev'], {
  // Read by the server (`/api/version`, the `data-build` attribute) …
  MAAK_BUILD: build,
  // … and inlined into the client chunks by Next, so a tab can compare the two and notice that the
  // JavaScript it is running predates the document it is showing.
  NEXT_PUBLIC_MAAK_BUILD: build,
});
