/**
 * Server-side gateway calls (App Router).
 *
 * Some screens read data the browser cannot assemble alone — the verification queue needs signed
 * URLs minted with the service role. The server forwards the visitor's own access token, so the
 * function still authorises the *user*, not the server: no service key leaves the edge.
 */

import { getSupabaseConfig } from './supabase/config';
import { getServerClient } from './supabase/server';

export interface GatewayFailure {
  readonly code: string;
  readonly detail?: string;
}

export type GatewayResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: GatewayFailure };

export async function callGateway<T>(path: string, body: unknown): Promise<GatewayResult<T>> {
  const config = getSupabaseConfig();
  const client = await getServerClient();
  if (!config || !client)
    return { ok: false, error: { code: 'INTERNAL', detail: 'not configured' } };

  const { data: session } = await client.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return { ok: false, error: { code: 'UNAUTHENTICATED' } };

  try {
    const response = await fetch(`${config.url}/functions/v1/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: config.anonKey,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: typeof payload.code === 'string' ? payload.code : 'INTERNAL',
          detail: typeof payload.detail === 'string' ? payload.detail : undefined,
        },
      };
    }
    return { ok: true, data: payload as T };
  } catch {
    return { ok: false, error: { code: 'NETWORK' } };
  }
}
