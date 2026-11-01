/**
 * The driver's trips, on native.
 *
 * Every read here goes through RLS with the driver's own session — `trips_driver_read` (00024) is what decides
 * which rows exist for this account, so this file never filters by driver id "for safety". The commands
 * (`trip.start`, `trip.stopReached`, `trip.recordPing`, `trip.end`) re-check the same relationship inside SQL,
 * which is the reason the screen can be thin.
 *
 * Two shapes, deliberately separate: the list (a driver's day) and one trip (what to do next). The trip screen
 * needs the stops in order and the last ping, and the list does not — loading them together would make the list
 * pay for the detail.
 */

import { getMobileClient } from './supabase';

export interface DriverTripSummary {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly departureAt: string;
  readonly origin: string;
  readonly destination: string;
  readonly vehicleLabel: string;
  readonly bookedSeats: number;
  readonly lastStopSeq: number | null;
  readonly startedAt: string | null;
  readonly lastPingAt: string | null;
}

export interface DriverStop {
  readonly seq: number;
  readonly name: string;
  readonly arriveOffsetMinutes: number | null;
  readonly reached: boolean;
}

export interface DriverTripDetail extends DriverTripSummary {
  readonly seatsTotal: number;
  readonly seatsAvailable: number;
  readonly stops: readonly DriverStop[];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0) || 0;
}

/**
 * The driver row bound to this account.
 *
 * `null` is a legitimate answer — an invited driver who has not accepted yet, or an operator. The screens turn it
 * into "no trips assigned" rather than an error, because a driver who has just installed the app is exactly that
 * case and a red message would be wrong.
 */
export async function myDriverProfileId(): Promise<string | null> {
  const supabase = getMobileClient();
  if (!supabase) return null;
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return null;

  const { data } = await supabase
    .from('driver_profiles')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1);
  const row = (data?.[0] as { id?: string } | undefined) ?? null;
  return row?.id ?? null;
}

interface Reference {
  readonly governorates: Map<string, string>;
  readonly vehicles: Map<string, string>;
}

