/**
 * Trips — the shared contract between the wizard, the edge function and the tests (Phase 4).
 *
 * One edge function (`trips`) dispatches on `action`; every write branch maps to exactly one `cmd_*`
 * in migration 00014, so a request is one call and one transaction. The public marketplace is read
 * through two RPCs (`search_public_trips`, `get_trip_public`) that are granted to `anon`, because a
 * visitor has to be able to find a trip before they have an account — those live here too, so the web
 * and the mobile app ask the same questions.
 *
 * `jsonb` arguments are serialized here, not by the transport: node-postgres turns a JavaScript array
 * into a Postgres array literal (`{...}`), which is not JSON, and passing one as `p_stops` fails with
 * `22P02`. One place serializes, so the Deno gateway and the dev gateway cannot disagree.
 */

import { z } from 'zod';

import { translate, type TranslationKey } from '../i18n/dictionaries';
import type { Locale } from '../i18n/locale';

const uuid = z.string().uuid();

/** `''` is what an empty `<input type="date">` submits; it must mean "not set", not "bad format". */
const optionalDate = z
  .union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')])
  .nullish()
  .transform((value) => (value === '' || value == null ? null : value));

/**
 * A timestamp from the wizard. `datetime-local` submits `2026-05-04T14:30`, which `Date.parse` accepts
 * as local time; anything `Date.parse` rejects is a bug in the form, so it is caught here rather than
 * arriving at the database as `22023`.
 */
const timestamp = z
  .string()
  .min(10)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'expected a date and a time');

export const tripBookingModeSchema = z.enum(['per_seat', 'whole_trip', 'both']);
export const tripPricingModeSchema = z.enum(['flat', 'per_stop']);
export const tripDiscountKindSchema = z.enum(['none', 'fixed', 'percent']);
export const tripDiscountScopeSchema = z.enum(['per_seat', 'whole_trip', 'all']);
export const tripGenderPolicySchema = z.enum(['any', 'women_only', 'men_only']);
export const tripPaymentPolicySchema = z.enum(['cash', 'transfer', 'deposit']);
export const tripSortSchema = z.enum(['soonest', 'cheapest', 'featured']);

/**
 * A stop as the wizard sends it.
 *
 * Either a place from the gazetteer (`placeId`) or a free-text name — a village that is not yet in the
 * map is still a stop. The offset is the elapsed minutes from departure, which is what the driver
 * thinks in; the database converts it to an arrival time.
 */
export const tripStopInputSchema = z.object({
  placeId: uuid.nullish(),
  governorateId: uuid.nullish(),
  nameAr: z.string().trim().max(160).nullish(),
  nameEn: z.string().trim().max(160).nullish(),
  arriveOffsetMinutes: z.number().int().min(0).max(4320),
  priceFromOriginYer: z.number().int().min(0).max(10_000_000).nullish(),
});

export type TripStopInput = z.infer<typeof tripStopInputSchema>;

/**
 * The whole trip, as the wizard submits it.
 *
 * The SQL re-validates every field (`app.assert_trip_payload`); this schema exists so a typo is a 422
 * with a field name instead of a 500 from Postgres, and so the same rules are available to the client
 * before a round trip.
 */
export const tripInputSchema = z.object({
  vehicleId: uuid,
  /** Optional: a trip may be published before a driver has accepted the invitation. */
  driverId: uuid.nullish(),
  originGovernorateId: uuid,
  destinationGovernorateId: uuid,
  departureAt: timestamp,
  arriveEstimateMinutes: z.number().int().min(0).max(4320).default(0),
  seatsTotal: z.number().int().min(1).max(60),
  bookingMode: tripBookingModeSchema.default('per_seat'),
  pricingMode: tripPricingModeSchema.default('flat'),
  pricePerSeatYer: z.number().int().min(0).max(10_000_000).nullish(),
  wholeTripPriceYer: z.number().int().min(0).max(100_000_000).nullish(),
  discountKind: tripDiscountKindSchema.default('none'),
  /** Basis points for a percentage (1000 = 10%), riyal for a fixed amount. */
  discountValue: z.number().int().min(0).max(10_000_000).default(0),
  discountScope: tripDiscountScopeSchema.default('all'),
  genderPolicy: tripGenderPolicySchema.default('any'),
  paymentPolicy: tripPaymentPolicySchema.default('cash'),
  luggageAllowanceKg: z.number().int().min(0).max(500).nullish(),
  policies: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().trim().max(2000).nullish(),
  stops: z.array(tripStopInputSchema).max(10).optional(),
});

