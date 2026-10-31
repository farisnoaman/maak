/**
 * JWT verification.
 *
 * `auth.getUser(token)` asks the Auth server to validate the token — it does not merely decode it,
 * so a forged or expired token cannot pass, and revocation takes effect immediately.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { unauthorized } from './errors.ts';

export interface AuthContext {
  readonly userId: string;
  readonly email: string | null;
  readonly token: string;
}

export function serviceClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'X-Maak-Client': 'edge' } },
  });
}

export async function requireUser(request: Request): Promise<AuthContext> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) throw unauthorized('No bearer token');

  const token = match[1];
  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data.user?.id) throw unauthorized('Token rejected');

  return { userId: data.user.id, email: data.user.email ?? null, token };
}
