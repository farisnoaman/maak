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
import { fileURLToPath } from 'node:url';

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

if (existsSync(target)) {
  console.log('▸ apps/web/.env.local already exists — left untouched.');
} else {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, CONTENT);
  console.log('▸ wrote apps/web/.env.local');
}

console.log('  next: npm run dev:api   (terminal 1)');
console.log('        npm run dev       (terminal 2)');
console.log('  sign in: admin@maak.test / Maak!2026');