export type TripInput = z.infer<typeof tripInputSchema>;

/**
 * Cross-field rules, mirroring `app.assert_trip_payload()` — the ones a person can actually fix in the
 * form. They are duplicated on purpose: the database is the authority, and the form should not need a
 * round trip to say "you cannot leave from the place you are going to".
 */
export function tripFieldErrors(
  input: TripInput,
  locale: Locale = 'ar',
  now = new Date(),
): Record<string, string> {
  const t = (key: TranslationKey) => translate(locale, key);
  const errors: Record<string, string> = {};

  if (input.originGovernorateId === input.destinationGovernorateId) {
    errors.destinationGovernorateId = t('trips.sameRoute');
  }

  const departure = Date.parse(input.departureAt);
  if (Number.isNaN(departure) || departure <= now.getTime()) {
    errors.departureAt = t('trips.departureInPast');
  }

  if (input.bookingMode === 'whole_trip') {
    if (input.wholeTripPriceYer == null) errors.wholeTripPriceYer = t('trips.wholePriceRequired');
  } else if (input.pricingMode === 'flat' && input.pricePerSeatYer == null) {
    errors.pricePerSeatYer = t('trips.priceRequired');
  }

  if (input.discountKind === 'percent' && (input.discountValue ?? 0) > 10_000) {
    errors.discountValue = t('trips.percentTooHigh');
  }
  if (input.discountKind === 'none' && (input.discountValue ?? 0) !== 0) {
    errors.discountValue = t('trips.discountMustBeZero');
  }

  const stops = input.stops ?? [];
  const last = stops.at(-1);
  if (
    last &&
    input.arriveEstimateMinutes > 0 &&
    input.arriveEstimateMinutes < last.arriveOffsetMinutes
  ) {
    errors.arriveEstimateMinutes = t('trips.arrivalBeforeLastStop');
  }
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const current = stops[index];
    if (!previous || !current) continue;
    if (current.arriveOffsetMinutes < previous.arriveOffsetMinutes) {
      errors.stops = t('trips.stopsOutOfOrder');
      break;
    }
    const previousName = (previous.nameAr ?? previous.placeId ?? '').toString();
    const currentName = (current.nameAr ?? current.placeId ?? '').toString();
    if (previousName !== '' && previousName === currentName) {
      errors.stops = t('trips.stopsRepeated');
      break;
    }
  }
  return errors;
}

export const createTripSchema = z.object({
  action: z.literal('trip.create'),
  /** Absent = the actor owns the trip personally. */
  orgId: uuid.nullish(),
  trip: tripInputSchema,
});

export const updateTripSchema = z.object({
  action: z.literal('trip.update'),
  tripId: uuid,
  trip: tripInputSchema,
});

export const setTripStopsSchema = z.object({
  action: z.literal('trip.setStops'),
  tripId: uuid,
  stops: z.array(tripStopInputSchema).max(10),
});

export const publishTripSchema = z.object({
  action: z.literal('trip.publish'),
  tripId: uuid,
});

export const submitTripVerificationSchema = z.object({
  action: z.literal('trip.submitVerification'),
  tripId: uuid,
  note: z.string().trim().max(500).optional(),
});

export const decideTripVerificationSchema = z.object({
  action: z.literal('trip.decideVerification'),
  tripId: uuid,
  outcome: z.enum(['approve', 'reject']),
  /** A rejection without a reason is unactionable; the SQL enforces the same minimum. */
  reason: z.string().trim().max(500).optional(),
});

export const cancelTripSchema = z.object({
  action: z.literal('trip.cancel'),
  tripId: uuid,
  reason: z.string().trim().min(3).max(500),
});

/** Phase 6 — the trip leaves the station. The odometer is a reading, not a delta. */
export const startTripSchema = z.object({
  action: z.literal('trip.start'),
  tripId: uuid,
  odoKm: z.number().int().min(0).max(3_000_000),
});

/** "Reached stop n." Monotonic in the database; a repeat is answered, not refused. */
export const markStopReachedSchema = z.object({
  action: z.literal('trip.stopReached'),
  tripId: uuid,
  seq: z.number().int().min(1).max(20),
});

export const endTripSchema = z.object({
  action: z.literal('trip.end'),
  tripId: uuid,
  odoKm: z.number().int().min(0).max(3_000_000),
});

