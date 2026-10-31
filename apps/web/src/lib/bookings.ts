import { getServerClient } from '@/lib/supabase/server';
import { signedObjectUrl } from '@/lib/storage';

/**
 * Reads for Phase 5 bookings.
 *
 * Every one of these is an RLS-filtered PostgREST read — no gateway, no service role. That is the whole
 * reason the policies in `00019` are written against the row's own columns: a page cannot ask for a
 * booking it may not see, even if a future route forgets to check.
 */

export interface BookingTripSummary {
  readonly id: string;
  readonly code: string;
  readonly departureAt: string;
  readonly seatsTotal: number;
  readonly seatsAvailable: number;
  readonly originName: string | null;
  readonly destinationName: string | null;
  readonly originCode: string | null;
  readonly destinationCode: string | null;
  readonly operatorName: string | null;
}

export interface PassengerBooking {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly seats: number;
  readonly totalYer: number;
  readonly refundYer: number;
  readonly paymentStatus: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly gender: string | null;
  readonly note: string | null;
  readonly holdExpiresAt: string | null;
  readonly rejectReason: string | null;
  readonly cancelReason: string | null;
  readonly createdAt: string;
  readonly trip: BookingTripSummary | null;
  readonly document: PassengerDocumentSummary | null;
}

export interface PassengerDocumentSummary {
  readonly id: string;
  readonly idType: string;
  readonly idNumber: string;
  readonly birthPlace: string | null;
  readonly birthDate: string | null;
  readonly photoPath: string | null;
}

export interface OperatorBooking extends PassengerBooking {
  readonly destinationSeq: number | null;
  readonly unitPriceYer: number;
  readonly subtotalYer: number;
  readonly discountYer: number;
  readonly acceptedAt: string | null;
}

export interface SharePreview {
  readonly bookingId: string;
  readonly bookingCode: string;
  readonly tripCode: string;
  readonly passengerName: string;
  readonly contactPhone: string;
  readonly idType: string | null;
  readonly idNumber: string | null;
  readonly birthPlace: string | null;
  readonly birthDate: string | null;
  readonly photoPath: string | null;
  readonly expiresAt: string;
  readonly views: number;
}

/**
 * Columns as literal strings, not a joined array: the generated types parse a select at compile time, and
 * a template literal defeats them. Reads are also two queries rather than one embedded one — an
 * embed would need relationships the hand-written `database.types.ts` does not model, and this way the
 * RLS on `trips` and `passenger_documents` is exercised on its own terms instead of through a join.
 */
const BOOKING_COLUMNS =
  'id, code, status, seats, total_yer, refund_yer, payment_status, contact_name, contact_phone, passenger_gender, note, hold_expires_at, reject_reason, cancel_reason, created_at, trip_id' as const;

const TRIP_COLUMNS =
  'id, code, departure_at, seats_total, seats_available, origin_governorate_id, destination_governorate_id' as const;

const DOCUMENT_COLUMNS =
  'id, booking_id, id_type, id_number, birth_place, birth_date, photo_path' as const;

type Row = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number =>
  typeof value === 'number' ? value : Number(value ?? 0) || 0;

/** Governorate names, in the caller's language, for the handful of rows any page needs. */
async function governorateNames(
  client: NonNullable<Awaited<ReturnType<typeof getServerClient>>>,
  ids: readonly (string | null)[],
): Promise<Map<string, { name: string; code: string }>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const map = new Map<string, { name: string; code: string }>();
  if (wanted.length === 0) return map;

  const result = await client
    .from('governorates')
    .select('id, code, name_ar, name_en')
    .in('id', wanted);
  for (const row of (result.data ?? []) as Row[]) {
    const id = String(row.id);
    map.set(id, {
      code: String(row.code ?? ''),
      name: String(row.name_en ?? row.name_ar ?? row.code ?? ''),
    });
  }
  return map;
}

function toTripSummary(row: Row | null, names: Map<string, { name: string; code: string }>) {
  if (!row) return null;
  const originId = str(row.origin_governorate_id);
  const destinationId = str(row.destination_governorate_id);
  const origin = originId ? names.get(originId) : undefined;
  const destination = destinationId ? names.get(destinationId) : undefined;
  return {
    id: String(row.id),
    code: String(row.code),
    departureAt: String(row.departure_at),
    seatsTotal: num(row.seats_total),
    seatsAvailable: num(row.seats_available),
    originName: origin?.name ?? null,
    destinationName: destination?.name ?? null,
    originCode: origin?.code ?? null,
    destinationCode: destination?.code ?? null,
    operatorName: null,
  } satisfies BookingTripSummary;
}

function toDocument(row: Row | null): PassengerDocumentSummary | null {
  if (!row) return null;
  return {
    id: String(row.id),
    idType: String(row.id_type),
    idNumber: String(row.id_number),
    birthPlace: str(row.birth_place),
    birthDate: str(row.birth_date),
    photoPath: str(row.photo_path),
  };
}

function toBooking(
  row: Row,
  trip: BookingTripSummary | null,
  document: Row | null,
): PassengerBooking {
  return {
    id: String(row.id),
    code: String(row.code),
    status: String(row.status),
    seats: num(row.seats),
    totalYer: num(row.total_yer),
    refundYer: num(row.refund_yer),
    paymentStatus: String(row.payment_status),
    contactName: String(row.contact_name),
    contactPhone: String(row.contact_phone),
    gender: str(row.passenger_gender),
    note: str(row.note),
    holdExpiresAt: str(row.hold_expires_at),
    rejectReason: str(row.reject_reason),
    cancelReason: str(row.cancel_reason),
    createdAt: String(row.created_at),
    trip,
    document: toDocument(document),
  };
}

