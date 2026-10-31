'use client';

/**
 * Browser-side gateway client.
 *
 * The only place the web app talks to `functions/v1` — via the same-origin `/api/data` proxy, which
 * holds the bearer token server-side. Every mutation still carries an idempotency key.
 */

import { ApiClient } from '@maak/core';
import { getSupabaseConfig } from './supabase/config';

/**
 * Marker, not a credential. The session cookie is httpOnly, so this file cannot read a token — and
 * must not. `/api/data/...` runs on the server, swaps this header for the caller's real token, and
 * streams the answer back. `ApiClient` only needs a truthy value to know a session exists.
 */
const SESSION_MARKER = 'session-cookie';

export function getApiClient(): ApiClient | null {
  if (!getSupabaseConfig()) return null;

  return new ApiClient({
    baseUrl: '/api/data/functions/v1',
    transport: async ({ method, path, body, headers }) => {
      const response = await fetch(path, {
        method,
        headers,
        body: JSON.stringify(body),
        // `same-origin`, never `omit`: the session is an httpOnly cookie, and omitting credentials
        // would make every authenticated call look anonymous.
        credentials: 'same-origin',
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
    getToken: async () => SESSION_MARKER,
    clientVersion: 'web',
  });
}

/**
 * Uploads a verification document to the caller's own folder and returns its object path.
 *
 * Goes through `/api/data/storage/v1/...` for the same reason as every other call: the token stays in
 * an httpOnly cookie, and the server decides which folder that token may write to (the database
 * policies enforce `auth.uid()` as the folder prefix regardless).
 */
export async function uploadVerificationDocument(
  file: File,
  kind: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!getSupabaseConfig()) return { ok: false, error: 'not-configured' };

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
  const path = `${kind}-${Date.now()}-${safeName}`;

  const response = await fetch(`/api/data/storage/v1/object/verification-docs/${path}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-upsert': 'false' },
    body: file,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => 'upload failed');
    return { ok: false, error: detail || 'upload failed' };
  }
  return { ok: true, path };
}
