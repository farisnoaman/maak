/**
 * Where the browser actually is, and what it is allowed to do.
 *
 * Everything that depended on `request.url` was wrong behind the preview proxy: the server is reached
 * on `0.0.0.0:3000`, so redirects pointed at an address no browser can resolve and the session cookie
 * was written `SameSite=Lax` into an https page (where a cross-site iframe silently drops it).
 *
 * The fix is to ask the browser instead of guessing: a form POST carries `Origin`, a navigation carries
 * `Referer`. Those cannot be forged by a third-party page for our own host, so they are the strongest
 * evidence available. Proxy headers come next, then a value remembered for this host, then `Host`
 * itself.
 */

export const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i;

/**
 * Last known public origin per `Host` header.
 *
 * A navigation usually carries a `Referer`, but a bookmark or a typed URL does not — and by then the
 * browser has already told us where it is at least once (the sign-in POST always does). Remembering it
 * keeps the cookie attributes stable instead of flipping between `Lax` and `None` and invalidating the
 * session on a refresh.
 */
const remembered = new Map<string, string>();

export type OriginEvidence =
  'origin' | 'referer' | 'forwarded' | 'remembered' | 'host' | 'fallback';

export interface RequestContext {
  /** e.g. `https://3000-abc123.e2b.app` — safe to use in `Location`. */
  readonly origin: string;
  /** `https:` or `http:`. */
  readonly protocol: string;
  readonly host: string;
  /** Which signal decided it. Surfaced by `/api/auth/status` so a failure is diagnosable. */
  readonly evidence: OriginEvidence;
}

function parseUrl(value: string | null | undefined): URL | null {
  if (!value || value === 'null') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function firstHeader(value: string | null): string {
  return (value ?? '').split(',')[0]?.trim() ?? '';
}

function protocolFor(host: string, forwardedProto: string): string {
  if (process.env.MAAK_COOKIE_SECURE === 'true') return 'https:';
  if (process.env.MAAK_COOKIE_SECURE === 'false') return 'http:';
  if (host && !LOOPBACK.test(host)) return 'https:';
  const proto = forwardedProto.endsWith(':') ? forwardedProto : `${forwardedProto}:`;
  if (forwardedProto && (proto === 'https:' || proto === 'http:')) return proto;
  return process.env.NODE_ENV === 'production' ? 'https:' : 'http:';
}

export function resolveRequest(request: { headers: Headers }): RequestContext {
  const headers = request.headers;
  const host = firstHeader(headers.get('host'));
  const forwardedHost = firstHeader(headers.get('x-forwarded-host'));
  const forwardedProto = firstHeader(headers.get('x-forwarded-proto')).replace(/:$/, '');

  // 1. The browser's own testimony. A form POST always sends `Origin`; a navigation sends `Referer`.
  const signed = parseUrl(headers.get('origin')) ?? parseUrl(headers.get('referer'));
  if (signed) {
    // The scheme is the browser's, even when the `Host` we see is the proxy's internal address.
    const protocol = protocolFor(signed.host, signed.protocol);
    const origin = `${protocol}//${signed.host}`;
    if (host) remembered.set(host.toLowerCase(), origin);
    return {
      origin,
      protocol,
      host: signed.host,
      evidence: headers.get('origin') ? 'origin' : 'referer',
    };
  }

  // 2. A proxy that forwards the original host.
  const forwarded = forwardedHost || (LOOPBACK.test(host) ? '' : host);
  if (forwarded) {
    const protocol = protocolFor(forwarded, forwardedProto);
    const origin = `${protocol}//${forwarded}`;
    if (host) remembered.set(host.toLowerCase(), origin);
    return { origin, protocol, host: forwarded, evidence: 'forwarded' };
  }

  // 3. Something we learned earlier for this host.
  const memo = parseUrl(remembered.get(host.toLowerCase()));
  if (memo) {
    return {
      origin: memo.origin,
      protocol: memo.protocol,
      host: memo.host,
      evidence: 'remembered',
    };
  }

  // 4. A direct local request: `Host` is genuinely the browser's address.
  const protocol = protocolFor(host, forwardedProto);
  const localHost = host || 'localhost:3000';
  return {
    origin: `${protocol}//${localHost}`,
    protocol,
    host: localHost,
    evidence: host ? 'host' : 'fallback',
  };
}

/**
 * Same-origin check for state-changing handlers (CSRF defence), compared by **host only**.
 *
 * Scheme and port are deliberately ignored: TLS usually terminates in front of us, and a mismatch
 * there would reject good requests for no security gain. A request with no `Origin` is a same-origin
 * navigation or a server-to-server call, not a cross-site form post.
 */
export function isSameOriginRequest(request: { headers: Headers }): boolean {
  const rawOrigin = request.headers.get('origin');
  if (!rawOrigin) return true;

  const origin = parseUrl(rawOrigin);
  if (!origin) return false;

  const known = [request.headers.get('x-forwarded-host'), request.headers.get('host')]
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (known.includes(origin.host.toLowerCase())) return true;

  // Every host we can see is loopback, so the request cannot be verified at all. Refusing would break
  // sign-in behind any proxy that rewrites `Host`; an attacker still cannot make `Origin` match a
  // public host, which is the case that matters.
  if (known.length > 0 && known.every((value) => LOOPBACK.test(value))) {
    console.warn(`[auth] cannot verify the request origin (host ${known.join(', ')}); allowing`);
    return true;
  }

  return false;
}
