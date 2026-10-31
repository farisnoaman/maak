import { describe, expect, it } from 'vitest';
import {
  driveTypeSchema,
  fleetActionSchema,
  fleetCommandArgs,
  fleetCommandSpec,
  fleetScope,
  fuelTypeSchema,
  transmissionSchema,
  vehicleBodyTypeSchema,
  vehicleFieldErrors,
  vehicleInputSchema,
  vehicleStatusSchema,
  type VehicleInput,
} from '../src/api/fleet';
import { parseQuotaDetail, quotaMetricKey, quotaOf } from '../src/api/quota';
import {
  DRIVE_TYPE_KEY,
  DRIVER_STATUS_KEY,
  FUEL_TYPE_KEY,
  isVehicleOperational,
  TRANSMISSION_KEY,
  VEHICLE_BODY_TYPE_KEY,
  VEHICLE_STATUS_KEY,
  VERIFICATION_KEY,
  vehicleBadges,
  VEHICLE_WIZARD_STEPS,
} from '../src/domain/vehicle';
import { translate } from '../src/i18n/dictionaries';
import { policyDenial, type Actor } from '../src/domain/policy';

const audit = { p_request_id: 'req-1', p_ip: null };

const vehicle = {
  make: 'Toyota',
  model: 'Hiace',
  modelYear: 2019,
  plateNumber: '12345-أ',
  seatsPassenger: 12,
  seatsTotal: 14,
  insuranceExpiry: '2027-01-01',
  inspectionExpiry: '2026-12-01',
};

const owner: Actor = {
  userId: 'u-owner',
  roles: ['individual'],
  verification: 'verified',
  plan: 'basic',
};
const unverified: Actor = { ...owner, verification: 'unverified' };

describe('vehicle input', () => {
  it('applies the defaults the command also applies', () => {
    const parsed = vehicleInputSchema.parse(vehicle);
    expect(parsed.bodyType).toBe('van');
    expect(parsed.fuelType).toBe('petrol');
    expect(parsed.spareTyre).toBe(true);
    expect(parsed.odometerKm).toBe(0);
  });

  it('rejects a plate the database would reject', () => {
    expect(vehicleInputSchema.safeParse({ ...vehicle, plateNumber: 'ab' }).success).toBe(false);
  });

  it('rejects a VIN that is not 17 characters', () => {
    expect(vehicleInputSchema.safeParse({ ...vehicle, vin: 'SHORTVIN' }).success).toBe(false);
    expect(vehicleInputSchema.safeParse({ ...vehicle, vin: '' }).success).toBe(true);
  });

  it('rejects a model year in the future', () => {
    const nextYear = new Date().getFullYear() + 2;
    expect(vehicleInputSchema.safeParse({ ...vehicle, modelYear: nextYear }).success).toBe(false);
  });

  it('mirrors the cross-field rules of app.assert_vehicle_payload()', () => {
    const parsed = vehicleInputSchema.parse({ ...vehicle, seatsPassenger: 20, seatsTotal: 10 });
    expect(vehicleFieldErrors(parsed, new Date('2026-06-01'))).toHaveProperty('seatsPassenger');

    const expired = vehicleInputSchema.parse({ ...vehicle, insuranceExpiry: '2026-01-01' });
    expect(vehicleFieldErrors(expired, new Date('2026-06-01'))).toHaveProperty('insuranceExpiry');

    const good = vehicleInputSchema.parse(vehicle);
    expect(vehicleFieldErrors(good, new Date('2026-06-01'))).toEqual({});
  });

  it('treats an empty document date as absent, not as an epoch date', () => {
    const parsed = vehicleInputSchema.parse({ ...vehicle, registrationExpiry: '' });
    expect(parsed.registrationExpiry).toBeNull();
  });
});

