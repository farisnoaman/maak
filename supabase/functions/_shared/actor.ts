/**
 * Actor resolution: JWT subject → the shape `@maak/core` policy expects.
 *
 * Roles, membership, geo scope and plan are re-read on **every** request. Nothing is cached and
 * nothing is trusted from token claims, so revoking a role takes effect on the next call.
 */

import type { Actor, PlanCode, Role, VerificationStatus } from '@maak/core';
import { serviceClient } from './auth.ts';
import { internal } from './errors.ts';

export interface ResolvedActor {
  readonly actor: Actor;
  readonly orgIds: string[];
  readonly hasGeoScope: boolean;
  readonly preferredLanguage: 'ar' | 'en';
}

interface ProfileRow {
  verification_status: VerificationStatus;
  preferred_language: 'ar' | 'en';
}

export async function resolveActor(userId: string): Promise<ResolvedActor> {
  const db = serviceClient();

  const [profileResult, rolesResult, orgResult, geoResult, driverResult] = await Promise.all([
    db
      .from('profiles')
      .select('verification_status, preferred_language')
      .eq('id', userId)
      .maybeSingle(),
    db.from('user_roles').select('role').eq('user_id', userId).is('revoked_at', null),
    db
      .from('organization_members')
      .select('org_id, role')
      .eq('user_id', userId)
      .eq('status', 'active'),
    db.from('geo_assignments').select('id').eq('user_id', userId).limit(1),
    db.from('driver_profiles').select('id').eq('user_id', userId).eq('is_active', true).limit(1),
  ]);

  if (profileResult.error) throw internal(profileResult.error.message);
  if (!profileResult.data) throw internal('Profile row missing for authenticated user');

  const profile = profileResult.data as ProfileRow;
  const platformRoles = (rolesResult.data ?? []).map((row) => row.role as Role);
  const membershipRows = (orgResult.data ?? []) as { org_id: string; role: string }[];
  const orgIds = membershipRows.map((row) => row.org_id);
  const hasGeoScope = (geoResult.data ?? []).length > 0;

  // Organization roles are mapped, never flattened: an accountant must not inherit owner powers.
  const ORG_ROLE_MAP: Record<string, Role> = {
    owner: 'org_owner',
    manager: 'org_manager',
    accountant: 'org_accountant',
    dispatcher: 'org_manager',
  };

  const roles: Role[] = ['passenger', ...platformRoles];
  for (const membership of membershipRows) {
    const mapped = ORG_ROLE_MAP[membership.role];
    if (mapped && !roles.includes(mapped)) roles.push(mapped);
  }
  if ((driverResult.data ?? []).length > 0) roles.push('driver');

  const actor: Actor = {
    userId,
    roles,
    verification: profile.verification_status,
    plan: await resolvePlan(orgIds),
    orgIds,
    hasGeoScope,
  };

  return { actor, orgIds, hasGeoScope, preferredLanguage: profile.preferred_language };
}

/**
 * Phase 0 default: Basic — the *lowest* plan, never unlimited (BR-37).
 * Phase 10 replaces this body with a subscriptions lookup; the signature stays identical, so no
 * caller changes.
 */
async function resolvePlan(_orgIds: string[]): Promise<PlanCode> {
  return 'basic';
}
