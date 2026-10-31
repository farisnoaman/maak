import { bookingsCommandSpec, fail, type BookingsAction, type Result } from '@maak/core';
import { getApiClient } from './api';
import { getMobileClient } from './supabase';

/**
 * Bookings on native.
 *
 * The same split as the web client, for the same reason: reads are RLS-filtered PostgREST queries (a
 * passenger can only ever see their own rows, enforced by the policy rather than by `where passenger_id =
 * …` in a client someone could copy), and every write goes through the one `bookings` command.
 *
 * There are no generated types here — React Native has no `supabase gen types` step in this repo — so the
 * row shapes below are the contract, and they are trimmed to what the screens render.
 */

export interface MobileBookingTrip {
  readonly code: string;
  readonly departureAt: string;
  readonly originName: string | null;
  readonly destinationName: string | null;
}

export interface MobileBooking {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly seats: number;
  readonly totalYer: number;
  readonly refundYer: number;
  readonly currency: string;
  readonly createdAt: string;
  readonly holdExpiresAt: string | null;
  readonly rejectReason: string | null;
  readonly cancelReason: string | null;
  readonly paymentStatus: string;
  readonly trip: MobileBookingTrip | null;
}

export interface MobilePassengerDocument {
  readonly idType: string;
  readonly idNumber: string;
  readonly birthPlace: string | null;
  readonly birthDate: string | null;
  readonly photoPath: string | null;
}

type Row = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' ? value : Number(value ?? fallback) || fallback;

async function governorateNames(ids: readonly string[]): Promise<Map<string, string>> {
  const supabase = getMobileClient();
  const names = new Map<string, string>();
  if (!supabase || ids.length === 0) return names;

  const { data } = await supabase
    .from('governorates')
    .select('id, name')
    .in('id', [...ids]);
  for (const row of (data ?? []) as Row[]) {
    const id = str(row.id);
    const name = str(row.name);
    if (id && name) names.set(id, name);
  }
  return names;
}

async function tripsById(ids: readonly string[]): Promise<Map<string, MobileBookingTrip>> {
  const supabase = getMobileClient();
  const trips = new Map<string, MobileBookingTrip>();
  if (!supabase || ids.length === 0) return trips;

  const { data } = await supabase
    .from('trips')
    .select('id, code, departure_at, origin_governorate_id, destination_governorate_id')
    .in('id', [...ids]);

  const rows = (data ?? []) as Row[];
  const names = await governorateNames(
    rows.flatMap((row) =>
      [str(row.origin_governorate_id), str(row.destination_governorate_id)].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );

  for (const row of rows) {
    const id = str(row.id);
    if (!id) continue;
    const origin = str(row.origin_governorate_id);
    const destination = str(row.destination_governorate_id);
    trips.set(id, {
      code: str(row.code) ?? '',
      departureAt: str(row.departure_at) ?? '',
      originName: origin ? (names.get(origin) ?? null) : null,
      destinationName: destination ? (names.get(destination) ?? null) : null,
    });
  }
  return trips;
}

function toBooking(row: Row, trip: MobileBookingTrip | null): MobileBooking {
  return {
    id: str(row.id) ?? '',
    code: str(row.code) ?? '',
    status: str(row.status) ?? 'pending',
    seats: num(row.seats, 1),
    totalYer: num(row.total_yer),
    refundYer: num(row.refund_yer),
    currency: str(row.currency) ?? 'YER',
    createdAt: str(row.created_at) ?? '',
    holdExpiresAt: str(row.hold_expires_at),
    rejectReason: str(row.reject_reason),
    cancelReason: str(row.cancel_reason),
    paymentStatus: str(row.payment_status) ?? 'unpaid',
    trip,
  };
}

/** The passenger's bookings, newest first. Anonymous callers get an empty list, not an error. */
export async function loadMyBookings(): Promise<{
  readonly configured: boolean;
  readonly items: readonly MobileBooking[];
}> {
  const supabase = getMobileClient();
  if (!supabase) return { configured: false, items: [] };

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return { configured: true, items: [] };

  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id, code, status, seats, total_yer, refund_yer, currency, created_at, hold_expires_at, reject_reason, cancel_reason, payment_status, trip_id',
    )
    .order('created_at', { ascending: false });

  if (error || !data) return { configured: true, items: [] };

  const rows = data as Row[];
  const trips = await tripsById(
    rows.map((row) => str(row.trip_id)).filter((value): value is string => Boolean(value)),
  );

  return {
    configured: true,
    items: rows.map((row) => {
      const tripId = str(row.trip_id);
      return toBooking(row, tripId ? (trips.get(tripId) ?? null) : null);
    }),
  };
}

