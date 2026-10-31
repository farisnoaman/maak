/**
 * Fleet commands — the shared contract between UI, edge function and tests (Phase 3).
 *
 * One edge function (`fleet`) dispatches on `action`; every branch maps to exactly one `cmd_*` in
 * migration 00013, so a request is still one call and one transaction.
 *
 * `jsonb` arguments are serialized **here**, not by the transport. Node's `pg` turns a JavaScript
 * array into a Postgres array literal (`{...}`), which is not JSON, so passing `p_documents` as an
 * array produced `22P02 invalid input syntax for type json` in the first integration run. Serializing
 * in one place means the dev gateway and the Deno edge function cannot disagree about it.
 */

import { z } from 'zod';

import type { Resource } from '../domain/policy';

const uuid = z.string().uuid();
/**
 * A date field. `''` is what an empty `<input type="date">` submits, and it must mean "no date", not
 * "a date that fails the format" — otherwise clearing an optional expiry makes the form red.
 */
const isoDate = z
  .union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')])
  .nullish()
  .transform((value) => (value === '' || value == null ? null : value));

export const vehicleBodyTypeSchema = z.enum([
  'sedan',
  'hatchback',
  'suv',
  'pickup',
  'van',
  'minibus',
  'bus',
  'coach',
  'truck',
  'other',
]);
export const driveTypeSchema = z.enum([
  'front_wheel_drive',
  'rear_wheel_drive',
  'four_wheel_drive',
  'all_wheel_drive',
]);
export const transmissionSchema = z.enum(['manual', 'automatic', 'cvt', 'dual_clutch']);
export const fuelTypeSchema = z.enum(['petrol', 'diesel', 'hybrid', 'electric', 'lpg']);
export const vehicleConditionSchema = z.enum(['new', 'used', 'refurbished']);
export const conditionRatingSchema = z.enum(['excellent', 'good', 'fair', 'poor']);
export const ownershipKindSchema = z.enum(['owned', 'leased', 'financed']);
export const vehicleStatusSchema = z.enum(['draft', 'active', 'suspended', 'retired']);

/**
 * The ~60 vehicle attributes as the client sends them.
 *
 * Deliberately one schema for create and update: the wizard submits the whole specification, so a
 * partial-update schema would be a second definition to keep in sync — exactly the drift the Phase 2
 * review found between two error mappers.
 */
