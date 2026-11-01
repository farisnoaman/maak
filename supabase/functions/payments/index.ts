/**
 * payments — every Phase 9 write (accounts, intents, proofs, confirmations, refunds, payouts, floats).
 *
 * Same shape as `bookings`, `trips` and `fleet`: one action discriminator, exactly one `cmd_*` per
 * request (one transaction), and the policy matrix checked here *and* inside the SQL command. The
 * action → argument mapping lives in `paymentsCommandArgs()` from @maak/core, so the web app, the
 * mobile app, the dev gateway and this file cannot drift apart.
 *
 * Reads are deliberately absent: a passenger's payments, the confirmation queue and the finance ledger
 * are RLS-filtered PostgREST reads. Proof images go straight to the `payment-proofs` bucket with a
 * policy that only lets a payer upload into their own folder.
 *
 * There is no PSP integration. A payment is a claim with a receipt, and a human at the operator or the
 * finance desk confirms it — which is why `payment.confirm` is a separate action from `payment.submit`
 * with a different capability.
 */

import {
  paymentsActionSchema,
  paymentsCommandArgs,
  paymentsScope,
  policyDenial,
  type Capability,
  type PaymentsAction,
} from '@maak/core';
import { ApiError } from '../_shared/errors.ts';
import { defineCommand } from '../_shared/handler.ts';
import { createDb } from '../_shared/db.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const schema = paymentsActionSchema;

/**
 * The capability each action needs.
 *
 * `payment.account.create` is the one action whose capability depends on its own payload: opening a
 * *platform* account is a finance decision, opening your own is not. The default below is the personal
 * one and the handler upgrades it for `kind: 'platform'`, because a static map cannot read the input.
 *
 * Three verbs share `payment.account.manageOwn` (create/verify/archive) only where the SQL re-derives
 * the account's owner; refusing and archiving are separate actions because they need a reason.
 */
const CAPABILITY: Record<PaymentsAction['action'], Capability> = {
  'payment.account.create': 'payment.account.manageOwn',
  'payment.account.verify': 'payment.account.managePlatform',
  'payment.account.archive': 'payment.account.manageOwn',
  'payment.intent.create': 'payment.submit',
  'payment.proof.submit': 'payment.submit',
  'payment.intent.cancel': 'payment.submit',
  'payment.confirm': 'payment.confirm',
  'payment.reject': 'payment.confirm',
  'refund.request': 'payment.submit',
  'refund.decide': 'refund.approve',
  'refund.pay': 'refund.approve',
  'agent.cashIn': 'payment.account.manageOwn',
  'payout.request': 'payout.request',
  'payout.approve': 'payout.approve',
  'payout.pay': 'payout.approve',
};

export default defineCommand({ schema }, async (ctx) => {
  const { actor } = ctx.resolved;
  const actorId = actor.userId as string;
  const input = ctx.input;

  const capability =
    input.action === 'payment.account.create' && input.kind === 'platform'
      ? 'payment.account.managePlatform'
      : CAPABILITY[input.action];

  const denial = policyDenial(actor, capability, paymentsScope(input));
  if (denial === 'NOT_VERIFIED') {
    throw new ApiError(403, 'NOT_VERIFIED', 'Account is not verified');
  }
  if (denial) throw new ApiError(denial === 'UNAUTHENTICATED' ? 401 : 403, denial, 'Not allowed');

  // Uploading a receipt is the one action a rider repeats per payment; the rest are desk work. The
  // ceiling is per actor and per action so a stuck retry loop cannot fill the queue.
  const riderSide =
    input.action === 'payment.intent.create' || input.action === 'payment.proof.submit';
  await enforceRateLimit(actorId, `payments.${input.action}`, {
    limit: riderSide ? 30 : 240,
    windowSeconds: 3600,
  });

  const db = createDb({ requestId: ctx.requestId });
  const { fn, args } = paymentsCommandArgs(input, actorId, {
    p_request_id: ctx.requestId,
    p_ip: ctx.ip,
  });

  const result = await db.rpc<Record<string, unknown>>(fn, args);
  return { ...result, requestId: ctx.requestId };
});
