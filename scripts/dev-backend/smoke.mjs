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

/**
 * The sign-in form, posted exactly as the browser posts it. Returns the cookie header.
 *
 * `origin` matters: a browser always sends it, and comparing it against the *internal* listening
 * origin is what made every preview sign-in answer `403 FORBIDDEN`.
 */
async function signInThroughForm(email, origin = BASE, extraHeaders = {}) {
  const response = await fetch(`${BASE}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin, ...extraHeaders },
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

  // The preview's situation: the browser refuses to store any cookie. The token in the redirect is
  // then the only session, and every screen must still work.
  const token = signIn.location ? new URL(signIn.location, BASE).searchParams.get('st') : null;
  check('sign-in hands back a cookie-less session token', Boolean(token));

  if (token) {
    const viaToken = await call(`/ar/account?st=${encodeURIComponent(token)}`, {
      headers: { accept: 'text/html' },
    });
    check(
      'the protected page renders with the token alone',
      viaToken.status === 200,
      `status ${viaToken.status}`,
    );
    check('and shows the signed-in user', viaToken.text.includes('فارس'));
    check(
      'notifications render their values, not raw {name} placeholders',
      viaToken.text.includes('مكانك «') && !viaToken.text.includes('{name}'),
    );
    check(
      'notification links carry the locale prefix',
      viaToken.text.includes('href="/ar/admin/places"'),
    );

    const meViaToken = await call(`/api/data/functions/v1/me?st=${encodeURIComponent(token)}`, {
      method: 'POST',
      body: {},
    });
    check(
      'the data proxy works with the token alone',
      meViaToken.body?.user?.roles?.includes('platform_admin'),
    );

    const statusViaToken = await call(`/api/auth/status?st=${encodeURIComponent(token)}`);
    check(
      'the probe reports the token session instead of looking broken',
      statusViaToken.body?.signedIn === true && statusViaToken.body?.via === 'token',
      `${statusViaToken.body?.signedIn}/${statusViaToken.body?.via}`,
    );

    const placesViaToken = await call(`/ar/admin/places?st=${encodeURIComponent(token)}`, {
      headers: { accept: 'text/html' },
    });
    check(
      'RLS-filtered content renders with the token alone',
      placesViaToken.status === 200 && placesViaToken.text.includes('نقطة تجمع'),
    );
  }

  const anonymousStatus = await call('/api/auth/status');
  check(
    'and an anonymous probe explains itself rather than just showing null',
    anonymousStatus.body?.signedIn === false &&
      typeof anonymousStatus.body?.summary === 'string' &&
      anonymousStatus.body.summary.includes('sign in'),
  );

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

  // A public host header is what makes the origin check decidable at all; on loopback the app allows
  // the request rather than break sign-in for a proxy that forwards no host.
  // `fetch` refuses to override `Host`, so the public host arrives the way a proxy sends it.
  const hostile = await signInThroughForm('admin@maak.test', 'https://evil.example', {
    'x-forwarded-host': '3000-abc123.e2b.app',
  });
  check(
    'a cross-site form post is refused',
    !hostile.setCookie.some((line) => line.includes('sb-maak-auth=')),
  );
  check(
    'and the refusal is a readable page, not raw JSON',
    (hostile.location ?? '').includes('error=origin'),
    String(hostile.location),
  );

  const redirect = await fetch(`${BASE}/ar/account`, { redirect: 'manual' });
  const location = redirect.headers.get('location');
  check(
    'a protected page still sends you to sign-in',
    redirect.status === 307 || redirect.status === 303,
    `status ${redirect.status}`,
  );
  if (location) {
    // The redirect must point at an address the browser can actually reach — never the listening one.
    const bounced = new URL(location, BASE);
    check(
      'and the bounce keeps the browser on a reachable host',
      bounced.host === new URL(BASE).host && !bounced.host.includes('0.0.0.0'),
      location,
    );
  }

  // The preview proxy may rewrite every Host header. The browser still says where it is: `Origin`.
  const viaPreview = await signInThroughForm('admin@maak.test', 'https://3000-preview.e2b.app', {
    'x-forwarded-host': '0.0.0.0:3000',
    'x-forwarded-proto': 'http',
  });
  const previewTarget = new URL(viaPreview.location ?? '/', 'https://3000-preview.e2b.app');
  check(
    'a rewritten Host still redirects to the real browser origin',
    previewTarget.origin === 'https://3000-preview.e2b.app' &&
      previewTarget.pathname === '/ar/account',
    String(viaPreview.location),
  );
  check(
    'and the cookie is cross-site capable (Secure, SameSite=None)',
    viaPreview.setCookie.some((line) => /SameSite=none/i.test(line) && /Secure/i.test(line)),
    viaPreview.setCookie.join(' | ').slice(0, 100),
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
