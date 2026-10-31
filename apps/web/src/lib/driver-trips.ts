/**
 * The driver's own trips, read with the driver's own session.
 *
 * A driver is not an operator: they have no organisation console and no membership policy to lean on,
 * and the only rows they may see are the ones a `driver_profiles` record binds them to (RLS, 00014).
 * This module therefore starts from that record — "who am I as a driver" — and never from a trip id a
 * caller supplied, which is what makes `/driver/trips/<code>` safe to open with any code: the query
 * simply returns nothing for a trip that is not theirs.
 */

import { getServerClient } from './supabase/server';

export interface DriverTripStop {
  readonly id: string;
  readonly seq: number;
  /** Both names: the console shows the driver's own language, which the page decides, not the query. */
  readonly nameAr: string | null;
  readonly nameEn: string | null;
  readonly arriveOffsetMinutes: number;
}

export interface DriverTripSummary {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly verificationStatus: string;
  readonly departureAt: string;
  readonly arriveEstimateMinutes: number;
  readonly origin: string;
  readonly destination: string;
  readonly vehicleLabel: string;
  readonly seatsTotal: number;
  readonly seatsAvailable: number;
  readonly bookedSeats: number;
  readonly lastStopSeq: number | null;
  readonly startedAt: string | null;
  readonly lastPingAt: string | null;
}

export interface DriverTripDetail extends DriverTripSummary {
  readonly stops: readonly DriverTripStop[];
  /** The vehicle's last known reading, shown next to the odometer input as the floor. */
  readonly lastOdoKm: number | null;
}

const TRIP_COLUMNS =
  'id, code, status, verification_status, departure_at, arrive_estimate_minutes, ' +
  'origin_governorate_id, destination_governorate_id, vehicle_id, seats_total, seats_available, ' +
  'last_stop_seq, started_at, last_ping_at';

function str(value: unknown): string | null {
  return value == null ? null : String(value);
}

function num(value: unknown): number {
  return value == null ? 0 : Number(value);
}

async function driverProfileId(
  client: NonNullable<Awaited<ReturnType<typeof getServerClient>>>,
  userId: string,
): Promise<string | null> {
  const result = await client
    .from('driver_profiles')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  const row = result.data as { id?: string } | null;
  return row?.id ? String(row.id) : null;
}

interface Reference {
  readonly governorates: Map<string, { ar: string; en: string | null }>;
  readonly vehicles: Map<string, string>;
}

async function loadReference(
  client: NonNullable<Awaited<ReturnType<typeof getServerClient>>>,
): Promise<Reference> {
  const [govResult, vehicleResult] = await Promise.all([
    client.from('governorates').select('id, name_ar, name_en').limit(40),
    client.from('vehicles').select('id, make, model, plate_number').limit(200),
  ]);

  const governorates = new Map<string, { ar: string; en: string | null }>();
  for (const row of (govResult.data ?? []) as unknown as Record<string, unknown>[]) {
    governorates.set(String(row.id), {
      ar: String(row.name_ar ?? ''),
      en: str(row.name_en),
    });
  }

  const vehicles = new Map<string, string>();
  for (const row of (vehicleResult.data ?? []) as unknown as Record<string, unknown>[]) {
    vehicles.set(
      String(row.id),
      [row.make, row.model, row.plate_number].filter(Boolean).join(' ').trim() || '—',
    );
  }

  return { governorates, vehicles };
}

