import { NextResponse } from 'next/server';
import { isTrustedOrigin, resolveRequest } from './origin';

/**
 * Redirects must be absolute URLs that are valid *for the browser*.
 *
 * `request.url` is not that: behind the preview proxy (and even with `next dev -H 0.0.0.0`) it carries
 * the address the server is *listening* on, and Next rejects a relative `Location`. So the origin comes
 * from `resolveRequest` — the browser's own `Origin`/`Referer` first.
 *
 * There is one case where nobody knows the public address: a cold navigation whose proxy rewrote
 * `Host`, before the browser has told us anything. Guessing then produces `http://0.0.0.0:3000`, which
 * a browser renders as "nothing happened". In that case we answer with a tiny document that navigates
 * itself using a *relative* URL, resolved by the browser against the address it actually used.
 */
export function redirectTo(
  request: { headers: Headers },
  path: string,
  status: 303 | 307 = 307,
): NextResponse {
  const context = resolveRequest(request);
  const target = path.startsWith('/') ? path : `/${path}`;

  // No trustworthy host *and* nothing learned yet — let the browser resolve the path itself.
  if (!isTrustedOrigin(context)) return selfNavigatingPage(target);

  const url = new URL(target, context.origin);
  return new NextResponse(null, {
    status,
    headers: { location: url.toString(), 'cache-control': 'no-store' },
  });
}

/**
 * A 200 page that immediately navigates to `path`, using a relative URL.
 *
 * Deliberately not a `Location` header: the whole point is that we do not know the absolute origin, and
 * the browser does. `<meta refresh>` works without JavaScript; the inline `location.replace` makes it
 * instant when JavaScript is on; the link is the accessible fallback.
 */
function selfNavigatingPage(path: string): NextResponse {
  const safe = path.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const body = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${safe}">
<title>Maak</title></head>
<body><p><a href="${safe}">${safe}</a></p>
<script>location.replace(${JSON.stringify(path)})</script></body></html>`;

  return new NextResponse(body, {
    // A 3xx without a `Location` is ignored by browsers, so they would stay put; 200 is honest and the
    // document does the navigating.
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
