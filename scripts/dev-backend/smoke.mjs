/**
 * End-to-end smoke test for the dev stack — the same path a browser takes.
 *
 * It talks to the app origin (default `http://127.0.0.1:3000`), so the Next rewrite, the sign-in form,
 * the httpOnly session cookie, the same-origin data proxy and the RLS-filtered reads are all exercised
 * together. Nothing here uses a shortcut the browser does not have.
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

/** Pages and `/api/*` are app routes; everything else is the Supabase-shaped surface. */
function urlFor(path) {
  if (path.startsWith('/api/') || /^\/(ar|en)(\/|$)/.test(path)) return `${BASE}${path}`;
  return `${BASE}${PREFIX}${path}`;
}

async function call(path, { method = 'GET', token, body, headers = {}, cookie } = {}) {
  const response = await fetch(urlFor(path), {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers, text };
}

/** The sign-in form, posted exactly as the browser posts it. Returns the cookie header. */
async function signInThroughForm(email) {
  const response = await fetch(`${BASE}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      mode: 'email',
      locale: 'ar',
      email,
      password: PASSWORD,
    }).toString(),
    redirect: 'manual',
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((line) => line.split(';')[0]).join('; ');
  return {
    status: response.status,
    location: response.headers.get('location'),
    setCookie,
    cookie,
  };
}

console.log(`▸ smoke test against ${BASE}${PREFIX}`);

if (!useApi) {
  const signIn = await signInThroughForm('admin@maak.test');
  check(
    'the sign-in form accepts valid credentials',
    signIn.status === 303,
    `status ${signIn.status}`,
  );
  // An absolute `Location` derived from the *listening* address (0.0.0.0) is a classic preview bug:
  // the server is happy, the browser cannot resolve it.
  const target = new URL(signIn.location, BASE);
  check(
    'it redirects to a browser-reachable address',
    target.pathname === '/ar/account' && target.host === new URL(BASE).host,
    String(signIn.location),
  );
  check('it sets the session cookie on the redirect', signIn.cookie.includes('sb-maak-auth='));

  const account = await call('/ar/account', {
    cookie: signIn.cookie,
    headers: { accept: 'text/html' },
  });
  check(
    'the protected page renders for that cookie',
    account.status === 200,
    `status ${account.status}`,
  );
  check('and shows the signed-in user', account.text.includes('فارس'));

  const status = await call('/api/auth/status', { cookie: signIn.cookie });
  check(
    'the session probe sees the user',
    status.body?.user === 'admin@maak.test',
    JSON.stringify(status.body),
  );

  const search = await call('/api/data/rest/v1/rpc/search_places', {
    method: 'POST',
    cookie: signIn.cookie,
    body: { p_query: 'عدن', p_locale: 'ar', p_limit: 3 },
  });
  check(
    'the data proxy reaches the database as the user',
    Array.isArray(search.body) && search.body.length > 0,
  );

  const me = await call('/api/data/functions/v1/me', {
    method: 'POST',
    cookie: signIn.cookie,
    body: {},
  });
  check(
    'the gateway resolves the actor',
    me.body?.user?.roles?.includes('platform_admin'),
    JSON.stringify(me.body).slice(0, 120),
  );

  const anonymous = await call('/api/data/rest/v1/rpc/search_places', {
    method: 'POST',
    body: { p_query: 'عدن', p_locale: 'ar', p_limit: 3 },
  });
  check(
    'an anonymous caller cannot run an authenticated-only function',
    anonymous.status >= 400,
    `status ${anonymous.status}`,
  );

  const redirect = await fetch(`${BASE}/ar/account`, { redirect: 'manual' });
  check(
    'a protected page still redirects when signed out',
    redirect.status === 307 || redirect.status === 303,
  );
  const bounced = new URL(redirect.headers.get('location') ?? '/', BASE);
  check(
    'and the bounce keeps the browser on a reachable host',
    bounced.host === new URL(BASE).host && !bounced.host.includes('0.0.0.0'),
    String(redirect.headers.get('location')),
  );
}

if (useApi) {
  const token = async (email) => {
    const result = await call('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });
    return result.body?.access_token ?? null;
  };

  const admin = await token('admin@maak.test');
  check('admin can sign in', Boolean(admin));
  const me = await call('/functions/v1/me', { method: 'POST', token: admin, body: {} });
  check('me returns a resolved actor', me.body?.user?.roles?.includes('platform_admin'));
  const governorates = await call('/rest/v1/governorates?select=code&limit=100', { token: admin });
  check(
    '22 governorates are readable',
    Array.isArray(governorates.body) && governorates.body.length === 22,
  );

  const owner = await token('owner@maak.test');
  const forbidden = await call('/functions/v1/geography', {
    method: 'POST',
    token: owner,
    body: {
      action: 'region.setActive',
      regionId: '00000000-0000-4000-8000-000000000000',
      active: false,
    },
  });
  check(
    'a plain individual cannot manage regions',
    forbidden.status === 403,
    `status ${forbidden.status}`,
  );
}

const write = await call('/rest/v1/governorates', { method: 'POST', body: {} });
check('REST rejects writes (single write path)', write.status === 405, `status ${write.status}`);

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
