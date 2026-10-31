import { NextResponse } from 'next/server';
import { resolveRequest } from './origin';

/**
 * Redirects must be absolute URLs that are valid *for the browser*, which is not `request.url`: behind
 * a proxy (and even with `next dev -H 0.0.0.0`) that carries the address the server is *listening* on,
 * and Next rejects a relative `Location`.
 *
 * `resolveRequest` supplies the answer — first-hand evidence from the browser (`Origin`/`Referer`),
 * then the proxy's forwarded host, then `Host`, which is correct for a direct local request.
 */
export function redirectTo(
  request: { headers: Headers },
  path: string,
  status: 303 | 307 = 307,
): NextResponse {
  const { origin } = resolveRequest(request);
  const target = new URL(path.startsWith('/') ? path : `/${path}`, origin);
  return new NextResponse(null, {
    status,
    headers: { location: target.toString(), 'cache-control': 'no-store' },
  });
}