export interface MobileBookingDetail {
  readonly booking: MobileBooking | null;
  readonly document: MobilePassengerDocument | null;
}

export async function loadBooking(id: string): Promise<MobileBookingDetail> {
  const supabase = getMobileClient();
  if (!supabase) return { booking: null, document: null };

  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id, code, status, seats, total_yer, refund_yer, currency, created_at, hold_expires_at, reject_reason, cancel_reason, payment_status, trip_id',
    )
    .eq('id', id)
    .maybeSingle();

  if (error || !data) return { booking: null, document: null };

  const row = data as Row;
  const tripId = str(row.trip_id);
  const trips = await tripsById(tripId ? [tripId] : []);

  const { data: documentRow } = await supabase
    .from('passenger_documents')
    .select('id_type, id_number, birth_place, birth_date, photo_path')
    .eq('booking_id', id)
    .maybeSingle();

  const document = documentRow as Row | null;

  return {
    booking: toBooking(row, tripId ? (trips.get(tripId) ?? null) : null),
    document: document
      ? {
          idType: str(document.id_type) ?? 'national_id',
          idNumber: str(document.id_number) ?? '',
          birthPlace: str(document.birth_place),
          birthDate: str(document.birth_date),
          photoPath: str(document.photo_path),
        }
      : null,
  };
}

/** The trip id behind a public code — `booking.create` wants an id, and a shared link only carries a code. */
export async function tripIdByCode(code: string): Promise<string | null> {
  const supabase = getMobileClient();
  if (!supabase) return null;
  const { data } = await supabase.from('trips').select('id').eq('code', code).maybeSingle();
  return str((data as Row | null)?.id);
}

async function run(action: BookingsAction): Promise<Result<Record<string, unknown>>> {
  const client = getApiClient();
  if (!client) return fail({ code: 'UNAUTHENTICATED' });
  return client.call(bookingsCommandSpec, action);
}

export function createBooking(action: Extract<BookingsAction, { action: 'booking.create' }>) {
  return run(action);
}

export function cancelBooking(
  action: Extract<BookingsAction, { action: 'booking.cancelByPassenger' }>,
) {
  return run(action);
}

export function setPassengerDocument(
  action: Extract<BookingsAction, { action: 'booking.setDocument' }>,
) {
  return run(action);
}

export function createShareLink(action: Extract<BookingsAction, { action: 'booking.shareLink' }>) {
  return run(action);
}

/**
 * Uploads an ID photo into `passenger-ids/<booking-id>/…`.
 *
 * The bucket policy is what authorises it: the first path segment is the booking, and only that booking's
 * passenger may write there. The path returned is exactly what `booking.setDocument` expects — the object
 * name inside the bucket, not a URL.
 */
export async function uploadPassengerId(
  uri: string,
  bookingId: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const supabase = getMobileClient();
  if (!supabase) return { ok: false, error: 'not-configured' };

  const extension = uri.split('.').pop()?.toLowerCase() ?? 'jpg';
  const path = `${bookingId}/${Date.now()}.${extension}`;

  try {
    // React Native cannot hand a `File` to storage, so the image is fetched as an ArrayBuffer.
    const response = await fetch(uri);
    const buffer = await response.arrayBuffer();
    const { error } = await supabase.storage.from('passenger-ids').upload(path, buffer, {
      contentType: extension === 'png' ? 'image/png' : 'image/jpeg',
      upsert: false,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'upload failed' };
  }
}