/** Governorate names and vehicle labels, once per screen rather than once per row. */
async function loadReference(rows: readonly Record<string, unknown>[]): Promise<Reference> {
  const supabase = getMobileClient();
  const governorates = new Map<string, string>();
  const vehicles = new Map<string, string>();
  if (!supabase || rows.length === 0) return { governorates, vehicles };

  const governorateIds = Array.from(
    new Set(
      rows.flatMap((row) => [
        String(row.origin_governorate_id),
        String(row.destination_governorate_id),
      ]),
    ),
  );
  const vehicleIds = Array.from(
    new Set(rows.map((row) => String(row.vehicle_id)).filter((id) => id !== 'null')),
  );

  const [gov, veh] = await Promise.all([
    supabase.from('governorates').select('id, name_ar').in('id', governorateIds),
    vehicleIds.length > 0
      ? supabase.from('vehicles').select('id, make, model, plate_number').in('id', vehicleIds)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  for (const row of (gov.data ?? []) as Record<string, unknown>[]) {
    governorates.set(String(row.id), String(row.name_ar ?? '—'));
  }
  for (const row of (veh.data ?? []) as Record<string, unknown>[]) {
    vehicles.set(
      String(row.id),
      `${String(row.make ?? '')} ${String(row.model ?? '')} · ${String(row.plate_number ?? '')}`.trim(),
    );
  }
  return { governorates, vehicles };
}

const TRIP_COLUMNS =
  'id, code, status, departure_at, origin_governorate_id, destination_governorate_id, vehicle_id, ' +
  'last_stop_seq, started_at, last_ping_at, seats_total, seats_available';

/**
 * Today's trips: everything assigned and not finished.
 *
 * `published` and `in_progress` only. A completed trip is a record, not a task, and a cancelled one is not the
 * driver's to act on — showing either here would invite a tap that the command then refuses.
 */
export async function loadDriverTrips(): Promise<{
  readonly configured: boolean;
  readonly trips: readonly DriverTripSummary[];
}> {
  const supabase = getMobileClient();
  if (!supabase) return { configured: false, trips: [] };

  const driverId = await myDriverProfileId();
  if (!driverId) return { configured: true, trips: [] };

  const { data } = await supabase
    .from('trips')
    .select(TRIP_COLUMNS)
    .eq('driver_id', driverId)
    .in('status', ['published', 'in_progress'])
    .order('departure_at', { ascending: true })
    .limit(20);

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  if (rows.length === 0) return { configured: true, trips: [] };

  const [reference, bookings] = await Promise.all([
    loadReference(rows),
    supabase
      .from('bookings')
      .select('trip_id, seats, status')
      .in(
        'trip_id',
        rows.map((row) => String(row.id)),
      ),
  ]);

  const booked = new Map<string, number>();
  for (const row of (bookings.data ?? []) as Record<string, unknown>[]) {
    if (!['pending', 'accepted', 'completed'].includes(String(row.status))) continue;
    const key = String(row.trip_id);
    booked.set(key, (booked.get(key) ?? 0) + num(row.seats));
  }

  return {
    configured: true,
    trips: rows.map((row) => toSummary(row, reference, booked)),
  };
}

function toSummary(
  row: Record<string, unknown>,
  reference: Reference,
  booked: Map<string, number>,
): DriverTripSummary {
  return {
    id: String(row.id),
    code: String(row.code),
    status: String(row.status),
    departureAt: String(row.departure_at),
    origin: reference.governorates.get(String(row.origin_governorate_id)) ?? '—',
    destination: reference.governorates.get(String(row.destination_governorate_id)) ?? '—',
    vehicleLabel: reference.vehicles.get(String(row.vehicle_id)) ?? '—',
    bookedSeats: booked.get(String(row.id)) ?? 0,
    lastStopSeq: row.last_stop_seq == null ? null : num(row.last_stop_seq),
    startedAt: str(row.started_at),
    lastPingAt: str(row.last_ping_at),
  };
}

/** One trip, by its short code, with its stops in travel order. */
export async function loadDriverTrip(code: string): Promise<DriverTripDetail | null> {
  const supabase = getMobileClient();
  if (!supabase) return null;

  const { data } = await supabase.from('trips').select(TRIP_COLUMNS).eq('code', code).limit(1);
  const row = ((data ?? [])[0] as Record<string, unknown> | undefined) ?? null;
  if (!row) return null;

  const [reference, bookings, stops] = await Promise.all([
    loadReference([row]),
    supabase.from('bookings').select('seats, status').eq('trip_id', String(row.id)),
    supabase
      .from('trip_stops')
      .select('seq, name_ar, name_en, place_id, arrive_offset_minutes')
      .eq('trip_id', String(row.id))
      .order('seq', { ascending: true }),
  ]);

  const bookedSeats = ((bookings.data ?? []) as Record<string, unknown>[])
    .filter((booking) => ['pending', 'accepted', 'completed'].includes(String(booking.status)))
    .reduce((total, booking) => total + num(booking.seats), 0);

  const lastSeq = row.last_stop_seq == null ? 0 : num(row.last_stop_seq);
  const stopRows = (stops.data ?? []) as Record<string, unknown>[];

  return {
    ...toSummary(row, reference, new Map([[String(row.id), bookedSeats]])),
    seatsTotal: num(row.seats_total),
    seatsAvailable: num(row.seats_available),
    stops: stopRows.map((stop) => ({
      seq: num(stop.seq),
      name: String(stop.name_ar ?? stop.name_en ?? '—'),
      arriveOffsetMinutes:
        stop.arrive_offset_minutes == null ? null : num(stop.arrive_offset_minutes),
      reached: num(stop.seq) <= lastSeq,
    })),
  };
}
