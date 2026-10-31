import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  adenLocalToIso,
  isoToAdenLocal,
  departureLabel,
  isTripEditable,
  readTripFilters,
  searchSuffix,
  tripBadges,
  tripFilterQuery,
  tripPriceFrom,
  tripStatusKey,
  tripVerificationKey,
} from '../src/domain/trip';
import { computePrice } from '../src/domain/pricing';
import { translate } from '../src/i18n/dictionaries';

const at = (iso: string) => new Date(iso);
const now = at('2026-05-01T09:00:00.000Z');

describe('the two-hour edit lock', () => {
  it('is open three days out', () => {
    expect(isTripEditable({ status: 'draft', departureAt: '2026-05-04T09:00:00.000Z' }, now)).toBe(
      true,
    );
  });

  it('is closed at one hour fifty-nine minutes — the same boundary the database enforces', () => {
    expect(
      isTripEditable({ status: 'published', departureAt: '2026-05-01T10:59:00.000Z' }, now),
    ).toBe(false);
  });

  it('is closed for a cancelled or completed trip however far away the departure is', () => {
    expect(
      isTripEditable({ status: 'cancelled', departureAt: '2026-12-01T09:00:00.000Z' }, now),
    ).toBe(false);
    expect(
      isTripEditable({ status: 'completed', departureAt: '2026-12-01T09:00:00.000Z' }, now),
    ).toBe(false);
  });

  it('treats an unparseable departure as locked, because a form that cannot tell should not open', () => {
    expect(isTripEditable({ status: 'draft', departureAt: 'soon' }, now)).toBe(false);
  });
});

describe('trip badges', () => {
  it('leads with the status and adds the verification state', () => {
    const badges = tripBadges(
      {
        status: 'published',
        verificationStatus: 'verified',
        departureAt: '2026-05-04T09:00:00.000Z',
        seatsAvailable: 9,
        seatsTotal: 12,
      },
      now,
    );
    expect(badges.map((badge) => badge.code)).toEqual(['published', 'verified']);
    expect(badges[0]?.tone).toBe('ok');
  });

  it('marks a published trip with two seats left, but not a draft with two seats left', () => {
    const facts = {
      verificationStatus: 'unverified',
      departureAt: '2026-05-04T09:00:00.000Z',
      seatsAvailable: 2,
      seatsTotal: 12,
    };
    expect(tripBadges({ ...facts, status: 'published' }, now).map((b) => b.code)).toContain(
      'lastSeats',
    );
    expect(tripBadges({ ...facts, status: 'draft' }, now).map((b) => b.code)).not.toContain(
      'lastSeats',
    );
  });

  it('marks a live featured listing, and stops when the boost expires', () => {
    const base = {
      status: 'published',
      verificationStatus: 'unverified',
      departureAt: '2026-05-04T09:00:00.000Z',
      seatsAvailable: 9,
    };
    expect(
      tripBadges({ ...base, featuredUntil: '2026-05-05T09:00:00.000Z' }, now).map((b) => b.code),
    ).toContain('featured');
    expect(
      tripBadges({ ...base, featuredUntil: '2026-04-30T09:00:00.000Z' }, now).map((b) => b.code),
    ).not.toContain('featured');
  });

  it('paints a cancelled trip as bad, whatever else is true of it', () => {
    const badges = tripBadges(
      {
        status: 'cancelled',
        verificationStatus: 'verified',
        departureAt: '2026-05-04T09:00:00.000Z',
      },
      now,
    );
    expect(badges[0]?.tone).toBe('bad');
  });

  it('maps every status and verification value to a label that exists in both dictionaries', () => {
    for (const status of ['draft', 'pending', 'published', 'cancelled', 'completed', 'nonsense']) {
      for (const locale of ['ar', 'en'] as const) {
        expect(translate(locale, tripStatusKey(status))).not.toContain('trips.');
      }
    }
    for (const status of ['unverified', 'pending', 'verified', 'rejected', null]) {
      for (const locale of ['ar', 'en'] as const) {
        expect(translate(locale, tripVerificationKey(status))).not.toContain('trips.');
      }
    }
  });
});

describe('departure labels', () => {
  it('reads in Aden time, whatever timezone the server is in', () => {
    // 06:30 UTC is 09:30 in Aden (UTC+03:00, no daylight saving).
    expect(departureLabel('2026-05-04T06:30:00.000Z', 'en').time).toBe('09:30');
    expect(departureLabel('2026-05-04T06:30:00.000Z', 'ar').time).toBe('09:30');
  });

  it('keeps Latin digits in Arabic, because a departure time is read as a number', () => {
    expect(departureLabel('2026-05-04T06:30:00.000Z', 'ar').time).toMatch(/^[0-9]{2}:[0-9]{2}$/);
  });

  it('renders an unparseable timestamp as a dash instead of "Invalid Date"', () => {
    expect(departureLabel('not a date', 'ar')).toEqual({ date: '—', time: '—' });
  });
});

