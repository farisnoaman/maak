import { NextResponse } from 'next/server';
import { getSession } from '@/lib/supabase/server';
import { AUTH_COOKIE_NAME } from '@/lib/supabase/config';

/**
 * Diagnostics for "I signed in and nothing happened".
 *
 * Open it in the same window that misbehaves: it reports whether this request carried a session at
 * all. `sessionCookiePresent: false` means the browser never sent it (blocked, or cross-site frame);
 * `true` with `user: null` means the token arrived and was rejected — two completely different bugs
 * that look identical from the outside.
 *
 * Read-only, and it never echoes the cookie value.
 */
export async function GET(request: Request) {
  const session = await getSession();
  const cookieSent = (request.headers.get('cookie') ?? '').includes(`${AUTH_COOKIE_NAME}=`);

  return NextResponse.json(
    {
      configured: session.configured,
      sessionCookiePresent: cookieSent,
      sessionCookieName: AUTH_COOKIE_NAME,
      user: session.user?.email ?? session.user?.phone ?? null,
      note: !cookieSent
        ? 'no session cookie reached the server — the browser is not storing or not sending it'
        : session.user
          ? 'the browser sent a session cookie and the server accepted it'
          : 'the cookie arrived but the token was rejected',
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
