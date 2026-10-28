import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { LOCALES, negotiateLocale } from '@maak/core';

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
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
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
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
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
    const signIn = new URL(`/${locale}/auth/sign-in`, request.url);
    signIn.searchParams.set('next', `${pathname}${search}`);
    // Preserve the destination so the user lands where they intended, not on a generic home page.
    return NextResponse.redirect(signIn);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)'],
};
