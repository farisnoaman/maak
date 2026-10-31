import { describe, expect, it } from 'vitest';
import {
  add,
  clampToZero,
  CurrencyMismatchError,
  equals,
  fromMajor,
  money,
  percent,
  percentOf,
  roundHalfUp,
  subtract,
  sum,
  toMajor,
} from '../src/domain/money';

describe('roundHalfUp', () => {
  it('rounds .5 away from zero in both directions', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(2.49)).toBe(2);
  });

  it('rejects non-finite input', () => {
    expect(() => roundHalfUp(Number.NaN)).toThrow();
    expect(() => roundHalfUp(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('money arithmetic', () => {
  it('adds and subtracts within one currency', () => {
    expect(equals(add(money(1500), money(500)), money(2000))).toBe(true);
    expect(equals(subtract(money(1500), money(500)), money(1000))).toBe(true);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(100, 'YER'), money(100, 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('rejects fractional minor units', () => {
    expect(() => money(10.5)).toThrow();
  });

  it('sums a list', () => {
    expect(sum([money(100), money(250), money(650)]).amountMinor).toBe(1000);
  });

  it('never goes negative when clamped', () => {
    expect(clampToZero(money(-500)).amountMinor).toBe(0);
  });
});

describe('percentages', () => {
  it('applies basis points half-up', () => {
    // 10% of 12,345 = 1,234.5 -> 1,235
    expect(percentOf(12_345, 1000)).toBe(1235);
    expect(percent(money(10_000), 500).amountMinor).toBe(500);
  });

  it('handles 0% and 100%', () => {
    expect(percentOf(9_999, 0)).toBe(0);
    expect(percentOf(9_999, 10_000)).toBe(9_999);
  });

  it('rejects negative rates', () => {
    expect(() => percentOf(1000, -1)).toThrow();
  });

  it('never loses a riyal to floating point', () => {
    // 7.5% of 1,000 = 75 exactly
    expect(percentOf(1_000, 750)).toBe(75);
    // 3% of 1,000 = 30
    expect(percentOf(1_000, 300)).toBe(30);
  });
});

describe('major/minor conversion', () => {
  it('converts YER (exponent 0) losslessly', () => {
    expect(fromMajor(1500, 'YER').amountMinor).toBe(1500);
    expect(toMajor(money(1500, 'YER'))).toBe(1500);
  });

  it('converts USD (exponent 2) with half-up rounding', () => {
    expect(fromMajor(10.005, 'USD').amountMinor).toBe(1001);
    expect(toMajor(money(1001, 'USD'))).toBeCloseTo(10.01);
  });
});
