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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webOnly = process.argv.includes('--web-only');
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
  run('db', process.execPath, ['scripts/dev-backend/server.mjs']);

  // Next must not compile before the API exists, or the first sign-in is the thing that discovers it.
  const ready = await waitForPort(54321);
  if (!ready) {
    console.error('✖ the dev API did not start — see the [db] lines above');
    shutdown(1);
  }
  console.log('▸ API ready on http://0.0.0.0:54321');
}

console.log('▸ starting the web app …');
run('web', 'npm', ['--workspace', '@maak/web', 'run', 'dev']);
