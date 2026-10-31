/**
 * Trip presentation rules — pure, shared by the web console, the marketplace and the mobile app.
 *
 * The database owns the *rules* (a trip is editable until two hours before departure, a draft is not
 * public). This module owns the *wording*: which badge a trip carries, how a departure reads in Aden
 * time, and how the marketplace encodes its filters in a URL. Every helper here is total and
 * side-effect free, so it can be unit-tested and used in a server component.
 */

import { translate, type TranslationKey } from '../i18n/dictionaries';
import type { Locale } from '../i18n/locale';

export type TripStatus = 'draft' | 'pending' | 'published' | 'cancelled' | 'completed';
export type TripVerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected';

/** The row facts a badge needs; deliberately structural, so both web and mobile fit it. */
export interface TripLike {
  readonly status: TripStatus | string;
  readonly verificationStatus?: TripVerificationStatus | string | null;
  readonly departureAt: string;
  readonly seatsAvailable?: number | null;
  readonly seatsTotal?: number | null;
  readonly featuredUntil?: string | null;
  readonly cancelledAt?: string | null;
}

export interface TripBadge {
  readonly code: string;
  readonly tone: 'ok' | 'warn' | 'bad' | 'neutral';
  readonly labelKey: TranslationKey;
}

/**
 * The two-hour edit lock (BR-06), mirrored so a form can disable itself before a round trip.
 *
 * The authority is `app.assert_trip_editable()` in the database: this only saves the user from
 * filling a wizard that will be refused. If the two ever disagree, the database wins.
 */
export const TRIP_EDIT_WINDOW_HOURS = 2;

export function isTripEditable(
  trip: Pick<TripLike, 'status' | 'departureAt'>,
  now = new Date(),
): boolean {
  if (trip.status === 'cancelled' || trip.status === 'completed') return false;
  const departure = Date.parse(trip.departureAt);
  if (Number.isNaN(departure)) return false;
  return departure - now.getTime() > TRIP_EDIT_WINDOW_HOURS * 3_600_000;
}

export const TRIP_STATUS_KEY: Record<string, TranslationKey> = {
  draft: 'trips.status.draft',
  pending: 'trips.status.pending',
  published: 'trips.status.published',
  cancelled: 'trips.status.cancelled',
  completed: 'trips.status.completed',
};

export const TRIP_VERIFICATION_KEY: Record<string, TranslationKey> = {
  unverified: 'trips.verification.unverified',
  pending: 'trips.verification.pending',
  verified: 'trips.verification.verified',
  rejected: 'trips.verification.rejected',
};

export const TRIP_BOOKING_KEY: Record<string, TranslationKey> = {
  per_seat: 'trips.booking.per_seat',
  whole_trip: 'trips.booking.whole_trip',
  both: 'trips.booking.both',
};

export const TRIP_PRICING_KEY: Record<string, TranslationKey> = {
  flat: 'trips.pricing.flat',
  per_stop: 'trips.pricing.per_stop',
};

export const TRIP_DISCOUNT_KIND_KEY: Record<string, TranslationKey> = {
  none: 'trips.discountKind.none',
  fixed: 'trips.discountKind.fixed',
  percent: 'trips.discountKind.percent',
};

export const TRIP_DISCOUNT_SCOPE_KEY: Record<string, TranslationKey> = {
  all: 'trips.discountScope.all',
  per_seat: 'trips.discountScope.per_seat',
  whole_trip: 'trips.discountScope.whole_trip',
};

export const TRIP_GENDER_KEY: Record<string, TranslationKey> = {
  any: 'trips.gender.any',
  women_only: 'trips.gender.women_only',
  men_only: 'trips.gender.men_only',
};

export const TRIP_PAYMENT_KEY: Record<string, TranslationKey> = {
  cash: 'trips.payment.cash',
  transfer: 'trips.payment.transfer',
  deposit: 'trips.payment.deposit',
};

export function tripStatusKey(status: string): TranslationKey {
  return TRIP_STATUS_KEY[status] ?? 'trips.status.draft';
}

export function tripVerificationKey(status: string | null | undefined): TranslationKey {
  return TRIP_VERIFICATION_KEY[status ?? 'unverified'] ?? 'trips.verification.unverified';
}

/**
 * The badges a trip card carries, in the order they matter: a cancelled trip says so first, then the
 * verification state, then the marketing facts (featured, last seats).
 */
