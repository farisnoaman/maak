import { cookies, headers } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { AUTH_COOKIE_NAME, authCookieFlags, getSupabaseConfig } from './config';
import { resolveRequest } from '../origin';

/**
 * Server-side session, with **two ways in**.
 *
 * 1. the normal one: a session cookie, refreshed by the proxy;
 * 2. a bearer token carried in the request header `x-maak-token`, injected by the proxy from `?st=`.
 *
 * (2) exists because an embedded preview can make cookies impossible: a third-party iframe whose
 * browser blocks third-party storage, or a proxy that drops `Set-Cookie`. Neither is a bug we can fix
 * from inside the app, and "sign-in does nothing" is not an acceptable answer. A token in the URL is a
 * weaker mechanism — it appears in history and server logs — so it is enabled **only outside
 * production** and can be switched off with `MAAK_IFRAME_SESSION=0`.
 */

type StorageCookieOptions = CookieOptions & { name?: string };

/** Token-in-URL fallback: development only, never in a production build. */
export const URL_SESSION_ENABLED =
  process.env.NODE_ENV !== 'production' && process.env.MAAK_IFRAME_SESSION !== '0';

export const TOKEN_HEADER = 'x-maak-token';

function cookieOptionsFor(protocol: string): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    ...authCookieFlags(protocol),
    maxAge: 60 * 60 * 24 * 30,
  };
}

/** A client that acts as the bearer of `token`, without touching cookies. */
function tokenClient(token: string): SupabaseClient | null {
  const config = getSupabaseConfig();
  if (!config) return null;
  return createServerClient(config.url, config.anonKey, {
    global: { headers: { Authorization: `Bearer ${token}`, 'X-Maak-Client': 'web-token' } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    cookies: { getAll: () => [], setAll: () => {} },
  });
}

/**
 * The cookie-backed client. Used for session-aware rendering and for the proxy's refresh, and as the
 * fallback when no token header is present.
 */
export async function getServerClient(): Promise<SupabaseClient | null> {
  const config = getSupabaseConfig();
  if (!config) return null;

  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);

  const injected = requestHeaders.get(TOKEN_HEADER);
  if (injected) return tokenClient(injected);

  const cookieOptions = cookieOptionsFor(resolveRequest({ headers: requestHeaders }).protocol);
  const storageOptions: StorageCookieOptions = { ...cookieOptions, name: AUTH_COOKIE_NAME };

  return createServerClient(config.url, config.anonKey, {
    cookieOptions: storageOptions,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, { ...cookieOptions, ...options });
          }
        } catch {
          // Called from a Server Component render: the proxy refreshes the session instead.
        }
      },
    },
    global: { headers: { 'X-Maak-Client': 'web-server' } },
  });
}

/** The bearer token this request carries, from the header or from the session cookie. */
export async function resolveAccessToken(): Promise<string | null> {
  const injected = (await headers()).get(TOKEN_HEADER);
  if (injected) return injected;

  const client = await getServerClient();
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session?.access_token ?? null;
}

export interface SessionInfo {
  readonly configured: boolean;
  readonly user: Pick<User, 'id' | 'email' | 'phone'> | null;
}

export async function getSession(): Promise<SessionInfo> {
  const config = getSupabaseConfig();
  if (!config) return { configured: false, user: null };

  const token = await resolveAccessToken();
  if (!token) return { configured: true, user: null };

  // Ask the auth endpoint who this token belongs to. This works identically for a cookie session and
  // for an injected token, and it is the only check that cannot be fooled by a forged local state.
  const response = await fetch(`${config.url}/auth/v1/user`, {
    headers: { authorization: `Bearer ${token}`, apikey: config.anonKey },
    cache: 'no-store',
  });
  if (!response.ok) return { configured: true, user: null };

  const user = (await response.json()) as {
    id: string;
    email?: string | null;
    phone?: string | null;
  };
  return {
    configured: true,
    user: {
      id: user.id,
      email: user.email ?? null,
      phone: user.phone ?? null,
    } as SessionInfo['user'],
  };
}