describe('fleet actions', () => {
  it('discriminates on action and refuses an unknown one', () => {
    expect(fleetActionSchema.safeParse({ action: 'vehicle.create', vehicle }).success).toBe(true);
    expect(fleetActionSchema.safeParse({ action: 'vehicle.deleteEverything' }).success).toBe(false);
  });

  it('requires at least one document to submit for review', () => {
    const base = {
      action: 'vehicle.submitVerification',
      vehicleId: '11111111-1111-4111-8111-111111111111',
    };
    expect(fleetActionSchema.safeParse({ ...base, documents: [] }).success).toBe(false);
    expect(
      fleetActionSchema.safeParse({ ...base, documents: [{ kind: 'insurance', path: 'a/b.pdf' }] })
        .success,
    ).toBe(true);
  });

  it('serialises jsonb arguments itself — a JS array is not JSON to Postgres', () => {
    const action = fleetActionSchema.parse({
      action: 'vehicle.setPhotos',
      vehicleId: '11111111-1111-4111-8111-111111111111',
      photos: [{ path: '11111111-1111-4111-8111-111111111111/front.jpg', isPrimary: true }],
    });
    const { fn, args } = fleetCommandArgs(action, 'u-owner', audit);
    expect(fn).toBe('cmd_set_vehicle_photos');
    expect(typeof args.p_photos).toBe('string');
    expect(JSON.parse(String(args.p_photos))).toHaveLength(1);
  });

  it('maps every action onto exactly one command', () => {
    const actions = [
      { action: 'vehicle.create', vehicle },
      { action: 'vehicle.update', vehicleId: '11111111-1111-4111-8111-111111111111', vehicle },
      {
        action: 'vehicle.submitVerification',
        vehicleId: '11111111-1111-4111-8111-111111111111',
        documents: [{ kind: 'insurance', path: 'a/b.pdf' }],
      },
      {
        action: 'vehicle.decide',
        vehicleId: '11111111-1111-4111-8111-111111111111',
        outcome: 'approve',
      },
      {
        action: 'vehicle.setStatus',
        vehicleId: '11111111-1111-4111-8111-111111111111',
        status: 'retired',
      },
      {
        action: 'vehicle.setPhotos',
        vehicleId: '11111111-1111-4111-8111-111111111111',
        photos: [],
      },
      { action: 'driver.invite', phone: '+967733111222', fullName: 'سالم' },
      { action: 'driver.accept' },
      {
        action: 'driver.setLicence',
        driverId: '11111111-1111-4111-8111-111111111111',
        licenceNo: 'YE-DL-4411',
        licenceExpiry: '2030-01-01',
        photoPath: '22222222-2222-4222-8222-222222222222/licence.jpg',
      },
      {
        action: 'driver.verify',
        driverId: '11111111-1111-4111-8111-111111111111',
        outcome: 'approve',
      },
      {
        action: 'driver.assign',
        vehicleId: '11111111-1111-4111-8111-111111111111',
        driverId: '22222222-2222-4222-8222-222222222222',
      },
      { action: 'driver.unassign', vehicleId: '11111111-1111-4111-8111-111111111111' },
    ];

    const functions = actions.map((candidate) => {
      const parsed = fleetActionSchema.parse(candidate);
      const { fn, args } = fleetCommandArgs(parsed, 'u-owner', audit);
      expect(fn.startsWith('cmd_')).toBe(true);
      expect(args.p_actor).toBe('u-owner');
      expect(args.p_request_id).toBe('req-1');
      return fn;
    });

    // Eleven actions, eleven distinct commands: no action can silently reuse another's function.
    expect(new Set(functions).size).toBe(actions.length);
    expect(fleetCommandSpec.path).toBe('fleet');
  });

  it('scopes an organization action to the membership, and a personal one to ownership', () => {
    const orgAction = fleetActionSchema.parse({
      action: 'vehicle.create',
      orgId: '33333333-3333-4333-8333-333333333333',
      vehicle,
    });
    expect(fleetScope(orgAction)).toEqual({ isOrgMember: true });
    expect(fleetScope(fleetActionSchema.parse({ action: 'vehicle.create', vehicle }))).toEqual({
      isOwner: true,
    });
  });
});

