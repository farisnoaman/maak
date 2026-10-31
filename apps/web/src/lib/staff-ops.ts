/**
 * Staff operations: the scan, the patch summary and the manifest.
 *
 * All three go through the session-bound RPC wrappers (`staff_scan`, `staff_summary`,
 * `staff_manifest`), which take no actor parameter — the only identity the database will use is the one
 * on this request's JWT. That is why nothing here filters by scope: scope is decided where it cannot be
 * edited by the caller.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { getServerClient } from './supabase/server';

export interface ScanStop {
  readonly seq: number;
  readonly nameAr: string | null;
  readonly nameEn: string | null;
  readonly arriveOffsetMinutes: number;
  readonly reached: boolean;
}

export interface ScanTrip {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly verificationStatus: string;
  readonly departureAt: string;
  readonly arriveEstimateMinutes: number;
  readonly seatsTotal: number;
  readonly seatsAvailable: number;
  readonly bookedSeats: number;
  readonly origin: string | null;
  readonly originEn: string | null;
  readonly destination: string | null;
  readonly destinationEn: string | null;
  readonly operatorName: string | null;
  readonly vehicleLabel: string | null;
  readonly driverName: string | null;
  readonly startedAt: string | null;
  readonly lastPingAt: string | null;
}

export type ScanResult =
  | { readonly allowed: true; readonly trip: ScanTrip; readonly stops: readonly ScanStop[] }
  | {
      readonly allowed: false;
      readonly reason: 'NOT_FOUND' | 'OUT_OF_SCOPE' | 'RATE_LIMITED' | 'FORBIDDEN' | 'INTERNAL';
      /** Present for OUT_OF_SCOPE: the route, without the passengers. */
      readonly route: {
        readonly code: string;
        readonly origin: string | null;
        readonly destination: string | null;
      } | null;
    };

export interface StaffSummary {
  readonly global: boolean;
  readonly governorates: readonly string[];
  readonly pendingTrips: number;
  readonly liveTrips: number;
  readonly staleTrips: number;
  readonly recentScans: readonly {
    readonly tripId: string | null;
    readonly code: string | null;
    readonly allowed: boolean;
    readonly reason: string | null;
    readonly at: string;
  }[];
}

export interface ManifestPassenger {
  readonly code: string;
  readonly seats: number;
  readonly name: string;
  readonly phone: string;
  readonly gender: string | null;
  readonly status: string;
  readonly paymentStatus: string;
  readonly totalYer: number;
  readonly note: string | null;
}

export interface Manifest {
  readonly trip: {
    readonly id: string;
    readonly code: string;
    readonly status: string;
    readonly verificationStatus: string;
    readonly departureAt: string;
    readonly arriveEstimateMinutes: number;
    readonly seatsTotal: number;
    readonly seatsAvailable: number;
    readonly origin: string | null;
    readonly originEn: string | null;
    readonly destination: string | null;
    readonly destinationEn: string | null;
    readonly operatorName: string | null;
    readonly vehicleLabel: string | null;
    readonly vehicleSeats: number | null;
    readonly driverName: string | null;
    readonly driverPhone: string | null;
    readonly qrToken: string | null;
  };
  readonly stops: readonly {
    seq: number;
    nameAr: string | null;
    nameEn: string | null;
    arriveOffsetMinutes: number;
  }[];
  readonly passengers: readonly ManifestPassenger[];
  readonly passengerCount: number;
}

/**
 * Is this refusal a permission refusal?
 *
 * PostgREST wraps the database's own error: `{ code: '42501', message: 'FORBIDDEN: not your trip' }`.
 * The SQLSTATE is the reliable signal (`42501` is `insufficient_privilege`); the message is checked too
 * because the dev gateway re-serialises errors and does not always carry the code through.
 */
function isDenied(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === '42501' ||
    /FORBIDDEN|42501|insufficient privilege|staff only/i.test(error.message ?? '')
  );
}

function str(value: unknown): string | null {
  return value == null ? null : String(value);
}

function num(value: unknown): number {
  return value == null ? 0 : Number(value);
}

