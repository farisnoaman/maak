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
  | 'org.create'
  | 'org.update'
  | 'member.invite'
  | 'member.remove'
  | 'verification.submit'
  | 'verification.decide'
  | 'role.manage'
  | 'account.delete'
  | 'notification.read'
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
  | 'vehicle.update'
  | 'vehicle.setStatus'
  | 'vehicle.verify'
  | 'driver.invite'
  | 'driver.accept'
  | 'driver.setLicence'
  | 'driver.assign'
  | 'driver.verify'
  | 'entity.verify'
  | 'geo.manage'
  | 'geo.assignSupervisor'
  | 'place.create'
  | 'place.decide'
  | 'place.setActive'
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
  | 'commission.manage'
  // Phase 8 — vehicle operations.
  | 'fuel.log'
  | 'odometer.record'
  | 'maintenance.log'
  | 'maintenance.schedule'
  | 'maintenance.complete'
  | 'maintenance.view'
  | 'fleet.settings'
  // Phase 11 — the platform telling people things.
  | 'notification.preferences'
  | 'notification.savedSearch'
  | 'notification.dispatch'
  | 'notification.health'
  | 'notification.catalogue'
  // Phase 10 — money, plans and the books.
  | 'expense.record'
  | 'expense.void'
  | 'subscription.manage'
  | 'invoice.manage'
  | 'reconciliation.manage'
  | 'quota.override';

interface Rule {
  readonly roles: readonly Role[];
  /** Actor account must be verified (individual) or belong to a verified org. */
  readonly verified?: boolean;
  /** Must be scoped to the resource (ownership / membership / geo). */
  readonly scoped?: 'owner' | 'orgMember' | 'geo' | 'driver' | 'booker';
}

const STAFF: readonly Role[] = ['platform_staff', 'platform_admin'];
const AUTHENTICATED: readonly Role[] = [
  'passenger',
  'individual',
  'org_owner',
  'org_manager',
  'org_accountant',
  'driver',
  'agent',
  'geo_supervisor',
  'platform_staff',
  'finance_officer',
  'platform_admin',
];
const FINANCE: readonly Role[] = ['finance_officer', 'platform_admin'];
/**
 * The people who may look at delivery health: the same set `app.is_finance()` grants in SQL. Not `FINANCE`,
 * because reading why a push failed is support work and needs no authority over money — and the rule has to
 * match the function it guards, or one of the two is lying.
 */
const DELIVERY_SUPPORT: readonly Role[] = ['finance_officer', 'platform_staff', 'platform_admin'];
const OPERATOR: readonly Role[] = ['individual', 'org_owner', 'org_manager'];

