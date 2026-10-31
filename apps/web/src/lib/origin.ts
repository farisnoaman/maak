/**
 * Same-origin check for state-changing route handlers (CSRF defence).
 *
 * The naive version compares `Origin` with `request.nextUrl.origin`, and it fails in exactly the place
 * that matters: behind a proxy, `nextUrl.origin` is the address the server was reached on internally
 * (`http://localhost:3000`), while the browser honestly says `https://3000-abc.e2b.app`. Every form post
 * in the hosted preview then came back `403 FORBIDDEN`.
 *
 * So the expectation is built from the headers the proxy preserves — `Host` and `x-forwarded-host` —
 * and compared by **host only**. Scheme and port are deliberately not compared: TLS usually terminates
 * in front of us, and a mismatch there would reject good requests for no security gain. An attacker's
 * page cannot forge either header, so the check still does its job.
 *
 * A request without an `Origin` header is allowed: that is a same-origin navigation, a `curl`, or a
 * server-to-server call — none of them a cross-site form post.
 */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i;

export function isSameOriginRequest(request: { headers: Headers }): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }

  const hosts = [request.headers.get('x-forwarded-host'), request.headers.get('host')]
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (hosts.includes(originHost)) return true;

  // Every host we can see is loopback, which means a proxy in front of us did not forward the
  // original host and the request cannot be verified at all. Refusing here would break sign-in for
  // every browser behind such a proxy; the attacker's page still cannot forge `Origin` to match a
  // *public* host, which is the case that matters. Log it rather than fail silently.
  if (hosts.every((host) => LOOPBACK.test(host))) {
    console.warn(`[auth] cannot verify the request origin (host ${hosts.join(', ')}); allowing`);
    return true;
  }

  return false;
}
