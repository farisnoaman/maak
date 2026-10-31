/**
 * Trip reads for the web app — RLS-filtered, no service role.
 *
 * The write path is the `trips` edge function; reads are plain `select`s through the visitor's own
 * session, so an operator only ever sees their own trips and platform staff see the review queue. The
 * public marketplace does **not** come through here: it is read with the two `anon` RPCs
 * (`search_public_trips`, `get_trip_public`), because a visitor has no session at all.
 *
 * Governorate names are fetched once and joined in memory rather than embedded through PostgREST: the
 * embed syntax is the part of PostgREST the dev stand-in is least faithful about, and 22 rows are
 * cheaper than a divergence between development and production.
 */

import { publicTripArgs, publicTripsArgs, staffTripsArgs, type TripFilters } from '@maak/core';

import { getServerClient } from './supabase/server';
import type { AccountContext } from './account';

export interface TripRow {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly verificationStatus: string;
  readonly departureAt: string;
  readonly arriveEstimateMinutes: number;
  readonly seatsTotal: number;
  readonly seatsAvailable: number;
  readonly bookingMode: string;
  readonly pricingMode: string;
  readonly pricePerSeatYer: number | null;
  readonly wholeTripPriceYer: number | null;
  readonly discountKind: string;
  readonly discountValue: number;
  readonly discountScope: string;
  readonly genderPolicy: string;
  readonly paymentPolicy: string;
  readonly luggageAllowanceKg: number | null;
  readonly notes: string | null;
  readonly featuredUntil: string | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  readonly publishedAt: string | null;
  readonly ownerUserId: string | null;
  readonly ownerOrgId: string | null;
  readonly vehicleId: string;
  readonly driverId: string | null;
  readonly vehicleLabel: string;
  readonly driverName: string | null;
  readonly origin: Governorate;
  readonly destination: Governorate;
}

export interface Governorate {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
}

export interface TripStopRow {
  readonly id: string;
  readonly tripId: string;
  readonly seq: number;
  readonly nameAr: string | null;
  readonly nameEn: string | null;
  readonly governorateId: string | null;
  readonly arriveOffsetMinutes: number;
  readonly priceFromOriginYer: number | null;
}

export interface TripEventRow {
  readonly id: number;
  readonly kind: string;
  readonly detail: Record<string, unknown>;
  readonly createdAt: string;
}

export interface TripOptionVehicle {
  readonly id: string;
  readonly label: string;
  readonly plateNumber: string;
  readonly verificationStatus: string;
  readonly ownerUserId: string | null;
  readonly ownerOrgId: string | null;
  /** Mirrors `isVehicleOperational()`: the wizard disables exactly what the RPC will refuse. */
  readonly status: string;
  readonly insuranceExpiry: string | null;
  readonly inspectionExpiry: string | null;
  readonly registrationExpiry: string | null;
}

export interface TripOptionDriver {
  readonly id: string;
  readonly name: string;
  readonly verificationStatus: string;
}

export interface TripOptions {
  readonly configured: boolean;
  readonly governorates: readonly Governorate[];
  readonly vehicles: readonly TripOptionVehicle[];
  readonly drivers: readonly TripOptionDriver[];
}

export interface TripsData {
  readonly configured: boolean;
  readonly trips: readonly TripRow[];
  readonly stops: readonly TripStopRow[];
  readonly pending: readonly TripRow[];
}

const str = (value: unknown): string | null => (value == null ? null : String(value));
const num = (value: unknown): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

const UNKNOWN: Governorate = { id: '', code: '', nameAr: '—', nameEn: '—' };

function governorateIndex(list: readonly Governorate[]): Map<string, Governorate> {
  return new Map(list.map((row) => [row.id, row]));
}

