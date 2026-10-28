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

export function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseConfig() !== null;
}