/** Everything this account has booked, newest first. Cancelled and past bookings stay: they are history. */
export async function loadMyBookings(): Promise<readonly PassengerBooking[]> {
  const client = await getServerClient();
  if (!client) return [];

  const result = await client
    .from('bookings')
    .select(BOOKING_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(100);
  if (result.error) return [];

  const rows = (result.data ?? []) as unknown as Row[];
  if (rows.length === 0) return [];

  const bookingIds = rows.map((row) => String(row.id));
  const tripIds = [...new Set(rows.map((row) => String(row.trip_id)))];

  const [trips, documents] = await Promise.all([
    client.from('trips').select(TRIP_COLUMNS).in('id', tripIds),
    client.from('passenger_documents').select(DOCUMENT_COLUMNS).in('booking_id', bookingIds),
  ]);

  const tripRows = new Map<string, Row>();
  for (const trip of (trips.data ?? []) as unknown as Row[]) tripRows.set(String(trip.id), trip);
  const documentRows = new Map<string, Row>();
  for (const doc of (documents.data ?? []) as unknown as Row[]) {
    documentRows.set(String(doc.booking_id), doc);
  }
  const names = await governorateNames(
    client,
    [...tripRows.values()].flatMap((trip) => [
      str(trip.origin_governorate_id),
      str(trip.destination_governorate_id),
    ]),
  );

  return rows.map((row) =>
    toBooking(
      row,
      toTripSummary(tripRows.get(String(row.trip_id)) ?? null, names),
      documentRows.get(String(row.id)) ?? null,
    ),
  );
}

/** One booking, if the caller may see it. `null` covers both "does not exist" and "not yours". */
export async function loadBooking(id: string): Promise<PassengerBooking | null> {
  const client = await getServerClient();
  if (!client) return null;

  const result = await client.from('bookings').select(BOOKING_COLUMNS).eq('id', id).maybeSingle();
  if (result.error || !result.data) return null;
  const row = result.data as unknown as Row;

  const [trip, document] = await Promise.all([
    client.from('trips').select(TRIP_COLUMNS).eq('id', String(row.trip_id)).maybeSingle(),
    client.from('passenger_documents').select(DOCUMENT_COLUMNS).eq('booking_id', id).maybeSingle(),
  ]);

  const tripRow = (trip.data ?? null) as unknown as Row | null;
  const names = await governorateNames(client, [
    str(tripRow?.origin_governorate_id ?? null),
    str(tripRow?.destination_governorate_id ?? null),
  ]);
  return toBooking(
    row,
    toTripSummary(tripRow, names),
    (document.data ?? null) as unknown as Row | null,
  );
}

/** The operator inbox for one trip: every booking, in the order it arrived. */
export async function loadTripBookings(tripId: string): Promise<readonly OperatorBooking[]> {
  const client = await getServerClient();
  if (!client) return [];

  const result = await client
    .from('bookings')
    .select(
      'id, code, status, seats, total_yer, refund_yer, payment_status, contact_name, contact_phone, passenger_gender, note, hold_expires_at, reject_reason, cancel_reason, created_at, trip_id, destination_seq, unit_price_yer, subtotal_yer, discount_yer, accepted_at',
    )
    .eq('trip_id', tripId)
    .order('created_at', { ascending: true });

  if (result.error) return [];
  const rows = (result.data ?? []) as unknown as Row[];
  const documentIds = rows.map((row) => String(row.id));
  const documents = new Map<string, Row>();
  if (documentIds.length > 0) {
    const docs = await client
      .from('passenger_documents')
      .select(DOCUMENT_COLUMNS)
      .in('booking_id', documentIds);
    for (const doc of (docs.data ?? []) as unknown as Row[]) {
      documents.set(String(doc.booking_id), doc);
    }
  }

  return rows.map((row) => ({
    ...toBooking(row, null, documents.get(String(row.id)) ?? null),
    destinationSeq: row.destination_seq == null ? null : num(row.destination_seq),
    unitPriceYer: num(row.unit_price_yer),
    subtotalYer: num(row.subtotal_yer),
    discountYer: num(row.discount_yer),
    acceptedAt: str(row.accepted_at),
  }));
}

/**
 * A share token, resolved for the operator who was sent it.
 *
 * The RPC is the read-with-an-audit-row: it refuses a caller who is not the trip's operator and writes a
 * `share_link` access row for one who is. `null` means "not found, expired, or not for you" — the page
 * must not tell a stranger which of the three.
 */
export async function loadSharePreview(token: string): Promise<SharePreview | null> {
  const client = await getServerClient();
  if (!client) return null;

  const result = await client.rpc('resolve_id_share_token', { p_token: token } as never);
  if (result.error || !result.data) return null;
  const row = result.data as Row;
  return {
    bookingId: String(row.bookingId),
    bookingCode: String(row.bookingCode),
    tripCode: String(row.tripCode),
    passengerName: String(row.passengerName),
    contactPhone: String(row.contactPhone),
    idType: str(row.idType),
    idNumber: str(row.idNumber),
    birthPlace: str(row.birthPlace),
    birthDate: str(row.birthDate),
    photoPath: str(row.photoPath),
    expiresAt: String(row.expiresAt),
    views: num(row.views),
  };
}

/** Records that this page rendered the passenger's ID, before it hands out the image URL. */
export async function logDocumentAccess(bookingId: string): Promise<void> {
  const client = await getServerClient();
  if (!client) return;
  await client.rpc('log_document_access', { p_booking_id: bookingId } as never);
}

/**
 * A signed, five-minute URL for one passenger ID image. See `lib/storage.ts` for the reasoning; the
 * wrapper exists so call sites say *what* they are reading rather than how it is signed.
 */
export function passengerIdSignedUrl(path: string): Promise<string | null> {
  return signedObjectUrl('passenger-ids', path);
}