/** Everything a trip screen needs to render a card without a second round trip. */
function toTripRow(
  row: Record<string, unknown>,
  governorates: Map<string, Governorate>,
  vehicles: Map<string, string>,
  drivers: Map<string, string>,
): TripRow {
  const originId = String(row.origin_governorate_id ?? '');
  const destinationId = String(row.destination_governorate_id ?? '');
  const vehicleId = String(row.vehicle_id ?? '');
  const driverId = str(row.driver_id);
  return {
    id: String(row.id),
    code: String(row.code ?? ''),
    status: String(row.status ?? 'draft'),
    verificationStatus: String(row.verification_status ?? 'unverified'),
    departureAt: String(row.departure_at ?? ''),
    arriveEstimateMinutes: num(row.arrive_estimate_minutes) ?? 0,
    seatsTotal: num(row.seats_total) ?? 0,
    seatsAvailable: num(row.seats_available) ?? 0,
    bookingMode: String(row.booking_mode ?? 'per_seat'),
    pricingMode: String(row.pricing_mode ?? 'flat'),
    pricePerSeatYer: num(row.price_per_seat_yer),
    wholeTripPriceYer: num(row.whole_trip_price_yer),
    discountKind: String(row.discount_kind ?? 'none'),
    discountValue: num(row.discount_value) ?? 0,
    discountScope: String(row.discount_scope ?? 'all'),
    genderPolicy: String(row.gender_policy ?? 'any'),
    paymentPolicy: String(row.payment_policy ?? 'cash'),
    luggageAllowanceKg: num(row.luggage_allowance_kg),
    notes: str(row.notes),
    featuredUntil: str(row.featured_until),
    cancelledAt: str(row.cancelled_at),
    cancelReason: str(row.cancel_reason),
    publishedAt: str(row.published_at),
    ownerUserId: str(row.owner_user_id),
    ownerOrgId: str(row.owner_org_id),
    vehicleId,
    driverId,
    vehicleLabel: vehicles.get(vehicleId) ?? '—',
    driverName: driverId ? (drivers.get(driverId) ?? null) : null,
    origin: governorates.get(originId) ?? UNKNOWN,
    destination: governorates.get(destinationId) ?? UNKNOWN,
  };
}

const TRIP_COLUMNS =
  'id, code, status, verification_status, departure_at, arrive_estimate_minutes, ' +
  'seats_total, seats_available, booking_mode, pricing_mode, price_per_seat_yer, ' +
  'whole_trip_price_yer, discount_kind, discount_value, discount_scope, gender_policy, ' +
  'payment_policy, luggage_allowance_kg, notes, featured_until, cancelled_at, cancel_reason, ' +
  'published_at, owner_user_id, owner_org_id, vehicle_id, driver_id, ' +
  'origin_governorate_id, destination_governorate_id';

const STOP_COLUMNS =
  'id, trip_id, seq, name_ar, name_en, governorate_id, arrive_offset_minutes, price_from_origin_yer';

/**
 * The 22 governorates, for a form that has no session — the home page's search box. A visitor reading the
 * landing page is anonymous by definition, and `governorates` is public reference data.
 */
export async function loadPublicGovernorates(): Promise<readonly Governorate[]> {
  const client = await getServerClient();
  if (!client) return [];
  return loadGovernorates(client);
}

async function loadGovernorates(client: NonNullable<Awaited<ReturnType<typeof getServerClient>>>) {
  const result = await client.from('governorates').select('id, code, name_ar, name_en').limit(40);
  return rows(result.data).map((row) => ({
    id: String(row.id),
    code: String(row.code ?? ''),
    nameAr: String(row.name_ar ?? ''),
    nameEn: str(row.name_en),
  }));
}

/**
 * The wizard's three dropdowns: where, in what, with whom.
 *
 * Only vehicles that may legally carry passengers are offered — `app.assert_trip_vehicle()` refuses
 * anything else, and a dropdown that lists a refusal is a trap.
 */
