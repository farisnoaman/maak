/**
 * Double-entry ledger primitives.
 *
 * Invariants enforced here (and re-asserted by the DB, see ADR-11 / BR-26..27):
 *  1. every journal has >= 2 lines
 *  2. sum(debits) === sum(credits)
 *  3. all amounts are positive integers in minor units
 *  4. one currency per journal
 *
 * This module only *builds* entries. Posting them is the job of an edge command
 * (`confirm_payment`, `pay_refund`, ...) which passes the draft to a single SQL call.
 */

import type { CurrencyCode } from './money';

export type Direction = 'debit' | 'credit';

export const ACCOUNTS = {
  platformCash: 'platform_cash',
  platformBank: 'platform_bank',
  agentReceivable: 'agent_receivable',
  operatorPayable: 'operator_payable',
  operatorReceivable: 'operator_receivable',
  commissionRevenue: 'commission_revenue',
  refundExpense: 'refund_expense',
  subscriptionRevenue: 'subscription_revenue',
  payoutClearing: 'payout_clearing',
  suspense: 'suspense',
} as const;

export type AccountCode = (typeof ACCOUNTS)[keyof typeof ACCOUNTS];

export interface LedgerLine {
  readonly account: AccountCode;
  readonly direction: Direction;
  readonly amountMinor: number;
}

export type JournalSource =
  | 'payment'
  | 'refund'
  | 'payout'
  | 'invoice'
  | 'commission'
  | 'subscription'
  | 'adjustment';

export interface JournalDraft {
  readonly description: string;
  /** ISO date (YYYY-MM-DD) in Asia/Aden; postings are dated, not timestamped. */
  readonly postingDate: string;
  readonly source: { readonly type: JournalSource; readonly id: string };
  readonly currency: CurrencyCode;
  readonly lines: readonly LedgerLine[];
}

export interface Journal extends JournalDraft {
  readonly totalDebitMinor: number;
  readonly totalCreditMinor: number;
  readonly balanced: true;
}

export class UnbalancedJournalError extends Error {
  readonly code = 'UNBALANCED_JOURNAL';
  constructor(debit: number, credit: number) {
    super(`Journal does not balance: debit ${debit} !== credit ${credit}`);
    this.name = 'UnbalancedJournalError';
  }
}

export class InvalidLedgerLineError extends Error {
  readonly code = 'INVALID_LEDGER_LINE';
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidLedgerLineError';
  }
}

export function line(
  account: AccountCode,
  direction: Direction,
  amountMinor: number,
): LedgerLine {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new InvalidLedgerLineError(`Ledger amounts must be positive integers, got ${amountMinor}`);
  }
  return { account, direction, amountMinor };
}

export function totals(lines: readonly LedgerLine[]): { debit: number; credit: number } {
  return lines.reduce(
    (acc, l) => {
      if (l.direction === 'debit') acc.debit += l.amountMinor;
      else acc.credit += l.amountMinor;
      return acc;
    },
    { debit: 0, credit: 0 },
  );
}

export function isBalanced(lines: readonly LedgerLine[]): boolean {
  const { debit, credit } = totals(lines);
  return debit === credit;
}

/** Validates a draft and returns it with totals attached. Throws on any invariant breach. */
export function buildJournal(draft: JournalDraft): Journal {
  if (draft.lines.length < 2) {
    throw new InvalidLedgerLineError('A journal needs at least two lines');
  }
  const { debit, credit } = totals(draft.lines);
  if (debit !== credit) throw new UnbalancedJournalError(debit, credit);
  if (debit === 0) throw new InvalidLedgerLineError('A journal cannot be empty');
  return { ...draft, totalDebitMinor: debit, totalCreditMinor: credit, balanced: true };
}

/** Reverses a journal (corrections are always new entries, never edits). */
export function reverseLines(lines: readonly LedgerLine[]): LedgerLine[] {
  return lines.map((l) => ({
    account: l.account,
    direction: l.direction === 'debit' ? 'credit' : 'debit',
    amountMinor: l.amountMinor,
  }));
}

/**
 * A passenger pays `gross` for a booking; the platform keeps `commission` and owes the rest.
 *   debit  platform_cash          gross
 *   credit operator_payable       gross - commission
 *   credit commission_revenue     commission
 */
export function bookingPaidLines(grossMinor: number, commissionMinor: number): LedgerLine[] {
  if (commissionMinor < 0 || commissionMinor > grossMinor) {
    throw new InvalidLedgerLineError(
      `Commission ${commissionMinor} must be between 0 and the gross ${grossMinor}`,
    );
  }
  const payable = grossMinor - commissionMinor;
  const lines: LedgerLine[] = [line(ACCOUNTS.platformCash, 'debit', grossMinor)];
  if (payable > 0) lines.push(line(ACCOUNTS.operatorPayable, 'credit', payable));
  if (commissionMinor > 0) lines.push(line(ACCOUNTS.commissionRevenue, 'credit', commissionMinor));
  return lines;
}

/**
 * A booking is confirmed but not yet paid (cash on boarding, prepay-pending):
 * the platform has a receivable, not cash.
 *   debit  operator_receivable    gross - commission
 *   debit  commission_revenue?    no — commission is recognised when cash lands
 * Instead: debit operator_receivable gross, credit operator_payable gross.
 * Kept separate from bookingPaidLines so cash and credit are never conflated.
 */
export function bookingConfirmedUnpaidLines(grossMinor: number): LedgerLine[] {
  return [
    line(ACCOUNTS.operatorReceivable, 'debit', grossMinor),
    line(ACCOUNTS.operatorPayable, 'credit', grossMinor),
  ];
}

/**
 * Refund to a passenger out of previously collected cash.
 *   debit  operator_payable       amount
 *   credit platform_cash          amount
 * (Commission reversal, when policy requires it, is a separate adjustment entry.)
 */
export function refundLines(amountMinor: number): LedgerLine[] {
  return [
    line(ACCOUNTS.operatorPayable, 'debit', amountMinor),
    line(ACCOUNTS.platformCash, 'credit', amountMinor),
  ];
}

/**
 * Payout to an operator from the payable balance.
 *   debit  operator_payable       amount
 *   credit platform_bank          amount
 */
export function payoutLines(amountMinor: number): LedgerLine[] {
  return [
    line(ACCOUNTS.operatorPayable, 'debit', amountMinor),
    line(ACCOUNTS.platformBank, 'credit', amountMinor),
  ];
}

export function journal(
  source: JournalDraft['source'],
  description: string,
  postingDate: string,
  currency: CurrencyCode,
  lines: readonly LedgerLine[],
): Journal {
  return buildJournal({ source, description, postingDate, currency, lines });
}
