import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { LOCALES, negotiateLocale } from '@maak/core';
import {
  AUTH_COOKIE_NAME,
  authCookieFlags,
  getSupabaseConfig,
  requestProtocol,
} from './lib/supabase/config';

/**
 * Two jobs, in order:
 *
 * 1. Locale negotiation — `/` redirects to `/ar` (or `/en` from Accept-Language), preserving query.
 * 2. Session refresh — Supabase access tokens are short-lived; refreshing them here means Server
 *    Components always see a valid session, and the refresh cookie stays httpOnly.
 *
 * Next 16 file convention: `proxy.ts` (formerly `middleware.ts`).
 */

const PROTECTED_PREFIXES = ['/account', '/operator', '/staff', '/admin', '/finance'];

export default async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (pathname === '/') {
    const locale = negotiateLocale(request.headers.get('accept-language'));
    const target = new URL(`/${locale}`, request.url);
    target.search = search;
    return NextResponse.redirect(target);
  }

  const segments = pathname.split('/').filter(Boolean);
  const first = segments[0];
  const config = getSupabaseConfig();

  if (!config) return NextResponse.next();

  let response = NextResponse.next({ request });

  const flags = authCookieFlags(
    requestProtocol(request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol),
  );
  const supabase = createServerClient(config.url, config.anonKey, {
    cookieOptions: { name: AUTH_COOKIE_NAME, ...flags },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, {
            ...options,
            httpOnly: true,
            ...flags,
            path: '/',
          });
        }
      },
    },
  });

  const { data } = await supabase.auth.getUser();
  const isLocaleSegment = first !== undefined && (LOCALES as readonly string[]).includes(first);

  if (!isLocaleSegment) return response;

  const locale = first as string;
  const rest = `/${segments.slice(1).join('/')}`;
  const needsAuth = PROTECTED_PREFIXES.some(
    (prefix) => rest === prefix || rest.startsWith(`${prefix}/`),
  );

  if (needsAuth && !data.user) {
    // The single most useful line when a sign-in "does nothing": it says whether the cookie arrived at
    // all, which separates a blocked/cross-site cookie from a rejected token.
    console.warn(
      `[auth] ${pathname} → sign-in (session cookie ${request.cookies.has(AUTH_COOKIE_NAME) ? 'present' : 'absent'})`,
    );
    const signIn = new URL(`/${locale}/auth/sign-in`, request.url);
    signIn.searchParams.set('next', `${pathname}${search}`);
    // Preserve the destination so the user lands where they intended, not on a generic home page.
    return NextResponse.redirect(signIn);
  }

  return response;
}

export const config = {
  // `supabase` is the same-origin proxy to the API: it must never run session logic, or every
  // auth call would recurse through `auth.getUser()`.
  matcher: ['/((?!_next|supabase|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)'],
};