export async function loadTripOptions(context: AccountContext): Promise<TripOptions> {
  const client = await getServerClient();
  if (!client) {
    return { configured: false, governorates: [], vehicles: [], drivers: [] };
  }

  const [governorateResult, vehicleResult, driverResult] = await Promise.all([
    loadGovernorates(client),
    client
      .from('vehicles')
      .select(
        'id, make, model, model_year, plate_number, verification_status, status, owner_user_id, owner_org_id, insurance_expiry, inspection_expiry, registration_expiry',
      )
      .eq('verification_status', 'verified')
      .eq('status', 'active')
      .eq('is_active', true)
      .limit(200),
    client
      .from('driver_profiles')
      .select('id, full_name, verification_status')
      .eq('status', 'active')
      .eq('is_active', true)
      .order('full_name', { ascending: true })
      .limit(200),
  ]);

  const vehicles = rows(vehicleResult.data)
    .filter((row) => {
      // RLS already limits this to the caller; the extra filter keeps an organization's vehicle out of a
      // personal trip (and the reverse), which is what `assert_trip_vehicle` checks anyway.
      if (!context.user) return false;
      const ownerUser = str(row.owner_user_id);
      const ownerOrg = str(row.owner_org_id);
      const orgIds = new Set(
        context.organizations
          .filter((organization) => organization.status === 'active')
          .map((organization) => organization.id),
      );
      return ownerUser === context.user.id || (ownerOrg != null && orgIds.has(ownerOrg));
    })
    .map((row) => ({
      id: String(row.id),
      label:
        `${String(row.make ?? '')} ${String(row.model ?? '')} ${String(row.model_year ?? '')}`.trim(),
      plateNumber: String(row.plate_number ?? ''),
      verificationStatus: String(row.verification_status ?? 'unverified'),
      ownerUserId: str(row.owner_user_id),
      ownerOrgId: str(row.owner_org_id),
      status: String(row.status ?? 'active'),
      insuranceExpiry: str(row.insurance_expiry),
      inspectionExpiry: str(row.inspection_expiry),
      registrationExpiry: str(row.registration_expiry),
    }));

  return {
    configured: true,
    governorates: governorateResult,
    vehicles,
    drivers: rows(driverResult.data).map((row) => ({
      id: String(row.id),
      name: String(row.full_name ?? ''),
      verificationStatus: String(row.verification_status ?? 'unverified'),
    })),
  };
}

/** The operator's trips, plus (for staff) the review queue. */
export async function loadTrips(context: AccountContext): Promise<TripsData> {
  const client = await getServerClient();
  if (!client || !context.user)
    return { configured: Boolean(client), trips: [], stops: [], pending: [] };

  const isStaff =
    context.roles.includes('platform_staff') || context.roles.includes('platform_admin');

  const [tripResult, stopResult, governorates, vehicleResult, driverResult, pendingResult] =
    await Promise.all([
      client
        .from('trips')
        .select(TRIP_COLUMNS)
        .order('departure_at', { ascending: false })
        .limit(200),
      client.from('trip_stops').select(STOP_COLUMNS).order('seq', { ascending: true }).limit(1000),
      loadGovernorates(client),
      client.from('vehicles').select('id, make, model, model_year').limit(200),
      client.from('driver_profiles').select('id, full_name').limit(200),
      isStaff
        ? client
            .from('trips')
            .select(TRIP_COLUMNS)
            .eq('verification_status', 'pending')
            .order('created_at', { ascending: true })
            .limit(100)
        : Promise.resolve({ data: [] }),
    ]);

  const index = governorateIndex(governorates);
  const vehicles = new Map(
    rows(vehicleResult.data).map((row) => [
      String(row.id),
      `${String(row.make ?? '')} ${String(row.model ?? '')} ${String(row.model_year ?? '')}`.trim(),
    ]),
  );
  const drivers = new Map(
    rows(driverResult.data).map((row) => [String(row.id), String(row.full_name ?? '')]),
  );

  return {
    configured: true,
    trips: rows(tripResult.data).map((row) => toTripRow(row, index, vehicles, drivers)),
    stops: rows(stopResult.data).map((row) => ({
      id: String(row.id),
      tripId: String(row.trip_id),
      seq: num(row.seq) ?? 0,
      nameAr: str(row.name_ar),
      nameEn: str(row.name_en),
      governorateId: str(row.governorate_id),
      arriveOffsetMinutes: num(row.arrive_offset_minutes) ?? 0,
      priceFromOriginYer: num(row.price_from_origin_yer),
    })),
    pending: rows(pendingResult.data).map((row) => toTripRow(row, index, vehicles, drivers)),
  };
}

