import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  bookingConfirmedUnpaidLines,
  bookingPaidLines,
  buildJournal,
  InvalidLedgerLineError,
  isBalanced,
  journal,
  line,
  payoutLines,
  refundLines,
  reverseLines,
  totals,
  UnbalancedJournalError,
} from '../src/domain/ledger';

const DATE = '2026-10-28';

describe('journal invariants', () => {
  it('requires at least two lines', () => {
    expect(() =>
      buildJournal({
        description: 'nope',
        postingDate: DATE,
        source: { type: 'payment', id: 'x' },
        currency: 'YER',
        lines: [line(ACCOUNTS.platformCash, 'debit', 100)],
      }),
    ).toThrow(InvalidLedgerLineError);
  });

  it('rejects unbalanced journals', () => {
    expect(() =>
      buildJournal({
        description: 'bad',
        postingDate: DATE,
        source: { type: 'payment', id: 'x' },
        currency: 'YER',
        lines: [
          line(ACCOUNTS.platformCash, 'debit', 100),
          line(ACCOUNTS.operatorPayable, 'credit', 90),
        ],
      }),
    ).toThrow(UnbalancedJournalError);
  });

  it('rejects zero and negative line amounts', () => {
    expect(() => line(ACCOUNTS.platformCash, 'debit', 0)).toThrow(InvalidLedgerLineError);
    expect(() => line(ACCOUNTS.platformCash, 'debit', -5)).toThrow(InvalidLedgerLineError);
  });

  it('accepts a balanced entry and reports totals', () => {
    const j = journal(
      { type: 'payment', id: 'pay_1' },
      'booking paid',
      DATE,
      'YER',
      [line(ACCOUNTS.platformCash, 'debit', 10_000), line(ACCOUNTS.operatorPayable, 'credit', 10_000)],
    );
    expect(j.balanced).toBe(true);
    expect(j.totalDebitMinor).toBe(10_000);
    expect(j.totalCreditMinor).toBe(10_000);
  });

  it('reversal flips direction and stays balanced', () => {
    const lines = bookingPaidLines(10_000, 500);
    const reversed = reverseLines(lines);
    expect(isBalanced(reversed)).toBe(true);
    const before = totals(lines);
    expect(totals(reversed)).toEqual({ debit: before.credit, credit: before.debit });
  });
});

describe('booking entries', () => {
  it('splits gross into operator payable and commission', () => {
    const lines = bookingPaidLines(10_000, 500);
    expect(totals(lines)).toEqual({ debit: 10_000, credit: 10_000 });
    expect(lines).toContainEqual({ account: ACCOUNTS.operatorPayable, direction: 'credit', amountMinor: 9_500 });
    expect(lines).toContainEqual({ account: ACCOUNTS.commissionRevenue, direction: 'credit', amountMinor: 500 });
  });

  it('omits the commission line when commission is zero', () => {
    const lines = bookingPaidLines(5_000, 0);
    expect(lines).toHaveLength(2);
    expect(isBalanced(lines)).toBe(true);
  });

  it('rejects commission larger than the gross', () => {
    expect(() => bookingPaidLines(1_000, 1_001)).toThrow(InvalidLedgerLineError);
  });

  it('models an unpaid confirmed booking as receivable/payable', () => {
    const lines = bookingConfirmedUnpaidLines(7_500);
    expect(totals(lines)).toEqual({ debit: 7_500, credit: 7_500 });
    expect(lines[0]?.account).toBe(ACCOUNTS.operatorReceivable);
  });
});

describe('refund and payout entries', () => {
  it('refunds out of collected cash and balances', () => {
    const lines = refundLines(3_000);
    expect(isBalanced(lines)).toBe(true);
    expect(lines).toContainEqual({ account: ACCOUNTS.platformCash, direction: 'credit', amountMinor: 3_000 });
  });

  it('pays out of the payable balance and balances', () => {
    const lines = payoutLines(25_000);
    expect(isBalanced(lines)).toBe(true);
  });
});