/**
 * Phase 6 — one position report from the road.
 *
 * `recordedAt` is the *phone's* clock, and it is optional because the common case is "now". It matters
 * when a queue flushes: an hour of driving should not all be stamped at the moment the tunnel ended.
 * The database clamps it into `[started_at, now()]`, so a wrong clock costs a bad point, not a bad trip.
 */
export const recordPingSchema = z.object({
  action: z.literal('trip.recordPing'),
  tripId: uuid,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000).nullish(),
  speedKmh: z.number().min(0).max(250).nullish(),
  recordedAt: timestamp.nullish(),
  source: z.enum(['app', 'background', 'web', 'manual']).default('app'),
});

export const tripsActionSchema = z.discriminatedUnion('action', [
  createTripSchema,
  updateTripSchema,
  setTripStopsSchema,
  publishTripSchema,
  submitTripVerificationSchema,
  decideTripVerificationSchema,
  cancelTripSchema,
  startTripSchema,
  markStopReachedSchema,
  endTripSchema,
  recordPingSchema,
]);

export type TripsAction = z.infer<typeof tripsActionSchema>;

/**
 * The scope facts an actor claims for an action.
 *
 * A claim, not a grant: every `cmd_*` re-derives ownership from the rows, so claiming too much buys
 * nothing but a wasted round trip.
 */
export function tripsScope(input: TripsAction) {
  switch (input.action) {
    case 'trip.create':
      return input.orgId ? { isOrgMember: true } : { isOwner: true };
    // `trip.start` is driver-scoped in the policy matrix: the driver claims they are the assigned one,
    // and `cmd_start_trip` re-derives it from `driver_profiles.user_id` before touching the trip.
    case 'trip.start':
    case 'trip.stopReached':
    case 'trip.end':
    case 'trip.recordPing':
      return { isAssignedDriver: true, isOwner: true, isOrgMember: true };
    default:
      return { isOwner: true, isOrgMember: true };
  }
}

/** A warning the command attaches instead of refusing: the operator can still publish, and should know. */
export const tripWarningSchema = z.object({
  code: z.enum(['QUOTA_SOFT_WARNING', 'VEHICLE_NOT_VERIFIED', 'DRIVER_NOT_VERIFIED']),
  metric: z.string().optional(),
  limit: z.number().optional(),
  used: z.number().optional(),
});

export const tripsResultSchema = z
  .object({
    trip: z.record(z.string(), z.unknown()).optional(),
    warnings: z.array(tripWarningSchema).optional(),
    odoKm: z.number().optional(),
    distanceKm: z.number().optional(),
    flagged: z.boolean().optional(),
    alreadyReached: z.boolean().optional(),
    recordedAt: z.string().optional(),
    progress: z.record(z.string(), z.unknown()).optional(),
    reverificationRequired: z.boolean().optional(),
    tripId: uuid.optional(),
    verificationStatus: z.string().optional(),
    status: z.string().optional(),
    requestId: z.string().optional(),
  })
  .passthrough();

export const tripsCommandSpec = {
  path: 'trips',
  input: tripsActionSchema,
  output: tripsResultSchema,
  mutating: true,
} as const;

/**
 * Action → SQL function and arguments.
 *
 * The `p_` names are the command signatures; `cmd_*` names in this file are checked against the
 * migrations by a guard, so a rename cannot leave a caller pointing at nothing.
 */
