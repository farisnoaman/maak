/**
 * Admin console reads.
 *
 * A **read through RLS** with the operator's own cookie: `profiles_select_staff` is what makes the list
 * possible and also what makes it safe — there is no service role here, so a passenger who reaches the
 * page reads nothing. The write that follows a row is `account.delete`, and it is refused by the command
 * itself if the caller is not a `platform_admin`.
 */

import { getServerClient, getSession } from './supabase/server';

export interface DeletionRequest {
  readonly id: string;
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly reason: string | null;
  readonly requestedAt: string;
}

export interface DeletionRequestList {
  readonly configured: boolean;
  readonly requests: readonly DeletionRequest[];
}

const EMPTY: DeletionRequestList = { configured: false, requests: [] };

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * People who asked to be deleted and have not been yet.
 *
 * Until this existed, the only way to find a request was to know that `profiles.deletion_requested_at`
 * exists and run SQL — which made "a platform admin completes the deletion" a procedure without a
 * starting point. `cmd_delete_account` was reachable; the person to point it at was not.
 */
export async function loadDeletionRequests(): Promise<DeletionRequestList> {
  const session = await getSession();
  if (!session.configured) return EMPTY;
  if (!session.user) return { ...EMPTY, configured: true };

  const client = await getServerClient();
  if (!client) return { ...EMPTY, configured: true };

  const result = await client
    .from('profiles')
    .select('id, full_name, phone, email, deletion_reason, deletion_requested_at')
    .not('deletion_requested_at', 'is', null)
    .is('deleted_at', null)
    .order('deletion_requested_at', { ascending: true })
    .limit(50);

  const rows = (result.data ?? []) as Record<string, unknown>[];

  return {
    configured: true,
    requests: rows.map((row) => ({
      id: String(row.id),
      name: str(row.full_name),
      phone: str(row.phone),
      email: str(row.email),
      reason: str(row.deletion_reason),
      requestedAt: String(row.deletion_requested_at),
    })),
  };
}