describe('Aden wall clock ↔ ISO', () => {
  it('reads a typed 14:30 as 14:30 in Aden, not 14:30 UTC', () => {
    expect(adenLocalToIso('2026-05-04T14:30')).toBe('2026-05-04T11:30:00.000Z');
  });

  it('round-trips what the form shows', () => {
    expect(isoToAdenLocal('2026-05-04T11:30:00.000Z')).toBe('2026-05-04T14:30');
    expect(adenLocalToIso(isoToAdenLocal('2026-05-04T11:30:00.000Z'))).toBe(
      '2026-05-04T11:30:00.000Z',
    );
  });

  it('crosses midnight correctly in both directions', () => {
    expect(adenLocalToIso('2026-05-05T01:15')).toBe('2026-05-04T22:15:00.000Z');
    expect(isoToAdenLocal('2026-05-04T22:15:00.000Z')).toBe('2026-05-05T01:15');
  });

  it('refuses a value it cannot read instead of guessing', () => {
    expect(adenLocalToIso('tomorrow at noon')).toBeNull();
    expect(isoToAdenLocal('not a date')).toBe('');
  });
});

describe('marketplace filter URLs', () => {
  it('round-trips a full filter set', () => {
    const state = {
      q: 'عدن',
      origin: ['g1', 'g2'],
      gender: ['women_only'],
      direct: true,
      priceMax: 9000,
      dateFrom: '2026-05-01',
      dateTo: '2026-05-09',
      sort: 'cheapest' as const,
    };
    expect(readTripFilters(new URLSearchParams(tripFilterQuery(state)))).toEqual(state);
  });

  it('leaves the default sort out of the URL, so the bare link stays readable', () => {
    expect(tripFilterQuery({ sort: 'soonest' })).toBe('');
    expect(tripFilterQuery({ sort: 'featured' })).toBe('sort=featured');
  });

  it('reads the same filters from Next.js searchParams and from a URLSearchParams', () => {
    const fromRecord = readTripFilters({ origin: 'g1,g2', direct: '1', priceMax: '5000' });
    const fromParams = readTripFilters(new URLSearchParams('origin=g1,g2&direct=1&priceMax=5000'));
    expect(fromRecord).toEqual(fromParams);
    expect(fromRecord.origin).toEqual(['g1', 'g2']);
    expect(fromRecord.direct).toBe(true);
    expect(fromRecord.priceMax).toBe(5000);
  });

  it('re-serialises a query for the language switch, keeping keys it does not know', () => {
    const search = searchSuffix({ q: 'عدن', status: ['draft', 'published'], page: '2' });
    expect(search).toBe('?q=%D8%B9%D8%AF%D9%86&status=draft&status=published&page=2');
    expect(new URLSearchParams(search).getAll('status')).toEqual(['draft', 'published']);
  });

  it('drops the session token and empty values, because a link is not a session', () => {
    expect(searchSuffix({ q: 'SA', st: 'token', empty: '', missing: undefined }, ['st'])).toBe(
      '?q=SA',
    );
    expect(searchSuffix({ st: 'token' }, ['st'])).toBe('');
    expect(searchSuffix({})).toBe('');
  });

  it('reads the same query from a URLSearchParams as from Next.js searchParams', () => {
    const params = new URLSearchParams('q=SA&status=draft&status=cancelled');
    expect(searchSuffix(params)).toBe(searchSuffix({ q: 'SA', status: ['draft', 'cancelled'] }));
    expect(searchSuffix(params)).toBe('?q=SA&status=draft&status=cancelled');
  });

  it('ignores junk instead of sending it to the database', () => {
    const state = readTripFilters({
      direct: 'maybe',
      priceMax: 'free',
      dateFrom: '01/05/2026',
      sort: 'alphabetical',
      origin: '',
    });
    expect(state).toEqual({});
  });

  it('counts the active filters for the badge on the filter button', () => {
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ q: 'عدن', origin: ['g1'], direct: true, priceMax: 5000 })).toBe(4);
  });
});

/**
 * The parity fixtures: the *same* numbers are asserted against `app.trip_total()` in
 * `supabase/tests/0007_trips.test.sql` §3. If the two implementations ever disagree about a discount,
 * one of the two suites goes red — which is the point of having both.
 */