const RULES: Record<Capability, Rule> = {
  // Phase 1 — identity and accounts.
  'org.create': { roles: AUTHENTICATED },
  'org.update': { roles: ['org_owner', 'org_manager', ...STAFF], scoped: 'orgMember' },
  'member.invite': { roles: ['org_owner', 'org_manager', ...STAFF], scoped: 'orgMember' },
  'member.remove': { roles: ['org_owner', ...STAFF], scoped: 'orgMember' },
  'verification.submit': { roles: AUTHENTICATED },
  'verification.decide': { roles: [...STAFF] },
  'role.manage': { roles: ['platform_admin'] },
  // The one command in the system that cannot be undone. Same role as granting roles, for the same reason:
  // whoever can hand out authority should be the one spending it. `cmd_delete_account` additionally refuses
  // the actor's own account, and the two checks cannot drift because both are asserted in 0018.
  'account.delete': { roles: ['platform_admin'] },
  'notification.read': { roles: AUTHENTICATED },
  // Phase 11. Everyone may choose their own channels and quiet hours; these are their own rows, and the
  // command takes the user from the session rather than from the payload.
  'notification.preferences': { roles: AUTHENTICATED },
  'notification.savedSearch': { roles: AUTHENTICATED },
  // The worker and the support view. `dispatch` is the cron's capability: it reads other people's
  // notifications because it is the thing that delivers them, which is why it is staff-only.
  'notification.dispatch': { roles: STAFF },
  'notification.health': { roles: DELIVERY_SUPPORT },
  // Reading the event catalogue is staff work: it is the surface that shows an operator's own routing.
  'notification.catalogue': { roles: STAFF },

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
  // Editing and retirement are ownership-scoped rather than verification-scoped: an owner whose
  // verification lapses must still be able to retire a vehicle and correct its mileage.
  'vehicle.update': { roles: [...OPERATOR, ...STAFF], scoped: 'owner' },
  'vehicle.setStatus': { roles: [...OPERATOR, ...STAFF], scoped: 'owner' },
  'vehicle.verify': { roles: [...STAFF] },
  // A personal driver is legitimate (an individual owner with one vehicle), so `individual` is in.
  'driver.invite': { roles: OPERATOR, verified: true, scoped: 'orgMember' },
  'driver.accept': { roles: AUTHENTICATED },
  // Every account may be a driver, and the SQL command decides whose licence it may touch.
  'driver.setLicence': { roles: AUTHENTICATED },
  'driver.assign': { roles: [...OPERATOR, ...STAFF], scoped: 'owner' },
  'driver.verify': { roles: [...STAFF] },
  'entity.verify': { roles: [...STAFF] },

  'geo.manage': { roles: ['platform_admin'] },
  'geo.assignSupervisor': { roles: ['platform_admin'] },
  // Anyone verified may drop a pin (their own gathering point); staff create reference places.
  // The `verified` rule is enforced in SQL because staff are trusted without being verified.
  'place.create': { roles: [...OPERATOR, ...STAFF] },
  'place.decide': { roles: [...STAFF] },
  // Retiring a place: staff may retire anything; a user may retire only the pin they created
  // (the ownership rule is enforced in `cmd_set_place_active`, which knows the row).
  'place.setActive': { roles: [...OPERATOR, ...STAFF] },

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
  // Confirming money received is the operator's job on their own trip and finance's job on anyone's, and
  // a scoped rule cannot express "somebody else's trip, but only for finance". The command is the
  // authority: `cmd_confirm_payment` re-derives the trip from the booking and allows exactly
  // `actor_can_manage_trip(...) or is_finance(...)`.
  'payment.confirm': { roles: [...OPERATOR, 'agent', ...FINANCE], verified: true },
  'payment.account.manageOwn': { roles: [...OPERATOR, 'agent'], verified: true },
  'payment.account.managePlatform': { roles: [...FINANCE] },
  // Seeing your own money is not scoped to an organization: an individual operator has no org and still
  // has payments. RLS decides which rows come back.
  'finance.viewOwn': { roles: [...OPERATOR, 'org_accountant', 'agent'] },
  'finance.viewAll': { roles: [...FINANCE] },
  'finance.adjust': { roles: [...FINANCE] },
  'payout.request': { roles: [...OPERATOR], verified: true },
  'payout.approve': { roles: [...FINANCE] },
  'refund.approve': { roles: [...FINANCE] },

  'plan.subscribe': { roles: [...OPERATOR], verified: true, scoped: 'orgMember' },
  'plan.manage': { roles: ['platform_admin'] },
  'commission.manage': { roles: ['platform_admin'] },

  // Phase 10 — the books. Recording a cost is the person who paid it; voiding one is the owner or finance.
  // The subscription verbs name a row rather than an owner, so the command re-derives whose it is from the
  // session — a scoped rule cannot see inside a payload it has not read.
  'expense.record': { roles: ['driver', ...OPERATOR, 'org_accountant', ...FINANCE] },
  'expense.void': { roles: [...OPERATOR, ...FINANCE], scoped: 'owner' },
  'subscription.manage': { roles: [...OPERATOR, 'org_accountant', ...FINANCE] },
  'invoice.manage': { roles: [...FINANCE] },
  'reconciliation.manage': { roles: [...FINANCE] },
  // An override is an exception to a commercial rule, so it belongs to the person who owns the rule.
  'quota.override': { roles: ['platform_admin'] },

  // Phase 8 — vehicle operations. Logging fuel and work is the driver's job as much as the owner's
  // (the person at the pump is usually the driver), so `driver` is in all three; the `cmd_*` re-derives
  // which vehicle the actor may touch, which is the part policy cannot know here.
  'fuel.log': { roles: ['driver', ...OPERATOR, ...STAFF] },
  'odometer.record': { roles: ['driver', ...OPERATOR, ...STAFF] },
  'maintenance.log': { roles: ['driver', ...OPERATOR, ...STAFF] },
  // Setting the interval and closing it are the owner's decisions: a driver reporting that the oil
  // was changed must not move the rule that decides when it is due again.
  'maintenance.schedule': { roles: [...OPERATOR, ...STAFF], scoped: 'owner' },
  'maintenance.complete': { roles: [...OPERATOR, ...STAFF], scoped: 'owner' },
  'maintenance.view': { roles: ['driver', ...OPERATOR, ...STAFF] },
  'fleet.settings': { roles: [...OPERATOR, ...STAFF], scoped: 'owner' },
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

export type PolicyDenial = 'UNAUTHENTICATED' | 'NOT_VERIFIED' | 'FORBIDDEN';

/**
 * *Why* a capability was refused, not just that it was.
 *
 * `FORBIDDEN` for an account that merely has not finished verification is the wrong answer twice over:
 * the user is told they lack permission for a thing they are entitled to, and the UI cannot offer the
 * one action that would fix it. Commands raise `NOT_VERIFIED` for exactly this case, so the gateway now
 * answers the same way.
 */
export function policyDenial(
  actor: Actor,
  capability: Capability,
  resource: Resource = {},
): PolicyDenial | null {
  if (can(actor, capability, resource)) return null;
  if (actor.roles.includes('platform_admin')) return null;

  const rule = RULES[capability];
  if (!rule) return 'FORBIDDEN';
  if (!actor.userId) return 'UNAUTHENTICATED';
  if (!actor.roles.some((r) => rule.roles.includes(r))) return 'FORBIDDEN';
  if (rule.verified && actor.verification !== 'verified') return 'NOT_VERIFIED';
  return 'FORBIDDEN';
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

/**
 * Every capability the actor holds **in the given resource context**.
 *
 * The resource argument is not optional decoration: most capabilities are scoped ("own trip", "own
 * organization"), and `can()` answers false for a scoped rule when no scope is supplied. Passing `{}`
 * returns only the unscoped capabilities, which is exactly right for a screen that has not yet chosen
 * what it is acting on.
 */
export function capabilitiesOf(actor: Actor, resource: Resource = {}): Capability[] {
  return (Object.keys(RULES) as Capability[]).filter((c) => can(actor, c, resource));
}

// ---------------------------------------------------------------------------
// Organization-scoped capabilities
// ---------------------------------------------------------------------------

/**
 * An actor's roles are *not* a flat set: being an owner of company A says nothing about company B,
 * and an accountant must never inherit the owner's powers. `capabilitiesOf` therefore describes the
 * personal context only; use `capabilitiesIn()` for anything that touches an organization.
 */
const ORG_ROLE_TO_ROLE: Record<string, Role> = {
  owner: 'org_owner',
  manager: 'org_manager',
  accountant: 'org_accountant',
  dispatcher: 'org_manager',
};

export interface OrgMembership {
  readonly orgId: string;
  readonly role: string;
}

export interface CapabilityContext {
  /** null for the personal context (no organization selected). */
  readonly organizationId: string | null;
  readonly memberRole: string | null;
  readonly capabilities: readonly Capability[];
}

/** The actor as they are when acting for one organization — other organizations' roles removed. */
export function actorInOrganization(
  actor: Actor,
  organizationId: string | null,
  memberRole: string | null,
): Actor {
  const base = actor.roles.filter((role) => !role.startsWith('org_'));
  const mapped = memberRole ? ORG_ROLE_TO_ROLE[memberRole] : undefined;
  return {
    ...actor,
    roles: mapped && !base.includes(mapped) ? [...base, mapped] : base,
    orgIds: organizationId ? [organizationId] : [],
  };
}

export function capabilitiesIn(
  actor: Actor,
  organizationId: string | null,
  memberRole: string | null,
): Capability[] {
  const scoped = actorInOrganization(actor, organizationId, memberRole);
  return capabilitiesOf(scoped, resourceFor(memberRole));
}

/** The scope facts implied by a membership (or by the absence of one). */
export function resourceFor(memberRole: string | null): Resource {
  if (!memberRole) return { isBooker: true };
  return { isOrgMember: true, isOwner: memberRole === 'owner' };
}

/** Every context a client may switch to, each with its own capability list. */
export function capabilityContexts(
  actor: Actor,
  memberships: readonly OrgMembership[],
): CapabilityContext[] {
  return [
    {
      organizationId: null,
      memberRole: null,
      capabilities: capabilitiesIn(actor, null, null),
    },
    ...memberships.map((membership) => ({
      organizationId: membership.orgId,
      memberRole: membership.role,
      capabilities: capabilitiesIn(actor, membership.orgId, membership.role),
    })),
  ];
}