export const vehicleInputSchema = z.object({
  // Identity
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(60),
  modelYear: z
    .number()
    .int()
    .min(1980)
    .max(new Date().getFullYear() + 1),
  trim: z.string().trim().max(60).nullish(),
  plateNumber: z.string().trim().min(3).max(12),
  plateGovernorateId: uuid.nullish(),
  vin: z
    .string()
    .trim()
    .length(17)
    .nullish()
    .or(z.literal('').transform(() => null)),
  chassisNo: z.string().trim().max(60).nullish(),
  color: z.string().trim().max(40).nullish(),

  // Mechanical
  bodyType: vehicleBodyTypeSchema.default('van'),
  driveType: driveTypeSchema.nullish(),
  transmission: transmissionSchema.nullish(),
  fuelType: fuelTypeSchema.default('petrol'),
  engineCc: z.number().int().min(50).max(20000).nullish(),
  cylinders: z.number().int().min(1).max(16).nullish(),
  fuelTankL: z.number().positive().max(2000).nullish(),
  tyreSize: z.string().trim().max(40).nullish(),
  tyreCount: z.number().int().min(3).max(18).nullish(),
  spareTyre: z.boolean().default(true),
  vehicleCondition: vehicleConditionSchema.default('used'),
  ownershipKind: ownershipKindSchema.default('owned'),

  // Capacity
  seatsPassenger: z.number().int().min(1).max(60),
  seatsTotal: z.number().int().min(1).max(62),
  luggageCapacityL: z.number().int().min(0).max(10000).nullish(),
  roofRack: z.boolean().default(false),

  // Comfort
  airConditioning: z.boolean().default(true),
  heating: z.boolean().default(false),
  recliningSeats: z.boolean().default(false),
  usbCharging: z.boolean().default(false),
  wifi: z.boolean().default(false),
  entertainment: z.boolean().default(false),
  curtains: z.boolean().default(false),
  readingLights: z.boolean().default(false),

  // Safety and compliance
  airbags: z.number().int().min(0).max(12).default(0),
  abs: z.boolean().default(true),
  esp: z.boolean().default(false),
  seatbeltsAll: z.boolean().default(true),
  fireExtinguisher: z.boolean().default(false),
  firstAid: z.boolean().default(false),
  emergencyExit: z.boolean().default(false),
  gpsDevice: z.boolean().default(false),
  speedLimiter: z.boolean().default(false),

  // Accessibility
  childSeat: z.boolean().default(false),
  wheelchairAccessible: z.boolean().default(false),
  stepAssist: z.boolean().default(false),

  // Documents (dates only; files are uploaded separately)
  insuranceCompany: z.string().trim().max(120).nullish(),
  insurancePolicyNo: z.string().trim().max(60).nullish(),
  insuranceExpiry: isoDate,
  inspectionExpiry: isoDate,
  registrationExpiry: isoDate,
  transportPermitExpiry: isoDate,

  // Appearance
  exteriorCondition: conditionRatingSchema.default('good'),
  interiorCondition: conditionRatingSchema.default('good'),

  notes: z.string().trim().max(2000).nullish(),
  odometerKm: z.number().int().min(0).max(5_000_000).default(0),
});

export type VehicleInput = z.infer<typeof vehicleInputSchema>;

/** Cross-field rules, mirroring `app.assert_vehicle_payload()`. */
export function vehicleFieldErrors(
  input: VehicleInput,
  today = new Date(),
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (input.seatsPassenger > input.seatsTotal) {
    errors.seatsPassenger = 'passenger seats cannot exceed total seats';
  }
  const parse = (value: string | null | undefined) => (value ? new Date(value) : null);
  const insurance = parse(input.insuranceExpiry);
  if (insurance && insurance.getTime() < today.getTime()) {
    errors.insuranceExpiry = 'insurance has already expired';
  }
  const inspection = parse(input.inspectionExpiry);
  if (inspection) {
    const limit = new Date(today);
    limit.setFullYear(limit.getFullYear() - 1);
    if (inspection.getTime() < limit.getTime()) {
      errors.inspectionExpiry = 'inspection is more than a year out of date';
    }
  }
  return errors;
}

const photoSchema = z.object({
  path: z.string().min(3).max(300),
  caption: z.string().trim().max(120).nullish(),
  isPrimary: z.boolean().default(false),
});

const documentSchema = z.object({
  kind: z.enum(['insurance', 'registration', 'inspection', 'permit', 'other']),
  path: z.string().min(3).max(400),
  mime: z.string().max(80).nullish(),
  sizeBytes: z.number().int().min(0).nullish(),
});

export const createVehicleSchema = z.object({
  action: z.literal('vehicle.create'),
  /** Absent = the actor owns it personally. */
  orgId: uuid.nullish(),
  vehicle: vehicleInputSchema,
});

export const updateVehicleSchema = z.object({
  action: z.literal('vehicle.update'),
  vehicleId: uuid,
  vehicle: vehicleInputSchema,
});

export const submitVehicleVerificationSchema = z.object({
  action: z.literal('vehicle.submitVerification'),
  vehicleId: uuid,
  documents: z.array(documentSchema).min(1).max(10),
});

export const decideVehicleVerificationSchema = z.object({
  action: z.literal('vehicle.decide'),
  vehicleId: uuid,
  outcome: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(500).optional(),
});

