/**
 * Actor resolution: JWT subject → the shape `packages/core/policy.ts` expects.
 *
 * Roles are re-read on **every** request from the database. Nothing is cached and nothing is
 * trusted from the token's claims, so revoking a role takes effect on the very next call.
 */

import type { Actor, PlanCode, Role, VerificationStatus } from '@maak/core';
import { serviceClient } from './auth.ts';
import { internal } from './errors.ts';

export interface ResolvedActor {
  readonly actor: Actor;
  readonly orgIds: string[];
  readonly hasGeoScope: boolean;
}

interface ProfileRow {
  verification_status: VerificationStatus;
  preferred_language: 'ar' | 'en';
}

export async function resolveActor(userId: string): Promise<ResolvedActor> {
  const db = serviceClient();

  const [profileResult, rolesResult, orgResult, geoResult] = await Promise.all([
    db.from('profiles').select('verification_status, preferred_language').eq('id', userId).maybeSingle(),
    db.from('user_roles').select('role').eq('user_id', userId).is('revoked_at', null),
    db.from('organization_members').select('org_id').eq('user_id', userId).eq('status', 'active'),
    db.from('geo_assignments').select('id').eq('user_id', userId).limit(1),
  ]);

  if (profileResult.error) throw internal(profileResult.error.message);
  if (!profileResult.data) throw internal('Profile row missing for authenticated user');

  const profile = profileResult.data as ProfileRow;
  const platformRoles = (rolesResult.data ?? []).map((row) => row.role as Role);
  const orgIds = (orgResult.data ?? []).map((row) => row.org_id as string);
  const hasGeoScope = (geoResult.data ?? []).length > 0;

  // Org membership maps onto operator roles; the org's own plan is resolved per-resource later.
  const roles: Role[] = ['passenger', ...platformRoles];
  if (orgIds.length > 0) roles.push('org_owner');

  const actor: Actor = {
    userId,
    roles,
    verification: profile.verification_status,
    plan: await resolvePlan(orgIds),
    orgIds,
    hasGeoScope,
  };

  return { actor, orgIds, hasGeoScope };
}

/**
 * Phase 0 default: Basic. Phase 10 replaces this body with a subscriptions lookup.
 * It deliberately defaults to the *lowest* plan, never to unlimited (BR-37).
 */
async function resolvePlan(_orgIds: string[]): Promise<PlanCode> {
  return 'basic';
}

/** Detects the driver role from an actual driver profile row, not from a claim. */
export async function resolveDriverActor(userId: string): Promise<ResolvedActor> {
  const resolved = await resolveActor(userId);
  const { data } = await serviceClient()
    .from('driver_profiles')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();

  if (data) {
    return { ...resolved, actor: { ...resolved.actor, roles: [...resolved.actor.roles, 'driver'] } };
  }
  return resolved;
}