/** One trip, with its stops and its audit trail — or null when RLS says it is not the visitor's. */
export async function loadTrip(id: string): Promise<{
  trip: TripRow;
  stops: readonly TripStopRow[];
  events: readonly TripEventRow[];
} | null> {
  const client = await getServerClient();
  if (!client) return null;

  const tripResult = await client.from('trips').select(TRIP_COLUMNS).eq('id', id).maybeSingle();
  const row = tripResult.data as Record<string, unknown> | null;
  if (!row) return null;

  const [stopResult, eventResult, governorates, vehicleResult, driverResult] = await Promise.all([
    client.from('trip_stops').select(STOP_COLUMNS).eq('trip_id', id).order('seq', {
      ascending: true,
    }),
    client
      .from('trip_events')
      .select('id, kind, detail, created_at')
      .eq('trip_id', id)
      .order('created_at', { ascending: false })
      .limit(50),
    loadGovernorates(client),
    client.from('vehicles').select('id, make, model, model_year').limit(200),
    client.from('driver_profiles').select('id, full_name').limit(200),
  ]);

  const vehicles = new Map(
    rows(vehicleResult.data).map((vehicle) => [
      String(vehicle.id),
      `${String(vehicle.make ?? '')} ${String(vehicle.model ?? '')} ${String(vehicle.model_year ?? '')}`.trim(),
    ]),
  );
  const drivers = new Map(
    rows(driverResult.data).map((driver) => [String(driver.id), String(driver.full_name ?? '')]),
  );

  return {
    trip: toTripRow(row, governorateIndex(governorates), vehicles, drivers),
    stops: rows(stopResult.data).map((stop) => ({
      id: String(stop.id),
      tripId: String(stop.trip_id),
      seq: num(stop.seq) ?? 0,
      nameAr: str(stop.name_ar),
      nameEn: str(stop.name_en),
      governorateId: str(stop.governorate_id),
      arriveOffsetMinutes: num(stop.arrive_offset_minutes) ?? 0,
      priceFromOriginYer: num(stop.price_from_origin_yer),
    })),
    events: rows(eventResult.data).map((event) => ({
      id: num(event.id) ?? 0,
      kind: String(event.kind ?? ''),
      detail: (event.detail ?? {}) as Record<string, unknown>,
      createdAt: String(event.created_at ?? ''),
    })),
  };
}

// ---------------------------------------------------------------------------
// The marketplace: two anonymous RPCs, no RLS guesses
// ---------------------------------------------------------------------------

/** A card in the public search results, as `search_public_trips` shapes it. */
export interface PublicTripSummary {
  readonly id: string;
  readonly code: string;
  readonly departureAt: string;
  readonly departureDate: string | null;
  readonly seatsAvailable: number;
  readonly seatsTotal: number;
  readonly priceFromYer: number | null;
  readonly currency: string;
  readonly stopCount: number;
  readonly bookingMode: string;
  readonly pricingMode: string;
  readonly discountKind: string;
  readonly discountValue: number;
  readonly genderPolicy: string;
  readonly isFeatured: boolean;
  readonly operatorName: string | null;
  readonly vehicleLabel: string | null;
  readonly origin: PublicGovernorate;
  readonly destination: PublicGovernorate;
}

export interface PublicGovernorate {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface PublicFacetCount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly count: number;
}

export interface PublicValueFacet {
  readonly value: string;
  readonly count: number;
}

export interface PublicFacets {
  readonly origins: readonly PublicFacetCount[];
  readonly destinations: readonly PublicFacetCount[];
  readonly genders: readonly PublicValueFacet[];
  readonly bookingModes: readonly PublicValueFacet[];
  readonly direct: { readonly direct: number; readonly withStops: number };
}

export interface PublicTripsPage {
  readonly items: readonly PublicTripSummary[];
  readonly total: number;
  readonly facets: PublicFacets;
  readonly nextCursor: string | null;
  readonly cached: boolean;
}

/** A boarding stop, as the public detail returns it — with its own computed fare. */
export interface PublicTripStop {
  readonly seq: number;
  readonly placeId: string | null;
  readonly governorateId: string | null;
  readonly name: string;
  readonly arriveOffsetMinutes: number;
  readonly priceFromOriginYer: number | null;
  readonly fare: PriceBreakdown | null;
}