export const setVehicleStatusSchema = z.object({
  action: z.literal('vehicle.setStatus'),
  vehicleId: uuid,
  status: vehicleStatusSchema,
  reason: z.string().trim().max(500).optional(),
});

export const setVehiclePhotosSchema = z.object({
  action: z.literal('vehicle.setPhotos'),
  vehicleId: uuid,
  photos: z.array(photoSchema).max(12),
});

export const inviteDriverSchema = z.object({
  action: z.literal('driver.invite'),
  orgId: uuid.nullish(),
  phone: z.string().trim().min(6).max(20),
  fullName: z.string().trim().min(2).max(120),
  licenceNo: z.string().trim().max(60).optional(),
  licenceExpiry: isoDate,
});

export const acceptDriverInviteSchema = z.object({
  action: z.literal('driver.accept'),
});

export const verifyDriverSchema = z.object({
  action: z.literal('driver.verify'),
  driverId: uuid,
  outcome: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(500).optional(),
});

export const setDriverLicenceSchema = z.object({
  action: z.literal('driver.setLicence'),
  driverId: uuid,
  licenceNo: z.string().trim().min(3).max(60).nullish(),
  licenceExpiry: isoDate.nullish(),
  licenceClass: z.string().trim().max(10).nullish(),
  photoPath: z.string().trim().max(300).nullish(),
});

export const assignDriverSchema = z.object({
  action: z.literal('driver.assign'),
  vehicleId: uuid,
  driverId: uuid,
});

export const unassignDriverSchema = z.object({
  action: z.literal('driver.unassign'),
  vehicleId: uuid,
});

export const fleetActionSchema = z.discriminatedUnion('action', [
  createVehicleSchema,
  updateVehicleSchema,
  submitVehicleVerificationSchema,
  decideVehicleVerificationSchema,
  setVehicleStatusSchema,
  setVehiclePhotosSchema,
  inviteDriverSchema,
  acceptDriverInviteSchema,
  setDriverLicenceSchema,
  verifyDriverSchema,
  assignDriverSchema,
  unassignDriverSchema,
]);

export type FleetAction = z.infer<typeof fleetActionSchema>;

/**
 * The scope facts an actor claims for an action.
 *
 * Both gateways pass this to `requirePolicy()` so a scoped capability can be evaluated before the
 * database is touched. It is a *claim*: the `cmd_*` re-derives ownership from the rows themselves, so
 * claiming too much here buys nothing.
 */
export function fleetScope(input: FleetAction): Resource {
  switch (input.action) {
    case 'vehicle.create':
    case 'driver.invite':
      return input.orgId ? { isOrgMember: true } : { isOwner: true };
    case 'driver.accept':
    case 'driver.setLicence':
      return {};
    default:
      return { isOwner: true, isOrgMember: true };
  }
}

export const fleetWarningSchema = z.object({
  code: z.enum([
    'PLATE_DUPLICATE',
    'DRIVER_NOT_VERIFIED',
    'VEHICLE_NOT_VERIFIED',
    'INSPECTION_EXPIRED',
    'INSURANCE_EXPIRED',
  ]),
  vehicleId: uuid.optional(),
  make: z.string().optional(),
  model: z.string().optional(),
});

export const fleetResultSchema = z
  .object({
    vehicle: z.record(z.string(), z.unknown()).optional(),
    warnings: z.array(fleetWarningSchema).optional(),
    driver: z.record(z.string(), z.unknown()).optional(),
    reverificationRequired: z.boolean().optional(),
    vehicleId: uuid.optional(),
    driverId: uuid.optional(),
    verificationStatus: z.string().optional(),
    status: z.string().optional(),
    changed: z.boolean().optional(),
    photos: z.number().optional(),
    unassigned: z.number().optional(),
    linkedImmediately: z.boolean().optional(),
    orgId: uuid.nullish(),
    requestId: z.string().optional(),
  })
  .passthrough();