export function tripBadges(trip: TripLike, now = new Date()): TripBadge[] {
  const badges: TripBadge[] = [];
  const verification = trip.verificationStatus ?? 'unverified';

  badges.push({
    code: String(trip.status),
    tone:
      trip.status === 'cancelled'
        ? 'bad'
        : trip.status === 'published'
          ? 'ok'
          : trip.status === 'pending'
            ? 'warn'
            : 'neutral',
    labelKey: tripStatusKey(String(trip.status)),
  });

  if (verification === 'verified') {
    badges.push({ code: 'verified', tone: 'ok', labelKey: 'trips.verification.verified' });
  } else if (verification === 'pending') {
    badges.push({ code: 'review', tone: 'warn', labelKey: 'trips.verification.pending' });
  } else if (verification === 'rejected') {
    badges.push({ code: 'rejected', tone: 'bad', labelKey: 'trips.verification.rejected' });
  }

  const featuredUntil = trip.featuredUntil ? Date.parse(trip.featuredUntil) : Number.NaN;
  if (Number.isFinite(featuredUntil) && featuredUntil > now.getTime()) {
    badges.push({ code: 'featured', tone: 'ok', labelKey: 'trips.badgeFeatured' });
  }

  const available = trip.seatsAvailable;
  if (
    trip.status === 'published' &&
    typeof available === 'number' &&
    available > 0 &&
    available <= 2
  ) {
    badges.push({ code: 'lastSeats', tone: 'warn', labelKey: 'trips.badgeLastSeats' });
  }

  return badges;
}

/**
 * A departure, in the timezone the operator and the passenger actually live in.
 *
 * `Asia/Aden` is UTC+03:00 with no daylight saving, but that must be stated rather than assumed: a
 * server in another region formatting a trip time is how a 16:00 departure becomes 13:00 on screen.
 * The date and the time are returned separately, because the card needs them in different weights and
 * the detail page needs them in one line.
 */
export function departureLabel(iso: string, locale: Locale): { date: string; time: string } {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return { date: '—', time: '—' };
  const tag = locale === 'ar' ? 'ar-YE' : 'en-GB';
  const date = new Intl.DateTimeFormat(tag, {
    timeZone: 'Asia/Aden',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    numberingSystem: locale === 'ar' ? 'latn' : undefined,
  }).format(parsed);
  const time = new Intl.DateTimeFormat(tag, {
    timeZone: 'Asia/Aden',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    numberingSystem: locale === 'ar' ? 'latn' : undefined,
  }).format(parsed);
  return { date, time };
}

/**
 * Yemen is UTC+03:00 all year — there is no daylight saving to get wrong — but the *server* may be in
 * any zone at all, and `<input type="datetime-local">` submits a bare `2026-05-04T14:30` with no offset.
 * Sent as-is, Postgres reads it in the server's zone: on a UTC database a 14:30 departure becomes 17:30
 * in Aden, three hours late. These two functions are the only place that conversion happens.
 */
export const ADEN_OFFSET_MINUTES = 180;

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/** `2026-05-04T14:30` (Aden wall clock) → `2026-05-04T11:30:00.000Z`. */
export function adenLocalToIso(value: string): string | null {
  const match = LOCAL_PATTERN.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  if (Number.isNaN(utc)) return null;
  return new Date(utc - ADEN_OFFSET_MINUTES * 60_000).toISOString();
}

/** The inverse: an ISO timestamp → the `datetime-local` value the form should show. */
export function isoToAdenLocal(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  const shifted = new Date(parsed.getTime() + ADEN_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 16);
}

/**
 * The marketplace filter ↔ URL mapping.
 *
 * The filters live in the URL so a search is shareable and the back button works; that only holds if
 * the encoding is stable, which is why it lives here and is unit-tested rather than being inlined in a
 * page. Keys are the SQL keys, so nothing has to be translated twice.
 */
export interface TripFilterState {
  q?: string;
  origin?: string[];
  destination?: string[];
  gender?: string[];
  booking?: string[];
  direct?: boolean;
  priceMax?: number;
  dateFrom?: string;
  dateTo?: string;
  sort?: 'soonest' | 'cheapest' | 'featured';
}

const listKeys = ['origin', 'destination', 'gender', 'booking'] as const;

export function readTripFilters(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
): TripFilterState {
  const get = (key: string): string[] => {
    if (params instanceof URLSearchParams) return params.getAll(key).flatMap((v) => v.split(','));
    const value = params[key];
    if (value == null) return [];
    return (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(','));
  };

  const state: TripFilterState = {};
  const q = get('q').join(' ').trim();
  if (q) state.q = q;

  for (const key of listKeys) {
    const values = get(key).filter(Boolean);
    if (values.length > 0) state[key] = values;
  }

  if (get('direct').includes('1') || get('direct').includes('true')) state.direct = true;
  const priceMax = Number(get('priceMax')[0]);
  if (Number.isFinite(priceMax) && priceMax > 0) state.priceMax = priceMax;
  const from = get('dateFrom')[0];
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) state.dateFrom = from;
  const to = get('dateTo')[0];
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) state.dateTo = to;
  const sort = get('sort')[0];
  if (sort === 'cheapest' || sort === 'featured' || sort === 'soonest') state.sort = sort;
  return state;
}

