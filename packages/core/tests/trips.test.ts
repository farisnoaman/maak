import { describe, expect, it } from 'vitest';
import {
  compactTripFilters,
  publicTripArgs,
  publicTripsArgs,
  staffTripsArgs,
  tripFieldErrors,
  tripInputSchema,
  tripsActionSchema,
  tripsCommandArgs,
  tripsScope,
} from '../src/api/trips';
import { policyDenial, type Actor } from '../src/domain/policy';

const audit = { p_request_id: 'req-1', p_ip: null };

const SOURCE = 'bbbb0001-0000-4000-8000-000000000001';
const TARGET = 'bbbb0001-0000-4000-8000-000000000002';
const VEHICLE = 'bbbb0002-0000-4000-8000-000000000001';
const TRIP = 'bbbb0003-0000-4000-8000-000000000001';

const departure = new Date(Date.now() + 86_400_000).toISOString();

const trip = {
  vehicleId: VEHICLE,
  originGovernorateId: SOURCE,
  destinationGovernorateId: TARGET,
  departureAt: departure,
  seatsTotal: 12,
  pricePerSeatYer: 10_000,
};

const owner: Actor = {
  userId: 'u-owner',
  roles: ['individual'],
  verification: 'verified',
  plan: 'basic',
};
const unverified: Actor = { ...owner, verification: 'unverified' };

describe('trip input', () => {
  it('applies the defaults the command also applies', () => {
    const parsed = tripInputSchema.parse(trip);
    expect(parsed.bookingMode).toBe('per_seat');
    expect(parsed.pricingMode).toBe('flat');
    expect(parsed.discountKind).toBe('none');
    expect(parsed.discountValue).toBe(0);
    expect(parsed.discountScope).toBe('all');
    expect(parsed.genderPolicy).toBe('any');
    expect(parsed.paymentPolicy).toBe('cash');
    expect(parsed.arriveEstimateMinutes).toBe(0);
  });

  it('accepts a `datetime-local` value, because that is what the wizard submits', () => {
    const parsed = tripInputSchema.parse({ ...trip, departureAt: '2026-05-04T14:30' });
    expect(parsed.departureAt).toBe('2026-05-04T14:30');
  });

  it('refuses a departure that is not a timestamp', () => {
    expect(tripInputSchema.safeParse({ ...trip, departureAt: 'tomorrow' }).success).toBe(false);
  });

  it('refuses more than ten stops, because the database does', () => {
    const stops = Array.from({ length: 11 }, (_, index) => ({
      nameAr: `stop ${index}`,
      arriveOffsetMinutes: index * 10,
    }));
    expect(tripInputSchema.safeParse({ ...trip, stops }).success).toBe(false);
  });
});

describe('trip cross-field rules', () => {
  const parse = (over: Record<string, unknown> = {}) => tripInputSchema.parse({ ...trip, ...over });

  it('refuses a trip that leaves and arrives in the same governorate', () => {
    const errors = tripFieldErrors(parse({ destinationGovernorateId: SOURCE }));
    expect(errors.destinationGovernorateId).toBeTruthy();
  });

  it('refuses a departure in the past', () => {
    const errors = tripFieldErrors(
      parse({ departureAt: new Date(Date.now() - 3_600_000).toISOString() }),
    );
    expect(errors.departureAt).toBeTruthy();
  });

  it('wants a per-seat price for a flat trip, and a whole-trip price for a whole-trip booking', () => {
    expect(tripFieldErrors(parse({ pricePerSeatYer: null })).pricePerSeatYer).toBeTruthy();
    expect(
      tripFieldErrors(parse({ bookingMode: 'whole_trip', wholeTripPriceYer: null }))
        .wholeTripPriceYer,
    ).toBeTruthy();
  });

  it('reads a percentage in basis points and refuses more than 100%', () => {
    expect(
      tripFieldErrors(parse({ discountKind: 'percent', discountValue: 10_001 })).discountValue,
    ).toBeTruthy();
  });

  it('refuses a discount value on a trip with no discount', () => {
    expect(
      tripFieldErrors(parse({ discountKind: 'none', discountValue: 500 })).discountValue,
    ).toBeTruthy();
  });

  it('refuses stops out of order, and two consecutive stops at the same place', () => {
    expect(
      tripFieldErrors(
        parse({
          stops: [
            { nameAr: 'عدن', arriveOffsetMinutes: 400 },
            { nameAr: 'تعز', arriveOffsetMinutes: 200 },
          ],
        }),
      ).stops,
    ).toBeTruthy();

    expect(
      tripFieldErrors(
        parse({
          stops: [
            { nameAr: 'تعز', arriveOffsetMinutes: 100 },
            { nameAr: 'تعز', arriveOffsetMinutes: 200 },
          ],
        }),
      ).stops,
    ).toBeTruthy();
  });

  it('refuses an arrival that is before the last stop', () => {
    const errors = tripFieldErrors(
      parse({
        arriveEstimateMinutes: 60,
        stops: [{ nameAr: 'تعز', arriveOffsetMinutes: 180 }],
      }),
    );
    expect(errors.arriveEstimateMinutes).toBeTruthy();
  });

  it('speaks the locale it was asked for', () => {
    const ar = tripFieldErrors(parse({ destinationGovernorateId: SOURCE }), 'ar');
    const en = tripFieldErrors(parse({ destinationGovernorateId: SOURCE }), 'en');
    expect(ar.destinationGovernorateId).not.toBe(en.destinationGovernorateId);
    expect(en.destinationGovernorateId).toMatch(/same governorate/i);
  });
});

