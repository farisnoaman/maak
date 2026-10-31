/**
 * Writes `apps/web/.env.local` for the dev stack, once.
 *
 * `.env.local` is git-ignored (as it must be), so a fresh clone has no Supabase URL and the app
 * falls back to preview fixtures. This script is the one-command way out, and it never overwrites a
 * file that already exists — someone pointing at a real project should not lose that by accident.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = join(root, 'apps', 'web', '.env.local');

const CONTENT = `# Local dev backend — see docs/dev-database.md
#
# The URL is *relative on purpose*: the browser then calls the same origin that served the app, and
# Next rewrites /supabase/* to the dev backend. That is what makes the hosted preview work — a
# browser inside it cannot resolve http://localhost:54321.
NEXT_PUBLIC_SUPABASE_URL=/supabase
NEXT_PUBLIC_SUPABASE_ANON_KEY=maak-dev-anon-key
MAAK_SUPABASE_INTERNAL=http://127.0.0.1:54321
`;

/**
 * Writes `apps/web/.env.local` if it is missing, and reports whether it had to.
 *
 * Exported so `scripts/dev.mjs` can call it before starting Next. That matters more than it sounds:
 * the file is git-ignored, so it does not survive a fresh clone *or a sandbox snapshot* — and without
 * it the app starts in preview-fixture mode, where every sign-in looks like it did nothing. Healing it
 * at startup turns that into a one-line log message instead of an afternoon of guessing.
 */
export async function ensureWebEnv({ quiet = false } = {}) {
  if (existsSync(target)) {
    if (!quiet) console.log('▸ apps/web/.env.local already exists — left untouched.');
    return false;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, CONTENT);
  console.log('▸ wrote apps/web/.env.local');
  return true;
}

// Only when run directly; importing this module (from `dev.mjs`) must not print or write anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await ensureWebEnv();
  console.log('  next: npm run dev:api   (terminal 1)');
  console.log('        npm run dev       (terminal 2)');
  console.log('  sign in: admin@maak.test / Maak!2026');
}
