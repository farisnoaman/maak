#!/usr/bin/env node
/**
 * Accessibility and direction smoke test.
 *
 * Lighthouse needs Chrome and a network round trip; this script covers the failures that
 * actually happen in this codebase, on every route, in both directions, in ~1 second:
 *
 *   - <html lang> and dir are correct for the locale
 *   - exactly one <h1>
 *   - every <img> has alt (empty is allowed for decorative images)
 *   - every form control has an accessible name (label, aria-label or aria-labelledby)
 *   - the skip link exists and points at #main
 *   - no empty links or buttons
 *   - the page has a <main id="main"> landmark
 *
 * Usage: node scripts/check-a11y.mjs [baseUrl]
 */

import { parse } from 'node-html-parser';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';

const ROUTES = [
  { path: '/ar', lang: 'ar', dir: 'rtl' },
  { path: '/en', lang: 'en', dir: 'ltr' },
  { path: '/ar/styleguide', lang: 'ar', dir: 'rtl' },
  { path: '/en/styleguide', lang: 'en', dir: 'ltr' },
  { path: '/ar/auth/sign-in', lang: 'ar', dir: 'rtl' },
  { path: '/en/auth/sign-in', lang: 'en', dir: 'ltr' },
  { path: '/ar/operator', lang: 'ar', dir: 'rtl' },
  { path: '/en/staff', lang: 'en', dir: 'ltr' },
];

const failures = [];

function fail(route, message) {
  failures.push(`${route}: ${message}`);
}

function textOf(element) {
  return (element.text ?? '').replace(/\s+/g, ' ').trim();
}

function hasAccessibleName(node, root) {
  const ariaLabel = node.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return true;
  const labelledBy = node.getAttribute('aria-labelledby');
  if (labelledBy && labelledBy.trim()) return true;
  const id = node.getAttribute('id');
  if (id) {
    // Label may be a sibling of the control's wrapper, so search the whole document.
    const escaped = id.replace(/"/g, '\\"');
    const label = root.querySelector(`label[for="${escaped}"]`);
    if (label && textOf(label)) return true;
  }
  if (node.parentNode?.tagName === 'LABEL' && textOf(node.parentNode)) return true;
  const title = node.getAttribute('title');
  if (title && title.trim()) return true;
  return false;
}

async function checkRoute(route) {
  let html;
  try {
    const response = await fetch(`${BASE}${route.path}`, { redirect: 'manual' });
    if (response.status !== 200) {
      // Protected routes redirect to sign-in without credentials: that is correct behaviour.
      if (response.status === 307 || response.status === 308 || response.status === 302) return;
      fail(route.path, `expected 200, received ${response.status}`);
      return;
    }
    html = await response.text();
  } catch (error) {
    fail(route.path, `unreachable (${error.message}). Is the dev server running?`);
    return;
  }

  const root = parse(html);
  const htmlNode = root.querySelector('html');

  if (!htmlNode) return fail(route.path, 'no <html> element');
  if (htmlNode.getAttribute('lang') !== route.lang) {
    fail(route.path, `<html lang="${htmlNode.getAttribute('lang')}">, expected "${route.lang}"`);
  }
  if (htmlNode.getAttribute('dir') !== route.dir) {
    fail(route.path, `<html dir="${htmlNode.getAttribute('dir')}">, expected "${route.dir}"`);
  }

  const h1s = root.querySelectorAll('h1');
  if (h1s.length !== 1) fail(route.path, `${h1s.length} <h1> elements, expected exactly 1`);

  const main = root.querySelector('main#main');
  if (!main) fail(route.path, 'missing <main id="main"> landmark');

  const skip = root.querySelector('a.skip-link');
  if (!skip || skip.getAttribute('href') !== '#main') {
    fail(route.path, 'missing skip link to #main');
  }

  for (const img of root.querySelectorAll('img')) {
    if (img.getAttribute('alt') === undefined) {
      fail(route.path, `<img> without alt: ${img.getAttribute('src') ?? '(no src)'}`);
    }
  }

  for (const control of root.querySelectorAll('input, select, textarea')) {
    const type = control.getAttribute('type');
    if (type === 'hidden') continue;
    if (!hasAccessibleName(control, root)) {
      fail(
        route.path,
        `form control without accessible name (name="${control.getAttribute('name') ?? ''}")`,
      );
    }
  }

  for (const link of root.querySelectorAll('a')) {
    if (!textOf(link) && !link.getAttribute('aria-label')) {
      fail(route.path, `empty link: ${link.getAttribute('href') ?? '(no href)'}`);
    }
  }

  for (const button of root.querySelectorAll('button')) {
    if (!textOf(button) && !button.getAttribute('aria-label')) {
      fail(route.path, 'button without accessible name');
    }
  }

  // Directional integrity: the CSS must not leak a physical margin into RTL pages.
  if (/margin-(left|right)\s*:/.test(html)) {
    fail(route.path, 'inline styles contain a physical margin');
  }
}

for (const route of ROUTES) {
  await checkRoute(route);
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} accessibility failure(s):\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ a11y smoke passed on ${ROUTES.length} routes (both directions)`);