/** `app.trip_total()` as the RPC returns it. The shape is the pricing contract, not a page's guess. */
export interface PriceBreakdown {
  readonly seats: number;
  readonly currency: string;
  readonly unitFareMinor: number;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
}

/**
 * One published trip.
 *
 * `get_trip_public` is a deliberately *richer* projection than the search card: it carries the stops
 * with their individual fares, the vehicle's amenities and the discount. It carries no owner id, no
 * plate number and no phone number — the type here cannot express what the function never sends.
 */
export interface PublicTripDetail {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly verificationStatus: string;
  readonly departureAt: string;
  readonly departureDate: string | null;
  readonly arriveEstimateMinutes: number;
  readonly seatsTotal: number;
  readonly seatsAvailable: number;
  readonly bookingMode: string;
  readonly pricingMode: string;
  readonly pricePerSeatYer: number | null;
  readonly wholeTripPriceYer: number | null;
  readonly discount: { readonly kind: string; readonly scope: string; readonly value: number };
  readonly genderPolicy: string;
  readonly paymentPolicy: string;
  readonly luggageAllowanceKg: number | null;
  readonly policies: Record<string, unknown>;
  readonly notes: string | null;
  readonly isFeatured: boolean;
  readonly hasDeparted: boolean;
  readonly currency: string;
  readonly operator: {
    readonly name: string | null;
    readonly verified: boolean;
    readonly userId: string | null;
    readonly orgId: string | null;
  } | null;
  readonly vehicle: {
    readonly label: string;
    readonly bodyType: string;
    readonly seatsTotal: number;
    readonly airConditioning: boolean;
    readonly wifi: boolean;
    readonly usbCharging: boolean;
  } | null;
  readonly origin: PublicGovernorate;
  readonly destination: PublicGovernorate;
  readonly stops: readonly PublicTripStop[];
  readonly fare: PriceBreakdown | null;
}

const EMPTY_FACETS: PublicFacets = {
  origins: [],
  destinations: [],
  genders: [],
  bookingModes: [],
  direct: { direct: 0, withStops: 0 },
};

function publicGovernorate(value: unknown): PublicGovernorate {
  const row = (value ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id ?? ''),
    code: String(row.code ?? ''),
    name: String(row.name ?? '—'),
  };
}

function publicSummary(row: Record<string, unknown>): PublicTripSummary {
  return {
    id: String(row.id ?? ''),
    code: String(row.code ?? ''),
    departureAt: String(row.departureAt ?? ''),
    departureDate: str(row.departureDate),
    seatsAvailable: num(row.seatsAvailable) ?? 0,
    seatsTotal: num(row.seatsTotal) ?? 0,
    priceFromYer: num(row.priceFromYer),
    currency: String(row.currency ?? 'YER'),
    stopCount: num(row.stopCount) ?? 0,
    bookingMode: String(row.bookingMode ?? 'per_seat'),
    pricingMode: String(row.pricingMode ?? 'flat'),
    discountKind: String(row.discountKind ?? 'none'),
    discountValue: num(row.discountValue) ?? 0,
    genderPolicy: String(row.genderPolicy ?? 'any'),
    isFeatured: row.isFeatured === true,
    operatorName: str(row.operatorName),
    vehicleLabel: str(row.vehicleLabel),
    origin: publicGovernorate(row.origin),
    destination: publicGovernorate(row.destination),
  };
}

function facetCounts(value: unknown): PublicFacetCount[] {
  return rows(value).map((row) => ({
    id: String(row.id ?? ''),
    code: String(row.code ?? ''),
    name: String(row.name ?? '—'),
    count: num(row.count) ?? 0,
  }));
}

function valueFacets(value: unknown): PublicValueFacet[] {
  return rows(value).map((row) => ({
    value: String(row.value ?? ''),
    count: num(row.count) ?? 0,
  }));
}

/**
 * The marketplace page.
 *
 * Read through `search_public_trips` rather than a table select: the function is the thing that knows
 * about visibility, caching, ranking and keyset pagination, and a second implementation here would be
 * a second set of rules to keep in step. A visitor with no session is `anon`, which is exactly the role
 * the function is granted to.
 */