describe('trip action contract', () => {
  it('parses every action the edge function routes', () => {
    const actions = [
      { action: 'trip.create', trip },
      { action: 'trip.update', tripId: TRIP, trip },
      {
        action: 'trip.setStops',
        tripId: TRIP,
        stops: [{ nameAr: 'تعز', arriveOffsetMinutes: 180 }],
      },
      { action: 'trip.publish', tripId: TRIP },
      { action: 'trip.submitVerification', tripId: TRIP, note: 'please review' },
      { action: 'trip.decideVerification', tripId: TRIP, outcome: 'approve' },
      { action: 'trip.cancel', tripId: TRIP, reason: 'vehicle broke down' },
    ];
    for (const action of actions) {
      expect(tripsActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it('refuses an action it does not know', () => {
    expect(tripsActionSchema.safeParse({ action: 'trip.teleport' }).success).toBe(false);
  });

  it('maps every action onto exactly one command', () => {
    const map = tripsActionSchema.options.map((option) => {
      const sample = {
        action: option.shape.action.value,
        tripId: TRIP,
        trip,
        stops: [],
        reason: 'vehicle broke down',
        odoKm: 184_400,
        seq: 2,
        lat: 13.55,
        lng: 44.05,
        source: 'app',
        tripIds: [TRIP],
        outcome: 'approve',
      };
      return tripsCommandArgs(sample as never, 'u-1', audit);
    });

    expect(map.map((entry) => entry.fn)).toEqual([
      'cmd_create_trip',
      'cmd_update_trip',
      'cmd_set_trip_stops',
      'cmd_publish_trip',
      'cmd_submit_trip_verification',
      'cmd_decide_trip_verification',
      'cmd_cancel_trip',
      'cmd_start_trip',
      'cmd_mark_stop_reached',
      'cmd_end_trip',
      'cmd_record_ping',
      'cmd_bulk_verify_trips',
      'cmd_rotate_trip_qr',
    ]);
    for (const entry of map) {
      expect(entry.args.p_actor).toBe('u-1');
      expect(entry.args.p_request_id).toBe('req-1');
    }
  });

  it('carries the odometer and the stop sequence as numbers, not strings', () => {
    // `p_odo_km` is an integer and `p_seq` a smallint: a string would be cast by Postgres and would hide
    // a client sending "12O" (letter O) until the driver is at the roadside.
    const start = tripsCommandArgs(
      { action: 'trip.start', tripId: TRIP, odoKm: 184_400 },
      'u-1',
      audit,
    );
    expect(start.args.p_odo_km).toBe(184_400);

    const stop = tripsCommandArgs(
      { action: 'trip.stopReached', tripId: TRIP, seq: 2 },
      'u-1',
      audit,
    );
    expect(stop.args.p_seq).toBe(2);
  });

  it('serialises jsonb arguments, because node-postgres would send an array literal', () => {
    const { args } = tripsCommandArgs(
      { action: 'trip.setStops', tripId: TRIP, stops: [{ nameAr: 'تعز', arriveOffsetMinutes: 9 }] },
      'u-1',
      audit,
    );
    expect(typeof args.p_stops).toBe('string');
    expect(JSON.parse(args.p_stops as string)).toEqual([{ nameAr: 'تعز', arriveOffsetMinutes: 9 }]);
  });

  it('passes the whole payload as one jsonb object on create', () => {
    const { fn, args } = tripsCommandArgs(
      { action: 'trip.create', orgId: null, trip: tripInputSchema.parse(trip) },
      'u-1',
      audit,
    );
    expect(fn).toBe('cmd_create_trip');
    expect(args.p_owner_org).toBeNull();
    expect(JSON.parse(args.p_trip as string).seatsTotal).toBe(12);
  });
});

describe('trip policy', () => {
  it('lets a verified owner create a trip and refuses an unverified one', () => {
    const action = tripsActionSchema.parse({ action: 'trip.create', trip }) as never;
    expect(policyDenial(owner, 'trip.create', tripsScope(action))).toBeNull();
    expect(policyDenial(unverified, 'trip.create', tripsScope(action))).toBe('NOT_VERIFIED');
  });

  it('claims organizational scope when the trip belongs to an organization', () => {
    const action = tripsActionSchema.parse({
      action: 'trip.create',
      orgId: 'bbbb0000-0000-4000-8000-000000000001',
      trip,
    }) as never;
    expect(tripsScope(action)).toEqual({ isOrgMember: true });
  });

  it('claims ownership for every other action, because the SQL re-derives it anyway', () => {
    const action = tripsActionSchema.parse({ action: 'trip.publish', tripId: TRIP }) as never;
    expect(tripsScope(action)).toEqual({ isOwner: true, isOrgMember: true });
  });
});

describe('marketplace reads', () => {
  it('drops empty filters, so an untouched form and an empty object are the same query', () => {
    expect(
      compactTripFilters({ origin: [], destination: [], q: '', direct: undefined, priceMax: 5000 }),
    ).toEqual({ priceMax: 5000 });
  });

  it('keeps the SQL filter keys, so there is no translation layer to drift', () => {
    expect(compactTripFilters({ origin: [SOURCE], direct: true })).toEqual({
      origin: [SOURCE],
      direct: true,
    });
  });

  it('serialises filters as jsonb and defaults the sort and the page size', () => {
    const { fn, args } = publicTripsArgs('ar', { origin: [SOURCE] });
    expect(fn).toBe('search_public_trips');
    expect(args.p_locale).toBe('ar');
    expect(args.p_sort).toBe('soonest');
    expect(args.p_limit).toBe(12);
    expect(args.p_cursor).toBeNull();
    expect(JSON.parse(args.p_filters as string)).toEqual({ origin: [SOURCE] });
  });

  it('passes the cursor through untouched, because the database built it', () => {
    const { args } = publicTripsArgs('en', {}, { cursor: '123.4|bbbb', limit: 50 });
    expect(args.p_cursor).toBe('123.4|bbbb');
    expect(args.p_limit).toBe(50);
  });

  it('asks for a detail page by code, not by id — the code is what a URL carries', () => {
    const { fn, args } = publicTripArgs('SA-AD-7K2Q', 'ar');
    expect(fn).toBe('get_trip_public');
    expect(args).toEqual({ p_code: 'SA-AD-7K2Q', p_locale: 'ar' });
  });

  it('omits the staff filters it was not given', () => {
    const { args } = staffTripsArgs('u-1', {});
    expect(JSON.parse(args.p_filters as string)).toEqual({});
    const withStatus = staffTripsArgs('u-1', { status: ['cancelled'], q: 'SA' });
    expect(JSON.parse(withStatus.args.p_filters as string)).toEqual({
      status: ['cancelled'],
      q: 'SA',
    });

    // Phase 7: the history filters. Absent keys stay absent — an empty `from` in the payload would be
    // parsed as a date and throw inside the database.
    const history = staffTripsArgs('u-1', {
      from: '2026-01-01',
      to: '2026-01-31',
      governorateId: SOURCE,
      verificationStatus: ['verified'],
    });
    expect(JSON.parse(history.args.p_filters as string)).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      governorateId: SOURCE,
      verificationStatus: ['verified'],
    });
    expect(staffTripsArgs('u-1', { from: '' as never }).args.p_filters).toBe('{}');
  });
});
