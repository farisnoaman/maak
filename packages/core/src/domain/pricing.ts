/**
 * Trip fare pricing — pure functions, no I/O.
 *
 * Mirrors specs.md §6.4:
 *  - booking mode: per seat | whole trip | both
 *  - stops pricing: one flat price for all stops, or a price per stop (from origin)
 *  - discounts: none | fixed amount | percentage, scoped to per-seat, whole-trip or all
 *
 * Every amount is in minor units. The returned breakdown is UI-ready and the
 * same numbers are re-validated by the `cmd_booking_create` SQL command.
 */

import type { CurrencyCode } from './money';
import { clampToZero, money, percentOf, type Money } from './money';

export type BookingMode = 'per_seat' | 'whole_trip' | 'both';
export type PricingMode = 'flat' | 'per_stop';
export type DiscountKind = 'none' | 'fixed' | 'percent';
export type DiscountScope = 'per_seat' | 'whole_trip' | 'all';

export interface Discount {
  readonly kind: DiscountKind;
  /** fixed: minor units. percent: basis points (1000 = 10%). */
  readonly value: number;
  readonly scope: DiscountScope;
}

export interface StopPrice {
  readonly stopId: string;
  /** null/undefined -> fall back to the trip's price per seat */
  readonly priceFromOriginMinor?: number | null;
}

export interface PricingInput {
  readonly bookingMode: BookingMode;
  readonly pricingMode: PricingMode;
  readonly seats: number;
  readonly pricePerSeatMinor: number;
  readonly wholeTripPriceMinor?: number | null;
  /** Required when pricingMode = 'per_stop' and the passenger boards at a stop. */
  readonly boardingStop?: StopPrice | null;
  readonly discount?: Discount | null;
  readonly currency?: CurrencyCode;
}

export type ComponentKey = 'fare' | 'discount';

export interface PriceComponent {
  readonly key: ComponentKey;
  readonly amountMinor: number;
}

export interface PriceBreakdown {
  readonly currency: CurrencyCode;
  readonly unitFareMinor: number;
  readonly seats: number;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  readonly components: readonly PriceComponent[];
}

export class PricingError extends Error {
  readonly code: 'INVALID_SEATS' | 'MISSING_WHOLE_TRIP_PRICE' | 'MODE_NOT_ALLOWED' | 'INVALID_PRICE';
  constructor(code: PricingError['code'], message: string) {
    super(message);
    this.name = 'PricingError';
    this.code = code;
  }
}

function assertNonNegative(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PricingError('INVALID_PRICE', `${field} must be a non-negative integer, got ${value}`);
  }
}

export function computeDiscountMinor(
  subtotalMinor: number,
  discount: Discount | null | undefined,
  bookingMode: BookingMode,
): number {
  if (!discount || discount.kind === 'none') return 0;
  const scopeMatches =
    discount.scope === 'all' ||
    (discount.scope === 'per_seat' && bookingMode !== 'whole_trip') ||
    (discount.scope === 'whole_trip' && bookingMode === 'whole_trip');
  if (!scopeMatches) return 0;

  const raw =
    discount.kind === 'percent'
      ? percentOf(subtotalMinor, discount.value)
      : Math.trunc(discount.value);

  if (!Number.isFinite(raw) || raw < 0) {
    throw new PricingError('INVALID_PRICE', `Invalid discount value ${discount.value}`);
  }
  return Math.min(raw, subtotalMinor);
}

export function computePrice(input: PricingInput): PriceBreakdown {
  const {
    bookingMode,
    pricingMode,
    seats,
    pricePerSeatMinor,
    wholeTripPriceMinor,
    boardingStop,
    discount,
    currency = 'YER',
  } = input;

  if (!Number.isInteger(seats) || seats < 1) {
    throw new PricingError('INVALID_SEATS', `Seats must be a positive integer, got ${seats}`);
  }
  assertNonNegative(pricePerSeatMinor, 'pricePerSeatMinor');

  let unitFareMinor: number;
  let subtotalMinor: number;

  if (bookingMode === 'whole_trip') {
    if (wholeTripPriceMinor == null) {
      throw new PricingError(
        'MISSING_WHOLE_TRIP_PRICE',
        'wholeTripPriceMinor is required when bookingMode is whole_trip',
      );
    }
    assertNonNegative(wholeTripPriceMinor, 'wholeTripPriceMinor');
    unitFareMinor = wholeTripPriceMinor;
    subtotalMinor = wholeTripPriceMinor;
  } else {
    const stopPrice = boardingStop?.priceFromOriginMinor;
    if (pricingMode === 'per_stop' && stopPrice != null) {
      assertNonNegative(stopPrice, 'boardingStop.priceFromOriginMinor');
      unitFareMinor = stopPrice;
    } else {
      unitFareMinor = pricePerSeatMinor;
    }
    subtotalMinor = unitFareMinor * seats;
  }

  const discountMinor = computeDiscountMinor(subtotalMinor, discount, bookingMode);
  const totalMinor = clampToZero(money(subtotalMinor - discountMinor, currency)).amountMinor;

  const components: PriceComponent[] = [{ key: 'fare', amountMinor: subtotalMinor }];
  if (discountMinor > 0) components.push({ key: 'discount', amountMinor: -discountMinor });

  return {
    currency,
    unitFareMinor,
    seats,
    subtotalMinor,
    discountMinor,
    totalMinor,
    components,
  };
}

/** True when the trip still has room for `requested` seats. */
export function canFit(seatsAvailable: number, requested: number): boolean {
  return Number.isInteger(requested) && requested > 0 && requested <= seatsAvailable;
}

export function seatsAfterBooking(seatsAvailable: number, requested: number): number {
  if (!canFit(seatsAvailable, requested)) {
    throw new PricingError('INVALID_SEATS', `Cannot book ${requested} of ${seatsAvailable} seats`);
  }
  return seatsAvailable - requested;
}

export function toMoney(breakdown: PriceBreakdown, key: 'total' | 'subtotal' | 'discount'): Money {
  const map = {
    total: breakdown.totalMinor,
    subtotal: breakdown.subtotalMinor,
    discount: breakdown.discountMinor,
  } as const;
  return money(map[key], breakdown.currency);
}