export async function loadStaffSummary(): Promise<StaffSummary | null> {
  const client = await getServerClient();
  if (!client) return null;

  const { data, error } = await client.rpc('staff_summary');
  if (error || !data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;

  return {
    global: Boolean(value.global),
    governorates: Array.isArray(value.governorates) ? (value.governorates as string[]) : [],
    pendingTrips: num(value.pendingTrips),
    liveTrips: num(value.liveTrips),
    staleTrips: num(value.staleTrips),
    recentScans: Array.isArray(value.recentScans)
      ? (value.recentScans as unknown as StaffSummary['recentScans'])
      : [],
  };
}

export async function runScan(token: string): Promise<ScanResult> {
  const client = await getServerClient();
  if (!client) return { allowed: false, reason: 'INTERNAL', route: null };

  const { data, error } = await client.rpc('staff_scan', { p_token: token.trim() });
  if (error || !data || typeof data !== 'object') {
    // 42501 from the function means "not staff at all"; anything else is ours to investigate.
    return { allowed: false, reason: isDenied(error) ? 'FORBIDDEN' : 'INTERNAL', route: null };
  }

  const value = data as Record<string, unknown>;
  if (value.allowed !== true) {
    const reason = String(value.reason ?? 'INTERNAL');
    const route = (value.trip ?? null) as {
      code?: string;
      origin?: string;
      destination?: string;
    } | null;
    return {
      allowed: false,
      reason: (['NOT_FOUND', 'OUT_OF_SCOPE', 'RATE_LIMITED'].includes(reason)
        ? reason
        : 'INTERNAL') as 'NOT_FOUND' | 'OUT_OF_SCOPE' | 'RATE_LIMITED',
      route: route?.code
        ? {
            code: String(route.code),
            origin: str(route.origin),
            destination: str(route.destination),
          }
        : null,
    };
  }

  const trip = (value.trip ?? {}) as Record<string, unknown>;
  return {
    allowed: true,
    trip: {
      id: String(trip.id ?? ''),
      code: String(trip.code ?? ''),
      status: String(trip.status ?? ''),
      verificationStatus: String(trip.verificationStatus ?? ''),
      departureAt: String(trip.departureAt ?? ''),
      arriveEstimateMinutes: num(trip.arriveEstimateMinutes),
      seatsTotal: num(trip.seatsTotal),
      seatsAvailable: num(trip.seatsAvailable),
      bookedSeats: num(trip.bookedSeats),
      origin: str(trip.origin),
      originEn: str(trip.originEn),
      destination: str(trip.destination),
      destinationEn: str(trip.destinationEn),
      operatorName: str(trip.operatorName),
      vehicleLabel: str(trip.vehicleLabel),
      driverName: str(trip.driverName),
      startedAt: str(trip.startedAt),
      lastPingAt: str(trip.lastPingAt),
    },
    stops: Array.isArray(value.stops) ? (value.stops as unknown as ScanStop[]) : [],
  };
}

export type ManifestLoad =
  | { readonly ok: true; readonly manifest: Manifest }
  | { readonly ok: false; readonly reason: 'FORBIDDEN' | 'NOT_FOUND' };

/**
 * The manifest, with the *reason* a refusal happened kept intact.
 *
 * "Not allowed" and "no such trip" are different answers with different status codes: a passenger who
 * follows a link must be told 403 (it exists, it is not theirs), while a wrong id is a 404. Collapsing
 * both into `null` would have made every refusal look like a broken link, and would have hidden a
 * permissions regression behind a 404.
 */
export async function loadManifest(tripId: string): Promise<ManifestLoad> {
  const client = await getServerClient();
  if (!client) return { ok: false, reason: 'NOT_FOUND' };

  const { data, error } = await client.rpc('staff_manifest', { p_trip_id: tripId });
  if (error) return { ok: false, reason: isDenied(error) ? 'FORBIDDEN' : 'NOT_FOUND' };
  if (!data || typeof data !== 'object') return { ok: false, reason: 'NOT_FOUND' };

  const value = data as Record<string, unknown>;
  const trip = (value.trip ?? {}) as Record<string, unknown>;

  return {
    ok: true,
    manifest: {
      trip: {
        id: String(trip.id ?? ''),
        code: String(trip.code ?? ''),
        status: String(trip.status ?? ''),
        verificationStatus: String(trip.verificationStatus ?? ''),
        departureAt: String(trip.departureAt ?? ''),
        arriveEstimateMinutes: num(trip.arriveEstimateMinutes),
        seatsTotal: num(trip.seatsTotal),
        seatsAvailable: num(trip.seatsAvailable),
        origin: str(trip.origin),
        originEn: str(trip.originEn),
        destination: str(trip.destination),
        destinationEn: str(trip.destinationEn),
        operatorName: str(trip.operatorName),
        vehicleLabel: str(trip.vehicleLabel),
        vehicleSeats: trip.vehicleSeats == null ? null : num(trip.vehicleSeats),
        driverName: str(trip.driverName),
        driverPhone: str(trip.driverPhone),
        qrToken: str(trip.qrToken),
      },
      stops: Array.isArray(value.stops) ? (value.stops as unknown as Manifest['stops']) : [],
      passengers: Array.isArray(value.passengers)
        ? (value.passengers as unknown as ManifestPassenger[])
        : [],
      passengerCount: num(value.passengerCount),
    },
  };
}

// The CSV, its filename and the print columns are pure formatting and live in `@maak/core`, where they
// are unit-tested without a browser. Re-exported here so a page has one import for staff operations.
export { manifestCsv, manifestFilename, manifestColumns } from '@maak/core';

export type WebClient = SupabaseClient;

export interface GovernorateOption {
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
}

/**
 * The governorates, for the history filter.
 *
 * Reference data, readable by anyone, so this needs no staff gate — and it is fetched with the visitor's
 * own cookie rather than the service role, which keeps the filter honest: a supervisor can only pick a
 * governorate, not a scope.
 */
export async function loadGovernorateOptions(): Promise<readonly GovernorateOption[]> {
  const client = await getServerClient();
  if (!client) return [];

  const { data } = await client
    .from('governorates')
    .select('id, name_ar, name_en')
    .order('name_ar', { ascending: true })
    .limit(40);

  return (data ?? []).map((row) => ({
    id: String((row as Record<string, unknown>).id ?? ''),
    nameAr: String((row as Record<string, unknown>).name_ar ?? ''),
    nameEn: ((row as Record<string, unknown>).name_en as string | null) ?? null,
  }));
}
