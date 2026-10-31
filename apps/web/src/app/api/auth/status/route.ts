import { NextResponse } from 'next/server';
import { getSession } from '@/lib/supabase/server';
import { AUTH_COOKIE_NAME } from '@/lib/supabase/config';
import { resolveRequest } from '@/lib/origin';

/**
 * Diagnostics for "I signed in and nothing happened".
 *
 * Open it in the window that misbehaves. It reports two independent things:
 *
 *   · **where the server thinks the browser is** — the evidence it used (`origin`, `referer`,
 *     `forwarded`, `remembered`, `host`), which is what decides cookie `SameSite`/`Secure` and every
 *     redirect target;
 *   · **whether the browser sent a session at all** — `sessionCookiePresent: false` means the cookie
 *     never arrived (blocked, or a cross-site frame); `true` with `user: null` means it arrived and was
 *     rejected. Two completely different bugs that look identical from the outside.
 *
 * Read-only, never echoes a cookie value or a token.
 */
export async function GET(request: Request) {
  const context = resolveRequest(request);
  const headers = request.headers;
  const session = await getSession();
  const cookieSent = (headers.get('cookie') ?? '').includes(`${AUTH_COOKIE_NAME}=`);

  return NextResponse.json(
    {
      configured: session.configured,
      sessionCookiePresent: cookieSent,
      sessionCookieName: AUTH_COOKIE_NAME,
      user: session.user?.email ?? session.user?.phone ?? null,
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
        // `cross-site` + `iframe` is the embedded preview. A browser that blocks third-party cookies
        // will store our session and never send it back, which is what an empty session looks like.
        secFetchSite: headers.get('sec-fetch-site'),
        secFetchDest: headers.get('sec-fetch-dest'),
        secFetchMode: headers.get('sec-fetch-mode'),
      },
      note: !cookieSent
        ? 'no session cookie reached the server — the browser is not storing or not sending it'
        : session.user
          ? 'the browser sent a session cookie and the server accepted it'
          : 'the cookie arrived but the token was rejected',
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
