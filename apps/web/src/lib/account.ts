/**
 * Server-side account context.
 *
 * Everything here is a **read** through RLS with the visitor's own cookie: no service role, no
 * client-trusted claims. The capability list still comes from the gateway (`me`); this module only
 * assembles what a screen needs to render, and returns `preview: true` when there is no database so
 * pages can say so instead of throwing.
 */

import { getServerClient, getSession } from './supabase/server';

export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected';
export type MemberRole = 'owner' | 'manager' | 'accountant' | 'dispatcher';

export interface AccountProfile {
  readonly id: string;
  readonly fullName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly verificationStatus: VerificationStatus;
  readonly verificationNote: string | null;
  readonly nationalIdType: string | null;
  readonly birthPlace: string | null;
  readonly avatarPath: string | null;
}

export interface AccountOrganization {
  readonly id: string;
  readonly name: string;
  readonly nameEn: string | null;
  readonly role: MemberRole;
  readonly status: 'invited' | 'active' | 'suspended' | 'removed';
  readonly verificationStatus: VerificationStatus;
  readonly plan: 'basic' | 'pro' | 'business';
  readonly registrationNo: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly taxNo: string | null;
  readonly kind: 'company' | 'agency';
}

export interface AccountNotification {
  readonly id: string;
  readonly titleKey: string;
  readonly params: Record<string, string | number>;
  readonly link: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface AccountMember {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string | null;
  readonly role: MemberRole;
  readonly status: 'invited' | 'active' | 'suspended' | 'removed';
  readonly email: string | null;
  readonly phone: string | null;
  readonly joinedAt: string | null;
}

export interface AccountContext {
  readonly configured: boolean;
  readonly user: { id: string; email: string | null } | null;
  readonly profile: AccountProfile | null;
  readonly organizations: readonly AccountOrganization[];
  readonly members: readonly AccountMember[];
  readonly notifications: readonly AccountNotification[];
  readonly roles: readonly string[];
}

const EMPTY: AccountContext = {
  configured: false,
  user: null,
  profile: null,
  organizations: [],
  members: [],
  notifications: [],
  roles: [],
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function loadAccountContext(): Promise<AccountContext> {
  const session = await getSession();
  if (!session.configured) return EMPTY;
  if (!session.user) return { ...EMPTY, configured: true };

  const client = await getServerClient();
  if (!client) return { ...EMPTY, configured: true };

  const userId = session.user.id;

  const [profileResult, membershipResult, notificationResult, roleResult] = await Promise.all([
    client
      .from('profiles')
      .select(
        'id, full_name, phone, email, verification_status, verification_note, national_id_type, birth_place, avatar_path',
      )
      .eq('id', userId)
      .maybeSingle(),
    client
      .from('organization_members')
      .select(
        'id, org_id, user_id, role, status, invited_email, invited_phone, joined_at, organizations(id, name, name_en, verification_status, plan, registration_no, phone, email, tax_no, kind)',
      )
      .order('created_at', { ascending: true }),
    client
      .from('notifications')
      .select('id, title_key, params, link, read_at, created_at')
      .order('created_at', { ascending: false })
      .limit(30),
    client.from('user_roles').select('role').is('revoked_at', null),
  ]);

  const profileRow = profileResult.data as Record<string, unknown> | null;

  const profile: AccountProfile | null = profileRow
    ? {
        id: String(profileRow.id),
        fullName: str(profileRow.full_name),
        phone: str(profileRow.phone),
        email: str(profileRow.email),
        verificationStatus: (profileRow.verification_status as VerificationStatus) ?? 'unverified',
        verificationNote: str(profileRow.verification_note),
        nationalIdType: str(profileRow.national_id_type),
        birthPlace: str(profileRow.birth_place),
        avatarPath: str(profileRow.avatar_path),
      }
    : null;

  const rows = (membershipResult.data ?? []) as Record<string, unknown>[];

  const members: AccountMember[] = rows.map((row) => ({
    id: String(row.id),
    orgId: String(row.org_id),
    userId: str(row.user_id),
    role: (row.role as MemberRole) ?? 'manager',
    status: (row.status as AccountMember['status']) ?? 'invited',
    email: str(row.invited_email),
    phone: str(row.invited_phone),
    joinedAt: str(row.joined_at),
  }));

  const organizations: AccountOrganization[] = rows
    .filter((row) => row.organizations && typeof row.organizations === 'object')
    .map((row) => {
      const org = row.organizations as Record<string, unknown>;
      return {
        id: String(org.id),
        name: String(org.name ?? ''),
        nameEn: str(org.name_en),
        role: (row.role as MemberRole) ?? 'manager',
        status: (row.status as AccountOrganization['status']) ?? 'invited',
        verificationStatus: (org.verification_status as VerificationStatus) ?? 'unverified',
        plan: (org.plan as AccountOrganization['plan']) ?? 'basic',
        registrationNo: str(org.registration_no),
        phone: str(org.phone),
        email: str(org.email),
        taxNo: str(org.tax_no),
        kind: (org.kind as AccountOrganization['kind']) ?? 'company',
      };
    });

  const notifications: AccountNotification[] = (
    (notificationResult.data ?? []) as Record<string, unknown>[]
  ).map((row) => ({
    id: String(row.id),
    titleKey: String(row.title_key ?? ''),
    params: (row.params as Record<string, string | number>) ?? {},
    link: str(row.link),
    readAt: str(row.read_at),
    createdAt: String(row.created_at ?? ''),
  }));

  return {
    configured: true,
    user: { id: userId, email: session.user.email ?? null },
    profile,
    organizations,
    members,
    notifications,
    roles: ((roleResult.data ?? []) as { role: string }[]).map((row) => row.role),
  };
}

/** The organization the visitor is acting for: explicit `?org=` wins, else the first active one. */
export function activeOrganization(
  context: AccountContext,
  requestedId?: string,
): AccountOrganization | null {
  const active = context.organizations.filter((org) => org.status === 'active');
  if (requestedId) return active.find((org) => org.id === requestedId) ?? null;
  return active[0] ?? null;
}

export function unreadCount(context: AccountContext): number {
  return context.notifications.filter((notification) => !notification.readAt).length;
}