export async function loadDriverTrips(): Promise<{
  readonly configured: boolean;
  readonly trips: readonly DriverTripSummary[];
}> {
  const client = await getServerClient();
  if (!client) return { configured: false, trips: [] };

  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return { configured: true, trips: [] };

  const profileId = await driverProfileId(client, user.id);
  if (!profileId) return { configured: true, trips: [] };

  const result = await client
    .from('trips')
    .select(TRIP_COLUMNS)
    .eq('driver_id', profileId)
    .in('status', ['published', 'in_progress'])
    .order('departure_at', { ascending: true })
    .limit(20);

  const rows = (result.data ?? []) as unknown as Record<string, unknown>[];
  if (rows.length === 0) return { configured: true, trips: [] };

  const [reference, bookings] = await Promise.all([
    loadReference(client),
    client
      .from('bookings')
      .select('trip_id, seats, status')
      .in(
        'trip_id',
        rows.map((row) => String(row.id)),
      ),
  ]);

  const bookedSeats = new Map<string, number>();
  for (const booking of (bookings.data ?? []) as unknown as Record<string, unknown>[]) {
    if (!['pending', 'accepted', 'completed'].includes(String(booking.status))) continue;
    const key = String(booking.trip_id);
    bookedSeats.set(key, (bookedSeats.get(key) ?? 0) + num(booking.seats));
  }

  return {
    configured: true,
    trips: rows.map((row) => toSummary(row, reference, bookedSeats)),
  };
}

function toSummary(
  row: Record<string, unknown>,
  reference: Reference,
  bookedSeats: Map<string, number>,
): DriverTripSummary {
  const origin = reference.governorates.get(String(row.origin_governorate_id));
  const destination = reference.governorates.get(String(row.destination_governorate_id));
  return {
    id: String(row.id),
    code: String(row.code),
    status: String(row.status),
    verificationStatus: String(row.verification_status),
    departureAt: String(row.departure_at),
    arriveEstimateMinutes: num(row.arrive_estimate_minutes),
    origin: origin?.ar ?? '—',
    destination: destination?.ar ?? '—',
    vehicleLabel: reference.vehicles.get(String(row.vehicle_id)) ?? '—',
    seatsTotal: num(row.seats_total),
    seatsAvailable: num(row.seats_available),
    bookedSeats: bookedSeats.get(String(row.id)) ?? 0,
    lastStopSeq: row.last_stop_seq == null ? null : num(row.last_stop_seq),
    startedAt: str(row.started_at),
    lastPingAt: str(row.last_ping_at),
  };
}

/**
 * One of the driver's trips, by code — or `null` when it is not assigned to them.
 *
 * The `null` is the whole authorisation story for this screen: RLS already refuses to return somebody
 * else's trip, and the page renders "not yours" rather than a console full of buttons that would all
 * answer `FORBIDDEN`.
 */
export async function loadDriverTrip(code: string): Promise<DriverTripDetail | null> {
  const client = await getServerClient();
  if (!client) return null;

  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return null;

  const profileId = await driverProfileId(client, user.id);
  if (!profileId) return null;

  const tripResult = await client
    .from('trips')
    .select(TRIP_COLUMNS)
    .eq('driver_id', profileId)
    .eq('code', code.toUpperCase())
    .limit(1)
    .maybeSingle();

  const row = tripResult.data as Record<string, unknown> | null;
  if (!row) return null;

  const tripId = String(row.id);
  const [reference, bookings, stopResult, vehicleResult] = await Promise.all([
    loadReference(client),
    client.from('bookings').select('trip_id, seats, status').eq('trip_id', tripId),
    client
      .from('trip_stops')
      .select('id, seq, name_ar, name_en, arrive_offset_minutes')
      .eq('trip_id', tripId)
      .order('seq', { ascending: true }),
    client.from('vehicles').select('odometer_km').eq('id', String(row.vehicle_id)).maybeSingle(),
  ]);

  const bookedSeats = ((bookings.data ?? []) as unknown as Record<string, unknown>[])
    .filter((booking) => ['pending', 'accepted', 'completed'].includes(String(booking.status)))
    .reduce((sum, booking) => sum + num(booking.seats), 0);

  const stops: DriverTripStop[] = (
    (stopResult.data ?? []) as unknown as Record<string, unknown>[]
  ).map((stop) => ({
    id: String(stop.id),
    seq: num(stop.seq),
    nameAr: str(stop.name_ar),
    nameEn: str(stop.name_en),
    arriveOffsetMinutes: num(stop.arrive_offset_minutes),
  }));

  const vehicle = vehicleResult.data as { odometer_km?: number } | null;

  return {
    ...toSummary(row, reference, new Map([[tripId, bookedSeats]])),
    stops,
    lastOdoKm: vehicle?.odometer_km == null ? null : Number(vehicle.odometer_km),
  };
}
