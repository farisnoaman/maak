import { describe, expect, it } from 'vitest';
import { can, capabilitiesOf, PolicyError, requirePolicy, type Actor } from '../src/domain/policy';

const verifiedIndividual: Actor = {
  userId: 'u1',
  roles: ['individual'],
  verification: 'verified',
  plan: 'pro',
};

const unverifiedIndividual: Actor = { ...verifiedIndividual, verification: 'unverified' };
const passenger: Actor = {
  userId: 'u2',
  roles: ['passenger'],
  verification: 'verified',
  plan: 'basic',
};
const staff: Actor = {
  userId: 'u3',
  roles: ['platform_staff'],
  verification: 'verified',
  plan: 'basic',
};
const admin: Actor = {
  userId: 'u4',
  roles: ['platform_admin'],
  verification: 'verified',
  plan: 'business',
};
const finance: Actor = {
  userId: 'u5',
  roles: ['finance_officer'],
  verification: 'verified',
  plan: 'basic',
};
const supervisor: Actor = {
  userId: 'u6',
  roles: ['geo_supervisor'],
  verification: 'verified',
  plan: 'basic',
  hasGeoScope: true,
};
const driver: Actor = { userId: 'u7', roles: ['driver'], verification: 'verified', plan: 'basic' };

describe('trust gates', () => {
  it('stops unverified actors from creating trips and vehicles', () => {
    expect(can(unverifiedIndividual, 'trip.create')).toBe(false);
    expect(can(unverifiedIndividual, 'vehicle.create')).toBe(false);
    expect(can(unverifiedIndividual, 'booking.accept', { isOwner: true })).toBe(false);
  });

  it('allows verified owners', () => {
    expect(can(verifiedIndividual, 'trip.create')).toBe(true);
    expect(can(verifiedIndividual, 'vehicle.create')).toBe(true);
    expect(can(verifiedIndividual, 'booking.accept', { isOwner: true })).toBe(true);
  });

  it('requires ownership for trip edits', () => {
    expect(can(verifiedIndividual, 'trip.update', { isOwner: false })).toBe(false);
    expect(can(verifiedIndividual, 'trip.update', { isOwner: true })).toBe(true);
  });

  it('lets org members act on org resources', () => {
    const manager: Actor = { ...verifiedIndividual, roles: ['org_manager'], orgIds: ['o1'] };
    expect(can(manager, 'trip.update', { isOrgMember: true })).toBe(true);
    expect(can(manager, 'trip.update', { isOrgMember: false })).toBe(false);
  });
});

describe('passengers', () => {
  it('can book and see their own booking', () => {
    expect(can(passenger, 'booking.create')).toBe(true);
    expect(can(passenger, 'booking.viewLive', { isBooker: true })).toBe(true);
    expect(can(passenger, 'booking.viewLive', { isBooker: false })).toBe(false);
  });

  it('cannot create trips, verify, or see the manifest', () => {
    expect(can(passenger, 'trip.create')).toBe(false);
    expect(can(passenger, 'trip.verify')).toBe(false);
    expect(can(passenger, 'trip.manifest')).toBe(false);
  });
});

describe('staff and supervisors', () => {
  it('staff verify entities and trips', () => {
    expect(can(staff, 'entity.verify')).toBe(true);
    expect(can(staff, 'trip.verify', { inGeoScope: true })).toBe(true);
    expect(can(staff, 'geo.manage')).toBe(false);
  });

  it('supervisors are limited to their geo scope', () => {
    expect(can(supervisor, 'trip.verify', { inGeoScope: true })).toBe(true);
    expect(can(supervisor, 'trip.verify', { inGeoScope: false })).toBe(false);
    expect(can(supervisor, 'trip.viewPassengers', { inGeoScope: false })).toBe(false);
  });

  it('only an admin can erase an account, and it is the same role that grants roles', () => {
    expect(can(admin, 'account.delete')).toBe(true);
    expect(can(staff, 'account.delete')).toBe(false);
    expect(can(passenger, 'account.delete')).toBe(false);
    // Self-service deletion is a *request* (`account.requestDeletion` has no capability: it is an own-row
    // write). The irreversible half is deliberately not something an actor can be granted by scope.
    expect(can(admin, 'account.delete', { isOwner: true })).toBe(true);
  });

  it('only admins manage geography and plans', () => {
    expect(can(admin, 'geo.manage')).toBe(true);
    expect(can(admin, 'plan.manage')).toBe(true);
    expect(can(staff, 'plan.manage')).toBe(false);
  });

  it('admin bypasses every gate (break-glass role)', () => {
    expect(can(admin, 'finance.adjust')).toBe(true);
    expect(can(admin, 'trip.start', { isAssignedDriver: false })).toBe(true);
  });
});

describe('drivers', () => {
  it('can start only the trip they are assigned to', () => {
    expect(can(driver, 'trip.start', { isAssignedDriver: true })).toBe(true);
    expect(can(driver, 'trip.start', { isAssignedDriver: false })).toBe(false);
    expect(can(driver, 'trip.create')).toBe(false);
  });
});

describe('money roles', () => {
  it('separates finance from operations', () => {
    expect(can(finance, 'payment.confirm', { isOwner: true })).toBe(true);
    expect(can(finance, 'finance.adjust')).toBe(true);
    expect(can(finance, 'entity.verify')).toBe(false);
    expect(can(staff, 'finance.adjust')).toBe(false);
  });

  it('requires verification before adding payout accounts', () => {
    expect(can(unverifiedIndividual, 'payout.request', { isOrgMember: true })).toBe(false);
    expect(can(verifiedIndividual, 'payout.request', { isOrgMember: true })).toBe(true);
  });
});

describe('policy errors and capability listing', () => {
  it('throws a typed PolicyError', () => {
    expect(() => requirePolicy(passenger, 'trip.create')).toThrow(PolicyError);
    try {
      requirePolicy(passenger, 'trip.create');
    } catch (e) {
      expect((e as PolicyError).code).toBe('FORBIDDEN');
      expect((e as PolicyError).capability).toBe('trip.create');
    }
  });

  it('lists capabilities per actor without duplicates', () => {
    const caps = capabilitiesOf(admin);
    expect(new Set(caps).size).toBe(caps.length);
    expect(caps).toContain('geo.manage');
    expect(capabilitiesOf(passenger)).not.toContain('trip.create');
  });
});
