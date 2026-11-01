import { describe, expect, it } from 'vitest';
import {
  paymentsActionSchema,
  paymentsCommandArgs,
  paymentsScope,
  type PaymentsAction,
} from '../src/api/payments';

const audit = { p_request_id: 'req-1', p_ip: null } as const;
const actor = '11111111-1111-4111-8111-111111111111';
const uuid = '22222222-2222-4222-8222-222222222222';

function parse(input: unknown): PaymentsAction {
  return paymentsActionSchema.parse(input);
}

describe('payments contract', () => {
  it('rejects an amount the form could not honestly produce', () => {
    expect(() =>
      parse({ action: 'refund.request', bookingId: uuid, amountYer: -5, reason: 'سبب واضح' }),
    ).toThrow();
    expect(() =>
      parse({ action: 'refund.request', bookingId: uuid, amountYer: 1.5, reason: 'سبب واضح' }),
    ).toThrow();
  });

  it('requires a reason worth reading', () => {
    expect(() => parse({ action: 'payment.reject', intentId: uuid, reason: 'no' })).toThrow();
    expect(
      parse({ action: 'payment.reject', intentId: uuid, reason: 'الصورة غير واضحة' }),
    ).toBeTruthy();
  });

  it('accepts a proof hash only as sha256 hex, lowercased on the way to SQL', () => {
    const hash = 'A'.repeat(64);
    const action = parse({
      action: 'payment.proof.submit',
      intentId: uuid,
      proofPath: `${uuid}/receipt.jpg`,
      proofHash: hash,
    });
    const { fn, args } = paymentsCommandArgs(action, actor, audit);
    expect(fn).toBe('cmd_submit_payment_proof');
    expect(args.p_proof_hash).toBe('a'.repeat(64));
  });

  it('never sends an amount the client chose as the amount to charge', () => {
    // The claim travels separately from the command's own computation: `p_intent.claimedAmountYer` is only
    // compared, and the booking id is what the SQL uses to derive the real figure.
    const action = parse({
      action: 'payment.intent.create',
      bookingId: uuid,
      method: 'jaib',
      clientReference: 'client-ref-1',
    });
    const { fn, args } = paymentsCommandArgs(action, actor, audit);
    expect(fn).toBe('cmd_create_payment_intent');
    expect((args.p_intent as Record<string, unknown>).bookingId).toBe(uuid);
    expect((args.p_intent as Record<string, unknown>).claimedAmountYer).toBeNull();
  });

  it('maps each verb to exactly one command', () => {
    const cases: Array<[PaymentsAction, string]> = [
      [parse({ action: 'payment.confirm', intentId: uuid }), 'cmd_confirm_payment'],
      [
        parse({ action: 'payment.account.verify', accountId: uuid, approve: true }),
        'cmd_verify_payment_account',
      ],
      [
        parse({ action: 'refund.decide', refundId: uuid, approve: false, note: 'رفض' }),
        'cmd_decide_refund',
      ],
      [parse({ action: 'refund.pay', refundId: uuid, reference: 'RF-1' }), 'cmd_pay_refund'],
      [parse({ action: 'agent.cashIn', agentId: uuid, amountYer: 500 }), 'cmd_agent_cash_in'],
      [parse({ action: 'payout.approve', payoutId: uuid }), 'cmd_approve_payout'],
      [parse({ action: 'payout.pay', payoutId: uuid, reference: 'BK-9' }), 'cmd_mark_payout_paid'],
      [
        parse({ action: 'payout.request', amountYer: 900, method: 'kuraimi' }),
        'cmd_request_payout',
      ],
      [parse({ action: 'payment.intent.cancel', intentId: uuid }), 'cmd_cancel_payment_intent'],
    ];
    for (const [action, expected] of cases) {
      expect(paymentsCommandArgs(action, actor, audit).fn).toBe(expected);
    }
  });

  it('claims a scope without granting one', () => {
    expect(paymentsScope(parse({ action: 'payment.confirm', intentId: uuid }))).toEqual({
      isOwner: true,
      isOrgMember: true,
    });
    expect(
      paymentsScope(
        parse({
          action: 'payment.intent.create',
          bookingId: uuid,
          method: 'cash_one',
          clientReference: 'client-ref-2',
        }),
      ),
    ).toEqual({ isBooker: true });
    expect(
      paymentsScope(parse({ action: 'payout.request', amountYer: 100, method: 'jaib' })),
    ).toEqual({ isOwner: true });
  });
});
