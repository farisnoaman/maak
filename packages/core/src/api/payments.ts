/**
 * Payments — the shared contract between the pay screen, the operator's money inbox, the finance desk
 * and the gateway (Phase 9).
 *
 * One edge function (`payments`) dispatches on `action`, and every branch maps to exactly one `cmd_*`
 * from migration 00030: one request, one transaction, one audit row. Reads are absent on purpose — a
 * passenger's payments, the confirmation queue and the finance ledger are RLS-filtered PostgREST reads,
 * because a read that needs a transaction is a read that will be slow.
 *
 * Two rules run through every schema here:
 *
 *   1. **The amount is never an input to a decision.** `claimedAmountYer` is what the page displayed;
 *      the command recomputes the real amount from the booking and refuses with `PRICE_CHANGED` when the
 *      two disagree. A payment form that posts `amount` is a payment form that can be edited.
 *   2. **Money moves in more than one hand.** Asking for a refund, approving it and paying it are three
 *      different actions for a reason; so are requesting a payout, approving it and marking it paid.
 *
 * There is no card gateway. Methods are the ones people in Yemen actually use: Jaib, M-Floos, YemPay,
 * Kuraimi, Tadhamon, cash at a desk, and a bank deposit — recorded with a receipt image and a human
 * confirmation, not captured through a PSP.
 */

import { z } from 'zod';

import type { Resource } from '../domain/policy';

const uuid = z.string().uuid();

/** The rails the platform records. Kept in step with the `payment_method` enum in 00030. */
export const paymentMethodSchema = z.enum([
  'jaib',
  'cash_one',
  'mfloos',
  'yempay',
  'kuraimi',
  'tadhamon',
  'cash_desk',
  'bank_transfer',
  'other',
]);

export const paymentPurposeSchema = z.enum(['booking', 'deposit', 'subscription', 'commission']);
export const paymentAccountKindSchema = z.enum(['platform', 'owner', 'agent']);

/**
 * An amount in Yemeni rials. Integer, because a rial has no practical subdivision and a float here would
 * round somebody's deposit down. The ceiling is a sanity bound, not a business rule.
 */
const amount = z.number().int().min(1).max(100_000_000);

/**
 * An optional free-text field. Empty and absent both mean `null` — a form that clears a note must not be
 * the same as a form that fails validation — and `.optional()` keeps the key out of the required set so a
 * caller can omit what it has nothing to say about.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value == null || value === '' ? null : value))
    .optional();

export const createPaymentAccountSchema = z.object({
  action: z.literal('payment.account.create'),
  kind: paymentAccountKindSchema.default('owner'),
  method: paymentMethodSchema,
  /** Present for an organization account; absent for a personal one. */
  orgId: uuid.nullish().transform((value) => value ?? null),
  accountNumber: z.string().trim().min(3).max(60),
  holderName: z.string().trim().min(3).max(120),
  providerLabel: optionalText(60),
  instructionsAr: optionalText(300),
  instructionsEn: optionalText(300),
  isDefault: z.boolean().default(false),
  verificationDocumentPath: optionalText(300),
});

export const verifyPaymentAccountSchema = z.object({
  action: z.literal('payment.account.verify'),
  accountId: uuid,
  approve: z.boolean(),
  /** Required when refusing — an account refused without a reason cannot be fixed. */
  note: optionalText(300),
});

export const archivePaymentAccountSchema = z.object({
  action: z.literal('payment.account.archive'),
  accountId: uuid,
  reason: optionalText(300),
});

export const createPaymentIntentSchema = z.object({
  action: z.literal('payment.intent.create'),
  bookingId: uuid,
  method: paymentMethodSchema,
  purpose: paymentPurposeSchema.default('booking'),
  /** What the page showed. Compared, never trusted. */
  claimedAmountYer: z.number().int().min(0).nullish(),
  /**
   * The client's own idempotency token, so a double tap on "pay" opens one intent rather than two.
   * Unique per payer; re-sending the same value returns the intent that already exists.
   */
  clientReference: z.string().trim().min(6).max(80),
  note: optionalText(300),
});

export const submitPaymentProofSchema = z.object({
  action: z.literal('payment.proof.submit'),
  intentId: uuid,
  /** Object path inside the `payment-proofs` bucket. */
  proofPath: z.string().trim().min(3).max(300),
  /** sha256 of the image bytes, computed client-side. One image pays for one thing. */
  proofHash: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/i, 'expected a sha256 hex digest'),
  referenceNo: optionalText(80),
  claimedAmountYer: z.number().int().min(0).nullish(),
});