export async function loadPublicTrips(
  locale: string,
  filters: TripFilters,
  options: {
    sort?: 'soonest' | 'cheapest' | 'featured';
    cursor?: string | null;
    limit?: number;
  } = {},
): Promise<PublicTripsPage> {
  const client = await getServerClient();
  if (!client) {
    return { items: [], total: 0, facets: EMPTY_FACETS, nextCursor: null, cached: false };
  }

  const { fn, args } = publicTripsArgs(locale, filters, options);
  const result = await client.rpc(fn, args as never);
  const payload = (result.data ?? {}) as Record<string, unknown>;
  if (result.error) {
    return { items: [], total: 0, facets: EMPTY_FACETS, nextCursor: null, cached: false };
  }

  const facets = (payload.facets ?? {}) as Record<string, unknown>;
  const direct = (facets.direct ?? {}) as Record<string, unknown>;
  return {
    items: rows(payload.items).map(publicSummary),
    total: num(payload.total) ?? 0,
    facets: {
      origins: facetCounts(facets.origins),
      destinations: facetCounts(facets.destinations),
      genders: valueFacets(facets.genders),
      bookingModes: valueFacets(facets.bookingModes),
      direct: { direct: num(direct.direct) ?? 0, withStops: num(direct.withStops) ?? 0 },
    },
    nextCursor: str(payload.nextCursor),
    cached: payload.cached === true,
  };
}

/**
 * One published trip by its short code, or null when it is not (or no longer) public.
 *
 * `null` is a normal answer, not an error: a link to a withdrawn trip has to render the not-found state
 * rather than a stale price.
 */
export async function loadPublicTrip(
  code: string,
  locale: string,
): Promise<PublicTripDetail | null> {
  const client = await getServerClient();
  if (!client) return null;

  const { fn, args } = publicTripArgs(code, locale);
  const result = await client.rpc(fn, args as never);
  if (result.error) return null;
  const payload = result.data as Record<string, unknown> | null;
  if (!payload) return null;

  const discount = (payload.discount ?? {}) as Record<string, unknown>;
  const operatorRow = (payload.operator ?? null) as Record<string, unknown> | null;
  const vehicleRow = (payload.vehicle ?? null) as Record<string, unknown> | null;
  const breakdown = (value: unknown): PriceBreakdown | null => {
    const row = (value ?? null) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      seats: num(row.seats) ?? 0,
      currency: String(row.currency ?? 'YER'),
      unitFareMinor: num(row.unitFareMinor) ?? 0,
      subtotalMinor: num(row.subtotalMinor) ?? 0,
      discountMinor: num(row.discountMinor) ?? 0,
      totalMinor: num(row.totalMinor) ?? 0,
    };
  };

  return {
    id: String(payload.id ?? ''),
    code: String(payload.code ?? code),
    status: String(payload.status ?? 'published'),
    verificationStatus: String(payload.verificationStatus ?? 'unverified'),
    departureAt: String(payload.departureAt ?? ''),
    departureDate: str(payload.departureDate),
    arriveEstimateMinutes: num(payload.arriveEstimateMinutes) ?? 0,
    seatsTotal: num(payload.seatsTotal) ?? 0,
    seatsAvailable: num(payload.seatsAvailable) ?? 0,
    bookingMode: String(payload.bookingMode ?? 'per_seat'),
    pricingMode: String(payload.pricingMode ?? 'flat'),
    pricePerSeatYer: num(payload.pricePerSeatYer),
    wholeTripPriceYer: num(payload.wholeTripPriceYer),
    discount: {
      kind: String(discount.kind ?? 'none'),
      scope: String(discount.scope ?? 'all'),
      value: num(discount.value) ?? 0,
    },
    genderPolicy: String(payload.genderPolicy ?? 'any'),
    paymentPolicy: String(payload.paymentPolicy ?? 'cash'),
    luggageAllowanceKg: num(payload.luggageAllowanceKg),
    policies: (payload.policies ?? {}) as Record<string, unknown>,
    notes: str(payload.notes),
    isFeatured: payload.isFeatured === true,
    hasDeparted: payload.hasDeparted === true,
    currency: String((breakdown(payload.fare)?.currency ?? 'YER') as string),
    operator: operatorRow
      ? {
          name: str(operatorRow.name),
          verified: operatorRow.verified === true,
          userId: str(operatorRow.userId),
          orgId: str(operatorRow.orgId),
        }
      : null,
    vehicle: vehicleRow
      ? {
          label: String(vehicleRow.label ?? '—'),
          bodyType: String(vehicleRow.bodyType ?? ''),
          seatsTotal: num(vehicleRow.seatsTotal) ?? 0,
          airConditioning: vehicleRow.airConditioning === true,
          wifi: vehicleRow.wifi === true,
          usbCharging: vehicleRow.usbCharging === true,
        }
      : null,
    origin: publicGovernorate(payload.origin),
    destination: publicGovernorate(payload.destination),
    stops: rows(payload.stops).map((row) => ({
      seq: num(row.seq) ?? 0,
      placeId: str(row.placeId),
      governorateId: str(row.governorateId),
      name: String(row.name ?? '—'),
      arriveOffsetMinutes: num(row.arriveOffsetMinutes) ?? 0,
      priceFromOriginYer: num(row.priceFromOriginYer),
      fare: breakdown(row.fare),
    })),
    fare: breakdown(payload.fare),
  };
}

