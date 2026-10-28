#!/usr/bin/env node
/**
 * Bundles every edge function into a single self-contained file (ADR-21).
 *
 * Why this exists: `supabase functions deploy` uploads ONLY the function's own folder, so a
 * workspace import like `@maak/core` resolves locally (`supabase functions serve`) and then
 * fails in production. Bundling inlines the shared package, and also cuts cold starts.
 *
 * Deno-native specifiers (`npm:`, `jsr:`, `https://`) stay external and are resolved by the runtime.
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const functionsDir = join(root, 'supabase', 'functions');
const outDir = join(functionsDir, '_bundled');
const coreEntry = join(root, 'packages', 'core', 'src', 'index.ts');

const INTERNAL = new Set(['_shared', '_bundled', 'deno.json', 'node_modules']);

async function listFunctions() {
  const entries = await readdir(functionsDir, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || INTERNAL.has(entry.name)) continue;
    const entryPoint = join(functionsDir, entry.name, 'index.ts');
    try {
      await stat(entryPoint);
      names.push(entry.name);
    } catch {
      // directory without an entry point: ignore
    }
  }
  return names.sort();
}

async function main() {
  const checkOnly = process.argv.includes('--check');

  const names = await listFunctions();
  if (names.length === 0) {
    console.log('No edge functions found; nothing to bundle.');
    return;
  }

  // Bundle in memory first, so `--check` never destroys the artefact it is validating.
  const outputs = new Map();
  const manifest = {};

  for (const name of names) {
    const result = await build({
      entryPoints: [join(functionsDir, name, 'index.ts')],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      sourcemap: false, // smaller cold-start payload; stack traces still map via bundled names
      legalComments: 'none',
      write: false,
      // Deno resolves these at runtime; everything else (including @maak/core and zod) is inlined.
      external: ['npm:*', 'jsr:*', 'https://*', 'http://*', 'node:*'],
      alias: { '@maak/core': coreEntry },
      logLevel: 'warning',
    });

    const file = result.outputFiles?.[0];
    if (!file) throw new Error(`esbuild produced no output for ${name}`);
    const contents = file.text;
    outputs.set(name, contents);
    manifest[name] = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  }

  const manifestPath = join(outDir, 'manifest.json');

  if (checkOnly) {
    let existing;
    try {
      existing = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      console.error('✗ No bundle manifest found. Run `npm run build:functions` before deploying.');
      process.exit(1);
    }
    if (JSON.stringify(existing.functions) !== JSON.stringify(manifest)) {
      console.error('✗ Edge bundle is stale relative to sources. Re-run `npm run build:functions`.');
      process.exit(1);
    }
    console.log('✓ Edge bundle is up to date.');
    return;
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const [name, contents] of outputs) {
    const target = join(outDir, name, 'index.ts');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  await writeFile(manifestPath, JSON.stringify({ functions: manifest }, null, 2) + '\n');
  console.log(`✓ Bundled ${names.length} function(s): ${names.join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