export function tripsCommandArgs(
  action: TripsAction,
  actorId: string,
  audit: { readonly p_request_id: string; readonly p_ip: string | null },
): { fn: string; args: Record<string, unknown> } {
  const json = (value: unknown) => JSON.stringify(value ?? null);

  switch (action.action) {
    case 'trip.create':
      return {
        fn: 'cmd_create_trip',
        args: {
          p_actor: actorId,
          p_owner_org: action.orgId ?? null,
          p_trip: json(action.trip),
          ...audit,
        },
      };
    case 'trip.update':
      return {
        fn: 'cmd_update_trip',
        args: { p_actor: actorId, p_trip_id: action.tripId, p_trip: json(action.trip), ...audit },
      };
    case 'trip.setStops':
      return {
        fn: 'cmd_set_trip_stops',
        args: { p_actor: actorId, p_trip_id: action.tripId, p_stops: json(action.stops), ...audit },
      };
    case 'trip.publish':
      return {
        fn: 'cmd_publish_trip',
        args: { p_actor: actorId, p_trip_id: action.tripId, ...audit },
      };
    case 'trip.submitVerification':
      return {
        fn: 'cmd_submit_trip_verification',
        args: {
          p_actor: actorId,
          p_trip_id: action.tripId,
          p_note: action.note ?? null,
          ...audit,
        },
      };
    case 'trip.decideVerification':
      return {
        fn: 'cmd_decide_trip_verification',
        args: {
          p_actor: actorId,
          p_trip_id: action.tripId,
          p_outcome: action.outcome,
          p_reason: action.reason ?? null,
          ...audit,
        },
      };
    case 'trip.cancel':
      return {
        fn: 'cmd_cancel_trip',
        args: { p_actor: actorId, p_trip_id: action.tripId, p_reason: action.reason, ...audit },
      };
    case 'trip.start':
      return {
        fn: 'cmd_start_trip',
        args: { p_actor: actorId, p_trip_id: action.tripId, p_odo_km: action.odoKm, ...audit },
      };
    case 'trip.stopReached':
      return {
        fn: 'cmd_mark_stop_reached',
        args: { p_actor: actorId, p_trip_id: action.tripId, p_seq: action.seq, ...audit },
      };
    case 'trip.end':
      return {
        fn: 'cmd_end_trip',
        args: { p_actor: actorId, p_trip_id: action.tripId, p_odo_km: action.odoKm, ...audit },
      };
    case 'trip.recordPing':
      return {
        fn: 'cmd_record_ping',
        args: {
          p_actor: actorId,
          p_trip_id: action.tripId,
          p_lat: action.lat,
          p_lng: action.lng,
          p_recorded_at: action.recordedAt ?? null,
          p_accuracy_m: action.accuracyM ?? null,
          p_speed_kmh: action.speedKmh ?? null,
          p_source: action.source,
          ...audit,
        },
      };
  }
}

// ---------------------------------------------------------------------------
// The marketplace: the two anonymous RPCs
// ---------------------------------------------------------------------------

/**
 * The filters the marketplace accepts, exactly as `app.trip_matches()` reads them.
 *
 * The keys are the SQL keys (`origin`, `priceMax`, …) so there is no translation layer that can drift;
 * a translation layer is exactly how a filter silently stops filtering.
 */
export const tripFiltersSchema = z.object({
  q: z.string().trim().max(80).optional(),
  origin: z.array(uuid).max(14).optional(),
  destination: z.array(uuid).max(14).optional(),
  gender: z.array(tripGenderPolicySchema).max(3).optional(),
  booking: z.array(tripBookingModeSchema).max(3).optional(),
  direct: z.boolean().optional(),
  priceMax: z.number().int().min(0).max(100_000_000).optional(),
  dateFrom: optionalDate.optional(),
  dateTo: optionalDate.optional(),
});

export type TripFilters = z.infer<typeof tripFiltersSchema>;

/** Drops empty filters, so `{origin: []}` and `{}` are the same cache key. */
export function compactTripFilters(filters: TripFilters): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    compact[key] = value;
  }
  return compact;
}

export function publicTripsArgs(
  locale: string,
  filters: TripFilters,
  options: { sort?: z.infer<typeof tripSortSchema>; cursor?: string | null; limit?: number } = {},
): { fn: 'search_public_trips'; args: Record<string, unknown> } {
  return {
    fn: 'search_public_trips',
    args: {
      p_locale: locale,
      p_filters: JSON.stringify(compactTripFilters(filters)),
      p_sort: options.sort ?? 'soonest',
      p_cursor: options.cursor ?? null,
      p_limit: options.limit ?? 12,
    },
  };
}

export function publicTripArgs(
  code: string,
  locale: string,
): { fn: 'get_trip_public'; args: Record<string, unknown> } {
  return { fn: 'get_trip_public', args: { p_code: code, p_locale: locale } };
}

export const staffTripFiltersSchema = z.object({
  status: z
    .array(z.enum(['draft', 'pending', 'published', 'cancelled', 'completed']))
    .max(5)
    .optional(),
  q: z.string().trim().max(80).optional(),
});

export function staffTripsArgs(
  actorId: string,
  filters: z.infer<typeof staffTripFiltersSchema>,
  limit = 50,
): { fn: 'staff_search_trips'; args: Record<string, unknown> } {
  const compact: Record<string, unknown> = {};
  if (filters.status?.length) compact.status = filters.status;
  if (filters.q) compact.q = filters.q;
  return {
    fn: 'staff_search_trips',
    args: { p_actor: actorId, p_filters: JSON.stringify(compact), p_limit: limit },
  };
}
