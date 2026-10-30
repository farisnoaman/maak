import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { AUTH_COOKIE_NAME, getSupabaseConfig } from './config';

/**
 * `@supabase/ssr` reads `cookieOptions.name` as the *storage key* for the session, but types it as the
 * `cookie` serialise options, which have no `name`. Widening the type here is the whole trick, and it
 * is worth it: deriving the key from the URL host would give the browser and the server different
 * cookie names behind the same-origin dev proxy.
 */
type StorageCookieOptions = CookieOptions & { name?: string };

const COOKIE_OPTIONS: CookieOptions = {
  path: '/',
  // The session cookie must never be readable by JavaScript, and only over HTTPS in production.
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 60 * 60 * 24 * 30,
};

/**
 * Server-side client bound to the request cookies (App Router).
 * Used for session-aware rendering and protected routes; writes still go through the gateway.
 */
export async function getServerClient(): Promise<SupabaseClient | null> {
  const config = getSupabaseConfig();
  if (!config) return null;

  const cookieStore = await cookies();

  const storageOptions: StorageCookieOptions = { ...COOKIE_OPTIONS, name: AUTH_COOKIE_NAME };

  return createServerClient(config.url, config.anonKey, {
    cookieOptions: storageOptions,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, { ...COOKIE_OPTIONS, ...options });
          }
        } catch {
          // Called from a Server Component render: the proxy refreshes the session instead.
        }
      },
    },
    global: { headers: { 'X-Maak-Client': 'web-server' } },
  });
}

export interface SessionInfo {
  readonly configured: boolean;
  readonly user: Pick<User, 'id' | 'email' | 'phone'> | null;
}

export async function getSession(): Promise<SessionInfo> {
  const client = await getServerClient();
  if (!client) return { configured: false, user: null };

  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return { configured: true, user: null };

  return {
    configured: true,
    user: {
      id: data.user.id,
      email: data.user.email ?? null,
      phone: data.user.phone ?? null,
    } as SessionInfo['user'],
  };
}