export const fleetCommandSpec = {
  path: 'fleet',
  input: fleetActionSchema,
  output: fleetResultSchema,
  mutating: true,
} as const;

/**
 * Action → SQL function and arguments.
 *
 * The `p_` prefix is the command signature, so this map is also the only place that knows the wiring —
 * `cmd_*` names in this file are checked against the migrations by a guard.
 */
export function fleetCommandArgs(
  action: FleetAction,
  actorId: string,
  audit: { readonly p_request_id: string; readonly p_ip: string | null },
): { fn: string; args: Record<string, unknown> } {
  const json = (value: unknown) => JSON.stringify(value ?? null);

  switch (action.action) {
    case 'vehicle.create':
      return {
        fn: 'cmd_create_vehicle',
        args: {
          p_actor: actorId,
          p_owner_org: action.orgId ?? null,
          p_vehicle: json(action.vehicle),
          ...audit,
        },
      };
    case 'vehicle.update':
      return {
        fn: 'cmd_update_vehicle',
        args: {
          p_actor: actorId,
          p_vehicle_id: action.vehicleId,
          p_vehicle: json(action.vehicle),
          ...audit,
        },
      };
    case 'vehicle.submitVerification':
      return {
        fn: 'cmd_submit_vehicle_verification',
        args: {
          p_actor: actorId,
          p_vehicle_id: action.vehicleId,
          p_documents: json(action.documents),
          ...audit,
        },
      };
    case 'vehicle.decide':
      return {
        fn: 'cmd_decide_vehicle_verification',
        args: {
          p_actor: actorId,
          p_vehicle_id: action.vehicleId,
          p_outcome: action.outcome,
          p_reason: action.reason ?? null,
          ...audit,
        },
      };
    case 'vehicle.setStatus':
      return {
        fn: 'cmd_set_vehicle_status',
        args: {
          p_actor: actorId,
          p_vehicle_id: action.vehicleId,
          p_status: action.status,
          p_reason: action.reason ?? null,
          ...audit,
        },
      };
    case 'vehicle.setPhotos':
      return {
        fn: 'cmd_set_vehicle_photos',
        args: {
          p_actor: actorId,
          p_vehicle_id: action.vehicleId,
          p_photos: json(action.photos),
          ...audit,
        },
      };
    case 'driver.invite':
      return {
        fn: 'cmd_invite_driver',
        args: {
          p_actor: actorId,
          p_org_id: action.orgId ?? null,
          p_phone: action.phone,
          p_full_name: action.fullName,
          p_licence_no: action.licenceNo ?? null,
          p_licence_expiry: action.licenceExpiry ?? null,
          ...audit,
        },
      };
    case 'driver.accept':
      return {
        fn: 'cmd_accept_driver_invite',
        args: { p_actor: actorId, ...audit },
      };
    case 'driver.verify':
      return {
        fn: 'cmd_verify_driver',
        args: {
          p_actor: actorId,
          p_driver_id: action.driverId,
          p_outcome: action.outcome,
          p_reason: action.reason ?? null,
          ...audit,
        },
      };
    case 'driver.setLicence':
      return {
        fn: 'cmd_set_driver_licence',
        args: {
          p_actor: actorId,
          p_driver_id: action.driverId,
          p_licence_no: action.licenceNo ?? null,
          p_licence_expiry: action.licenceExpiry ?? null,
          p_licence_class: action.licenceClass ?? null,
          p_photo_path: action.photoPath ?? null,
          ...audit,
        },
      };
    case 'driver.assign':
      return {
        fn: 'cmd_assign_driver',
        args: {
          p_actor: actorId,
          p_vehicle_id: action.vehicleId,
          p_driver_id: action.driverId,
          ...audit,
        },
      };
    case 'driver.unassign':
      return {
        fn: 'cmd_unassign_driver',
        args: { p_actor: actorId, p_vehicle_id: action.vehicleId, ...audit },
      };
  }
}
