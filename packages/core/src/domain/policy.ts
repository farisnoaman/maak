/**
 * The capability matrix as a pure function (specs.md §5.2 / §5.3).
 *
 * The edge gateway calls `requirePolicy()` with the actor resolved from the JWT
 * and the database. Because this is pure, the whole matrix is unit-tested
 * without a database — and the SQL command re-asserts the same rule.
 *
 * NOTE: some capabilities have a *scope* (own trip, own org, geo scope).
 * `can()` answers "may this kind of actor do this at all?"; scope is checked by
 * the command with `ownsTrip` / `inGeoScope` facts passed in `Resource`.
 */

import type { PlanCode } from './finance';

export type Role =
  | 'passenger'
  | 'individual'
  | 'org_owner'
  | 'org_manager'
  | 'org_accountant'
  | 'driver'
  | 'agent'
  | 'geo_supervisor'
  | 'platform_staff'
  | 'finance_officer'
  | 'platform_admin';

export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected';

export interface Actor {
  readonly userId: string | null;
  readonly roles: readonly Role[];
  readonly verification: VerificationStatus;
  readonly plan: PlanCode;
  readonly orgIds?: readonly string[];
  /** Set by the gateway for geo supervisors: at least one active geo assignment. */
  readonly hasGeoScope?: boolean;
}

export interface Resource {
  /** true when the actor owns the trip / vehicle / booking. */
  readonly isOwner?: boolean;
  /** true when the actor is an active member of the owning organization. */
  readonly isOrgMember?: boolean;
  /** true when the resource falls inside the actor's geo assignment. */
  readonly inGeoScope?: boolean;
  /** true when the actor is the assigned driver. */
  readonly isAssignedDriver?: boolean;
  /** true when the actor made the booking. */
  readonly isBooker?: boolean;
}

export type Capability =
  | 'trip.browse'
  | 'trip.create'
  | 'trip.update'
  | 'trip.cancel'
  | 'trip.start'
  | 'trip.verify'
  | 'trip.viewPassengers'
  | 'trip.manifest'
  | 'booking.create'
  | 'booking.accept'
  | 'booking.cancelAsOperator'
  | 'booking.cancelAsPassenger'
  | 'booking.viewLive'
  | 'vehicle.create'
  | 'vehicle.verify'
  | 'driver.invite'
  | 'driver.verify'
  | 'entity.verify'
  | 'geo.manage'
  | 'geo.assignSupervisor'
  | 'payment.submit'
  | 'payment.confirm'
  | 'payment.account.manageOwn'
  | 'payment.account.managePlatform'
  | 'finance.viewOwn'
  | 'finance.viewAll'
  | 'finance.adjust'
  | 'payout.request'
  | 'payout.approve'
  | 'refund.approve'
  | 'plan.subscribe'
  | 'plan.manage'
  | 'commission.manage';

interface Rule {
  readonly roles: readonly Role[];
  /** Actor account must be verified (individual) or belong to a verified org. */
  readonly verified?: boolean;
  /** Must be scoped to the resource (ownership / membership / geo). */
  readonly scoped?: 'owner' | 'orgMember' | 'geo' | 'driver' | 'booker';
}

const STAFF: readonly Role[] = ['platform_staff', 'platform_admin'];
const FINANCE: readonly Role[] = ['finance_officer', 'platform_admin'];
const OPERATOR: readonly Role[] = ['individual', 'org_owner', 'org_manager'];

