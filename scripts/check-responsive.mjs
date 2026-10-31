#!/usr/bin/env node
/**
 * Responsive guard.
 *
 * The bugs this exists for are the ones no unit test catches, because they are not in the code —
 * they are in the stylesheet:
 *
 *   · the header used to run `@media (max-width: 720px) { nav { display: none } }`, so on a phone
 *     there was no navigation at all and nothing said so;
 *   · `repeat(auto-fill, minmax(280px, 1fr))` inside a 272px panel is 8px wider than its container,
 *     which is exactly how a page starts scrolling sideways on a phone.
 *
 * Both are static facts about the CSS, so they can be asserted without a browser:
 *
 *   1. the viewport is exported with `width: 'device-width'` (no page may be designed for 980px and
 *      zoomed out on a phone);
 *   2. no media query hides the navigation — navigation that disappears must be replaced by a menu,
 *      and this checks the selector is not hidden at all;
 *   3. every `minmax(<px>, …)` track is wrapped in `min(100%, <px>)`, so a grid can never be wider
 *      than the column it is in;
 *   4. the classes that act as buttons are at least `var(--tap-target)` tall;
 *   5. every `<table>` sits inside a `.table-scroll` box, so a five-column table scrolls in its own
 *      region instead of widening the document.
 *
 * Usage: node scripts/check-responsive.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cssPath = resolve(root, 'apps/web/src/app/globals.css');
const layoutPath = resolve(root, 'apps/web/src/app/[locale]/layout.tsx');
const tokensPath = resolve(root, 'packages/design-tokens/tokens.css');

const problems = [];
const fail = (file, line, message) => problems.push({ file, line, message });

const css = readFileSync(cssPath, 'utf8');
const layout = readFileSync(layoutPath, 'utf8');
const tokens = readFileSync(tokensPath, 'utf8');

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// ---------------------------------------------------------------------------
// 1. The viewport
// ---------------------------------------------------------------------------

if (!/export const viewport[^=]*=\s*\{[\s\S]*?width:\s*'device-width'/.test(layout)) {
  fail(
    'apps/web/src/app/[locale]/layout.tsx',
    1,
    "no `export const viewport` with width: 'device-width' — a phone would render the desktop layout zoomed out",
  );
}

// ---------------------------------------------------------------------------
// 2. No media query may hide the navigation
// ---------------------------------------------------------------------------

/** Depth-aware splitter: returns every `@media (...)` block with its condition, body and offset. */
function mediaBlocks(source) {
  const blocks = [];
  const pattern = /@media([^{]+)\{/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const bodyStart = pattern.lastIndex;
    let depth = 1;
    let index = bodyStart;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      index += 1;
    }
    blocks.push({
      condition: match[1].trim(),
      body: source.slice(bodyStart, index - 1),
      offset: bodyStart,
    });
  }
  return blocks;
}

const NAV_SELECTOR = /(^|[\s,>])(nav|\.site-nav|\.site-menu|\.site-menu__links)([\s,:.#[]|$)/;

for (const block of mediaBlocks(css)) {
  const rules = /([^{}]+)\{([^{}]*)\}/g;
  let rule;
  while ((rule = rules.exec(block.body)) !== null) {
    const selectors = rule[1];
    const declarations = rule[2];
    if (!/display:\s*none/.test(declarations)) continue;
    if (!NAV_SELECTOR.test(selectors.trim())) continue;
    fail(
      'apps/web/src/app/globals.css',
      lineOf(css, block.offset + rule.index),
      `@media ${block.condition} hides "${selectors.trim()}" — navigation must collapse into a menu, never vanish`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Grid tracks may not exceed their container
// ---------------------------------------------------------------------------

const gridTrack = /minmax\(\s*(\d+)px\s*,/g;
let track;
while ((track = gridTrack.exec(css)) !== null) {
  const before = css.slice(Math.max(0, track.index - 12), track.index);
  if (/min\(\s*100%\s*,\s*$/.test(before)) continue;
  fail(
    'apps/web/src/app/globals.css',
    lineOf(css, track.index),
    `minmax(${track[1]}px, …) has no min(100%, …) guard — it overflows any container narrower than ${track[1]}px`,
  );
}

// ---------------------------------------------------------------------------
// 4. Anything that behaves like a button is at least --tap-target tall
// ---------------------------------------------------------------------------

const tapTarget = /--tap-target:\s*(\d+)px/.exec(tokens);
if (!tapTarget) {
  fail('packages/design-tokens/tokens.css', 1, 'no --tap-target token');
} else if (Number(tapTarget[1]) < 44) {
  fail(
    'packages/design-tokens/tokens.css',
    lineOf(tokens, tapTarget.index),
    `--tap-target is ${tapTarget[1]}px; 44px is the smallest comfortable target`,
  );
}

const TARGETS = [
  '.btn',
  '.nav-link',
  '.console-nav a',
  '.fleet-step',
  '.site-menu__toggle',
  '.fleet-toggle',
  '.tabbar__link',
];

for (const selector of TARGETS) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(^|\\n)${escaped}\\s*\\{([^{}]*)\\}`, 'm').exec(css);
  if (!rule) {
    fail(
      'apps/web/src/app/globals.css',
      1,
      `"${selector}" has no rule — the tap-target check cannot run`,
    );
    continue;
  }
  if (!/min-block-size:\s*var\(--tap-target\)/.test(rule[2])) {
    fail(
      'apps/web/src/app/globals.css',
      lineOf(css, rule.index),
      `"${selector}" does not set min-block-size: var(--tap-target) — too small to tap on a phone`,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. Wide tables scroll inside their own box
// ---------------------------------------------------------------------------

const COMPONENTS = resolve(root, 'apps/web/src');
const tables = walk(resolve(COMPONENTS)).filter((file) => file.endsWith('.tsx'));

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

for (const file of tables) {
  const source = readFileSync(file, 'utf8');
  const tableCount = (source.match(/<table\b/g) ?? []).length;
  if (tableCount === 0) continue;
  const wrappers = (source.match(/className="table-scroll"/g) ?? []).length;
  if (wrappers < tableCount) {
    fail(
      file.slice(root.length + 1),
      1,
      `${tableCount} <table> element(s) but ${wrappers} .table-scroll wrapper(s) — a wide table widens the page`,
    );
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`  ✖ ${problem.file}:${problem.line} — ${problem.message}`);
  }
  console.error(`\n✖ responsive check failed: ${problems.length} problem(s)`);
  process.exit(1);
}

const mediaCount = mediaBlocks(css).length;
console.log(
  `✓ responsive check passed (viewport exported, ${mediaCount} media queries, ` +
    `no hidden navigation, no unguarded grid tracks, ${TARGETS.length} tap targets, ` +
    `every wide table scrollable)`,
);
