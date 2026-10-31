import {
  publicTripArgs,
  publicTripsArgs,
  tripPriceFrom,
  type TripFilters,
  type TripFilterState,
} from '@maak/core';
import { getMobileClient } from './supabase';

/**
 * Trips on native.
 *
 * The reads are the *same two RPCs* the web marketplace uses (`search_public_trips`, `get_trip_public`),
 * called with the *same* argument builder from `@maak/core`. That matters more on mobile than anywhere
 * else: a filter that means something different in the app than on the web is a bug nobody notices until
 * a passenger screenshots two different result sets.
 *
 * Without a configured Supabase project the screens fall back to a small fixture set, so the UI is
 * reviewable offline — the same rule the place picker follows.
 */

export interface MobileGovernorate {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface MobileTripCard {
  readonly id: string;
  readonly code: string;
  readonly departureAt: string;
  readonly seatsAvailable: number;
  readonly seatsTotal: number;
  readonly priceFromYer: number | null;
  readonly stopCount: number;
  readonly bookingMode: string;
  readonly genderPolicy: string;
  readonly isFeatured: boolean;
  readonly operatorName: string | null;
  readonly vehicleLabel: string | null;
  readonly origin: MobileGovernorate;
  readonly destination: MobileGovernorate;
}

export interface MobileFacet {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly count: number;
}

export interface MobileTripsResult {
  readonly configured: boolean;
  readonly items: readonly MobileTripCard[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly origins: readonly MobileFacet[];
  readonly destinations: readonly MobileFacet[];
}

export interface MobileTripStop {
  readonly seq: number;
  readonly name: string;
  readonly arriveOffsetMinutes: number;
  readonly priceFromOriginYer: number | null;
}

export interface MobileTripDetail {
  readonly code: string;
  readonly departureAt: string;
  readonly seatsAvailable: number;
  readonly seatsTotal: number;
  readonly bookingMode: string;
  readonly pricingMode: string;
  readonly genderPolicy: string;
  readonly paymentPolicy: string;
  readonly notes: string | null;
  readonly arriveEstimateMinutes: number;
  readonly pricePerSeatYer: number | null;
  readonly wholeTripPriceYer: number | null;
  readonly fareTotalMinor: number | null;
  readonly operatorName: string | null;
  readonly operatorVerified: boolean;
  readonly vehicleLabel: string | null;
  readonly origin: MobileGovernorate;
  readonly destination: MobileGovernorate;
  readonly stops: readonly MobileTripStop[];
}

const num = (value: unknown): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

function governorate(value: unknown): MobileGovernorate {
  const row = (value ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id ?? ''),
    code: String(row.code ?? ''),
    name: String(row.name ?? '—'),
  };
}

const FALLBACK_CARDS: readonly MobileTripCard[] = [
  {
    id: 'fallback-1',
    code: 'SA-AD-0001',
    departureAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    seatsAvailable: 7,
    seatsTotal: 12,
    priceFromYer: 10_000,
    stopCount: 2,
    bookingMode: 'per_seat',
    genderPolicy: 'any',
    isFeatured: false,
    operatorName: 'نقل عدن',
    vehicleLabel: 'Toyota Hiace 2019',
    origin: { id: 'g-sanaa', code: 'YE-SA', name: 'صنعاء' },
    destination: { id: 'g-aden', code: 'YE-AD', name: 'عدن' },
  },
  {
    id: 'fallback-2',
    code: 'AD-TZ-0002',
    departureAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    seatsAvailable: 2,
    seatsTotal: 12,
    priceFromYer: 6_000,
    stopCount: 0,
    bookingMode: 'per_seat',
    genderPolicy: 'women_only',
    isFeatured: true,
    operatorName: 'رحلات تعز',
    vehicleLabel: 'Hyundai Starex 2018',
    origin: { id: 'g-aden', code: 'YE-AD', name: 'عدن' },
    destination: { id: 'g-taiz', code: 'YE-TZ', name: 'تعز' },
  },
];

/** Maps the URL-shaped filter state the web uses onto the RPC's filter object. */
export function filtersFromState(state: TripFilterState): TripFilters {
  return {
    q: state.q,
    origin: state.origin,
    destination: state.destination,
    gender: state.gender as TripFilters['gender'],
    booking: state.booking as TripFilters['booking'],
    direct: state.direct,
    priceMax: state.priceMax,
    dateFrom: state.dateFrom,
    dateTo: state.dateTo,
  };
}

export async function searchTrips(
  locale: string,
  filters: TripFilters,
  options: {
    sort?: 'soonest' | 'cheapest' | 'featured';
    cursor?: string | null;
    limit?: number;
  } = {},
): Promise<MobileTripsResult> {
  const client = getMobileClient();
  if (!client) {
    return {
      configured: false,
      items: FALLBACK_CARDS,
      total: FALLBACK_CARDS.length,
      nextCursor: null,
      origins: [],
      destinations: [],
    };
  }

  const { fn, args } = publicTripsArgs(locale, filters, options);
  const { data, error } = await client.rpc(fn as never, args as never);
  if (error || !data) {
    return {
      configured: true,
      items: [],
      total: 0,
      nextCursor: null,
      origins: [],
      destinations: [],
    };
  }

  const payload = data as Record<string, unknown>;
  const facets = (payload.facets ?? {}) as Record<string, unknown>;
  const facetList = (value: unknown): MobileFacet[] =>
    Array.isArray(value)
      ? (value as Record<string, unknown>[]).map((row) => ({
          id: String(row.id ?? ''),
          code: String(row.code ?? ''),
          name: String(row.name ?? '—'),
          count: num(row.count) ?? 0,
        }))
      : [];

  const items = Array.isArray(payload.items)
    ? (payload.items as Record<string, unknown>[]).map((row) => ({
        id: String(row.id ?? ''),
        code: String(row.code ?? ''),
        departureAt: String(row.departureAt ?? ''),
        seatsAvailable: num(row.seatsAvailable) ?? 0,
        seatsTotal: num(row.seatsTotal) ?? 0,
        priceFromYer: num(row.priceFromYer),
        stopCount: num(row.stopCount) ?? 0,
        bookingMode: String(row.bookingMode ?? 'per_seat'),
        genderPolicy: String(row.genderPolicy ?? 'any'),
        isFeatured: row.isFeatured === true,
        operatorName: str(row.operatorName),
        vehicleLabel: str(row.vehicleLabel),
        origin: governorate(row.origin),
        destination: governorate(row.destination),
      }))
    : [];

  return {
    configured: true,
    items,
    total: num(payload.total) ?? items.length,
    nextCursor: str(payload.nextCursor),
    origins: facetList(facets.origins),
    destinations: facetList(facets.destinations),
  };
}

export const FALLBACK_DETAIL: MobileTripDetail = {
  code: 'SA-AD-0001',
  departureAt: FALLBACK_CARDS[0]!.departureAt,
  seatsAvailable: 7,
  seatsTotal: 12,
  bookingMode: 'per_seat',
  pricingMode: 'per_stop',
  genderPolicy: 'any',
  paymentPolicy: 'cash',
  notes: null,
  arriveEstimateMinutes: 480,
  pricePerSeatYer: 10_000,
  wholeTripPriceYer: null,
  fareTotalMinor: 9_000,
  operatorName: 'نقل عدن',
  operatorVerified: true,
  vehicleLabel: 'Toyota Hiace 2019',
  origin: FALLBACK_CARDS[0]!.origin,
  destination: FALLBACK_CARDS[0]!.destination,
  stops: [
    { seq: 1, name: 'تعز', arriveOffsetMinutes: 180, priceFromOriginYer: 6_000 },
    { seq: 2, name: 'عدن', arriveOffsetMinutes: 480, priceFromOriginYer: 9_000 },
  ],
};

export async function getTripDetail(
  code: string,
  locale: string,
): Promise<{ configured: boolean; trip: MobileTripDetail | null }> {
  const client = getMobileClient();
  if (!client) {
    return { configured: false, trip: FALLBACK_DETAIL };
  }

  const { fn, args } = publicTripArgs(code, locale);
  const { data, error } = await client.rpc(fn as never, args as never);
  if (error || !data) return { configured: true, trip: null };

  const payload = data as Record<string, unknown>;
  const operator = (payload.operator ?? null) as Record<string, unknown> | null;
  const vehicle = (payload.vehicle ?? null) as Record<string, unknown> | null;
  const fare = (payload.fare ?? null) as Record<string, unknown> | null;

  return {
    configured: true,
    trip: {
      code: String(payload.code ?? code),
      departureAt: String(payload.departureAt ?? ''),
      seatsAvailable: num(payload.seatsAvailable) ?? 0,
      seatsTotal: num(payload.seatsTotal) ?? 0,
      bookingMode: String(payload.bookingMode ?? 'per_seat'),
      pricingMode: String(payload.pricingMode ?? 'flat'),
      genderPolicy: String(payload.genderPolicy ?? 'any'),
      paymentPolicy: String(payload.paymentPolicy ?? 'cash'),
      notes: str(payload.notes),
      arriveEstimateMinutes: num(payload.arriveEstimateMinutes) ?? 0,
      pricePerSeatYer: num(payload.pricePerSeatYer),
      wholeTripPriceYer: num(payload.wholeTripPriceYer),
      fareTotalMinor: fare ? num(fare.totalMinor) : null,
      operatorName: operator ? str(operator.name) : null,
      operatorVerified: operator?.verified === true,
      vehicleLabel: vehicle ? str(vehicle.label) : null,
      origin: governorate(payload.origin),
      destination: governorate(payload.destination),
      stops: Array.isArray(payload.stops)
        ? (payload.stops as Record<string, unknown>[]).map((row) => ({
            seq: num(row.seq) ?? 0,
            name: String(row.name ?? '—'),
            arriveOffsetMinutes: num(row.arriveOffsetMinutes) ?? 0,
            priceFromOriginYer: num(row.priceFromOriginYer),
          }))
        : [],
    },
  };
}

/** The cheapest seat a card can advertise — the same rule the web card uses. */
export function cardPrice(card: MobileTripCard): number | null {
  return tripPriceFrom(
    {
      bookingMode: card.bookingMode,
      pricingMode: 'flat',
      pricePerSeatYer: card.priceFromYer,
      wholeTripPriceYer: card.priceFromYer,
    },
    [],
  );
}
