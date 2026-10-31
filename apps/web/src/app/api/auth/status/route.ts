import { NextResponse } from 'next/server';
import { getSession, URL_SESSION_ENABLED } from '@/lib/supabase/server';
import { AUTH_COOKIE_NAME } from '@/lib/supabase/config';
import { resolveRequest } from '@/lib/origin';

/**
 * Diagnostics for "I signed in and nothing happened".
 *
 * It answers two **independent** questions, which look identical from the outside:
 *
 *   · **where the server thinks the browser is** — the evidence it used (`origin`, `referer`,
 *     `forwarded`, `remembered`, `host`), which decides cookie `SameSite`/`Secure` and every redirect;
 *   · **which channel is carrying the session** — a cookie, or (outside production) the token the proxy
 *     recovers from `?st=` for previews where the browser refuses to store anything.
 *
 * `sessionCookiePresent: false` is **not an error** when `via: "token"` and `signedIn: true` — it is the
 * expected shape in an embedded preview whose browser blocks third-party storage. The `summary` field
 * says so in one sentence rather than leaving you to infer it.
 *
 * Read-only, and it never echoes a cookie value or a token.
 */
export async function GET(request: Request) {
  const context = resolveRequest(request);
  const headers = request.headers;

  // Read the same token the app itself is using, so the probe reports the real session.
  const url = new URL(request.url);
  const tokenInUrl = URL_SESSION_ENABLED ? url.searchParams.get('st') : null;
  const session = await getSession(tokenInUrl);
  const cookieSent = (headers.get('cookie') ?? '').includes(`${AUTH_COOKIE_NAME}=`);
  const signedIn = Boolean(session.user);

  const via: 'cookie' | 'token' | 'none' = !signedIn
    ? 'none'
    : tokenInUrl || headers.get('x-maak-token')
      ? 'token'
      : 'cookie';

  const summary = !session.configured
    ? 'The auth backend is not configured — check apps/web/.env.local.'
    : signedIn && via === 'token'
      ? 'Signed in through the URL token, not a cookie: this browser refuses to store one in an ' +
        'embedded frame. That is expected in the preview and the app works normally.'
      : signedIn
        ? 'Signed in through a session cookie, and the server accepted it.'
        : cookieSent
          ? 'A session cookie arrived, but it was not valid — it may have expired. Sign in again.'
          : 'No session at all. This probe was opened without a token, so sign in from this window first.';

  return NextResponse.json(
    {
      // Headline first: the one question people actually open this for.
      ok: true,
      signedIn,
      via,
      user: session.user?.email ?? session.user?.phone ?? null,
      summary,

      configured: session.configured,
      sessionCookiePresent: cookieSent,
      sessionCookieName: AUTH_COOKIE_NAME,
      tokenChannel: {
        enabled: URL_SESSION_ENABLED,
        present: Boolean(tokenInUrl || headers.get('x-maak-token')),
        why: 'development-only fallback for previews where the browser blocks third-party storage',
      },

      browser: {
        resolvedOrigin: context.origin,
        scheme: context.protocol,
        host: context.host,
        evidence: context.evidence,
      },
      // The headers the proxy actually preserved — the whole point when a redirect goes somewhere odd.
      received: {
        host: headers.get('host'),
        forwardedHost: headers.get('x-forwarded-host'),
        forwardedProto: headers.get('x-forwarded-proto'),
        origin: headers.get('origin'),
        referer: headers.get('referer'),
        // `cross-site` + `iframe` is the embedded preview: a browser that blocks third-party storage
        // will store our cookie and never send it back, which is exactly what an empty session is.
        secFetchSite: headers.get('sec-fetch-site'),
        secFetchDest: headers.get('sec-fetch-dest'),
        secFetchMode: headers.get('sec-fetch-mode'),
        hasTokenParam: Boolean(tokenInUrl),
      },
      note: cookieSent
        ? 'a session cookie reached the server'
        : 'no session cookie reached the server — normal when signed in with the token channel',
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
