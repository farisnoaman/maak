/**
 * Commission and refund math — pure, deterministic, unit-testable.
 *
 * These functions decide *how much*; the SQL command decides *whether* the
 * actor may trigger them and writes the resulting journal atomically.
 */

import { percentOf } from './money';

export type PlanCode = 'basic' | 'pro' | 'business';

export interface CommissionRule {
  readonly kind: 'percent' | 'fixed';
  /** percent -> basis points (500 = 5%). fixed -> minor units. */
  readonly value: number;
  readonly minMinor?: number | null;
  readonly maxMinor?: number | null;
}

export class CommissionError extends Error {
  readonly code = 'INVALID_COMMISSION_RULE';
  constructor(message: string) {
    super(message);
    this.name = 'CommissionError';
  }
}

export function computeCommission(grossMinor: number, rule: CommissionRule): number {
  if (!Number.isSafeInteger(grossMinor) || grossMinor < 0) {
    throw new CommissionError(`Gross must be a non-negative integer, got ${grossMinor}`);
  }
  let amount = rule.kind === 'percent' ? percentOf(grossMinor, rule.value) : Math.trunc(rule.value);

  if (rule.minMinor != null) amount = Math.max(amount, rule.minMinor);
  if (rule.maxMinor != null) amount = Math.min(amount, rule.maxMinor);
  if (grossMinor > 0 && rule.kind === 'percent' && rule.value > 0) {
    // never let rounding turn a real commission into zero
    amount = Math.max(amount, 1);
  }
  return Math.min(Math.max(amount, 0), grossMinor);
}

export type RefundReason = 'full' | 'partial' | 'outside_policy' | 'nothing_paid';

export interface RefundPolicy {
  /** Hours before departure after which the booking is no longer refundable. */
  readonly cutoffHours: number;
  readonly kind: 'full' | 'tiered';
  /** Applied when kind = 'tiered'; first matching tier wins (descending hours). */
  readonly tiers?: readonly { readonly hoursBeforeStart: number; readonly basisPoints: number }[];
}

export interface RefundDecision {
  readonly amountMinor: number;
  readonly eligible: boolean;
  readonly appliedBasisPoints: number;
  readonly reason: RefundReason;
}

export const DEFAULT_REFUND_POLICY: RefundPolicy = { cutoffHours: 2, kind: 'full' };

/**
 * The booking policy the database mirrors in `app.compute_refund()`.
 *
 * ≥ 48 h → 100 %, ≥ 24 h → 75 %, ≥ 2 h → 50 %, inside 2 h → nothing. Operator cancellations do not use
 * this ladder: the passenger did nothing wrong, so they get everything back.
 *
 * `supabase/tests/0008_bookings.test.sql` asserts the same five numbers against the SQL function, so a
 * change on one side without the other fails a suite instead of shipping a wrong refund.
 */
export const BOOKING_REFUND_POLICY: RefundPolicy = {
  cutoffHours: 2,
  kind: 'tiered',
  tiers: [
    { hoursBeforeStart: 48, basisPoints: 10_000 },
    { hoursBeforeStart: 24, basisPoints: 7_500 },
    { hoursBeforeStart: 2, basisPoints: 5_000 },
  ],
};

export class RefundPolicyError extends Error {
  readonly code = 'INVALID_REFUND_POLICY';
  constructor(message: string) {
    super(message);
    this.name = 'RefundPolicyError';
  }
}

export function computeRefund(input: {
  readonly paidMinor: number;
  readonly hoursBeforeStart: number;
  readonly policy?: RefundPolicy;
}): RefundDecision {
  const { paidMinor, hoursBeforeStart } = input;
  const policy = input.policy ?? DEFAULT_REFUND_POLICY;

  if (!Number.isSafeInteger(paidMinor) || paidMinor < 0) {
    throw new RefundPolicyError(`Paid amount must be a non-negative integer, got ${paidMinor}`);
  }
  if (!Number.isFinite(hoursBeforeStart)) {
    throw new RefundPolicyError(`hoursBeforeStart must be finite, got ${hoursBeforeStart}`);
  }
  if (paidMinor === 0) {
    return { amountMinor: 0, eligible: false, appliedBasisPoints: 0, reason: 'nothing_paid' };
  }

  if (policy.kind === 'full') {
    const eligible = hoursBeforeStart >= policy.cutoffHours;
    return eligible
      ? {
          amountMinor: paidMinor,
          eligible: true,
          appliedBasisPoints: 10_000,
          reason: 'full',
        }
      : { amountMinor: 0, eligible: false, appliedBasisPoints: 0, reason: 'outside_policy' };
  }

  const tiers = [...(policy.tiers ?? [])].sort((a, b) => b.hoursBeforeStart - a.hoursBeforeStart);
  const tier = tiers.find((t) => hoursBeforeStart >= t.hoursBeforeStart);
  if (!tier || tier.basisPoints <= 0) {
    return { amountMinor: 0, eligible: false, appliedBasisPoints: 0, reason: 'outside_policy' };
  }
  const amountMinor = Math.min(percentOf(paidMinor, tier.basisPoints), paidMinor);
  const full = tier.basisPoints >= 10_000;
  return {
    amountMinor,
    eligible: true,
    appliedBasisPoints: tier.basisPoints,
    reason: full ? 'full' : 'partial',
  };
}

/** Plan commission discount in basis points (Pro -1pp, Business -2pp by default). */
export function applyPlanCommissionDiscount(
  basisPoints: number,
  plan: PlanCode,
  discounts: Partial<Record<PlanCode, number>> = { pro: 100, business: 200 },
): number {
  const reduction = discounts[plan] ?? 0;
  return Math.max(0, basisPoints - reduction);
}
