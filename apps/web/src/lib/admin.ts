/**
 * Admin console reads.
 *
 * A **read through RLS** with the operator's own cookie: `profiles_select_staff` is what makes the list
 * possible and also what makes it safe — there is no service role here, so a passenger who reaches the
 * page reads nothing. The write that follows a row is `account.delete`, and it is refused by the command
 * itself if the caller is not a `platform_admin`.
 */

import { getServerClient, getSession } from './supabase/server';

export interface AdminUser {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly verification: string;
  readonly roles: readonly string[];
  readonly joinedAt: string;
  readonly deletionPending: boolean;
}

export interface AdminUserList {
  readonly configured: boolean;
  readonly users: readonly AdminUser[];
  /** True when the cap hid someone — the page says so rather than pretending it is the whole platform. */
  readonly truncated: boolean;
}

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

const USER_LIMIT = 50;

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

/**
 * The accounts the role console can act on.
 *
 * The page used to list exactly one person — the operator looking at it — which made "grant a role" a
 * screen that could only grant roles to yourself. `profiles_select_staff` and `user_roles_select_staff`
 * (00004) have always allowed staff to read the directory; nothing read it. Both are still RLS reads with
 * the operator's own cookie, so a passenger who opens the URL gets the two queries back empty rather than
 * an error, and the page's own role check is a second gate rather than the only one.
 *
 * The cap is 50 and it is *stated* when it bites: an unbounded directory is a page that gets slower every
 * week and a select an operator cannot use, and a silent cap reads as "this is everyone".
 */
export async function loadAdminUsers(limit = USER_LIMIT): Promise<AdminUserList> {
  const session = await getSession();
  if (!session.configured) return { configured: false, users: [], truncated: false };
  if (!session.user) return { configured: true, users: [], truncated: false };

  const client = await getServerClient();
  if (!client) return { configured: true, users: [], truncated: false };

  // One extra row is the cheapest way to know whether the cap hid somebody.
  const profiles = await client
    .from('profiles')
    .select('id, full_name, email, phone, verification_status, created_at, deletion_requested_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit + 1);

  const rows = (profiles.data ?? []) as Record<string, unknown>[];
  const visible = rows.slice(0, limit);
  const ids = visible.map((row) => String(row.id));

  const roles =
    ids.length === 0
      ? []
      : (((
          await client
            .from('user_roles')
            .select('user_id, role')
            .in('user_id', ids)
            .is('revoked_at', null)
        ).data ?? []) as Record<string, unknown>[]);

  const byUser = new Map<string, string[]>();
  for (const row of roles) {
    const userId = String(row.user_id);
    const list = byUser.get(userId) ?? [];
    list.push(String(row.role));
    byUser.set(userId, list);
  }

  return {
    configured: true,
    truncated: rows.length > limit,
    users: visible.map((row) => ({
      id: String(row.id),
      name: str(row.full_name),
      email: str(row.email),
      phone: str(row.phone),
      verification:
        typeof row.verification_status === 'string' ? row.verification_status : 'unverified',
      roles: (byUser.get(String(row.id)) ?? []).sort(),
      joinedAt: String(row.created_at),
      deletionPending: row.deletion_requested_at != null,
    })),
  };
}
