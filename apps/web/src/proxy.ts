import { NextResponse, type NextRequest } from 'next/server';
import { LOCALES, negotiateLocale } from '@maak/core';

/**
 * Locale negotiation (Next 16 file convention: `proxy.ts`): `/` → `/ar` (or `/en` from the Accept-Language header).
 * Unknown first segments that are not locales are passed through untouched.
 */
export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === '/') {
    const locale = negotiateLocale(request.headers.get('accept-language'));
    return NextResponse.redirect(new URL(`/${locale}`, request.url));
  }

  const firstSegment = pathname.split('/')[1];
  if (firstSegment && !(LOCALES as readonly string[]).includes(firstSegment)) {
    // A real 404 is better than an infinite redirect loop for unknown top-level paths.
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|robots.txt|sitemap.xml).*)'],
};