// ---------------------------------------------------------------------------
// Staff search: every trip, including the ones the marketplace hides
// ---------------------------------------------------------------------------

/** A row from `staff_search_trips` — a fleet-wide view with the operator named. */
export interface StaffTripRow {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly verificationStatus: string;
  readonly departureAt: string;
  readonly seatsAvailable: number;
  readonly seatsTotal: number;
  readonly priceFromYer: number | null;
  readonly operatorName: string | null;
  readonly cancelReason: string | null;
  /** Governorate *names*, not ids: this read is for a human scanning a table. */
  readonly origin: string;
  readonly destination: string;
  /** Phase 7: the ids are what the history filter round-trips, the names are what the table shows. */
  readonly originId: string | null;
  readonly destinationId: string | null;
  readonly qrToken: string | null;
}

/**
 * Staff trip search.
 *
 * `staff_search_trips` is `security definer` and raises `42501` for anyone who is not staff, so the
 * RPC is the permission check as well as the query — the page does not have to be trusted, and a
 * customer who guesses the URL gets an empty result rather than other people's drafts.
 */
export async function loadStaffTrips(
  actorId: string,
  filters: {
    status?: readonly string[];
    verificationStatus?: readonly string[];
    q?: string;
    from?: string;
    to?: string;
    governorateId?: string;
  },
): Promise<{ configured: boolean; items: readonly StaffTripRow[]; error?: string }> {
  const client = await getServerClient();
  if (!client) return { configured: false, items: [] };

  const { fn, args } = staffTripsArgs(
    actorId,
    {
      status: filters.status?.length
        ? (filters.status as ('draft' | 'pending' | 'published' | 'cancelled' | 'completed')[])
        : undefined,
      verificationStatus: filters.verificationStatus?.length
        ? (filters.verificationStatus as ('unverified' | 'pending' | 'verified' | 'rejected')[])
        : undefined,
      q: filters.q,
      from: filters.from,
      to: filters.to,
      governorateId: filters.governorateId,
    },
    50,
  );

  const result = await client.rpc(fn, args as never);
  if (result.error) {
    return { configured: true, items: [], error: result.error.message };
  }

  const payload = (result.data ?? {}) as Record<string, unknown>;
  return {
    configured: true,
    items: rows(payload.items).map((row) => ({
      id: String(row.id ?? ''),
      code: String(row.code ?? ''),
      status: String(row.status ?? 'draft'),
      verificationStatus: String(row.verificationStatus ?? 'unverified'),
      departureAt: String(row.departureAt ?? ''),
      seatsAvailable: num(row.seatsAvailable) ?? 0,
      seatsTotal: num(row.seatsTotal) ?? 0,
      priceFromYer: num(row.priceFromYer),
      operatorName: str(row.operatorName),
      cancelReason: str(row.cancelReason),
      origin: String(row.origin ?? '—'),
      destination: String(row.destination ?? '—'),
      originId: str(row.originId),
      destinationId: str(row.destinationId),
      qrToken: str(row.qrToken),
    })),
  };
}
