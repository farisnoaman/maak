#!/usr/bin/env node
/**
 * Database types: generation + drift detection.
 *
 * `supabase gen types` needs the CLI (and a database). CI and this sandbox may not have it, so the
 * committed types file carries a hash of the migrations it was generated from:
 *
 *   // migrations-sha256: <hash>
 *
 *  --write   regenerate with the CLI when available, otherwise re-stamp the current file
 *  --check   fail if migrations changed without the types being regenerated
 *
 * This makes "the types are stale" a build failure rather than a runtime surprise.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'supabase', 'migrations');
const typesPath = join(root, 'apps', 'web', 'src', 'lib', 'supabase', 'database.types.ts');
const HASH_PREFIX = '// migrations-sha256:';

async function migrationsHash() {
  const names = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name);
    hash.update(await readFile(join(migrationsDir, name)));
  }
  return { hash: hash.digest('hex'), count: names.length };
}

function hasSupabaseCli() {
  try {
    execFileSync('supabase', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function generateWithCli() {
  return execFileSync('supabase', ['gen', 'types', 'typescript', '--local'], {
    encoding: 'utf8',
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function readStamp() {
  try {
    const content = await readFile(typesPath, 'utf8');
    const firstLine = content.split('\n').find((line) => line.startsWith(HASH_PREFIX));
    return firstLine ? firstLine.slice(HASH_PREFIX.length).trim() : null;
  } catch {
    return null;
  }
}

async function main() {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  const { hash, count } = await migrationsHash();

  if (write) {
    let content;
    if (hasSupabaseCli()) {
      content = generateWithCli();
      console.log('✓ Generated types with the Supabase CLI');
    } else {
      content = await readFile(typesPath, 'utf8');
      content = content
        .split('\n')
        .filter((line) => !line.startsWith(HASH_PREFIX))
        .join('\n');
      console.log('• Supabase CLI not found: keeping the committed types and re-stamping the hash');
    }

    // Strip every existing banner before adding one: re-running --write must be idempotent.
    const body = content
      .replace(/^\uFEFF/, '')
      .split('\n')
      .filter((line) => !line.startsWith(HASH_PREFIX) && !line.startsWith('/* Generated from'))
      .join('\n')
      .replace(/^\n+/, '');

    const stamped = `${HASH_PREFIX} ${hash}\n/* Generated from ${count} migrations. Run \`npm run db:types\` after changing the schema. */\n\n${body}`;
    await writeFile(typesPath, stamped);
    return;
  }

  if (!check) {
    console.error('Usage: db-types.mjs [--write|--check]');
    process.exit(2);
  }

  const stamp = await readStamp();
  if (!stamp) {
    console.error('✗ database.types.ts has no migration hash. Run `npm run db:types`.');
    process.exit(1);
  }
  if (stamp !== hash) {
    console.error(
      `✗ Database types are stale.\n  migrations: ${hash.slice(0, 16)} (${count} files)\n  types:      ${stamp.slice(0, 16)}\n  Run \`npm run db:types\`.`,
    );
    process.exit(1);
  }

  console.log(`✓ database.types.ts matches ${count} migrations`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
