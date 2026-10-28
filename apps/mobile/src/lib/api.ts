/**
 * Native gateway client — the same `@maak/core` ApiClient the web app uses.
 *
 * Only the transport differs (fetch is global in React Native; no cookies, so the bearer token is
 * read from the Supabase session on every call).
 */

import { ApiClient } from '@maak/core';
import { getMobileClient } from './supabase';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export function isBackendConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export function getApiClient(): ApiClient | null {
  if (!SUPABASE_URL) return null;
  const supabase = getMobileClient();
  if (!supabase) return null;

  return new ApiClient({
    baseUrl: `${SUPABASE_URL}/functions/v1`,
    clientVersion: 'mobile',
    transport: async ({ method, path, body, headers }) => {
      const response = await fetch(path, {
        method,
        headers,
        body: JSON.stringify(body),
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
  });
}

/** Uploads a captured document to the caller's own storage prefix and returns the object path. */
export async function uploadDocument(
  uri: string,
  kind: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const supabase = getMobileClient();
  if (!supabase) return { ok: false, error: 'not-configured' };

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (userError || !userId) return { ok: false, error: 'UNAUTHENTICATED' };

  const extension = uri.split('.').pop()?.toLowerCase() ?? 'jpg';
  const path = `${userId}/${kind}-${Date.now()}.${extension}`;

  try {
    // React Native cannot hand a `File` to storage, so the image is fetched as an ArrayBuffer.
    const response = await fetch(uri);
    const buffer = await response.arrayBuffer();

    const { error } = await supabase.storage.from('verification-docs').upload(path, buffer, {
      contentType: extension === 'png' ? 'image/png' : 'image/jpeg',
      upsert: false,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'upload failed' };
  }
}
