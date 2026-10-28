import { describe, expect, it } from 'vitest';
import {
  applyPlanCommissionDiscount,
  CommissionError,
  computeCommission,
  computeRefund,
} from '../src/domain/finance';

describe('commission', () => {
  it('takes a percentage of the gross', () => {
    expect(computeCommission(10_000, { kind: 'percent', value: 500 })).toBe(500);
  });

  it('rounds half-up and never returns zero for a real percentage', () => {
    // 5% of 1 YER = 0.05 -> would round to 0
    expect(computeCommission(1, { kind: 'percent', value: 500 })).toBe(1);
  });

  it('respects floors and caps', () => {
    expect(computeCommission(10_000, { kind: 'percent', value: 500, minMinor: 1_000 })).toBe(1_000);
    expect(computeCommission(1_000_000, { kind: 'percent', value: 500, maxMinor: 2_000 })).toBe(2_000);
  });

  it('never exceeds the gross', () => {
    expect(computeCommission(100, { kind: 'fixed', value: 5_000 })).toBe(100);
  });

  it('rejects invalid gross amounts', () => {
    expect(() => computeCommission(-1, { kind: 'percent', value: 500 })).toThrow(CommissionError);
  });

  it('applies plan commission discounts', () => {
    expect(applyPlanCommissionDiscount(500, 'basic')).toBe(500);
    expect(applyPlanCommissionDiscount(500, 'pro')).toBe(400);
    expect(applyPlanCommissionDiscount(500, 'business')).toBe(300);
    expect(applyPlanCommissionDiscount(50, 'business')).toBe(0);
  });
});

describe('refunds', () => {
  it('refunds in full outside the cutoff', () => {
    const d = computeRefund({ paidMinor: 10_000, hoursBeforeStart: 5 });
    expect(d).toEqual({ amountMinor: 10_000, eligible: true, appliedBasisPoints: 10_000, reason: 'full' });
  });

  it('refuses inside the cutoff', () => {
    const d = computeRefund({ paidMinor: 10_000, hoursBeforeStart: 1.9 });
    expect(d.eligible).toBe(false);
    expect(d.amountMinor).toBe(0);
    expect(d.reason).toBe('outside_policy');
  });

  it('treats exactly the cutoff as refundable', () => {
    expect(computeRefund({ paidMinor: 1_000, hoursBeforeStart: 2 }).eligible).toBe(true);
  });

  it('handles nothing paid', () => {
    expect(computeRefund({ paidMinor: 0, hoursBeforeStart: 10 }).reason).toBe('nothing_paid');
  });

  it('supports tiered policies (first matching tier wins)', () => {
    const policy = {
      cutoffHours: 2,
      kind: 'tiered' as const,
      tiers: [
        { hoursBeforeStart: 48, basisPoints: 10_000 },
        { hoursBeforeStart: 24, basisPoints: 5_000 },
        { hoursBeforeStart: 2, basisPoints: 2_000 },
      ],
    };
    expect(computeRefund({ paidMinor: 10_000, hoursBeforeStart: 72, policy }).amountMinor).toBe(10_000);
    expect(computeRefund({ paidMinor: 10_000, hoursBeforeStart: 30, policy }).amountMinor).toBe(5_000);
    expect(computeRefund({ paidMinor: 10_000, hoursBeforeStart: 3, policy }).amountMinor).toBe(2_000);
    expect(computeRefund({ paidMinor: 10_000, hoursBeforeStart: 1, policy }).eligible).toBe(false);
  });
});
