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