const RULES: Record<Capability, Rule> = {
  'trip.browse': {
    roles: [
      'passenger',
      'individual',
      'org_owner',
      'org_manager',
      'driver',
      'agent',
      'geo_supervisor',
      'platform_staff',
      'finance_officer',
      'platform_admin',
    ],
  },
  'trip.create': { roles: OPERATOR, verified: true },
  'trip.update': { roles: [...OPERATOR, ...STAFF], scoped: 'owner' },
  'trip.cancel': { roles: [...OPERATOR, ...STAFF], scoped: 'owner' },
  'trip.start': { roles: ['driver', ...STAFF], scoped: 'driver' },
  'trip.verify': { roles: ['geo_supervisor', ...STAFF], scoped: 'geo' },
  'trip.viewPassengers': { roles: ['geo_supervisor', ...STAFF], scoped: 'geo' },
  'trip.manifest': { roles: [...OPERATOR, ...STAFF, 'geo_supervisor'], scoped: 'owner' },

  'booking.create': {
    roles: [
      'passenger',
      ...OPERATOR,
      'driver',
      'agent',
      'geo_supervisor',
      'platform_staff',
      'finance_officer',
      'platform_admin',
    ],
  },
  'booking.accept': { roles: [...OPERATOR, ...STAFF], verified: true, scoped: 'owner' },
  'booking.cancelAsOperator': { roles: [...OPERATOR, ...STAFF], verified: true, scoped: 'owner' },
  'booking.cancelAsPassenger': { roles: ['passenger', ...OPERATOR], scoped: 'booker' },
  'booking.viewLive': {
    roles: ['passenger', ...OPERATOR, ...STAFF, 'geo_supervisor'],
    scoped: 'booker',
  },

  'vehicle.create': { roles: OPERATOR, verified: true },
  'vehicle.verify': { roles: [...STAFF] },
  'driver.invite': { roles: ['org_owner', 'org_manager'], verified: true, scoped: 'orgMember' },
  'driver.verify': { roles: [...STAFF] },
  'entity.verify': { roles: [...STAFF] },

  'geo.manage': { roles: ['platform_admin'] },
  'geo.assignSupervisor': { roles: ['platform_admin'] },

  'payment.submit': {
    roles: [
      'passenger',
      ...OPERATOR,
      'agent',
      'platform_staff',
      'finance_officer',
      'platform_admin',
    ],
  },
  'payment.confirm': { roles: [...OPERATOR, 'agent', ...FINANCE], verified: true, scoped: 'owner' },
  'payment.account.manageOwn': { roles: [...OPERATOR, 'agent'], verified: true },
  'payment.account.managePlatform': { roles: [...FINANCE] },
  'finance.viewOwn': { roles: [...OPERATOR, 'org_accountant', 'agent'], scoped: 'orgMember' },
  'finance.viewAll': { roles: [...FINANCE] },
  'finance.adjust': { roles: [...FINANCE] },
  'payout.request': { roles: [...OPERATOR], verified: true, scoped: 'orgMember' },
  'payout.approve': { roles: [...FINANCE] },
  'refund.approve': { roles: [...FINANCE] },

  'plan.subscribe': { roles: [...OPERATOR], verified: true, scoped: 'orgMember' },
  'plan.manage': { roles: ['platform_admin'] },
  'commission.manage': { roles: ['platform_admin'] },
};

export function can(actor: Actor, capability: Capability, resource: Resource = {}): boolean {
  if (actor.roles.includes('platform_admin')) return true;

  const rule = RULES[capability];
  if (!rule) return false;
  if (!actor.roles.some((r) => rule.roles.includes(r))) return false;
  if (rule.verified && actor.verification !== 'verified') return false;

  switch (rule.scoped) {
    case 'owner':
      return resource.isOwner === true || resource.isOrgMember === true;
    case 'orgMember':
      return resource.isOrgMember === true || resource.isOwner === true;
    case 'geo':
      return resource.inGeoScope === true || actor.roles.some((r) => STAFF.includes(r));
    case 'driver':
      return resource.isAssignedDriver === true || actor.roles.some((r) => STAFF.includes(r));
    case 'booker':
      return (
        resource.isBooker === true ||
        resource.isOrgMember === true ||
        actor.roles.some((r) => STAFF.includes(r))
      );
    default:
      return true;
  }
}

export class PolicyError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(
    readonly capability: Capability,
    message = 'You do not have permission to perform this action',
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

export function requirePolicy(actor: Actor, capability: Capability, resource: Resource = {}): void {
  if (!can(actor, capability, resource)) throw new PolicyError(capability);
}

export function isOperator(actor: Actor): boolean {
  return actor.roles.some((r) => OPERATOR.includes(r));
}

export function isPlatformStaff(actor: Actor): boolean {
  return actor.roles.some((r) => STAFF.includes(r));
}

export function capabilitiesOf(actor: Actor): Capability[] {
  return (Object.keys(RULES) as Capability[]).filter((c) => can(actor, c));
}