export function tripFilterQuery(state: TripFilterState): string {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  for (const key of listKeys) {
    const values = state[key];
    if (values && values.length > 0) params.set(key, values.join(','));
  }
  if (state.direct) params.set('direct', '1');
  if (state.priceMax != null) params.set('priceMax', String(state.priceMax));
  if (state.dateFrom) params.set('dateFrom', state.dateFrom);
  if (state.dateTo) params.set('dateTo', state.dateTo);
  if (state.sort && state.sort !== 'soonest') params.set('sort', state.sort);
  return params.toString();
}

/** How many filters are active — the badge on the mobile filter button, and the "clear" affordance. */
export function activeFilterCount(state: TripFilterState): number {
  let count = 0;
  if (state.q) count += 1;
  for (const key of listKeys) count += state[key]?.length ?? 0;
  if (state.direct) count += 1;
  if (state.priceMax != null) count += 1;
  if (state.dateFrom) count += 1;
  if (state.dateTo) count += 1;
  return count;
}

/**
 * Keys we can name in Arabic and English. `trips.policies` is free-form operator JSON — there is no
 * schema to validate against — so this is a courtesy, not a contract: a key we do not know is shown
 * exactly as the operator wrote it, because inventing a translation for an unknown key is a lie.
 */
const POLICY_LABELS: Record<string, TranslationKey> = {
  luggage: 'trips.policy.luggage',
  smoking: 'trips.policy.smoking',
  women_only: 'trips.policy.womenOnly',
  pets: 'trips.policy.pets',
  cancellation: 'trips.policy.cancellation',
};

function humanisePolicyKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The policy block on the trip page: printable label/value pairs, in the operator's own words.
 *
 * Nested objects are dropped rather than stringified — `[object Object]` in a public page is worse than
 * a missing row — and flags read as yes/no instead of `true`/`false`.
 */
export function describePolicies(
  policies: Readonly<Record<string, unknown>> | null | undefined,
  locale: Locale,
): [string, string][] {
  if (!policies) return [];

  return Object.entries(policies).flatMap(([key, value]): [string, string][] => {
    const label = POLICY_LABELS[key]
      ? translate(locale, POLICY_LABELS[key])
      : humanisePolicyKey(key);
    if (typeof value === 'boolean')
      return [[label, translate(locale, value ? 'fleet.yes' : 'fleet.no')]];
    if (typeof value === 'number') return [[label, String(value)]];
    if (typeof value === 'string' && value.trim() !== '') return [[label, value]];
    return [];
  });
}

/**
 * Re-serialise a page's query for a link that must not drop it — the language switcher, a sort link, the
 * "next page" affordance. Returns `''` or a string that already starts with `?`.
 *
 * `drop` removes keys that belong to one rendering only: `st` is a session token in development, and
 * carrying it into a link would hand the visitor's session to the next page's history entry. Unknown keys
 * are kept on purpose — dropping one silently is how a filter nobody thought of disappears on a locale
 * switch.
 */
export function searchSuffix(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
  drop: readonly string[] = [],
): string {
  const serialised = new URLSearchParams();
  const append = (key: string, value: string | null | undefined) => {
    if (!value || drop.includes(key)) return;
    serialised.append(key, value);
  };

  if (params instanceof URLSearchParams) {
    for (const key of new Set(params.keys())) {
      for (const value of params.getAll(key)) append(key, value);
    }
  } else {
    for (const [key, value] of Object.entries(params)) {
      for (const item of Array.isArray(value) ? value : [value]) append(key, item);
    }
  }

  return serialised.size > 0 ? `?${serialised.toString()}` : '';
}

/**
 * The cheapest fare a card can advertise — the TypeScript side of `app.trip_price_from()`.
 *
 * A per-stop trip has no flat fare, so reading `pricePerSeatYer` for the card would show "—" for a
 * bookable trip (and an operator would report it as a bug). Whole-trip bookings advertise the whole
 * price; per-stop trips advertise their cheapest stop, falling back to the flat fare for a stop that has
 * no price of its own — which is exactly the `coalesce` in the SQL.
 *
 * It lives in the domain package, not the web app, because the mobile client needs the same answer and
 * because a *client* component cannot import the server-only trip reader that used to own it.
 */
export function tripPriceFrom(
  trip: {
    readonly bookingMode: string;
    readonly pricingMode: string;
    readonly pricePerSeatYer: number | null;
    readonly wholeTripPriceYer: number | null;
  },
  stops: readonly { readonly priceFromOriginYer: number | null }[] = [],
): number | null {
  if (trip.bookingMode === 'whole_trip') return trip.wholeTripPriceYer;
  if (trip.pricingMode === 'per_stop') {
    const prices = stops
      .map((stop) => stop.priceFromOriginYer ?? trip.pricePerSeatYer)
      .filter((price): price is number => typeof price === 'number');
    if (prices.length > 0) return Math.min(...prices);
  }
  return trip.pricePerSeatYer;
}