export const confirmPaymentSchema = z.object({
  action: z.literal('payment.confirm'),
  intentId: uuid,
  note: optionalText(300),
});

export const rejectPaymentSchema = z.object({
  action: z.literal('payment.reject'),
  intentId: uuid,
  reason: z.string().trim().min(5).max(300),
});

export const cancelPaymentIntentSchema = z.object({
  action: z.literal('payment.intent.cancel'),
  intentId: uuid,
  reason: optionalText(300),
});

export const requestRefundSchema = z.object({
  action: z.literal('refund.request'),
  bookingId: uuid,
  amountYer: amount,
  reason: z.string().trim().min(5).max(500),
});

export const decideRefundSchema = z.object({
  action: z.literal('refund.decide'),
  refundId: uuid,
  approve: z.boolean(),
  note: optionalText(300),
});

export const payRefundSchema = z.object({
  action: z.literal('refund.pay'),
  refundId: uuid,
  /** The transfer reference finance will match against their statement. */
  reference: optionalText(80),
});

export const agentCashInSchema = z.object({
  action: z.literal('agent.cashIn'),
  agentId: uuid,
  amountYer: amount,
  note: optionalText(300),
});

export const requestPayoutSchema = z.object({
  action: z.literal('payout.request'),
  /** Which wallet receives it. A payout always names where the money lands. */
  orgId: uuid.nullish().transform((value) => value ?? null),
  amountYer: amount,
  method: paymentMethodSchema,
  destinationAccountId: uuid.nullish().transform((value) => value ?? null),
  note: optionalText(300),
});

export const approvePayoutSchema = z.object({
  action: z.literal('payout.approve'),
  payoutId: uuid,
  note: optionalText(300),
});

export const payPayoutSchema = z.object({
  action: z.literal('payout.pay'),
  payoutId: uuid,
  reference: optionalText(80),
});

export const paymentsActionSchema = z.discriminatedUnion('action', [
  createPaymentAccountSchema,
  verifyPaymentAccountSchema,
  archivePaymentAccountSchema,
  createPaymentIntentSchema,
  submitPaymentProofSchema,
  confirmPaymentSchema,
  rejectPaymentSchema,
  cancelPaymentIntentSchema,
  requestRefundSchema,
  decideRefundSchema,
  payRefundSchema,
  agentCashInSchema,
  requestPayoutSchema,
  approvePayoutSchema,
  payPayoutSchema,
]);

export type PaymentsAction = z.infer<typeof paymentsActionSchema>;
export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentSchema>;
export type SubmitPaymentProofInput = z.infer<typeof submitPaymentProofSchema>;

/**
 * The scope facts an actor claims.
 *
 * A claim, not a grant: every command re-derives ownership from the booking, the trip or the account
 * row, so an operator who claims `isOwner` for somebody else's trip gets 42501 rather than access.
 */
export function paymentsScope(input: PaymentsAction): Resource {
  switch (input.action) {
    // A passenger paying for their own seat. The command checks `passenger_id` / `booked_by`.
    case 'payment.intent.create':
    case 'payment.proof.submit':
    case 'payment.intent.cancel':
    case 'refund.request':
      return { isBooker: true };
    // An operator or agent looking at their own money, which may be organizational.
    case 'payment.account.create':
    case 'payout.request':
      return input.orgId ? { isOrgMember: true } : { isOwner: true };
    // Confirming, rejecting and paying back happens on the operator's own trip or at the finance desk.
    default:
      return { isOwner: true, isOrgMember: true };
  }
}

export const paymentResultSchema = z
  .object({
    account: z.record(z.string(), z.unknown()).optional(),
    intent: z.record(z.string(), z.unknown()).optional(),
    refund: z.record(z.string(), z.unknown()).optional(),
    payout: z.record(z.string(), z.unknown()).optional(),
    agent: z.record(z.string(), z.unknown()).optional(),
    transaction: z.record(z.string(), z.unknown()).optional(),
    /** `false` when a repeat call found the work already done — the successful no-op. */
    created: z.boolean().optional(),
    changed: z.boolean().optional(),
    /** Recomputed by the database, so the UI can print what it was charged without re-reading. */
    bookingPaymentStatus: z.string().optional(),
    requestId: z.string().optional(),
  })
  .passthrough();

export const paymentsCommandSpec = {
  path: 'payments',
  input: paymentsActionSchema,
  output: paymentResultSchema,
  mutating: true,
} as const;

