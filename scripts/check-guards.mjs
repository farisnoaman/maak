#!/usr/bin/env node
/**
 * Guard checks that protect the architecture promises made in the docs.
 *
 * Dependency-free on purpose: these run in CI before anything else and must never be the reason
 * a build is slow or flaky. Each check fails the build with an actionable message.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

async function walk(dir, predicate, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        ['node_modules', '.next', 'dist', 'build', '_bundled', '.git', 'coverage'].includes(
          entry.name,
        )
      )
        continue;
      await walk(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function rel(path) {
  return relative(root, path);
}

/* 1. packages/core stays framework-free (ADR-01). */
const coreFiles = await walk(join(root, 'packages', 'core', 'src'), (f) => f.endsWith('.ts'));
const FORBIDDEN = [
  /from ['"]react['"]/,
  /from ['"]react-native['"]/,
  /from ['"]next/,
  /from ['"]expo/,
  /from ['"]@supabase\//,
];
for (const file of coreFiles) {
  const source = await readFile(file, 'utf8');
  for (const pattern of FORBIDDEN) {
    if (pattern.test(source)) {
      failures.push(`${rel(file)}: packages/core must stay framework-free (matched ${pattern})`);
    }
  }
}

/* 2. No physical-direction CSS: RTL must stay free (ADR-16). */
const styleFiles = await walk(join(root, 'apps'), (f) =>
  ['.css', '.scss', '.tsx'].includes(extname(f)),
);
const PHYSICAL = [
  [/\bmargin-(left|right)\s*:/, 'margin-inline-start/end'],
  [/\bpadding-(left|right)\s*:/, 'padding-inline-start/end'],
  [/\b(float|clear)\s*:\s*(left|right)\b/, 'logical flow (no float)'],
  [/[^-]\b(text-align)\s*:\s*(left|right)\b/, 'text-align: start/end'],
  [/(?:^|[;{\s])(left|right)\s*:\s*-?\d/, 'inset-inline-start/end'],
  [/\bborder-(left|right)\s*:/, 'border-inline-start/end'],
];
for (const file of styleFiles) {
  const source = await readFile(file, 'utf8');
  const lines = source.split('\n');
  lines.forEach((lineText, index) => {
    if (lineText.trimStart().startsWith('*') || lineText.trimStart().startsWith('//')) return;
    // Custom properties and keyframe names are data, not layout.
    if (/--(left|right)/.test(lineText)) return;
    for (const [pattern, replacement] of PHYSICAL) {
      if (pattern.test(lineText)) {
        failures.push(
          `${rel(file)}:${index + 1}: use a logical property (${replacement}) — ${lineText.trim()}`,
        );
      }
    }
  });
}

/* 3. The service role key must never reach a client bundle (ADR-17). */
const clientArtefacts = await walk(
  join(root, 'apps'),
  (f) => f.endsWith('.js') && (f.includes('.next/static') || f.includes('/dist/')),
);
for (const file of clientArtefacts) {
  const source = await readFile(file, 'utf8');
  if (/SUPABASE_SERVICE_ROLE_KEY|service_role/.test(source)) {
    failures.push(`${rel(file)}: a service-role key reference leaked into a client bundle`);
  }
}

/* 4. Every edge function must be bundling-safe: no relative imports escaping its folder. */
const functionDirs = await readdir(join(root, 'supabase', 'functions'), { withFileTypes: true });
for (const entry of functionDirs) {
  if (!entry.isDirectory() || ['_shared', '_bundled'].includes(entry.name)) continue;
  const files = await walk(join(root, 'supabase', 'functions', entry.name), (f) =>
    f.endsWith('.ts'),
  );
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/from ['"](\.\.\/\.\.\/(?!packages)[^'"]+)['"]/g)) {
      failures.push(
        `${rel(file)}: imports outside the function folder (${match[1]}); use @maak/core or _shared`,
      );
    }
  }
}

/* 5. No `select('*')` in edge functions: response shapes must be explicit (§11). */
const edgeFiles = await walk(
  join(root, 'supabase', 'functions'),
  (f) => f.endsWith('.ts') && !f.includes('_bundled'),
);
for (const file of edgeFiles) {
  const source = await readFile(file, 'utf8');
  if (/\.select\(\s*['"]\*['"]\s*\)/.test(source)) {
    failures.push(
      `${rel(file)}: select('*') leaks new columns into responses; enumerate the fields`,
    );
  }
}

/* 6. Migrations must be numbered and forward-only. */
const migrations = await readdir(join(root, 'supabase', 'migrations'));
const badNames = migrations.filter((name) => !/^\d{5}_[a-z0-9_]+\.sql$/.test(name));
if (badNames.length > 0) {
  failures.push(`supabase/migrations: bad names ${badNames.join(', ')} (expected 00001_name.sql)`);
}

/* 7. Every notification title key written by SQL must exist in both dictionaries (BR-43).
      A missing key renders as "notifications.something" in the bell — a silent, user-visible bug. */
const dictionariesSource = await readFile(
  join(root, 'packages', 'core', 'src', 'i18n', 'dictionaries.ts'),
  'utf8',
);
const definedKeys = new Set(
  [...dictionariesSource.matchAll(/'((?:notifications|errors)\.[A-Za-z]+)':/g)].map((m) => m[1]),
);
const sqlSource = (
  await Promise.all(
    (await readdir(join(root, 'supabase', 'migrations')))
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFile(join(root, 'supabase', 'migrations', name), 'utf8')),
  )
).join('\n');

for (const key of new Set(
  [...sqlSource.matchAll(/'(notifications\.[A-Za-z]+)'/g)].map((m) => m[1]),
)) {
  if (!definedKeys.has(key)) {
    failures.push(`supabase/migrations: notification key '${key}' is not in dictionaries.ts`);
  }
}

/* 8. Every cmd_* a client-facing module can call must exist in a migration.
      A typo here is a runtime 500 the type system cannot see. */
const definedCommands = new Set(
  [...sqlSource.matchAll(/create or replace function public\.(cmd_[a-z0-9_]+)/g)].map((m) => m[1]),
);
const callers = [
  ...(await walk(join(root, 'packages', 'core', 'src', 'api'), (f) => f.endsWith('.ts'))),
  ...(await walk(
    join(root, 'supabase', 'functions'),
    (f) => f.endsWith('.ts') && !f.includes('_bundled'),
  )),
];
for (const file of callers) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/['"](cmd_[a-z0-9_]+)['"]/g)) {
    if (!definedCommands.has(match[1])) {
      failures.push(`${rel(file)}: calls ${match[1]}() which no migration defines`);
    }
  }
}

// --- 9. No page may reload itself ---------------------------------------------------------------
// A reload loop is destructive in a way that is hard to notice from a screenshot: it wipes whatever is
// typed into a form, so the user reports "the login screen clears itself" rather than "the page
// reloads". Auto-reloading was added once to recover from stale dev chunks and did exactly that. A
// reload must therefore be a user's action — triggered from a click handler, never from an effect.
for (const file of await walk(join(root, 'apps', 'web', 'src'), (f) => /\.(tsx|ts)$/.test(f))) {
  const source = await readFile(file, 'utf8');
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    if (!/location\.reload\(|location\.reload\b/.test(line)) return;
    // Allowed only when the surrounding statement is an event handler.
    const window = lines.slice(Math.max(0, index - 4), index + 2).join('\n');
    if (/onClick|onSubmit|onChange|addEventListener/.test(window)) return;
    failures.push(
      `${rel(file)}:${index + 1}: reloads the page outside an event handler — a self-reloading page ` +
        `destroys typed input; show a banner and let the user click instead`,
    );
  });
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} guard failure(s):\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `✓ guards passed (${coreFiles.length} core files, ${styleFiles.length} style files, ${migrations.length} migrations, ${definedCommands.size} commands)`,
);