describe('policy denials explain themselves', () => {
  it('says NOT_VERIFIED rather than FORBIDDEN for an unverified account', () => {
    expect(policyDenial(unverified, 'vehicle.create')).toBe('NOT_VERIFIED');
    expect(policyDenial(owner, 'vehicle.create', { isOwner: true })).toBeNull();
  });

  it('says UNAUTHENTICATED when there is no user at all', () => {
    const anonymous: Actor = { userId: null, roles: [], verification: 'unverified', plan: 'basic' };
    expect(policyDenial(anonymous, 'vehicle.create')).toBe('UNAUTHENTICATED');
  });

  it('keeps a passenger out of the fleet entirely', () => {
    const passenger: Actor = {
      userId: 'u-passenger',
      roles: ['passenger'],
      verification: 'verified',
      plan: 'basic',
    };
    expect(policyDenial(passenger, 'vehicle.create', { isOwner: true })).toBe('FORBIDDEN');
  });
});

describe('quota', () => {
  it('parses the message the command raises', () => {
    expect(parseQuotaDetail('metric=vehicles limit=1 used=1')).toEqual({
      metric: 'vehicles',
      limit: 1,
      used: 1,
    });
  });

  it('keeps NULL distinct from 0 (unlimited is not "none allowed")', () => {
    expect(parseQuotaDetail('metric=featured_listings limit=0 used=0')?.limit).toBe(0);
    expect(parseQuotaDetail('metric=vehicles limit=null used=9')?.limit).toBeNull();
  });

  it('prefers the structured context when the gateway sends it', () => {
    expect(
      quotaOf({
        code: 'QUOTA_EXCEEDED',
        context: { metric: 'drivers', limit: 1, used: 2 },
      }),
    ).toEqual({ metric: 'drivers', limit: 1, used: 2 });
  });

  it('is null for anything that is not a quota failure', () => {
    expect(quotaOf({ code: 'FORBIDDEN' })).toBeNull();
    expect(parseQuotaDetail('some other error')).toBeNull();
  });

  it('has a label for every metric plan_limits accepts', () => {
    for (const metric of [
      'vehicles',
      'drivers',
      'trips',
      'staff',
      'active_trips',
      'featured_listings',
    ]) {
      expect(quotaMetricKey(metric)).not.toBe('fleet.metricOther');
    }
    expect(quotaMetricKey('unknown_metric')).toBe('fleet.metricOther');
  });
});

describe('vehicle badges', () => {
  const today = new Date('2026-06-01T00:00:00Z');

  it('shows the verification state first', () => {
    expect(vehicleBadges({ verification_status: 'pending' }, today)[0]?.code).toBe('pending');
    expect(vehicleBadges({ verification_status: 'verified' }, today)[0]?.code).toBe('verified');
  });

  it('warns amber inside the 30-day window and red once expired', () => {
    const soon = vehicleBadges(
      { verification_status: 'verified', insuranceExpiry: '2026-06-20' },
      today,
    );
    expect(soon.map((badge) => badge.code)).toContain('insuranceExpiring');
    expect(soon.find((badge) => badge.code === 'insuranceExpiring')?.tone).toBe('warn');
    expect(soon.find((badge) => badge.code === 'insuranceExpiring')?.days).toBe(19);

    const expired = vehicleBadges(
      { verification_status: 'verified', inspectionExpiry: '2026-05-01' },
      today,
    );
    expect(expired.map((badge) => badge.code)).toContain('inspectionExpired');
    expect(expired.find((badge) => badge.code === 'inspectionExpired')?.tone).toBe('bad');
  });

  it('keeps a maintenance slot that stays quiet until there is a service date', () => {
    // Phase 3 has no maintenance schedule, so the placeholder must never invent a badge.
    expect(vehicleBadges({ verification_status: 'verified' }, today).map((b) => b.code)).toEqual([
      'verified',
    ]);

    const due = vehicleBadges(
      { verification_status: 'verified', nextMaintenanceDue: '2026-06-21' },
      today,
    );
    expect(due.find((badge) => badge.code === 'maintenanceDue')?.tone).toBe('warn');
    expect(due.find((badge) => badge.code === 'maintenanceDue')?.days).toBe(20);

    const overdue = vehicleBadges(
      { verification_status: 'verified', nextMaintenanceDue: '2026-05-20' },
      today,
    );
    expect(overdue.find((badge) => badge.code === 'maintenanceOverdue')?.tone).toBe('bad');

    // A service date months away is not worth a badge at all.
    const later = vehicleBadges(
      { verification_status: 'verified', nextMaintenanceDue: '2026-09-01' },
      today,
    );
    expect(later.map((badge) => badge.code)).toEqual(['verified']);
  });

  it('says nothing about a document that is comfortably in date', () => {
    const badges = vehicleBadges(
      { verification_status: 'verified', insuranceExpiry: '2027-01-01' },
      today,
    );
    expect(badges.map((badge) => badge.code)).toEqual(['verified']);
  });

  it('marks a suspended or retired vehicle', () => {
    expect(
      vehicleBadges({ verification_status: 'verified', status: 'suspended' }, today)[0]?.code,
    ).toBe('suspended');
    expect(
      vehicleBadges({ verification_status: 'verified', status: 'retired' }, today)[0]?.code,
    ).toBe('retired');
  });
});