/** Action → SQL function and arguments. The names are checked against the migrations by a guard. */
export function paymentsCommandArgs(
  action: PaymentsAction,
  actorId: string,
  audit: { readonly p_request_id: string; readonly p_ip: string | null },
): { fn: string; args: Record<string, unknown> } {
  switch (action.action) {
    case 'payment.account.create':
      return {
        fn: 'cmd_create_payment_account',
        args: {
          p_actor: actorId,
          p_account: {
            kind: action.kind,
            method: action.method,
            orgId: action.orgId,
            accountNumber: action.accountNumber,
            holderName: action.holderName,
            providerLabel: action.providerLabel,
            instructionsAr: action.instructionsAr,
            instructionsEn: action.instructionsEn,
            isDefault: action.isDefault,
            verificationDocumentPath: action.verificationDocumentPath,
          },
          ...audit,
        },
      };
    case 'payment.account.verify':
      return {
        fn: 'cmd_verify_payment_account',
        args: {
          p_actor: actorId,
          p_account_id: action.accountId,
          p_approve: action.approve,
          p_note: action.note,
          ...audit,
        },
      };
    case 'payment.account.archive':
      return {
        fn: 'cmd_archive_payment_account',
        args: {
          p_actor: actorId,
          p_account_id: action.accountId,
          p_reason: action.reason,
          ...audit,
        },
      };
    case 'payment.intent.create':
      return {
        fn: 'cmd_create_payment_intent',
        args: {
          p_actor: actorId,
          p_intent: {
            bookingId: action.bookingId,
            method: action.method,
            purpose: action.purpose,
            claimedAmountYer: action.claimedAmountYer ?? null,
            clientReference: action.clientReference,
            note: action.note,
          },
          ...audit,
        },
      };
    case 'payment.proof.submit':
      return {
        fn: 'cmd_submit_payment_proof',
        args: {
          p_actor: actorId,
          p_intent_id: action.intentId,
          p_proof_path: action.proofPath,
          p_proof_hash: action.proofHash.toLowerCase(),
          p_reference_no: action.referenceNo,
          p_claimed_amount: action.claimedAmountYer ?? null,
          ...audit,
        },
      };
    case 'payment.confirm':
      return {
        fn: 'cmd_confirm_payment',
        args: { p_actor: actorId, p_intent_id: action.intentId, p_note: action.note, ...audit },
      };
    case 'payment.reject':
      return {
        fn: 'cmd_reject_payment',
        args: { p_actor: actorId, p_intent_id: action.intentId, p_reason: action.reason, ...audit },
      };
    case 'payment.intent.cancel':
      return {
        fn: 'cmd_cancel_payment_intent',
        args: { p_actor: actorId, p_intent_id: action.intentId, p_reason: action.reason, ...audit },
      };
    case 'refund.request':
      return {
        fn: 'cmd_request_refund',
        args: {
          p_actor: actorId,
          p_booking_id: action.bookingId,
          p_amount: action.amountYer,
          p_reason: action.reason,
          ...audit,
        },
      };
    case 'refund.decide':
      return {
        fn: 'cmd_decide_refund',
        args: {
          p_actor: actorId,
          p_refund_id: action.refundId,
          p_approve: action.approve,
          p_note: action.note,
          ...audit,
        },
      };
    case 'refund.pay':
      return {
        fn: 'cmd_pay_refund',
        args: {
          p_actor: actorId,
          p_refund_id: action.refundId,
          p_reference: action.reference,
          ...audit,
        },
      };
    case 'agent.cashIn':
      return {
        fn: 'cmd_agent_cash_in',
        args: {
          p_actor: actorId,
          p_agent_id: action.agentId,
          p_amount: action.amountYer,
          p_note: action.note,
          ...audit,
        },
      };
    case 'payout.request':
      return {
        fn: 'cmd_request_payout',
        args: {
          p_actor: actorId,
          p_payout: {
            orgId: action.orgId,
            amountYer: action.amountYer,
            method: action.method,
            destinationAccountId: action.destinationAccountId,
            note: action.note,
          },
          ...audit,
        },
      };
    case 'payout.approve':
      return {
        fn: 'cmd_approve_payout',
        args: { p_actor: actorId, p_payout_id: action.payoutId, p_note: action.note, ...audit },
      };
    case 'payout.pay':
      return {
        fn: 'cmd_mark_payout_paid',
        args: {
          p_actor: actorId,
          p_payout_id: action.payoutId,
          p_reference: action.reference,
          ...audit,
        },
      };
  }
}
