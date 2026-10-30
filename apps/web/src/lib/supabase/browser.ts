'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AUTH_COOKIE_NAME, getSupabaseConfig } from './config';

let cached: SupabaseClient | null = null;

/**
 * Browser client for auth and RLS-filtered reads.
 * Returns null when the environment is not configured, so the UI can show a clear notice
 * instead of throwing during a preview or a fresh clone.
 */
export function getBrowserClient(): SupabaseClient | null {
  if (cached) return cached;
  const config = getSupabaseConfig();
  if (!config) return null;
  cached = createBrowserClient(config.url, config.anonKey, {
    cookieOptions: { name: AUTH_COOKIE_NAME },
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    global: { headers: { 'X-Maak-Client': 'web' } },
  });
  return cached;
}