describe('isVehicleOperational (what Phase 4 gates a trip on)', () => {
  const today = new Date('2026-06-01T00:00:00Z');
  const healthy = {
    verification_status: 'verified',
    status: 'active',
    insuranceExpiry: '2027-01-01',
    inspectionExpiry: '2026-12-01',
  } as const;

  it('accepts a verified, active vehicle with documents in date', () => {
    expect(isVehicleOperational(healthy, today)).toBe(true);
  });

  it('refuses an unverified one, even if everything else is fine', () => {
    expect(isVehicleOperational({ ...healthy, verification_status: 'pending' }, today)).toBe(false);
  });

  it('refuses expired insurance or inspection', () => {
    expect(isVehicleOperational({ ...healthy, insuranceExpiry: '2026-05-01' }, today)).toBe(false);
    expect(isVehicleOperational({ ...healthy, inspectionExpiry: '2026-05-01' }, today)).toBe(false);
  });

  it('refuses a suspended or retired vehicle', () => {
    expect(isVehicleOperational({ ...healthy, status: 'suspended' }, today)).toBe(false);
    expect(isVehicleOperational({ ...healthy, status: 'retired' }, today)).toBe(false);
  });
});

describe('wizard steps', () => {
  it('is the seven steps the screens render', () => {
    expect(VEHICLE_WIZARD_STEPS).toHaveLength(7);
    expect(VEHICLE_WIZARD_STEPS[0]).toBe('identity');
    expect(VEHICLE_WIZARD_STEPS.at(-1)).toBe('review');
  });

  it('round-trips a parsed vehicle back into the schema', () => {
    const parsed: VehicleInput = vehicleInputSchema.parse(vehicle);
    expect(vehicleInputSchema.parse(parsed).plateNumber).toBe('12345-أ');
  });
});

describe('enum labels', () => {
  // The acceptance criterion is literal: no raw `four_wheel_drive` on a screen. A missing table entry
  // would fall back to `fleet.unknown` in the UI, so the table and the schema are compared here rather
  // than trusted to stay in step.
  const tables = [
    ['body type', vehicleBodyTypeSchema.options, VEHICLE_BODY_TYPE_KEY],
    ['drive type', driveTypeSchema.options, DRIVE_TYPE_KEY],
    ['transmission', transmissionSchema.options, TRANSMISSION_KEY],
    ['fuel type', fuelTypeSchema.options, FUEL_TYPE_KEY],
    ['vehicle status', vehicleStatusSchema.options, VEHICLE_STATUS_KEY],
    ['verification', ['unverified', 'pending', 'verified', 'rejected'], VERIFICATION_KEY],
    ['driver status', ['invited', 'active', 'suspended', 'revoked'], DRIVER_STATUS_KEY],
  ] as const;

  it('has a localized label for every value of every fleet enum', () => {
    for (const [name, values, table] of tables) {
      for (const value of values as readonly string[]) {
        const key = table[value];
        expect(key, `${name}: ${value} has no label`).toBeDefined();
        for (const locale of ['ar', 'en'] as const) {
          const label = translate(locale, key!);
          expect(label, `${name}: ${value} in ${locale}`).not.toBe(value);
          expect(label, `${name}: ${value} in ${locale}`).not.toContain('_');
        }
      }
    }
  });
});
