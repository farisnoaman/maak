/**
 * Supabase connection settings, resolved once.
 *
 * Only the anon key ever reaches the browser: it can read nothing that RLS forbids and can write
 * nothing at all (all write grants are revoked — see migration 00003). The service-role key is
 * used exclusively inside Edge Functions.
 */

export interface SupabaseConfig {
  readonly url: string;
  readonly anonKey: string;
}

/**
 * The session cookie name, pinned instead of derived.
 *
 * `@supabase/ssr` otherwise derives the storage key from the URL's first host label. With a
 * same-origin proxy the browser sees `3000-abc.e2b.app` while the server talks to `127.0.0.1`, so
 * the two would disagree about which cookie holds the session and every server render would look
 * signed out. One constant, both runtimes, no drift.
 */
export const AUTH_COOKIE_NAME = 'sb-maak-auth';

/**
 * Cookie attributes for the session, derived from the scheme the page is actually served over.
 *
 * Why this is not simply `SameSite=Lax`: the hosted preview renders the app inside a cross-site
 * iframe, and a document in a third-party frame is "cross-site" even when it calls its own origin.
 * A `Lax` cookie is then never sent back — the browser looks signed in on the client and signed out
 * on the server, which reads as "sign-in does nothing". `SameSite=None` is the only attribute that
 * survives that context, and it is only legal together with `Secure`, which in turn needs https.
 *
 * Over plain http (localhost) `None` is rejected, so local development stays on `Lax`. Both sides —
 * browser and server — derive this from the real request, so they can never disagree.
 */
export interface AuthCookieFlags {
  readonly sameSite: 'lax' | 'none';
  readonly secure: boolean;
  /**
   * `Partitioned` (CHIPS): lets the cookie exist inside a third-party frame *and* keeps it keyed to
   * this top-level site, which is exactly the preview's situation. Browsers that do not know the
   * attribute ignore it, so it costs nothing where it is not needed.
   */
  readonly partitioned?: boolean;
}

export function authCookieFlags(protocol: string): AuthCookieFlags {
  return protocol.startsWith('https')
    ? { sameSite: 'none', secure: true, partitioned: true }
    : { sameSite: 'lax', secure: false };
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i;

/** `http` in, `http:` out; tolerates a comma-separated proxy chain and a missing colon. */
function normalizeProto(value: string): string {
  const first = value.split(',')[0] ?? 'https';
  return `${first.trim().replace(/:$/, '')}:`;
}

/**
 * The scheme this request was *browser-visible* on.
 *
 * Order matters, because getting it wrong silently breaks every protected page: the cookie is then
 * written `SameSite=Lax` and, inside the preview's cross-site iframe, is never sent back.
 *
 *  1. the browser knows, if there is one;
 *  2. a **non-loopback `Host` is https**. It beats `x-forwarded-proto` on purpose: in `next dev` the
 *     framework itself supplies `x-forwarded-proto: http`, describing the hop to the dev server rather
 *     than the browser's connection — trusting it wrote `SameSite=Lax` cookies into an https preview,
 *     where they are then never sent back. A public host on plain http is rare enough to be an
 *     explicit override (`MAAK_COOKIE_SECURE=false`);
 *  3. otherwise `x-forwarded-proto`;
 *  4. otherwise local: http in development, https in production.
 *
 * `MAAK_COOKIE_SECURE` overrides all of it for unusual deployments (plain http on a LAN IP).
 */
export function requestProtocol(forwardedProto?: string | null, host?: string | null): string {
  if (process.env.MAAK_COOKIE_SECURE === 'true') return 'https:';
  if (process.env.MAAK_COOKIE_SECURE === 'false') return 'http:';
  if (typeof window !== 'undefined') return window.location.protocol;
  if (host && !LOOPBACK.test(host)) return 'https:';
  if (forwardedProto) return normalizeProto(forwardedProto);
  return process.env.NODE_ENV === 'production' ? 'https:' : 'http:';
}

/**
 * Resolves the API base URL for the current runtime.
 *
 * A `/`-prefixed URL means "same origin, through the Next rewrite":
 *   · the browser expands it against its own origin, so the hosted preview works without anyone
 *     knowing its public host name — and the request stays same-origin, so there is no CORS;
 *   · the server talks to `MAAK_SUPABASE_INTERNAL` *directly* (the rewrite is a browser convenience,
 *     not a hop the server needs), so the mount path is dropped.
 *
 * Both results are absolute because `supabase-js` builds its endpoints with `new URL(path, base)`,
 * which rejects relative bases. In production `NEXT_PUBLIC_SUPABASE_URL` is already absolute, so
 * this is a no-op.
 */
export function resolveSupabaseUrl(url: string): string {
  if (!url.startsWith('/')) return url;
  if (typeof window !== 'undefined') return `${window.location.origin}${url}`;
  return (process.env.MAAK_SUPABASE_INTERNAL ?? 'http://127.0.0.1:54321').replace(/\/$/, '');
}

export function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url: resolveSupabaseUrl(url), anonKey };
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseConfig() !== null;
}
