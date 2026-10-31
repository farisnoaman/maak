import { describe, expect, it } from 'vitest';
import {
  canFit,
  computeDiscountMinor,
  computePrice,
  PricingError,
  seatsAfterBooking,
} from '../src/domain/pricing';

const base = {
  bookingMode: 'per_seat' as const,
  pricingMode: 'flat' as const,
  seats: 2,
  pricePerSeatMinor: 5_000,
};

describe('per-seat pricing', () => {
  it('multiplies the seat price', () => {
    const p = computePrice(base);
    expect(p.subtotalMinor).toBe(10_000);
    expect(p.totalMinor).toBe(10_000);
    expect(p.unitFareMinor).toBe(5_000);
  });

  it('uses the boarding stop price in per-stop mode', () => {
    const p = computePrice({
      ...base,
      pricingMode: 'per_stop',
      boardingStop: { stopId: 'stop_1', priceFromOriginMinor: 3_200 },
    });
    expect(p.unitFareMinor).toBe(3_200);
    expect(p.subtotalMinor).toBe(6_400);
  });

  it('falls back to the trip price when a stop has no price', () => {
    const p = computePrice({
      ...base,
      pricingMode: 'per_stop',
      boardingStop: { stopId: 'stop_2', priceFromOriginMinor: null },
    });
    expect(p.unitFareMinor).toBe(5_000);
  });
});

describe('whole-trip pricing', () => {
  it('charges the whole-trip price regardless of seats', () => {
    const p = computePrice({
      ...base,
      bookingMode: 'whole_trip',
      seats: 14,
      wholeTripPriceMinor: 60_000,
    });
    expect(p.subtotalMinor).toBe(60_000);
  });

  it('requires a whole-trip price', () => {
    expect(() => computePrice({ ...base, bookingMode: 'whole_trip' })).toThrow(PricingError);
  });
});

describe('discounts', () => {
  it('applies a percentage discount (basis points)', () => {
    const p = computePrice({ ...base, discount: { kind: 'percent', value: 1000, scope: 'all' } });
    expect(p.discountMinor).toBe(1_000);
    expect(p.totalMinor).toBe(9_000);
  });

  it('applies a fixed discount and never goes below zero', () => {
    const p = computePrice({ ...base, discount: { kind: 'fixed', value: 99_000, scope: 'all' } });
    expect(p.discountMinor).toBe(10_000);
    expect(p.totalMinor).toBe(0);
  });

  it('ignores a per-seat discount on a whole-trip booking', () => {
    const p = computePrice({
      ...base,
      bookingMode: 'whole_trip',
      seats: 10,
      wholeTripPriceMinor: 60_000,
      discount: { kind: 'percent', value: 1000, scope: 'per_seat' },
    });
    expect(p.discountMinor).toBe(0);
  });

  it('applies a whole-trip discount only to whole-trip bookings', () => {
    expect(
      computeDiscountMinor(
        10_000,
        { kind: 'percent', value: 500, scope: 'whole_trip' },
        'per_seat',
      ),
    ).toBe(0);
    expect(
      computeDiscountMinor(
        10_000,
        { kind: 'percent', value: 500, scope: 'whole_trip' },
        'whole_trip',
      ),
    ).toBe(500);
  });

  it('reports components for the UI', () => {
    const p = computePrice({ ...base, discount: { kind: 'fixed', value: 1_500, scope: 'all' } });
    expect(p.components).toEqual([
      { key: 'fare', amountMinor: 10_000 },
      { key: 'discount', amountMinor: -1_500 },
    ]);
  });
});

describe('validation and seats', () => {
  it('rejects zero or fractional seats', () => {
    expect(() => computePrice({ ...base, seats: 0 })).toThrow(PricingError);
    expect(() => computePrice({ ...base, seats: 1.5 })).toThrow(PricingError);
  });

  it('rejects a negative seat price', () => {
    expect(() => computePrice({ ...base, pricePerSeatMinor: -1 })).toThrow(PricingError);
  });

  it('guards availability', () => {
    expect(canFit(3, 3)).toBe(true);
    expect(canFit(3, 4)).toBe(false);
    expect(seatsAfterBooking(3, 2)).toBe(1);
    expect(() => seatsAfterBooking(1, 2)).toThrow(PricingError);
  });
});
