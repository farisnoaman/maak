/**
 * Vehicle rules that must be identical everywhere: what a badge says, what an enum is called in the
 * UI, and what "expiring" means. Pure, so the web app, the mobile app and the tests share one answer.
 */

import type { TranslationKey } from '../i18n/dictionaries';

export type VehicleVerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected';
export type VehicleStatus = 'draft' | 'active' | 'suspended' | 'retired';

export interface VehicleDocumentDates {
  readonly insuranceExpiry?: string | null;
  readonly inspectionExpiry?: string | null;
  readonly registrationExpiry?: string | null;
  readonly transportPermitExpiry?: string | null;
}

export interface VehicleLike extends VehicleDocumentDates {
  // Strings, not the literal unions: rows arrive from PostgREST typed as `string`, and narrowing here
  // would force every caller to cast what it already knows is valid.
  readonly verification_status?: VehicleVerificationStatus | string;
  readonly verificationStatus?: VehicleVerificationStatus | string;
  readonly status?: VehicleStatus | string;
  /** Some callers are upstream; the badge helper formats the date from the text as given. */
  readonly today?: string;
}

export type BadgeTone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface VehicleBadge {
  readonly code:
    | 'verified'
    | 'pending'
    | 'rejected'
    | 'unverified'
    | 'insuranceExpiring'
    | 'insuranceExpired'
    | 'inspectionExpiring'
    | 'inspectionExpired'
    | 'registrationExpired'
    | 'permitExpiring'
    | 'suspended'
    | 'retired';
  readonly tone: BadgeTone;
  readonly labelKey: TranslationKey;
  /** Days until expiry; negative when already expired. Only for date badges. */
  readonly days?: number;
}

/** "Expiring" means within this window — one month is what an owner can still act on. */
export const EXPIRY_WARNING_DAYS = 30;

