/**
 * End-to-end smoke test for the dev stack: auth → session → RLS read → gateway command.
 *
 * It talks to the app origin by default (`http://127.0.0.1:3000`), so the Next rewrite, the pinned
 * session cookie and the API are all exercised in one go — the browser path, minus the browser.
 *
 *   npm run dev:check              # against http://127.0.0.1:3000
 *   npm run dev:check -- --api     # against the backend directly (no Next)
 *   MAAK_BASE=http://host:port npm run dev:check
 */

const useApi = process.argv.includes('--api');
const BASE = process.env.MAAK_BASE ?? (useApi ? 'http://127.0.0.1:54321' : 'http://127.0.0.1:3000');
const PREFIX = useApi ? '' : '/supabase';
const PASSWORD = 'Maak!2026';

let failures = 0;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
}

async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${BASE}${PREFIX}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function signIn(email) {
  const result = await call('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  return result.body?.access_token ?? null;
}

console.log(`▸ smoke test against ${BASE}${PREFIX}`);

const admin = await signIn('admin@maak.test');
check('admin can sign in', Boolean(admin));

if (admin) {
  const me = await call('/functions/v1/me', { method: 'POST', token: admin, body: {} });
  check(
    'me returns a resolved actor',
    me.body?.user?.roles?.includes('platform_admin'),
    JSON.stringify(me.body),
  );
  check(
    'me returns server-computed capabilities',
    (me.body?.capabilities ?? []).includes('place.decide'),
  );

  const governorates = await call('/rest/v1/governorates?select=code&limit=100', { token: admin });
  check(
    '22 governorates are readable',
    Array.isArray(governorates.body) && governorates.body.length === 22,
  );

  const places = await call('/rest/v1/places?select=id,name_ar&limit=1', { token: admin });
  check('places are readable as staff', Array.isArray(places.body) && places.body.length > 0);

  const write = await call('/rest/v1/governorates', { method: 'POST', token: admin, body: {} });
  check('REST rejects writes (single write path)', write.status === 405, `status ${write.status}`);
}

const owner = await signIn('owner@maak.test');
check('owner can sign in', Boolean(owner));

if (owner) {
  const me = await call('/functions/v1/me', { method: 'POST', token: owner, body: {} });
  check('owner is not platform staff', me.body?.flags?.isStaff === false);
  check('owner has an organization context', (me.body?.user?.organizations ?? []).length === 1);

  // A *valid* payload on purpose: an invalid one would be rejected by the schema (422) before the
  // policy matrix ever runs, which is not what this check is about.
  const governorate = await call('/rest/v1/governorates?select=id&limit=1', { token: owner });
  const forbidden = await call('/functions/v1/geography', {
    method: 'POST',
    token: owner,
    body: {
      action: 'region.upsert',
      kind: 'region',
      nameAr: 'منطقة اختبار',
      nameEn: 'Test region',
      governorateIds: [governorate.body?.[0]?.id],
    },
  });
  check('owner cannot create regions', forbidden.status === 403, `status ${forbidden.status}`);
}

const anon = await call('/rest/v1/profiles?select=id');
check('anonymous cannot read profiles', anon.status >= 400, `status ${anon.status}`);

const unauthenticated = await call('/functions/v1/me', { method: 'POST', body: {} });
check(
  'the gateway requires a session',
  unauthenticated.status === 401,
  `status ${unauthenticated.status}`,
);

if (failures > 0) {
  console.error(`\n✖ ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n✓ dev stack is healthy');
