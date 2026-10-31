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

// --- 10. The dev gateway and the edge functions must agree on every action's capability -----------
// The two gateways are intentionally separate (one runs on Deno, one on Node), and that is exactly how
// `driver.setLicence` shipped into the edge function but not into the dev map: every call answered 403
// FORBIDDEN locally while the SQL was correct. A missing key is invisible to types in one file and to
// tests that talk to the other, so it is checked here, by name.
const GATEWAY_MAP = {
  bookings: 'BOOKINGS_CAPABILITY',
  fleet: 'FLEET_CAPABILITY',
  geography: 'GEO_CAPABILITY',
  payments: 'PAYMENTS_CAPABILITY',
  trips: 'TRIPS_CAPABILITY',
};
const gatewaySource = await readFile(join(root, 'scripts', 'dev-backend', 'gateway.mjs'), 'utf8');

function objectKeys(source, header) {
  const start = source.indexOf(header);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  const close = source.indexOf('\n};', open);
  if (open === -1 || close === -1) return null;
  const body = source.slice(open, close);
  return new Set([...body.matchAll(/^\s*'([a-zA-Z.]+)':/gm)].map((match) => match[1]));
}

for (const [fn, mapName] of Object.entries(GATEWAY_MAP)) {
  const edgePath = join(root, 'supabase', 'functions', fn, 'index.ts');
  const edgeSource = await readFile(edgePath, 'utf8').catch(() => null);
  if (!edgeSource) continue;

  const edgeKeys = objectKeys(edgeSource, 'const CAPABILITY');
  const gatewayKeys = objectKeys(gatewaySource, `const ${mapName} =`);
  if (!edgeKeys || !gatewayKeys) {
    failures.push(
      `${fn}: could not read the capability map (${edgeKeys ? mapName : 'edge CAPABILITY'})`,
    );
    continue;
  }

  for (const key of edgeKeys) {
    if (!gatewayKeys.has(key)) {
      failures.push(
        `scripts/dev-backend/gateway.mjs: ${mapName} is missing '${key}', which supabase/functions/${fn} accepts — every such call is 403 in development`,
      );
    }
  }
  for (const key of gatewayKeys) {
    if (!edgeKeys.has(key)) {
      failures.push(
        `supabase/functions/${fn}/index.ts: CAPABILITY is missing '${key}', which the dev gateway routes`,
      );
    }
  }
}

