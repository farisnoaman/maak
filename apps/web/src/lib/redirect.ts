import { NextResponse } from 'next/server';
import { requestProtocol } from './supabase/config';

/**
 * Redirects must be absolute URLs that are valid *for the browser*, which is not the same thing as
 * `request.url`: behind a preview proxy — or even `next dev -H 0.0.0.0` — `request.url` carries the
 * address the server listens on (`http://0.0.0.0:3000`), and Next rejects a relative `Location`
 * outright. So the origin is rebuilt from the incoming `Host` / `x-forwarded-*` headers: the address
 * the browser actually used.
 */
export function requestOrigin(request: { headers: Headers }): string {
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? 'localhost:3000';
  const protocol = requestProtocol(request.headers.get('x-forwarded-proto'), host).replace(
    /:$/,
    '',
  );
  return `${protocol}://${host.split(',')[0]?.trim() ?? host}`;
}

export function redirectTo(
  request: { headers: Headers },
  path: string,
  status: 303 | 307 = 307,
): NextResponse {
  const target = new URL(path.startsWith('/') ? path : `/${path}`, requestOrigin(request));
  return new NextResponse(null, {
    status,
    headers: { location: target.toString(), 'cache-control': 'no-store' },
  });
}
