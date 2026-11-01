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
 *      region instead of widening the document;
 *   6. a table that becomes a stack of cards on a phone has a `data-label` on every cell, because the
 *      header is hidden at that width and an unlabelled value is a number nobody can name.
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
// 3b. Nothing may be wider than the screen
// ---------------------------------------------------------------------------
//
// The console shipped with a horizontal scrollbar on a phone, and the cause was not a wide element — it was a
// track that refused to shrink. `.console-layout` is a grid with no `grid-template-columns`, so the implicit
// column was `auto`, which sizes to the *max-content* of its contents: a row of `nowrap` nav chips. The track
// became ~600px wide on a 390px screen, and the panel beside it was laid out at that width.
//
// Four rules catch that family, all static:
//
//   · a bare `<n>fr` track is `minmax(auto, <n>fr)` — it cannot be narrower than its content. Guarded tracks
//     (`minmax(0, …)`, or the `min(100%, …)` minmax used for card grids) are fine;
//   · the layout containers that hold a sidebar and a chip row must declare an explicit shrinking track, because
//     an implicit `auto` column is exactly the bug above;
//   · an element sized `calc(100% + …)` is wider than its parent by construction, which is a document wider than
//     the screen;
//   · anything that scrolls horizontally must cap itself at `max-inline-size: 100%`, so the scroll happens inside
//     it and never on the page.

/** The stylesheet with comments blanked out (same length, so line numbers still line up). */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));

const STRIP_MINMAX = (value) => {
  // Remove `minmax(…)` and `min(…)` groups, parenthesis-matched, so their `1fr` max is not mistaken for a bare one.
  let out = '';
  let depth = 0;
  for (const char of value) {
    if (char === '(') depth += 1;
    if (depth === 0) out += char;
    if (char === ')') depth = Math.max(0, depth - 1);
  }
  return out;
};

for (const match of cssCode.matchAll(/grid-template-columns:\s*([^;}]+);/g)) {
  const value = match[1];
  if (/repeat\(/.test(value)) continue; // its inner tracks are min()/minmax()-guarded and checked above
  const naked = STRIP_MINMAX(value);
  if (/(^|[\s,])\d*\.?\d+fr($|[\s,;])/.test(naked)) {
    fail(
      'apps/web/src/app/globals.css',
      lineOf(css, match.index),
      `"grid-template-columns: ${value.trim()}" uses a bare fr track — write minmax(0, 1fr), or the track cannot shrink below its content and the page scrolls sideways`,
    );
  }
}

const SHRINKING_LAYOUTS = ['.console-layout'];
for (const selector of SHRINKING_LAYOUTS) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(^|\\n)${escaped}\\s*\\{([^{}]*)\\}`, 'm').exec(css);
  if (!rule) {
    fail(
      'apps/web/src/app/globals.css',
      1,
      `"${selector}" has no rule — the shrink check cannot run`,
    );
  } else if (!/grid-template-columns:\s*minmax\(0,/.test(rule[2])) {
    fail(
      'apps/web/src/app/globals.css',
      lineOf(css, rule.index),
      `"${selector}" is a grid with no shrinking track — an implicit auto column sizes to its widest content, which is how the console grew past a phone's screen`,
    );
  }
}

for (const match of cssCode.matchAll(/inline-size:\s*calc\(\s*100%\s*\+/g)) {
  fail(
    'apps/web/src/app/globals.css',
    lineOf(css, match.index),
    '`inline-size: calc(100% + …)` makes an element wider than its parent by construction — a page that scrolls sideways on a phone',
  );
}

// `100vw` is the viewport *including* a classic scrollbar, so a box of that width is wider than the page the moment
// one is visible. `100%` against the same containing block is the width that fits.
for (const match of cssCode.matchAll(
  /(inline-size|max-inline-size|min-inline-size):\s*([^;}]*100vw[^;}]*);/g,
)) {
  fail(
    'apps/web/src/app/globals.css',
    lineOf(css, match.index),
    `"${match[1]}: ${match[2].trim()}" uses 100vw — it counts the scrollbar, so the box overflows the document`,
  );
}

// A fixed width is fine on a desktop and is a sideways scroll on a 360px phone: anything wider than a phone must
// say how it shrinks. `210mm` of manifest paper is the case this exists for.
for (const match of cssCode.matchAll(/(^|\n)([^{}\n][^{}]*)\{([^{}]*)\}/g)) {
  const [, , selector, declarations] = match;
  if (/max-inline-size:\s*(100%|100vw)/.test(declarations)) continue;
  const width = /inline-size:\s*(\d+)(px|mm)\s*;/.exec(declarations);
  if (!width) continue;
  const pixels = width[2] === 'mm' ? Number(width[1]) * (96 / 25.4) : Number(width[1]);
  if (pixels <= 360) continue;
  fail(
    'apps/web/src/app/globals.css',
    lineOf(css, match.index + match[1].length),
    `"${selector.trim()}" is ${width[1]}${width[2]} wide with no max-inline-size — wider than a phone, so the page scrolls`,
  );
}

for (const match of cssCode.matchAll(/(^|\n)([^{}\n][^{}]*)\{([^{}]*)\}/g)) {
  const [, , selector, declarations] = match;
  if (!/overflow-x:\s*(auto|scroll)/.test(declarations)) continue;
  if (/max-inline-size:/.test(declarations)) continue;
  fail(
    'apps/web/src/app/globals.css',
    lineOf(css, match.index + match[1].length),
    `"${selector.trim()}" scrolls horizontally without max-inline-size: 100% — the scroll would land on the page instead of the row`,
  );
}

// ---------------------------------------------------------------------------
// 3c. A console page is not a card in a card
// ---------------------------------------------------------------------------
//
// The shell used to render `<section class="card console-panel">` and every screen put its own cards inside it: two
// frames, two paddings and two shadows around one piece of content. The panel is gone; this keeps it gone.

const shellPath = resolve(root, 'apps/web/src/components/ConsoleShell.tsx');
const shellSource = readFileSync(shellPath, 'utf8');
// Comments may name the thing being banned; only the code counts.
const shell = shellSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
if (/className="[^"]*\bcard\b/.test(shell) || /\bconsole-panel\b/.test(shell)) {
  fail(
    'apps/web/src/components/ConsoleShell.tsx',
    1,
    'the console shell renders a card again — a console page is a page header and a flat content column, not a card with cards inside it',
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
// 6. A card-stacked table labels every cell
// ---------------------------------------------------------------------------

const CARD_TABLE = /<table[^>]*className="[^"]*(table-cards|--cards)[^"]*"[\s\S]*?<\/table>/g;

for (const file of tables) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(CARD_TABLE)) {
    const block = match[0];
    const cells = (block.match(/<td\b/g) ?? []).length;
    const labelled = (block.match(/<td\b[^>]*data-label=/g) ?? []).length;
    // The last cell is the row's action button; it is a target, not a value, and needs no label.
    if (cells - 1 > labelled) {
      fail(
        file.slice(root.length + 1),
        1,
        `${cells - 1} value cell(s) but only ${labelled} carry data-label — stacked cards would show unlabelled numbers`,
      );
    }
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
    `no hidden navigation, no unguarded grid tracks, no track or fixed width wider than its container, no card-in-card console shell, ${TARGETS.length} tap targets, ` +
    `every wide table scrollable, stacked card tables labelled)`,
);
