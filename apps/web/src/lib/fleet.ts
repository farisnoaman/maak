/**
 * Fleet reads for the web app — RLS-filtered, no service role.
 *
 * The write path is the `fleet` edge function; reads are plain `select`s through the visitor's own
 * session, so a driver only ever sees the vehicle assigned to them and a stranger sees nothing. Every
 * loader returns a preview shape when the database is not configured, so the preview environment shows
 * a working screen instead of an empty one.
 */

import { getServerClient } from './supabase/server';
import type { AccountContext } from './account';

export interface VehicleRow {
  readonly id: string;
  readonly ownerUserId: string | null;
  readonly ownerOrgId: string | null;
  readonly make: string;
  readonly model: string;
  readonly modelYear: number;
  readonly trim: string | null;
  readonly plateNumber: string;
  readonly vin: string | null;
  readonly chassisNo: string | null;
  readonly color: string | null;
  readonly bodyType: string;
  readonly driveType: string | null;
  readonly transmission: string | null;
  readonly fuelType: string;
  readonly engineCc: number | null;
  readonly cylinders: number | null;
  readonly fuelTankL: number | null;
  readonly tyreSize: string | null;
  readonly tyreCount: number | null;
  readonly spareTyre: boolean;
  readonly vehicleCondition: string;
  readonly ownershipKind: string;
  readonly seatsPassenger: number;
  readonly seatsTotal: number;
  readonly luggageCapacityL: number | null;
  readonly roofRack: boolean;
  readonly airConditioning: boolean;
  readonly heating: boolean;
  readonly recliningSeats: boolean;
  readonly usbCharging: boolean;
  readonly wifi: boolean;
  readonly entertainment: boolean;
  readonly curtains: boolean;
  readonly readingLights: boolean;
  readonly airbags: number;
  readonly abs: boolean;
  readonly esp: boolean;
  readonly seatbeltsAll: boolean;
  readonly fireExtinguisher: boolean;
  readonly firstAid: boolean;
  readonly emergencyExit: boolean;
  readonly gpsDevice: boolean;
  readonly speedLimiter: boolean;
  readonly childSeat: boolean;
  readonly wheelchairAccessible: boolean;
  readonly stepAssist: boolean;
  readonly insuranceCompany: string | null;
  readonly insurancePolicyNo: string | null;
  readonly insuranceExpiry: string | null;
  readonly inspectionExpiry: string | null;
  readonly registrationExpiry: string | null;
  readonly transportPermitExpiry: string | null;
  readonly exteriorCondition: string;
  readonly interiorCondition: string;
  readonly odometerKm: number;
  readonly status: string;
  readonly verificationStatus: string;
  readonly verificationNote: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VehiclePhotoRow {
  readonly id: string;
  readonly vehicleId: string;
  readonly storagePath: string;
  readonly caption: string | null;
  readonly isPrimary: boolean;
}

export interface VehicleDocumentRow {
  readonly id: string;
  readonly vehicleId: string;
  readonly kind: string;
  readonly storagePath: string;
  readonly uploadedAt: string;
}

export interface DriverRow {
  readonly id: string;
  readonly userId: string | null;
  readonly orgId: string | null;
  readonly fullName: string;
  readonly phone: string;
  readonly licenceNo: string | null;
  readonly licenceExpiry: string | null;
  readonly status: string;
  readonly verificationStatus: string;
  readonly verificationNote: string | null;
  readonly createdAt: string;
}

export interface AssignmentRow {
  readonly id: string;
  readonly vehicleId: string;
  readonly driverId: string;
  readonly assignedAt: string;
  readonly unassignedAt: string | null;
  readonly driverName: string;
}

export interface PlanLimitRow {
  readonly planCode: string;
  readonly metric: string;
  readonly limitValue: number | null;
}

export interface FleetData {
  readonly configured: boolean;
  readonly vehicles: readonly VehicleRow[];
  readonly drivers: readonly DriverRow[];
  readonly photos: readonly VehiclePhotoRow[];
  readonly documents: readonly VehicleDocumentRow[];
  readonly assignments: readonly AssignmentRow[];
  readonly limits: readonly PlanLimitRow[];
  readonly pendingVehicles: readonly VehicleRow[];
  readonly pendingDrivers: readonly DriverRow[];
}

const VEHICLE_COLUMNS = [
  'id',
  'owner_user_id',
  'owner_org_id',
  'make',
  'model',
  'model_year',
  'trim',
  'plate_number',
  'vin',
  'chassis_no',
  'color',
  'body_type',
  'drive_type',
  'transmission',
  'fuel_type',
  'engine_cc',
  'cylinders',
  'fuel_tank_l',
  'tyre_size',
  'tyre_count',
  'spare_tyre',
  'vehicle_condition',
  'ownership_kind',
  'seats_passenger',
  'seats_total',
  'luggage_capacity_l',
  'roof_rack',
  'air_conditioning',
  'heating',
  'reclining_seats',
  'usb_charging',
  'wifi',
  'entertainment',
  'curtains',
  'reading_lights',
  'airbags',
  'abs',
  'esp',
  'seatbelts_all',
  'fire_extinguisher',
  'first_aid',
  'emergency_exit',
  'gps_device',
  'speed_limiter',
  'child_seat',
  'wheelchair_accessible',
  'step_assist',
  'insurance_company',
  'insurance_policy_no',
  'insurance_expiry',
  'inspection_expiry',
  'registration_expiry',
  'transport_permit_expiry',
  'exterior_condition',
  'interior_condition',
  'odometer_km',
  'status',
  'verification_status',
  'verification_note',
  'notes',
  'created_at',
  'updated_at',
].join(', ');

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function toVehicleRow(row: Record<string, unknown>): VehicleRow {
  return {
    id: String(row.id),
    ownerUserId: str(row.owner_user_id),
    ownerOrgId: str(row.owner_org_id),
    make: String(row.make ?? ''),
    model: String(row.model ?? ''),
    modelYear: num(row.model_year),
    trim: str(row.trim),
    plateNumber: String(row.plate_number ?? ''),
    vin: str(row.vin),
    chassisNo: str(row.chassis_no),
    color: str(row.color),
    bodyType: String(row.body_type ?? 'van'),
    driveType: str(row.drive_type),
    transmission: str(row.transmission),
    fuelType: String(row.fuel_type ?? 'petrol'),
    engineCc: numOrNull(row.engine_cc),
    cylinders: numOrNull(row.cylinders),
    fuelTankL: numOrNull(row.fuel_tank_l),
    tyreSize: str(row.tyre_size),
    tyreCount: numOrNull(row.tyre_count),
    spareTyre: row.spare_tyre !== false,
    vehicleCondition: String(row.vehicle_condition ?? 'used'),
    ownershipKind: String(row.ownership_kind ?? 'owned'),
    seatsPassenger: num(row.seats_passenger),
    seatsTotal: num(row.seats_total),
    luggageCapacityL: numOrNull(row.luggage_capacity_l),
    roofRack: row.roof_rack === true,
    airConditioning: row.air_conditioning !== false,
    heating: row.heating === true,
    recliningSeats: row.reclining_seats === true,
    usbCharging: row.usb_charging === true,
    wifi: row.wifi === true,
    entertainment: row.entertainment === true,
    curtains: row.curtains === true,
    readingLights: row.reading_lights === true,
    airbags: num(row.airbags),
    abs: row.abs !== false,
    esp: row.esp === true,
    seatbeltsAll: row.seatbelts_all !== false,
    fireExtinguisher: row.fire_extinguisher === true,
    firstAid: row.first_aid === true,
    emergencyExit: row.emergency_exit === true,
    gpsDevice: row.gps_device === true,
    speedLimiter: row.speed_limiter === true,
    childSeat: row.child_seat === true,
    wheelchairAccessible: row.wheelchair_accessible === true,
    stepAssist: row.step_assist === true,
    insuranceCompany: str(row.insurance_company),
    insurancePolicyNo: str(row.insurance_policy_no),
    insuranceExpiry: str(row.insurance_expiry),
    inspectionExpiry: str(row.inspection_expiry),
    registrationExpiry: str(row.registration_expiry),
    transportPermitExpiry: str(row.transport_permit_expiry),
    exteriorCondition: String(row.exterior_condition ?? 'good'),
    interiorCondition: String(row.interior_condition ?? 'good'),
    odometerKm: num(row.odometer_km),
    status: String(row.status ?? 'draft'),
    verificationStatus: String(row.verification_status ?? 'unverified'),
    verificationNote: str(row.verification_note),
    notes: str(row.notes),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

const EMPTY: FleetData = {
  configured: false,
  vehicles: [],
  drivers: [],
  photos: [],
  documents: [],
  assignments: [],
  limits: [],
  pendingVehicles: [],
  pendingDrivers: [],
};

/**
 * Preview fixtures: one verified vehicle and one awaiting review, with documents that expire soon
 * enough to show the amber badge. A preview that hides the warning paths never gets them tested.
 */
function previewFleet(): FleetData {
  const base = {
    ownerUserId: 'preview-owner',
    ownerOrgId: null,
    trim: 'GL',
    vin: null,
    chassisNo: null,
    color: 'أبيض',
    driveType: 'rear_wheel_drive',
    transmission: 'manual',
    engineCc: 2500,
    cylinders: 4,
    fuelTankL: 70,
    tyreSize: '195/70 R15',
    tyreCount: 4,
    spareTyre: true,
    vehicleCondition: 'used',
    ownershipKind: 'owned',
    seatsTotal: 14,
    luggageCapacityL: 400,
    roofRack: true,
    heating: false,
    recliningSeats: true,
    usbCharging: true,
    wifi: false,
    entertainment: true,
    curtains: true,
    readingLights: false,
    airbags: 2,
    esp: false,
    seatbeltsAll: true,
    fireExtinguisher: true,
    firstAid: true,
    emergencyExit: true,
    gpsDevice: true,
    speedLimiter: false,
    childSeat: false,
    wheelchairAccessible: false,
    stepAssist: true,
    insuranceCompany: 'شركة اليمن للتأمين',
    insurancePolicyNo: 'POL-2026-118',
    registrationExpiry: '2026-12-31',
    transportPermitExpiry: null,
    exteriorCondition: 'good',
    interiorCondition: 'good',
    verificationNote: null,
    notes: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-02T08:00:00.000Z',
  } satisfies Partial<VehicleRow>;

  const soon = new Date(Date.now() + 18 * 86_400_000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10);

  const vehicles: VehicleRow[] = [
    {
      ...(base as Omit<VehicleRow, 'id'>),
      id: 'preview-vehicle-1',
      make: 'Toyota',
      model: 'Hiace',
      modelYear: 2019,
      plateNumber: '12345-أ',
      bodyType: 'van',
      fuelType: 'diesel',
      seatsPassenger: 12,
      airConditioning: true,
      abs: true,
      insuranceExpiry: soon,
      inspectionExpiry: later,
      odometerKm: 182_400,
      status: 'active',
      verificationStatus: 'verified',
    } as VehicleRow,
    {
      ...(base as Omit<VehicleRow, 'id'>),
      id: 'preview-vehicle-2',
      make: 'Hyundai',
      model: 'H1',
      modelYear: 2021,
      plateNumber: '77788-ب',
      bodyType: 'van',
      fuelType: 'diesel',
      seatsPassenger: 10,
      airConditioning: true,
      abs: true,
      insuranceExpiry: later,
      inspectionExpiry: later,
      odometerKm: 64_000,
      status: 'active',
      verificationStatus: 'pending',
    } as VehicleRow,
  ];

  return {
    configured: false,
    vehicles,
    drivers: [
      {
        id: 'preview-driver-1',
        userId: 'preview-driver-user',
        orgId: null,
        fullName: 'سالم الحضرمي',
        phone: '+967 733 000 002',
        licenceNo: 'LIC-9931',
        licenceExpiry: later,
        status: 'active',
        verificationStatus: 'verified',
        verificationNote: null,
        createdAt: '2026-09-20T08:00:00.000Z',
      },
    ],
    photos: [
      {
        id: 'preview-photo-1',
        vehicleId: 'preview-vehicle-1',
        storagePath: 'preview-vehicle-1/front.jpg',
        caption: null,
        isPrimary: true,
      },
    ],
    documents: [
      {
        id: 'preview-doc-1',
        vehicleId: 'preview-vehicle-1',
        kind: 'insurance',
        storagePath: 'preview-vehicle-1/insurance.pdf',
        uploadedAt: '2026-10-01T09:00:00.000Z',
      },
    ],
    assignments: [
      {
        id: 'preview-assignment-1',
        vehicleId: 'preview-vehicle-1',
        driverId: 'preview-driver-1',
        assignedAt: '2026-10-02T08:00:00.000Z',
        unassignedAt: null,
        driverName: 'سالم الحضرمي',
      },
    ],
    limits: [
      { planCode: 'basic', metric: 'vehicles', limitValue: 1 },
      { planCode: 'basic', metric: 'drivers', limitValue: 1 },
      { planCode: 'pro', metric: 'vehicles', limitValue: 5 },
      { planCode: 'pro', metric: 'drivers', limitValue: 10 },
      { planCode: 'business', metric: 'vehicles', limitValue: null },
      { planCode: 'business', metric: 'drivers', limitValue: null },
    ],
    pendingVehicles: [vehicles[1]!],
    pendingDrivers: [],
  };
}

/**
 * Everything the fleet screens need, in one round of parallel reads.
 *
 * Staff also get the two review queues; everyone else gets their own rows (RLS decides what "their own"
 * means, so this function does not filter twice).
 */
export async function loadFleet(context: AccountContext): Promise<FleetData> {
  if (!context.configured) return previewFleet();
  if (!context.user) return { ...EMPTY, configured: true };

  const client = await getServerClient();
  if (!client) return { ...EMPTY, configured: true };

  const isStaff =
    context.roles.includes('platform_staff') || context.roles.includes('platform_admin');

  const [
    vehicleResult,
    driverResult,
    photoResult,
    documentResult,
    assignmentResult,
    limitResult,
    pendingVehicleResult,
    pendingDriverResult,
  ] = await Promise.all([
    client
      .from('vehicles')
      .select(VEHICLE_COLUMNS)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(200),
    client
      .from('driver_profiles')
      .select(
        'id, user_id, org_id, full_name, invited_phone, licence_no, licence_expiry, status, verification_status, verification_note, created_at',
      )
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(200),
    client
      .from('vehicle_photos')
      .select('id, vehicle_id, storage_path, caption, is_primary')
      .order('is_primary', { ascending: false })
      .limit(600),
    client
      .from('vehicle_documents')
      .select('id, vehicle_id, kind, storage_path, uploaded_at')
      .limit(600),
    client
      .from('vehicle_driver_assignments')
      .select('id, vehicle_id, driver_id, assigned_at, unassigned_at, driver_profiles(full_name)')
      .is('unassigned_at', null),
    client.from('plan_limits').select('plan_code, metric, limit_value'),
    isStaff
      ? client
          .from('vehicles')
          .select(VEHICLE_COLUMNS)
          .eq('verification_status', 'pending')
          .order('created_at', { ascending: true })
          .limit(100)
      : Promise.resolve({ data: [] }),
    isStaff
      ? client
          .from('driver_profiles')
          .select(
            'id, user_id, org_id, full_name, invited_phone, licence_no, licence_expiry, status, verification_status, verification_note, created_at',
          )
          .eq('verification_status', 'pending')
          .order('created_at', { ascending: true })
          .limit(100)
      : Promise.resolve({ data: [] }),
  ]);

  const rows = (value: unknown) =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

  return {
    configured: true,
    vehicles: rows(vehicleResult.data).map(toVehicleRow),
    drivers: rows(driverResult.data).map((row) => ({
      id: String(row.id),
      userId: str(row.user_id),
      orgId: str(row.org_id),
      fullName: String(row.full_name ?? ''),
      phone: String(row.invited_phone ?? ''),
      licenceNo: str(row.licence_no),
      licenceExpiry: str(row.licence_expiry),
      status: String(row.status ?? 'invited'),
      verificationStatus: String(row.verification_status ?? 'unverified'),
      verificationNote: str(row.verification_note),
      createdAt: String(row.created_at ?? ''),
    })),
    photos: rows(photoResult.data).map((row) => ({
      id: String(row.id),
      vehicleId: String(row.vehicle_id),
      storagePath: String(row.storage_path ?? ''),
      caption: str(row.caption),
      isPrimary: row.is_primary === true,
    })),
    documents: rows(documentResult.data).map((row) => ({
      id: String(row.id),
      vehicleId: String(row.vehicle_id),
      kind: String(row.kind ?? 'other'),
      storagePath: String(row.storage_path ?? ''),
      uploadedAt: String(row.uploaded_at ?? ''),
    })),
    assignments: rows(assignmentResult.data).map((row) => {
      const driver = Array.isArray(row.driver_profiles)
        ? (row.driver_profiles[0] as Record<string, unknown> | undefined)
        : (row.driver_profiles as Record<string, unknown> | undefined);
      return {
        id: String(row.id),
        vehicleId: String(row.vehicle_id),
        driverId: String(row.driver_id),
        assignedAt: String(row.assigned_at ?? ''),
        unassignedAt: str(row.unassigned_at),
        driverName: String(driver?.full_name ?? ''),
      };
    }),
    limits: rows(limitResult.data).map((row) => ({
      planCode: String(row.plan_code),
      metric: String(row.metric),
      limitValue: numOrNull(row.limit_value),
    })),
    pendingVehicles: rows(pendingVehicleResult.data).map(toVehicleRow),
    pendingDrivers: rows(pendingDriverResult.data).map((row) => ({
      id: String(row.id),
      userId: str(row.user_id),
      orgId: str(row.org_id),
      fullName: String(row.full_name ?? ''),
      phone: String(row.invited_phone ?? ''),
      licenceNo: str(row.licence_no),
      licenceExpiry: str(row.licence_expiry),
      status: String(row.status ?? 'invited'),
      verificationStatus: String(row.verification_status ?? 'unverified'),
      verificationNote: str(row.verification_note),
      createdAt: String(row.created_at ?? ''),
    })),
  };
}

/** One vehicle's detail, or null when RLS says it is not the visitor's. */
export async function loadVehicle(id: string): Promise<{
  vehicle: VehicleRow;
  photos: readonly VehiclePhotoRow[];
  documents: readonly VehicleDocumentRow[];
  assignment: AssignmentRow | null;
} | null> {
  const client = await getServerClient();
  if (!client) return null;

  const vehicleResult = await client
    .from('vehicles')
    .select(VEHICLE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  const row = vehicleResult.data as Record<string, unknown> | null;
  if (!row) return null;

  const [photoResult, documentResult, assignmentResult] = await Promise.all([
    client
      .from('vehicle_photos')
      .select('id, vehicle_id, storage_path, caption, is_primary')
      .eq('vehicle_id', id)
      .order('is_primary', { ascending: false }),
    client
      .from('vehicle_documents')
      .select('id, vehicle_id, kind, storage_path, uploaded_at')
      .eq('vehicle_id', id),
    client
      .from('vehicle_driver_assignments')
      .select('id, vehicle_id, driver_id, assigned_at, unassigned_at, driver_profiles(full_name)')
      .eq('vehicle_id', id)
      .is('unassigned_at', null)
      .maybeSingle(),
  ]);

  const rows = (value: unknown) =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  const assignmentRow = assignmentResult.data as Record<string, unknown> | null;
  const driver = assignmentRow?.driver_profiles;
  const driverRecord = Array.isArray(driver)
    ? (driver[0] as Record<string, unknown> | undefined)
    : (driver as Record<string, unknown> | undefined);

  return {
    vehicle: toVehicleRow(row),
    photos: rows(photoResult.data).map((item) => ({
      id: String(item.id),
      vehicleId: String(item.vehicle_id),
      storagePath: String(item.storage_path ?? ''),
      caption: str(item.caption),
      isPrimary: item.is_primary === true,
    })),
    documents: rows(documentResult.data).map((item) => ({
      id: String(item.id),
      vehicleId: String(item.vehicle_id),
      kind: String(item.kind ?? 'other'),
      storagePath: String(item.storage_path ?? ''),
      uploadedAt: String(item.uploaded_at ?? ''),
    })),
    assignment: assignmentRow
      ? {
          id: String(assignmentRow.id),
          vehicleId: String(assignmentRow.vehicle_id),
          driverId: String(assignmentRow.driver_id),
          assignedAt: String(assignmentRow.assigned_at ?? ''),
          unassignedAt: str(assignmentRow.unassigned_at),
          driverName: String(driverRecord?.full_name ?? ''),
        }
      : null,
  };
}