describe('pricing parity with app.trip_total()', () => {
  const flat = {
    bookingMode: 'per_seat' as const,
    pricingMode: 'flat' as const,
    pricePerSeatMinor: 10_000,
  };

  it('two seats at 10 000 with a 10% discount: 20 000 − 2 000 = 18 000', () => {
    const price = computePrice({
      ...flat,
      seats: 2,
      discount: { kind: 'percent', value: 1000, scope: 'all' },
    });
    expect(price.subtotalMinor).toBe(20_000);
    expect(price.discountMinor).toBe(2_000);
    expect(price.totalMinor).toBe(18_000);
  });

  it('half a riyal of discount rounds up, exactly like round() in SQL', () => {
    const price = computePrice({
      ...flat,
      pricePerSeatMinor: 5000,
      seats: 1,
      discount: { kind: 'percent', value: 1, scope: 'all' },
    });
    expect(price.discountMinor).toBe(1);
  });

  it('a fixed discount is subtracted once from the subtotal', () => {
    const price = computePrice({
      ...flat,
      seats: 2,
      discount: { kind: 'fixed', value: 3000, scope: 'all' },
    });
    expect(price.totalMinor).toBe(17_000);
  });

  it('a discount larger than the fare stops at zero', () => {
    const price = computePrice({
      ...flat,
      pricePerSeatMinor: 5000,
      seats: 1,
      discount: { kind: 'fixed', value: 999_999, scope: 'all' },
    });
    expect(price.totalMinor).toBe(0);
  });

  it('a whole-trip booking costs the whole-trip price, however many seats are chosen', () => {
    const price = computePrice({
      bookingMode: 'whole_trip',
      pricingMode: 'flat',
      seats: 4,
      pricePerSeatMinor: 10_000,
      wholeTripPriceMinor: 60_000,
    });
    expect(price.subtotalMinor).toBe(60_000);
  });

  it('a per-seat discount does not apply to a whole-trip booking', () => {
    const price = computePrice({
      bookingMode: 'whole_trip',
      pricingMode: 'flat',
      seats: 4,
      pricePerSeatMinor: 10_000,
      wholeTripPriceMinor: 60_000,
      discount: { kind: 'percent', value: 1000, scope: 'per_seat' },
    });
    expect(price.discountMinor).toBe(0);
  });

  it('per-stop pricing reads the boarding stop, and falls back to the flat fare', () => {
    const withStop = computePrice({
      ...flat,
      pricingMode: 'per_stop',
      seats: 1,
      boardingStop: { stopId: 'stop-2', priceFromOriginMinor: 9000 },
    });
    expect(withStop.unitFareMinor).toBe(9000);

    const withoutStop = computePrice({
      ...flat,
      pricingMode: 'per_stop',
      seats: 1,
      boardingStop: { stopId: 'stop-3', priceFromOriginMinor: null },
    });
    expect(withoutStop.unitFareMinor).toBe(10_000);
  });
});

describe('tripPriceFrom mirrors app.trip_price_from()', () => {
  const flat = {
    bookingMode: 'per_seat',
    pricingMode: 'flat',
    pricePerSeatYer: 10_000,
    wholeTripPriceYer: null,
  };

  it('advertises the flat fare for a flat per-seat trip', () => {
    expect(tripPriceFrom(flat, [{ priceFromOriginYer: 6_000 }])).toBe(10_000);
  });

  it('advertises the cheapest stop for a per-stop trip', () => {
    expect(
      tripPriceFrom({ ...flat, pricingMode: 'per_stop' }, [
        { priceFromOriginYer: 9_000 },
        { priceFromOriginYer: 6_000 },
      ]),
    ).toBe(6_000);
  });

  it('falls back to the flat fare for a stop with no price of its own', () => {
    expect(
      tripPriceFrom({ ...flat, pricingMode: 'per_stop', pricePerSeatYer: 7_500 }, [
        { priceFromOriginYer: null },
      ]),
    ).toBe(7_500);
  });

  it('advertises the whole-trip price for a whole-trip booking', () => {
    expect(
      tripPriceFrom({ ...flat, bookingMode: 'whole_trip', wholeTripPriceYer: 60_000 }, []),
    ).toBe(60_000);
  });

  it('is null when a draft has no price at all, rather than zero', () => {
    expect(
      tripPriceFrom({ ...flat, pricePerSeatYer: null, wholeTripPriceYer: null }, []),
    ).toBeNull();
  });
});
