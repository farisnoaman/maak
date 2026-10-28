'use client';

/**
 * Browser-side gateway client.
 *
 * The only place the web app talks to `functions/v1`. The session token is read at call time (never
 * cached), so a refreshed token is always used, and every mutation carries an idempotency key.
 */

import { ApiClient } from '@maak/core';
import { getBrowserClient } from './supabase/browser';
import { getSupabaseConfig } from './supabase/config';

export function getApiClient(): ApiClient | null {
  const config = getSupabaseConfig();
  const supabase = getBrowserClient();
  if (!config || !supabase) return null;

  return new ApiClient({
    baseUrl: `${config.url}/functions/v1`,
    transport: async ({ method, path, body, headers }) => {
      const response = await fetch(path, {
        method,
        headers,
        body: JSON.stringify(body),
        credentials: 'omit',
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { code: 'INTERNAL', detail: 'Unreadable response' };
      }
      return { status: response.status, body: parsed };
    },
    getToken: async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    },
    clientVersion: 'web',
  });
}

/** Uploads a verification document to the caller's own folder and returns its object path. */
export async function uploadVerificationDocument(
  file: File,
  kind: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const supabase = getBrowserClient();
  if (!supabase) return { ok: false, error: 'not-configured' };

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return { ok: false, error: 'UNAUTHENTICATED' };

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
  const path = `${userId}/${kind}-${Date.now()}-${safeName}`;

  const { error } = await supabase.storage
    .from('verification-docs')
    .upload(path, file, { contentType: file.type, upsert: false });

  if (error) return { ok: false, error: error.message };
  return { ok: true, path };
}