// --- 11. A function that writes must not call itself STABLE or IMMUTABLE -------------------------
// `search_public_trips` shipped as STABLE while filling its 30-second cache, so every cache miss raised
// "INSERT is not allowed in a non-volatile function": the marketplace worked only for pages somebody
// else had already searched. PostgreSQL enforces this at call time, not at creation time, which is why
// it needs a static check — and pgTAP (0007) now pins the behaviour too.
const writePattern = /\b(?:insert\s+into|delete\s+from|update\s+(?:public|storage|audit)\.)\b/i;
// Comments are stripped first: this codebase explains *why* a function is volatile, and the explanation
// naturally contains the word it is warning about.
const stripComments = (text) => text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
for (const match of sqlSource.matchAll(
  /create or replace function ((?:public|app)\.[a-z0-9_]+)\(([\s\S]*?)\$\$;/g,
)) {
  const block = match[0];
  const bodyStart = block.indexOf('as $$');
  if (bodyStart === -1) continue;
  const header = stripComments(block.slice(0, bodyStart));
  const body = stripComments(block.slice(bodyStart));
  const volatileMarker = /\b(stable|immutable)\b/.exec(header);
  if (volatileMarker && writePattern.test(body)) {
    failures.push(
      `supabase/migrations: ${match[1]}() is declared ${volatileMarker[1].toUpperCase()} but writes to a table — ` +
        `PostgreSQL answers "not allowed in a non-volatile function" at call time`,
    );
  }
}

// --- 12. No `gen_random_bytes`: it is pgcrypto, and pgcrypto is not on the empty search_path ------
// Supabase installs extensions into the `extensions` schema; a `set search_path = ''` function cannot
// see `gen_random_bytes` unqualified, and every call fails with 42883 in production. `md5(random())`
// is pg_catalog and always resolves.
if (/gen_random_bytes\s*\(/.test(stripComments(sqlSource))) {
  failures.push(
    'supabase/migrations: gen_random_bytes() is a pgcrypto function and is not visible from a function ' +
      "declared with set search_path = '' — use md5(random()::text) instead",
  );
}

// --- 12b. Every call to `/api/data` carries the preview session token ------------------------------
// The `?st=` fallback exists for browsers that will not keep a cookie. It covered *rendering* from the
// day it shipped and silently did not cover *writing*: the booking form posted through `/api/data`,
// which authenticates with a cookie that this browser did not have, and answered `401 UNAUTHENTICATED`
// — "Please sign in first." — to somebody who was, on that very page, signed in. Client fetches must
// therefore go through `lib/api.ts`, which attaches the token, and every fetch inside that file must
// attach it. A new ad-hoc `fetch('/api/data/…')` somewhere else is how that bug comes back.
const webSrc = join(root, 'apps', 'web', 'src');
for (const file of await walk(webSrc, (f) => /\.(tsx|ts)$/.test(f))) {
  const source = await readFile(file, 'utf8');
  const calls = source.split(/fetch\(/).slice(1);
  for (const call of calls) {
    if (!call.slice(0, 120).includes('/api/data')) continue;
    // Only *calls* matter: a signed URL re-rooted onto `/api/data` for an <img> carries its own token.
    if (!/^\s*[`'"]\/api\/data/.test(call)) continue;
    if (call.slice(0, 900).includes('sessionHeaders()')) continue;
    failures.push(
      `${rel(file)}: fetch('/api/data…') does not attach sessionHeaders() — in a preview where the ` +
        'browser keeps no cookie this call arrives anonymous, and a signed-in user is told to sign in',
    );
  }
}

// --- 13. Every screen is reachable ---------------------------------------------------------------
// A page that exists but that nothing links to is indistinguishable, from the user's side, from a page
// that was never built: the Phase 4 marketplace shipped at `/trips` while the home page's "Explore
// trips" button was still an in-page anchor and the header had no Trips entry, so the product's front
// door could only be opened by typing the URL. This check fails when a non-dynamic route under
// `app/[locale]` has no inbound `/${locale}…` link anywhere in the web app. Dynamic routes ([id],
// [code]) are excluded here — they are discovered from their list page by `check-a11y.mjs`.
const appRoot = join(root, 'apps', 'web', 'src', 'app', '[locale]');
const pageFiles = await walk(appRoot, (f) => f.endsWith('page.tsx'));
// Only `.tsx`: a link lives in a component. `.ts` modules (the proxy's locale-less allowlist, for one)
// mention routes without linking them, and would make this check pass on a page nobody can open.
const viewFiles = await walk(join(root, 'apps', 'web', 'src'), (f) => f.endsWith('.tsx'));
const views = (await Promise.all(viewFiles.map((f) => readFile(f, 'utf8'))))
  .join('\n')
  // `pathname="/trips"` tells the language switcher which page is current; it is not an inbound link,
  // and it is exactly the difference this check exists to see.
  .replaceAll(/pathname="[^"]*"/g, '');

for (const file of pageFiles) {
  const route = relative(appRoot, dirname(file)).replaceAll('\\', '/');
  const routePath = route === '' || route === '.' ? '/' : `/${route}`;
  if (routePath.includes('[')) continue;

  // `'/' + '${locale}'` is the source text a template link is written with (single quotes keep
  // `${locale}` literal); the other two forms cover a pre-interpolated path and a plain absolute href.
  const linked =
    views.includes('/' + '${locale}' + routePath) ||
    views.includes(`'${routePath}'`) ||
    views.includes(`href="${routePath}"`);
  if (linked) continue;

  failures.push(
    `apps/web/src/app/[locale]${routePath === '/' ? '' : routePath}: no inbound link — nothing in a .tsx file points at this route, so the screen cannot be opened from the UI`,
  );
}

// --- 14. The web app is installable, and it says so on purpose --------------------------------
//
// A manifest is easy to add and easy to break: a renamed icon, a lost `start_url`, a service worker
// deleted by a tidy-up, and the install prompt silently stops existing — no error anywhere, just an app
// that is no longer an app. These are the facts the prompt depends on, and the one policy that keeps the
// offline page honest: this worker caches nothing, because the app ships often and a cached shell fights
// the build stamp the layout already carries.

{
  const manifest = await readFile(join(root, 'apps/web/src/app/manifest.ts'), 'utf8').catch(
    () => '',
  );

  if (manifest === '') {
    failures.push('apps/web/src/app/manifest.ts is missing — a phone cannot install the web app');
  } else {
    for (const [needle, message] of [
      ['start_url:', 'the manifest has no `start_url` — installability requires one'],
      [
        "display: 'standalone'",
        'the manifest does not open standalone, so it installs as a bookmark',
      ],
      ['/icons/192', 'the manifest has no 192px icon — Android needs it to offer the install'],
      ['/icons/512', 'the manifest has no 512px icon — Android needs it for the splash screen'],
    ]) {
      if (!manifest.includes(needle)) failures.push(`apps/web/src/app/manifest.ts: ${message}`);
    }
  }

  const icons = await readFile(join(root, 'apps/web/src/app/icons/[size]/route.tsx'), 'utf8').catch(
    () => '',
  );
  if (icons === '') {
    failures.push(
      'apps/web/src/app/icons/[size]/route.tsx is missing — the manifest points at nothing',
    );
  }

  const sw = await readFile(join(root, 'apps/web/public/sw.js'), 'utf8').catch(() => '');
  if (sw === '') {
    failures.push(
      'apps/web/public/sw.js is missing — without a service worker there is no offline page',
    );
  } else {
    if (!/addEventListener\(['"]fetch['"]/.test(sw)) {
      failures.push(
        'apps/web/public/sw.js has no fetch handler — a navigation cannot fall back offline',
      );
    }
    if (/caches\.open|cache\.add|cache\.put/.test(sw)) {
      failures.push(
        'apps/web/public/sw.js caches something — this app ships often, and a cached shell fights the build stamp',
      );
    }
  }

  const layout = await readFile(join(root, 'apps/web/src/app/[locale]/layout.tsx'), 'utf8').catch(
    () => '',
  );
  if (!layout.includes('<ServiceWorker />')) {
    failures.push(
      'apps/web/src/app/[locale]/layout.tsx does not render <ServiceWorker /> — the worker never registers',
    );
  }
}

// --- 15. React may not own `<details open>` ------------------------------------------------------
// `open` on a disclosure is mutable state the *user* holds: tapping the summary flips it with no React
// involvement, and the browser restores it on back/forward. Rendering it from props or state makes React
// the authority on an attribute anybody can change, so a tap that lands while hydration is still running
// is a hydration mismatch — the panel open in the DOM, `open={false}` in props, and the error *"a tree
// hydrated but some attributes of the server rendered HTML didn't match"*. It happened once, on the
// marketplace filter panel, which had also been relying on that prop to make the panel reachable at all.
// Drive the element through a ref in an effect (`element.open = true`) instead; this keeps the shortcut
// from coming back now that the symptom is fixed.
for (const file of await walk(join(root, 'apps', 'web', 'src'), (f) => f.endsWith('.tsx'))) {
  const source = await readFile(file, 'utf8');
  const pattern = /<\s*details\b[^>]*?\sopen\s*=/gs;
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index).split('\n').length;
    failures.push(
      `${rel(file)}:${line}: renders \`open\` on <details> — that attribute belongs to the user, and a ` +
        `controlled version is a hydration mismatch waiting for a fast tap; set element.open in an effect`,
    );
  }
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} guard failure(s):\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `✓ guards passed (${coreFiles.length} core files, ${styleFiles.length} style files, ${migrations.length} migrations, ${definedCommands.size} commands)`,
);
