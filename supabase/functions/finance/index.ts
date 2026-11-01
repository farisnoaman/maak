/**
 * finance — every Phase 10 write and the three aggregates that need a transaction (journals, plans,
 * subscriptions, invoices, expenses, reconciliation, exports, and the nightly jobs).
 *
 * Same shape as `payments` and `bookings`: one action discriminator, exactly one `cmd_*` per request, and
 * the capability checked here *and* inside the SQL. The action → argument mapping lives in
 * `financeCommandArgs()` from @maak/core, so the web app, the dev gateway and this file cannot drift.
 *
 * The read actions exist here rather than in PostgREST on purpose. `finance.dashboard` and
 * `finance.statement` are sums over the ledger with a period, an owner and a sign convention; expressing
 * them in a client would mean shipping a month of rows to compute a number the database can compute, and
 * two clients would eventually compute it differently. `finance.job.run` is here because the cron holds a
 * service token, not a session — what it needs is the same dispatch table everybody else uses.
 */

import {
  financeActionSchema,
  financeCommandArgs,
  financeScope,
  policyDenial,
  type Capability,
  type FinanceAction,
} from '@maak/core';
import { ApiError } from '../_shared/errors.ts';
import { defineCommand } from '../_shared/handler.ts';
import { createDb } from '../_shared/db.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const schema = financeActionSchema;

/**
 * The capability each action needs.
 *
 * Reads and jobs take one of two capabilities depending on scope: a platform-wide dashboard is
 * `finance.viewAll`, an operator's own is `finance.viewOwn`. A static map cannot read the payload, so the
 * default is the narrow one and the handler upgrades it for `platform: true`, exactly like
 * `payment.account.create`.
 */
const CAPABILITY: Record<FinanceAction['action'], Capability> = {
  'finance.journal.post': 'finance.adjust',
  'finance.journal.reverse': 'finance.adjust',
  'expense.record': 'expense.record',
  'expense.void': 'expense.void',
  'subscription.start': 'subscription.manage',
  'subscription.changePlan': 'subscription.manage',
  'subscription.cancel': 'subscription.manage',
  'invoice.pay': 'invoice.manage',
  'invoice.void': 'invoice.manage',
  'finance.export': 'finance.viewOwn',
  'finance.reconciliation.import': 'reconciliation.manage',
  'finance.reconciliation.resolve': 'reconciliation.manage',
  'plan.update': 'plan.manage',
  'commission.rule.save': 'commission.manage',
  'quota.override.grant': 'quota.override',
  'quota.override.revoke': 'quota.override',
  'finance.dashboard': 'finance.viewOwn',
  'finance.statement': 'finance.viewOwn',
  'finance.job.run': 'finance.viewAll',
};

/** The actions that are finance-desk work whichever scope they are called with. */
const PLATFORM_ONLY: ReadonlySet<FinanceAction['action']> = new Set([
  'finance.journal.post',
  'finance.journal.reverse',
  'invoice.pay',
  'invoice.void',
  'finance.reconciliation.import',
  'finance.reconciliation.resolve',
  'finance.job.run',
]);

function capabilityFor(input: FinanceAction): Capability {
  if (PLATFORM_ONLY.has(input.action)) return 'finance.viewAll';
  if (input.action === 'finance.dashboard' || input.action === 'finance.statement') {
    return input.platform ? 'finance.viewAll' : 'finance.viewOwn';
  }
  return CAPABILITY[input.action];
}

export default defineCommand({ schema }, async (ctx) => {
  const { actor } = ctx.resolved;
  const actorId = actor.userId as string;
  const input = ctx.input;

  const denial = policyDenial(actor, capabilityFor(input), financeScope(input));
  if (denial === 'NOT_VERIFIED') {
    throw new ApiError(403, 'NOT_VERIFIED', 'Account is not verified');
  }
  if (denial) throw new ApiError(denial === 'UNAUTHENTICATED' ? 401 : 403, denial, 'Not allowed');

  // Desk work, not rider work: the ceiling is per actor and per action so a stuck retry loop cannot mint a
  // hundred journals, and it is generous enough that a real month-end never touches it.
  await enforceRateLimit(actorId, `finance.${input.action}`, {
    limit: input.action === 'finance.job.run' ? 12 : 120,
    windowSeconds: 3600,
  });

  const db = createDb({ requestId: ctx.requestId });
  const { fn, args } = financeCommandArgs(input, actorId, {
    p_request_id: ctx.requestId,
    p_ip: ctx.ip,
  });

  const result = await db.rpc<Record<string, unknown>>(fn, args);
  return { ...result, requestId: ctx.requestId };
});
