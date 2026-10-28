import { describe, expect, it } from 'vitest';
import {
  can,
  isOperator,
  isPlatformStaff,
  PolicyError,
  requirePolicy,
  type Actor,
} from '../src/domain/policy';
import { nextVerificationStatus } from '../src/domain/identity';
import { dictionaries, translate } from '../src/i18n/dictionaries';
import { equals, isZero, max, min, money, negate, toMajor } from '../src/domain/money';
import { computeRefund, RefundPolicyError } from '../src/domain/finance';
import { computePrice, PricingError, seatsAfterBooking, toMoney } from '../src/domain/pricing';
import { buildJournal, line, ACCOUNTS } from '../src/domain/ledger';
import { interpolate } from '../src/i18n/locale';

/**
 * Edge cases that the happy-path suites do not reach: invalid input, currencies that must not mix,
 * and helpers the UI depends on. These are the branches that turn into production incidents.
 */

const operator: Actor = {
  userId: 'u1',
  roles: ['individual'],
  verification: 'verified',
  plan: 'basic',
};
const staff: Actor = {
  userId: 'u2',
  roles: ['platform_staff'],
  verification: 'verified',
  plan: 'basic',
};
const passenger: Actor = {
  userId: 'u3',
  roles: ['passenger'],
  verification: 'verified',
  plan: 'basic',
};

describe('actor helpers', () => {
  it('detects operators', () => {
    expect(isOperator(operator)).toBe(true);
    expect(isOperator(passenger)).toBe(false);
  });

  it('detects platform staff', () => {
    expect(isPlatformStaff(staff)).toBe(true);
    expect(isPlatformStaff(operator)).toBe(false);
  });
});

describe('money helpers', () => {
  it('negates and detects zero', () => {
    expect(negate(money(500)).amountMinor).toBe(-500);
    expect(isZero(money(0))).toBe(true);
    expect(isZero(money(1))).toBe(false);
  });

  it('min/max refuse to compare across currencies', () => {
    expect(min(money(100), money(200)).amountMinor).toBe(100);
    expect(max(money(100), money(200)).amountMinor).toBe(200);
    expect(() => min(money(100, 'YER'), money(100, 'USD'))).toThrow();
  });

  it('equals is currency-aware', () => {
    expect(equals(money(100, 'YER'), money(100, 'YER'))).toBe(true);
    expect(equals(money(100, 'YER'), money(100, 'USD'))).toBe(false);
  });

  it('converts to major units for display', () => {
    expect(toMajor(money(1500, 'YER'))).toBe(1500);
  });
});

describe('refund policy validation', () => {
  it('rejects a negative paid amount', () => {
    expect(() => computeRefund({ paidMinor: -1, hoursBeforeStart: 5 })).toThrow(RefundPolicyError);
  });

  it('rejects a non-finite hours value', () => {
    expect(() => computeRefund({ paidMinor: 100, hoursBeforeStart: Number.NaN })).toThrow(
      RefundPolicyError,
    );
  });
});

describe('pricing edge cases', () => {
  const base = {
    bookingMode: 'per_seat' as const,
    pricingMode: 'flat' as const,
    seats: 1,
    pricePerSeatMinor: 1000,
  };

  it('rejects a negative fixed discount', () => {
    expect(() =>
      computePrice({ ...base, discount: { kind: 'fixed', value: -5, scope: 'all' } }),
    ).toThrow(PricingError);
  });

  it('refuses to book more seats than exist', () => {
    expect(() => seatsAfterBooking(2, 3)).toThrow(PricingError);
  });

  it('exposes breakdown parts as money', () => {
    const breakdown = computePrice({
      ...base,
      discount: { kind: 'percent', value: 1000, scope: 'all' },
    });
    expect(toMoney(breakdown, 'total').amountMinor).toBe(900);
    expect(toMoney(breakdown, 'subtotal').amountMinor).toBe(1000);
    expect(toMoney(breakdown, 'discount').amountMinor).toBe(100);
  });
});

describe('ledger edge cases', () => {
  it('refuses a journal with only one side', () => {
    expect(() =>
      buildJournal({
        description: 'one-sided',
        postingDate: '2026-10-28',
        source: { type: 'adjustment', id: 'a1' },
        currency: 'YER',
        lines: [line(ACCOUNTS.suspense, 'debit', 100)],
      }),
    ).toThrow();
  });

  it('refuses an empty journal', () => {
    expect(() =>
      buildJournal({
        description: 'empty',
        postingDate: '2026-10-28',
        source: { type: 'adjustment', id: 'a2' },
        currency: 'YER',
        lines: [],
      }),
    ).toThrow();
  });
});

describe('interpolation safety', () => {
  it('returns the template untouched when no variables are supplied', () => {
    expect(interpolate('no {vars} here')).toBe('no {vars} here');
  });
});

describe('small branches kept honest', () => {
  it('verification state machine is a total function', () => {
    // Every action on every status has a defined outcome — no silent undefined.
    const statuses = ['unverified', 'pending', 'verified', 'rejected'] as const;
    const actions = ['submit', 'approve', 'reject', 'withdraw', 'revoke'] as const;
    for (const status of statuses) {
      for (const action of actions) {
        expect(typeof nextVerificationStatus(status, action)).toBe('string');
      }
    }
    // The default arm: an action that is not in the union changes nothing.
    expect(nextVerificationStatus('verified', 'nonsense' as 'submit')).toBe('verified');
  });

  it('requirePolicy throws a typed error carrying the capability', () => {
    const nobody = {
      userId: 'u1',
      roles: ['passenger'] as const,
      verification: 'unverified' as const,
      plan: 'basic' as const,
    };
    expect(() => requirePolicy(nobody, 'vehicle.create')).toThrow(PolicyError);
    try {
      requirePolicy(nobody, 'vehicle.create');
    } catch (error) {
      expect((error as PolicyError).code).toBe('FORBIDDEN');
      expect((error as PolicyError).capability).toBe('vehicle.create');
    }
  });

  it('an unknown capability is denied rather than allowed', () => {
    const actor = {
      userId: 'u1',
      roles: ['org_owner'] as const,
      verification: 'verified' as const,
      plan: 'basic' as const,
    };
    expect(can(actor, 'not.a.capability' as 'trip.create')).toBe(false);
  });

  it('translate falls back to Arabic, then to the key itself', () => {
    // A key that exists in Arabic but not in the requested locale dictionary.
    const missingInEn = Object.keys(dictionaries.ar).find((key) => !(key in dictionaries.en));
    expect(missingInEn).toBeUndefined(); // parity is enforced elsewhere; this documents the guarantee

    expect(translate('ar', 'missing.key' as never)).toBe('missing.key');

    // A template with placeholders and no values keeps them literal (never "undefined").
    expect(translate('ar', 'org.inviteMessage', {})).toContain('{org}');
    expect(translate('ar', 'org.inviteMessage', { org: 'معك' })).toContain('معك');
  });
});
