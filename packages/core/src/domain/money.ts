/**
 * Money is always an integer number of minor units plus a currency.
 * Never a float. YER has no minor unit (exponent 0), so 1500 YER === 1500 minor units.
 *
 * Rules (see specs.md BR-20):
 *  - addition/subtraction require the same currency
 *  - percentages are expressed in basis points (1 bp = 0.01%) and rounded half-up, away from zero
 *  - results are never negative unless explicitly allowed by the caller
 */

export const CURRENCIES = {
  YER: { code: 'YER', exponent: 0, symbolAr: 'ر.ي', symbolEn: 'YER' },
  USD: { code: 'USD', exponent: 2, symbolAr: '$', symbolEn: 'USD' },
  SAR: { code: 'SAR', exponent: 2, symbolAr: 'ر.س', symbolEn: 'SAR' },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Cannot combine ${a} with ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidAmountError extends Error {
  readonly code = 'INVALID_AMOUNT';
  constructor(amount: number) {
    super(`Amount must be a safe integer of minor units, received ${amount}`);
    this.name = 'InvalidAmountError';
  }
}

/** Rounds half-up, away from zero (2.5 -> 3, -2.5 -> -3). */
export function roundHalfUp(value: number): number {
  if (!Number.isFinite(value)) throw new InvalidAmountError(value);
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function money(amountMinor: number, currency: CurrencyCode = 'YER'): Money {
  if (!Number.isSafeInteger(amountMinor)) throw new InvalidAmountError(amountMinor);
  return { amountMinor, currency };
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function sum(amounts: readonly Money[], currency: CurrencyCode = 'YER'): Money {
  return amounts.reduce<Money>((acc, next) => add(acc, next), money(0, currency));
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

/** `basisPoints` of 10000 === 100%. Half-up rounding. */
export function percentOf(amountMinor: number, basisPoints: number): number {
  if (!Number.isSafeInteger(amountMinor)) throw new InvalidAmountError(amountMinor);
  if (!Number.isFinite(basisPoints) || basisPoints < 0) {
    throw new InvalidAmountError(basisPoints);
  }
  return roundHalfUp((amountMinor * basisPoints) / 10_000);
}

export function percent(amount: Money, basisPoints: number): Money {
  return money(percentOf(amount.amountMinor, basisPoints), amount.currency);
}

/** Never lets a discount or allocation push a total below zero. */
export function clampToZero(amount: Money): Money {
  return amount.amountMinor < 0 ? money(0, amount.currency) : amount;
}

export function min(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return a.amountMinor <= b.amountMinor ? a : b;
}

export function max(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return a.amountMinor >= b.amountMinor ? a : b;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

/** Converts a major-unit number (e.g. 1500.5) to minor units for the currency. */
export function fromMajor(amountMajor: number, currency: CurrencyCode = 'YER'): Money {
  const { exponent } = CURRENCIES[currency];
  return money(roundHalfUp(amountMajor * 10 ** exponent), currency);
}

export function toMajor(a: Money): number {
  return a.amountMinor / 10 ** CURRENCIES[a.currency].exponent;
}