function daysUntil(dateText: string | null | undefined, today: Date): number | null {
  if (!dateText) return null;
  const date = new Date(`${dateText.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const reference = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  return Math.round((date.getTime() - reference.getTime()) / 86_400_000);
}

/**
 * The badges shown on a vehicle card, in the order they should be read.
 *
 * Verification comes first because it decides whether the vehicle can be used at all; an expired
 * document comes before a merely expiring one, so a card never hides the serious problem behind a
 * mild one. An approved vehicle with expired insurance is *not* usable in Phase 4 — the badge says so
 * before the trip screen has to.
 */
export function vehicleBadges(vehicle: VehicleLike, today = new Date()): VehicleBadge[] {
  const badges: VehicleBadge[] = [];
  const verification = vehicle.verification_status ?? vehicle.verificationStatus;

  if (vehicle.status === 'retired') {
    badges.push({ code: 'retired', tone: 'neutral', labelKey: 'fleet.badgeRetired' });
  } else if (vehicle.status === 'suspended') {
    badges.push({ code: 'suspended', tone: 'bad', labelKey: 'fleet.badgeSuspended' });
  }

  if (verification === 'verified') {
    badges.push({ code: 'verified', tone: 'ok', labelKey: 'fleet.badgeVerified' });
  } else if (verification === 'pending') {
    badges.push({ code: 'pending', tone: 'warn', labelKey: 'fleet.badgePending' });
  } else if (verification === 'rejected') {
    badges.push({ code: 'rejected', tone: 'bad', labelKey: 'fleet.badgeRejected' });
  } else {
    badges.push({ code: 'unverified', tone: 'neutral', labelKey: 'fleet.badgeUnverified' });
  }

  const mount = (key: 'insurance' | 'inspection' | 'registration' | 'permit') => {
    const dates: Record<typeof key, string | null | undefined> = {
      insurance: vehicle.insuranceExpiry,
      inspection: vehicle.inspectionExpiry,
      registration: vehicle.registrationExpiry,
      permit: vehicle.transportPermitExpiry,
    };
    const days = daysUntil(dates[key], today);
    if (days === null) return;

    if (days < 0) {
      const code =
        key === 'insurance'
          ? ('insuranceExpired' as const)
          : key === 'inspection'
            ? ('inspectionExpired' as const)
            : ('registrationExpired' as const);
      const labelKey: Record<typeof key, TranslationKey> = {
        insurance: 'fleet.badgeInsuranceExpired',
        inspection: 'fleet.badgeInspectionExpired',
        registration: 'fleet.badgeRegistrationExpired',
        permit: 'fleet.badgePermitExpired',
      };
      badges.push({ code, tone: 'bad', labelKey: labelKey[key], days });
      return;
    }
    if (days <= EXPIRY_WARNING_DAYS) {
      const code =
        key === 'inspection' ? ('inspectionExpiring' as const) : ('insuranceExpiring' as const);
      const labelKey: Record<typeof key, TranslationKey> = {
        insurance: 'fleet.badgeInsuranceExpiring',
        inspection: 'fleet.badgeInspectionExpiring',
        registration: 'fleet.badgeRegistrationExpiring',
        permit: 'fleet.badgePermitExpiring',
      };
      badges.push({ code, tone: 'warn', labelKey: labelKey[key], days });
    }
  };

  mount('insurance');
  mount('inspection');
  mount('registration');
  mount('permit');

  return badges;
}

/** May this vehicle be put on a trip? Phase 4 calls exactly this. */
export function isVehicleOperational(vehicle: VehicleLike, today = new Date()): boolean {
  const verification = vehicle.verification_status ?? vehicle.verificationStatus;
  if (verification !== 'verified') return false;
  if (vehicle.status && vehicle.status !== 'active') return false;
  const bad = vehicleBadges(vehicle, today).some(
    (badge) =>
      badge.code === 'insuranceExpired' ||
      badge.code === 'inspectionExpired' ||
      badge.code === 'registrationExpired' ||
      badge.code === 'suspended',
  );
  return !bad;
}

/**
 * Enum → label key. A raw `four_wheel_drive` on screen is the bug this table exists to prevent, and
 * the i18n test asserts every value here has a label in both dictionaries.
 */
export const VEHICLE_BODY_TYPE_KEY: Record<string, TranslationKey> = {
  sedan: 'fleet.bodySedan',
  hatchback: 'fleet.bodyHatchback',
  suv: 'fleet.bodySuv',
  pickup: 'fleet.bodyPickup',
  van: 'fleet.bodyVan',
  minibus: 'fleet.bodyMinibus',
  bus: 'fleet.bodyBus',
  coach: 'fleet.bodyCoach',
  truck: 'fleet.bodyTruck',
  other: 'fleet.bodyOther',
};

export const DRIVE_TYPE_KEY: Record<string, TranslationKey> = {
  front_wheel_drive: 'fleet.driveFwd',
  rear_wheel_drive: 'fleet.driveRwd',
  four_wheel_drive: 'fleet.drive4wd',
  all_wheel_drive: 'fleet.driveAwd',
};

export const TRANSMISSION_KEY: Record<string, TranslationKey> = {
  manual: 'fleet.transmissionManual',
  automatic: 'fleet.transmissionAutomatic',
  cvt: 'fleet.transmissionCvt',
  dual_clutch: 'fleet.transmissionDualClutch',
};

export const FUEL_TYPE_KEY: Record<string, TranslationKey> = {
  petrol: 'fleet.fuelPetrol',
  diesel: 'fleet.fuelDiesel',
  hybrid: 'fleet.fuelHybrid',
  electric: 'fleet.fuelElectric',
  lpg: 'fleet.fuelLpg',
};

export const VEHICLE_STATUS_KEY: Record<string, TranslationKey> = {
  draft: 'fleet.statusDraft',
  active: 'fleet.statusActive',
  suspended: 'fleet.statusSuspended',
  retired: 'fleet.statusRetired',
};

export const DRIVER_STATUS_KEY: Record<string, TranslationKey> = {
  invited: 'fleet.driverInvited',
  active: 'fleet.driverActive',
  suspended: 'fleet.driverSuspended',
  revoked: 'fleet.driverRevoked',
};

export const VERIFICATION_KEY: Record<string, TranslationKey> = {
  unverified: 'fleet.badgeUnverified',
  pending: 'fleet.badgePending',
  verified: 'fleet.badgeVerified',
  rejected: 'fleet.badgeRejected',
};

/**
 * The wizard's steps. Kept here so the web form, the mobile form and the review checklist cannot
 * drift on what "step 3" contains.
 */
export const VEHICLE_WIZARD_STEPS = [
  'identity',
  'mechanical',
  'capacity',
  'comfort',
  'safety',
  'documents',
  'review',
] as const;

export type VehicleWizardStep = (typeof VEHICLE_WIZARD_STEPS)[number];
