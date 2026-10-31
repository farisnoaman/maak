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
 * Authenticated screens are checked too. Without a session every console route answers 307 and the
 * guard used to `return` — green, having parsed only the sign-in page. So the script signs in with the
 * seeded dev account and fails a protected route that still redirects; when sign-in is unavailable it
 * says how many routes were skipped instead of pretending they passed.
 *
 * Usage: node scripts/check-a11y.mjs [baseUrl]
 *   A11Y_EMAIL / A11Y_PASSWORD override the demo account (owner@maak.test, staff@maak.test …).
 */

import { parse } from 'node-html-parser';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';

const ROUTES = [
  { path: '/ar', lang: 'ar', dir: 'rtl', account: null },
  { path: '/en', lang: 'en', dir: 'ltr', account: null },
  { path: '/ar/styleguide', lang: 'ar', dir: 'rtl', account: null },
  { path: '/en/styleguide', lang: 'en', dir: 'ltr', account: null },
  { path: '/ar/auth/sign-in', lang: 'ar', dir: 'rtl', account: null },
  { path: '/en/auth/sign-in', lang: 'en', dir: 'ltr', account: null },
  { path: '/ar/operator', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/en/staff', lang: 'en', dir: 'ltr', account: 'staff' },
  // Phase 1 surfaces
  { path: '/ar/account', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/en/account', lang: 'en', dir: 'ltr', account: 'owner' },
  { path: '/ar/account/verification', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/en/account/verification', lang: 'en', dir: 'ltr', account: 'owner' },
  { path: '/ar/account/licence', lang: 'ar', dir: 'rtl', account: 'driver' },
  { path: '/en/account/licence', lang: 'en', dir: 'ltr', account: 'driver' },
  { path: '/ar/account/bookings', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/en/account/bookings', lang: 'en', dir: 'ltr', account: 'owner' },
  { path: '/ar/operator/settings', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/en/operator/team', lang: 'en', dir: 'ltr', account: 'owner' },
  { path: '/ar/staff/verifications', lang: 'ar', dir: 'rtl', account: 'staff' },
  { path: '/en/staff/verifications', lang: 'en', dir: 'ltr', account: 'staff' },
  { path: '/ar/admin/users', lang: 'ar', dir: 'rtl', account: 'staff' },
  { path: '/en/admin/users', lang: 'en', dir: 'ltr', account: 'staff' },
  // Phase 2 surfaces
  { path: '/ar/admin/regions', lang: 'ar', dir: 'rtl', account: 'staff' },
  { path: '/en/admin/regions', lang: 'en', dir: 'ltr', account: 'staff' },
  { path: '/ar/admin/places', lang: 'ar', dir: 'rtl', account: 'staff' },
  { path: '/en/admin/places', lang: 'en', dir: 'ltr', account: 'staff' },
  // Phase 3 surfaces
  { path: '/ar/operator/fleet', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/en/operator/fleet', lang: 'en', dir: 'ltr', account: 'owner' },
  // Phase 8.1: the printable fleet report. Pro in the dev seed, so this exercises the sheet itself; the
  // locked variant is covered by the plan test rather than by a second route.
  {
    path: '/ar/operator/fleet/report?org=aaaaaaaa-0000-4000-8000-000000000001',
    lang: 'ar',
    dir: 'rtl',
    account: 'owner',
  },
  {
    path: '/en/operator/fleet/report?org=aaaaaaaa-0000-4000-8000-000000000001',
    lang: 'en',
    dir: 'ltr',
    account: 'owner',
  },
  { path: '/ar/operator/vehicles', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/en/operator/vehicles', lang: 'en', dir: 'ltr', account: 'owner' },
  { path: '/ar/operator/vehicles/new', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/en/operator/vehicles/new', lang: 'en', dir: 'ltr', account: 'owner' },
  { path: '/ar/operator/drivers', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/en/operator/drivers', lang: 'en', dir: 'ltr', account: 'owner' },
  { path: '/ar/staff/vehicles', lang: 'ar', dir: 'rtl', account: 'staff' },
  { path: '/en/staff/vehicles', lang: 'en', dir: 'ltr', account: 'staff' },
  // Phase 4 surfaces — the marketplace is public, so it is checked with no session at all.
  { path: '/ar/trips', lang: 'ar', dir: 'rtl', account: null },
  { path: '/en/trips', lang: 'en', dir: 'ltr', account: null },
  { path: '/ar/trips?direct=1&sort=cheapest', lang: 'ar', dir: 'rtl', account: null },
  { path: '/ar/operator/trips', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/en/operator/trips', lang: 'en', dir: 'ltr', account: 'owner' },
  { path: '/ar/operator/trips?status=draft', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/ar/operator/trips/new', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/en/operator/trips/new', lang: 'en', dir: 'ltr', account: 'owner' },
  { path: '/ar/operator/trips/calendar', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/en/operator/trips/calendar', lang: 'en', dir: 'ltr', account: 'owner' },
  { path: '/ar/account/trips', lang: 'ar', dir: 'rtl', account: 'owner' },
  { path: '/en/account/trips', lang: 'en', dir: 'ltr', account: 'owner' },
  { path: '/ar/staff/trips', lang: 'ar', dir: 'rtl', account: 'staff' },
  { path: '/en/staff/trips', lang: 'en', dir: 'ltr', account: 'staff' },
  { path: '/ar/staff/trips?q=SA&status=published', lang: 'ar', dir: 'rtl', account: 'staff' },
  // Phase 7: the supervisor's two new screens, plus the history filters in both directions.
  { path: '/ar/staff/dashboard', lang: 'ar', dir: 'rtl', account: 'staff' },
  { path: '/en/staff/dashboard', lang: 'en', dir: 'ltr', account: 'staff' },
  { path: '/ar/staff/scan', lang: 'ar', dir: 'rtl', account: 'staff' },
  { path: '/en/staff/scan', lang: 'en', dir: 'ltr', account: 'staff' },
  {
    path: '/ar/staff/trips?from=2026-01-01&to=2026-12-31',
    lang: 'ar',
    dir: 'rtl',
    account: 'staff',
  },
  { path: '/en/staff/trips?verification=verified', lang: 'en', dir: 'ltr', account: 'staff' },
];

const failures = [];
const skipped = [];
let detailRoutes = 0;

/** The cookie for the account a route expects, or null for public screens. */
function sessionCookie(route) {
  if (route.account === null || route.account === undefined) return null;
  return sessions[route.account] ?? null;
}

/** A cookie handler for the demo account, so console screens are parsed as themselves. */
const ACCOUNTS = {
  owner: process.env.A11Y_OWNER ?? 'owner@maak.test',
  staff: process.env.A11Y_STAFF ?? 'admin@maak.test',
  // The seeded driver: the licence screen renders an empty state for anybody else, and an empty state
  // is not what this gate is here to parse.
  driver: process.env.A11Y_DRIVER ?? 'driver@maak.test',
};
const PASSWORD = process.env.A11Y_PASSWORD ?? 'Maak!2026';

async function signIn(who) {
  const email = ACCOUNTS[who];
  const body = new URLSearchParams({
    mode: 'email',
    locale: 'en',
    email,
    password: PASSWORD,
    next: '/en/account',
  });

  try {
    const response = await fetch(`${BASE}/api/auth/sign-in`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
      body,
    });
    const cookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    const session = cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    if (!session) return null;
    return session;
  } catch {
    return null;
  }
}

const sessions = { owner: null, staff: null, driver: null };

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
    const response = await fetch(`${BASE}${route.path}`, {
      redirect: 'manual',
      headers: sessionCookie(route) ? { cookie: sessionCookie(route) } : {},
    });
    if (response.status !== 200) {
      if (response.status === 307 || response.status === 308 || response.status === 302) {
        // Without a session a protected route redirects to sign-in, which is correct behaviour — but
        // it means the screen was never parsed, so it is counted as skipped, not as passed.
        if (sessionCookie(route)) {
          fail(route.path, 'redirected to sign-in despite a valid session');
        } else {
          skipped.push(route.path);
        }
        return;
      }
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

for (const who of Object.keys(sessions)) {
  sessions[who] = await signIn(who);
  if (!sessions[who]) {
    console.warn(`⚠ could not sign in as ${who} — those screens will be skipped, not verified`);
  }
}

for (const route of ROUTES) {
  await checkRoute(route);
}

/**
 * Detail screens need a real row, so they are discovered from the list page instead of guessed. This
 * closes the one hole that mattered most in Phase 3: the vehicle detail page renders the full
 * specification and it was the only Phase 3 screen the guard never saw.
 */
if (sessions.owner) {
  for (const locale of ['ar', 'en']) {
    // The list filters by the organization in scope, so every context is tried: a vehicle that lives
    // in a company is not on the personal list, and the detail page is the same either way.
    let href = null;
    for (const suffix of ['', '?org=aaaaaaaa-0000-4000-8000-000000000001']) {
      const listHtml = await fetch(`${BASE}/${locale}/operator/vehicles${suffix}`, {
        headers: { cookie: sessions.owner },
      })
        .then((response) => (response.ok ? response.text() : ''))
        .catch(() => '');
      href = listHtml.match(/href="\/(ar|en)\/operator\/vehicles\/([0-9a-f-]{36})"/);
      if (href) break;
    }
    if (!href) continue;
    await checkRoute({
      path: `/${locale}/operator/vehicles/${href[2]}`,
      lang: locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      account: 'owner',
    });
    detailRoutes += 1;
  }

  // The vehicle health card — discovered from the rollup, which links every row to it. Discovered rather
  // than guessed for the same reason as the detail page: the id has to be a row the account can read.
  for (const locale of ['ar', 'en']) {
    let href = null;
    for (const suffix of ['', '?org=aaaaaaaa-0000-4000-8000-000000000001']) {
      const listHtml = await fetch(`${BASE}/${locale}/operator/fleet${suffix}`, {
        headers: { cookie: sessions.owner },
      })
        .then((response) => (response.ok ? response.text() : ''))
        .catch(() => '');
      href = listHtml.match(/href="\/(ar|en)\/operator\/vehicles\/([0-9a-f-]{36})\/health"/);
      if (href) break;
    }
    if (!href) continue;
    await checkRoute({
      path: `/${locale}/operator/vehicles/${href[2]}/health`,
      lang: locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      account: 'owner',
    });
    detailRoutes += 1;
  }

  // The operator's trip detail — discovered from the list, so the screen is only checked when a trip
  // actually exists (an empty dev database must not fail the guard).
  for (const locale of ['ar', 'en']) {
    const listHtml = await fetch(`${BASE}/${locale}/operator/trips`, {
      headers: { cookie: sessions.owner },
    })
      .then((response) => (response.ok ? response.text() : ''))
      .catch(() => '');
    const href = listHtml.match(/href="\/(ar|en)\/operator\/trips\/([0-9a-f-]{36})"/);
    if (!href) continue;
    await checkRoute({
      path: `/${locale}/operator/trips/${href[2]}`,
      lang: locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      account: 'owner',
    });
    detailRoutes += 1;
  }
}

/**
 * The staff trip detail — discovered from the staff *search* rather than from the queue, because the
 * queue is empty on a healthy database and an unexercised screen is the one that breaks. The page shows
 * the operator's trip through the same component as `/operator/trips/[id]`, plus the one action staff own.
 */
if (sessions.staff) {
  for (const locale of ['ar', 'en']) {
    const listHtml = await fetch(`${BASE}/${locale}/staff/trips?status=published`, {
      headers: { cookie: sessions.staff },
    })
      .then((response) => (response.ok ? response.text() : ''))
      .catch(() => '');
    const href = listHtml.match(/href="\/(ar|en)\/staff\/trips\/([0-9a-f-]{36})"/);
    if (!href) continue;
    await checkRoute({
      path: `/${locale}/staff/trips/${href[2]}`,
      lang: locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      account: 'staff',
    });
    detailRoutes += 1;

    // The manifest is the page that gets printed, so it is the one where a missing label or a table
    // without a caption is worth catching before it reaches a printer.
    await checkRoute({
      path: `/${locale}/staff/trips/${href[2]}/manifest`,
      lang: locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      account: 'staff',
    });
    detailRoutes += 1;
  }
}

{
  const publicHtml = await fetch(`${BASE}/ar/trips`)
    .then((response) => (response.ok ? response.text() : ''))
    .catch(() => '');
  const code = publicHtml.match(/href="\/ar\/trips\/([A-Za-z0-9-]{4,20})"/);
  if (code) {
    await checkRoute({
      path: `/ar/trips/${code[1]}`,
      lang: 'ar',
      dir: 'rtl',
      account: null,
    });
    detailRoutes += 1;
  }
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} accessibility failure(s):\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const checked = ROUTES.length + detailRoutes - skipped.length;
console.log(
  `✓ a11y smoke passed on ${checked} routes (both directions` +
    (detailRoutes > 0 ? `, ${detailRoutes} discovered detail pages` : '') +
    ')' +
    (skipped.length > 0 ? `, ${skipped.length} skipped (no session)` : ''),
);
