/**
 * Finance — the shared contract between the operator's billing page, the finance desk, the admin
 * consoles and the gateway (Phase 10).
 *
 * One edge function (`finance`) dispatches on `action`, and every write maps to exactly one `cmd_*` from
 * migration 00031: one request, one transaction, one audit row. Unlike `payments`, this file *does* carry
 * three read actions — the dashboard, the statement and the integrity check — because they are aggregates
 * over the ledger, and PostgREST cannot express "sum these accounts for this owner this month" without
 * shipping a hundred rows to the client and adding them up in JavaScript, which is how two screens end up
 * disagreeing about the same money.
 *
 * Three rules run through every schema here:
 *
 *   1. **Nothing in the ledger is edited.** A mistake is a reversing journal with a reason; `void` only
 *      exists for documents that carry no posting yet. The schemas below therefore never accept an amount
 *      for something that already exists.
 *   2. **The plan is data.** `plan.update` and `quota.override.grant` change rows that the enforcement
 *      functions read at request time, not constants in a build.
 *   3. **An exception has a name and an expiry.** An override must say why and, normally, until when.
 */

import { z } from 'zod';

import type { Resource } from '../domain/policy';

const uuid = z.string().uuid();

/** A money amount in rials. Integer, positive: a rial has no practical subdivision. */
const amount = z.number().int().min(1).max(100_000_000);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value == null || value === '' ? null : value))
    .optional();

/** A period bound, `YYYY-MM-DD`, because every finance query is a period and every period is a date. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const financeScopeSchema = z
  .object({
    orgId: uuid.nullish().transform((value) => value ?? null),
    ownerUserId: uuid.nullish().transform((value) => value ?? null),
  })
  .refine(
    (scope) => !(scope.orgId && scope.ownerUserId),
    'a scope is an organization or a user, not both',
  );

/** One side of a journal. Positive amounts plus a direction — never a signed amount. */
export const ledgerLineSchema = z.object({
  account: z.string().trim().min(3).max(41),
  direction: z.enum(['debit', 'credit']),
  amount,
});

export const postDatedJournalSchema = z.object({
  action: z.literal('finance.journal.post'),
  sourceKind: z.enum(['adjustment', 'expense']).default('adjustment'),
  description: z.string().trim().min(3).max(300),
  postingDate: isoDate.nullish().transform((value) => value ?? null),
  orgId: uuid.nullish().transform((value) => value ?? null),
  ownerUserId: uuid.nullish().transform((value) => value ?? null),
  reason: optionalText(300),
  /** Makes a double-click one journal: the same reference is the same posting. */
  clientReference: optionalText(64),
  lines: z.array(ledgerLineSchema).min(2).max(40),
});

export const reverseJournalSchema = z.object({
  action: z.literal('finance.journal.reverse'),
  journalId: uuid,
  reason: z.string().trim().min(5).max(300),
});

/** Kept in step with the `expense_category` enum in 00027 — the list the triggers already write. */
export const expenseCategorySchema = z.enum([
  'fuel',
  'maintenance',
  'insurance',
  'registration',
  'permit',
  'salary',
  'toll',
  'parking',
  'fine',
  'other',
]);

export const recordExpenseSchema = z.object({
  action: z.literal('expense.record'),
  orgId: uuid.nullish().transform((value) => value ?? null),
  ownerUserId: uuid.nullish().transform((value) => value ?? null),
  category: expenseCategorySchema,
  amountYer: amount,
  incurredOn: isoDate.nullish().transform((value) => value ?? null),
  description: optionalText(500),
  vehicleId: uuid.nullish().transform((value) => value ?? null),
  tripId: uuid.nullish().transform((value) => value ?? null),
  /** True = paid out of the money the platform holds for this owner, which posts a settlement journal. */
  settleFromBalance: z.boolean().default(false),
});

export const voidExpenseSchema = z.object({
  action: z.literal('expense.void'),
  expenseId: uuid,
  reason: z.string().trim().min(5).max(300),
});

export const startSubscriptionSchema = z.object({
  action: z.literal('subscription.start'),
  orgId: uuid.nullish().transform((value) => value ?? null),
  ownerUserId: uuid.nullish().transform((value) => value ?? null),
  planCode: z.enum(['basic', 'pro', 'business']),
  trial: z.boolean().default(true),
});

export const changePlanSchema = z.object({
  action: z.literal('subscription.changePlan'),
  subscriptionId: uuid,
  planCode: z.enum(['basic', 'pro', 'business']),
  /**
   * `now` upgrades immediately and bills the prorated difference; `period_end` schedules the change for
   * the boundary. A downgrade is only ever `period_end` — the SQL refuses the other, and this schema
   * says so in the type as well so the form cannot offer it.
   */
  when: z.enum(['now', 'period_end']).default('period_end'),
});

export const cancelSubscriptionSchema = z.object({
  action: z.literal('subscription.cancel'),
  subscriptionId: uuid,
  atPeriodEnd: z.boolean().default(true),
  reason: optionalText(300),
});

export const payInvoiceSchema = z.object({
  action: z.literal('invoice.pay'),
  invoiceId: uuid,
  reference: optionalText(64),
});

export const voidInvoiceSchema = z.object({
  action: z.literal('invoice.void'),
  invoiceId: uuid,
  reason: z.string().trim().min(5).max(300),
});

export const exportFinanceSchema = z.object({
  action: z.literal('finance.export'),
  kind: z.enum(['statement', 'revenue', 'payouts', 'invoices']),
  orgId: uuid.nullish().transform((value) => value ?? null),
  ownerUserId: uuid.nullish().transform((value) => value ?? null),
  from: isoDate,
  to: isoDate,
});

export const reconciliationLineInputSchema = z.object({
  externalRef: optionalText(64),
  amountYer: amount,
  occurredOn: isoDate.nullish().transform((value) => value ?? null),
  note: optionalText(300),
});

export const importReconciliationSchema = z.object({
  action: z.literal('finance.reconciliation.import'),
  orgId: uuid.nullish().transform((value) => value ?? null),
  ownerUserId: uuid.nullish().transform((value) => value ?? null),
  source: z.enum(['jaib', 'kuraimi', 'tadhamon', 'cash_desk', 'bank_transfer', 'other']),
  from: isoDate,
  to: isoDate,
  lines: z.array(reconciliationLineInputSchema).min(1).max(500),
});

export const resolveReconciliationSchema = z.object({
  action: z.literal('finance.reconciliation.resolve'),
  lineId: uuid,
  status: z.enum(['matched', 'exception', 'ignored']),
  intentId: uuid.nullish().transform((value) => value ?? null),
  payoutId: uuid.nullish().transform((value) => value ?? null),
  note: optionalText(300),
});

/** The plans editor. Only the keys present are changed; `limits` is per metric, with `null` = unlimited. */
export const updatePlanSchema = z.object({
  action: z.literal('plan.update'),
  code: z.enum(['basic', 'pro', 'business']),
  nameAr: optionalText(60),
  nameEn: optionalText(60),
  priceYer: z.number().int().min(0).max(10_000_000).optional(),
  trialDays: z.number().int().min(0).max(90).optional(),
  softLimit: z.boolean().optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  limits: z.record(z.string(), z.number().int().min(0).nullable()).optional(),
});

export const commissionRuleSchema = z.object({
  action: z.literal('commission.rule.save'),
  orgId: uuid.nullish().transform((value) => value ?? null),
  ownerUserId: uuid.nullish().transform((value) => value ?? null),
  basisPoints: z.number().int().min(0).max(3_000),
  minYer: z
    .number()
    .int()
    .min(0)
    .nullish()
    .transform((value) => value ?? null),
  maxYer: z
    .number()
    .int()
    .min(0)
    .nullish()
    .transform((value) => value ?? null),
  effectiveFrom: isoDate.nullish().transform((value) => value ?? null),
  effectiveTo: isoDate.nullish().transform((value) => value ?? null),
  note: optionalText(300),
});

export const grantQuotaOverrideSchema = z.object({
  action: z.literal('quota.override.grant'),
  orgId: uuid.nullish().transform((value) => value ?? null),
  ownerUserId: uuid.nullish().transform((value) => value ?? null),
  metric: z.string().trim().min(3).max(40),
  limitValue: z.number().int().min(0).nullable(),
  expiresAt: z
    .string()
    .datetime({ offset: true })
    .nullish()
    .transform((value) => value ?? null),
  reason: z.string().trim().min(5).max(300),
});

export const revokeQuotaOverrideSchema = z.object({
  action: z.literal('quota.override.revoke'),
  overrideId: uuid,
  reason: z.string().trim().min(5).max(300),
});

const readScopeSchema = z
  .object({
    orgId: uuid.nullish().transform((value) => value ?? null),
    ownerUserId: uuid.nullish().transform((value) => value ?? null),
    platform: z.boolean().optional(),
  })
  // Shared with `financeScopeSchema`: a read is for one owner. Both set is not a wider query, it is an
  // ambiguous one — and the SQL would silently prefer the organization.
  .refine(
    (scope) => !(scope.orgId && scope.ownerUserId),
    'a scope is an organization or a user, not both',
  );

export const financeDashboardSchema = z.object({
  action: z.literal('finance.dashboard'),
  ...readScopeSchema.shape,
});

export const financeStatementSchema = z.object({
  action: z.literal('finance.statement'),
  ...readScopeSchema.shape,
  from: isoDate.nullish().transform((value) => value ?? null),
  to: isoDate.nullish().transform((value) => value ?? null),
});

/** The jobs. `cron` is a deployment detail; what they need is a finance actor and no payload. */
export const financeJobSchema = z.object({
  action: z.literal('finance.job.run'),
  job: z.enum(['outbox', 'renewals', 'expiry', 'usage-snapshot', 'integrity']),
  limit: z.number().int().min(1).max(1_000).default(200),
});

export const financeActionSchema = z
  .discriminatedUnion('action', [
    postDatedJournalSchema,
    reverseJournalSchema,
    recordExpenseSchema,
    voidExpenseSchema,
    startSubscriptionSchema,
    changePlanSchema,
    cancelSubscriptionSchema,
    payInvoiceSchema,
    voidInvoiceSchema,
    exportFinanceSchema,
    importReconciliationSchema,
    resolveReconciliationSchema,
    updatePlanSchema,
    commissionRuleSchema,
    grantQuotaOverrideSchema,
    revokeQuotaOverrideSchema,
    financeDashboardSchema,
    financeStatementSchema,
    financeJobSchema,
  ])
  // A scope is an organization or a user, never both. On the union rather than on each member: Zod 4 builds
  // the discriminated union from the members' shapes, and a member-level `.refine` on an object is dropped
  // when it is rebuilt — so the check has to sit where it is guaranteed to run.
  .refine(
    (input) => !('orgId' in input && 'ownerUserId' in input && input.orgId && input.ownerUserId),
    'a scope is an organization or a user, not both',
  );

export type FinanceAction = z.infer<typeof financeActionSchema>;
export type LedgerLineInput = z.infer<typeof ledgerLineSchema>;

/**
 * Which rows the action is about, for the policy check.
 *
 * A platform-wide read is not scoped to anything — the capability (`finance.viewAll`) is the gate, which
 * is exactly what "finance sees everything" means. An owner-scoped action is an owner or an org member,
 * and the SQL re-derives the owner from the session anyway.
 */
export function financeScope(input: FinanceAction): Resource {
  switch (input.action) {
    case 'finance.journal.post':
    case 'finance.journal.reverse':
    case 'finance.reconciliation.import':
    case 'finance.reconciliation.resolve':
    case 'finance.export':
    case 'finance.dashboard':
    case 'finance.statement':
    case 'finance.job.run':
      return { isOwner: true, isOrgMember: true };
    case 'expense.record':
    case 'subscription.start':
      return input.orgId ? { isOrgMember: true } : { isOwner: true };
    // These name a row, not an owner: the command re-derives whose row it is from the session, which is
    // the check that cannot be talked around by sending somebody else's id.
    case 'expense.void':
    case 'subscription.changePlan':
    case 'subscription.cancel':
      return { isOwner: true, isOrgMember: true };
    case 'invoice.pay':
    case 'invoice.void':
    case 'plan.update':
    case 'commission.rule.save':
    case 'quota.override.grant':
    case 'quota.override.revoke':
      return {};
  }
}

export interface FinanceCommand {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}

/** `null` for a read: the edge function answers it from the same dispatch table. */
export function financeCommandArgs(
  input: FinanceAction,
  actorId: string,
  audit: { p_request_id?: string | null; p_ip?: string | null } = {},
): FinanceCommand {
  switch (input.action) {
    case 'finance.journal.post':
      return {
        fn: 'cmd_post_manual_journal',
        args: {
          p_actor: actorId,
          p_journal: {
            sourceKind: input.sourceKind,
            description: input.description,
            postingDate: input.postingDate,
            orgId: input.orgId,
            ownerUserId: input.ownerUserId,
            reason: input.reason,
            clientReference: input.clientReference,
            lines: input.lines,
          },
          ...audit,
        },
      };
    case 'finance.journal.reverse':
      return {
        fn: 'cmd_reverse_journal',
        args: { p_actor: actorId, p_journal_id: input.journalId, p_reason: input.reason, ...audit },
      };
    case 'expense.record':
      return {
        fn: 'cmd_record_expense',
        args: {
          p_actor: actorId,
          p_expense: {
            orgId: input.orgId,
            ownerUserId: input.ownerUserId,
            category: input.category,
            amountYer: input.amountYer,
            incurredOn: input.incurredOn,
            description: input.description,
            vehicleId: input.vehicleId,
            tripId: input.tripId,
            settleFromBalance: input.settleFromBalance,
          },
          ...audit,
        },
      };
    case 'expense.void':
      return {
        fn: 'cmd_void_expense',
        args: { p_actor: actorId, p_expense_id: input.expenseId, p_reason: input.reason, ...audit },
      };
    case 'subscription.start':
      return {
        fn: 'cmd_start_subscription',
        args: {
          p_actor: actorId,
          p_subscription: {
            orgId: input.orgId,
            ownerUserId: input.ownerUserId,
            planCode: input.planCode,
            trial: input.trial,
          },
          ...audit,
        },
      };
    case 'subscription.changePlan':
      return {
        fn: 'cmd_change_plan',
        args: {
          p_actor: actorId,
          p_subscription_id: input.subscriptionId,
          p_plan_code: input.planCode,
          p_when: input.when,
          ...audit,
        },
      };
    case 'subscription.cancel':
      return {
        fn: 'cmd_cancel_subscription',
        args: {
          p_actor: actorId,
          p_subscription_id: input.subscriptionId,
          p_at_period_end: input.atPeriodEnd,
          p_reason: input.reason,
          ...audit,
        },
      };
    case 'invoice.pay':
      return {
        fn: 'cmd_pay_invoice',
        args: {
          p_actor: actorId,
          p_invoice_id: input.invoiceId,
          p_reference: input.reference,
          ...audit,
        },
      };
    case 'invoice.void':
      return {
        fn: 'cmd_void_invoice',
        args: { p_actor: actorId, p_invoice_id: input.invoiceId, p_reason: input.reason, ...audit },
      };
    case 'finance.export':
      return {
        fn: 'cmd_export_finance',
        args: {
          p_actor: actorId,
          p_export: {
            kind: input.kind,
            orgId: input.orgId,
            ownerUserId: input.ownerUserId,
            from: input.from,
            to: input.to,
          },
          ...audit,
        },
      };
    case 'finance.reconciliation.import':
      return {
        fn: 'cmd_import_reconciliation',
        args: {
          p_actor: actorId,
          p_import: {
            orgId: input.orgId,
            ownerUserId: input.ownerUserId,
            source: input.source,
            from: input.from,
            to: input.to,
            lines: input.lines,
          },
          ...audit,
        },
      };
    case 'finance.reconciliation.resolve':
      return {
        fn: 'cmd_resolve_reconciliation_line',
        args: {
          p_actor: actorId,
          p_line_id: input.lineId,
          p_resolution: {
            status: input.status,
            intentId: input.intentId,
            payoutId: input.payoutId,
            note: input.note,
          },
          ...audit,
        },
      };
    case 'plan.update':
      return {
        fn: 'cmd_update_plan',
        args: {
          p_actor: actorId,
          p_plan: {
            code: input.code,
            nameAr: input.nameAr,
            nameEn: input.nameEn,
            priceYer: input.priceYer,
            trialDays: input.trialDays,
            softLimit: input.softLimit,
            features: input.features,
            limits: input.limits,
          },
          ...audit,
        },
      };
    case 'commission.rule.save':
      return {
        fn: 'cmd_upsert_commission_rule',
        args: {
          p_actor: actorId,
          p_rule: {
            orgId: input.orgId,
            ownerUserId: input.ownerUserId,
            basisPoints: input.basisPoints,
            minYer: input.minYer,
            maxYer: input.maxYer,
            effectiveFrom: input.effectiveFrom,
            effectiveTo: input.effectiveTo,
            note: input.note,
          },
          ...audit,
        },
      };
    case 'quota.override.grant':
      return {
        fn: 'cmd_grant_quota_override',
        args: {
          p_actor: actorId,
          p_override: {
            orgId: input.orgId,
            ownerUserId: input.ownerUserId,
            metric: input.metric,
            limitValue: input.limitValue,
            expiresAt: input.expiresAt,
            reason: input.reason,
          },
          ...audit,
        },
      };
    case 'quota.override.revoke':
      return {
        fn: 'cmd_revoke_quota_override',
        args: {
          p_actor: actorId,
          p_override_id: input.overrideId,
          p_reason: input.reason,
          ...audit,
        },
      };
    case 'finance.dashboard':
      return {
        fn: 'cmd_get_finance_dashboard',
        args: {
          p_actor: actorId,
          p_scope: { orgId: input.orgId, ownerUserId: input.ownerUserId, platform: input.platform },
        },
      };
    case 'finance.statement':
      return {
        fn: 'cmd_get_statement',
        args: {
          p_actor: actorId,
          p_scope: { orgId: input.orgId, ownerUserId: input.ownerUserId },
          p_from: input.from,
          p_to: input.to,
        },
      };
    case 'finance.job.run':
      return {
        fn: FINANCE_JOB_FN[input.job],
        args:
          input.job === 'integrity'
            ? { p_actor: actorId }
            : input.job === 'usage-snapshot'
              ? { p_actor: actorId }
              : { p_actor: actorId, p_limit: input.limit },
      };
  }
}

/**
 * The result of any finance action.
 *
 * Loosely shaped on purpose: the actions return journals, subscriptions, invoices, statements and check
 * results, and each screen reads the branch it asked for. What every branch does share is `requestId`, which
 * is how a user's screenshot of an error can be found in the audit log.
 */
export const financeResultSchema = z
  .object({
    journal: z.record(z.string(), z.unknown()).optional(),
    lines: z.array(z.record(z.string(), z.unknown())).optional(),
    reversalJournalId: z.string().optional(),
    expense: z.record(z.string(), z.unknown()).optional(),
    subscription: z.record(z.string(), z.unknown()).nullable().optional(),
    invoice: z.record(z.string(), z.unknown()).optional(),
    export: z.record(z.string(), z.unknown()).optional(),
    rows: z.array(z.record(z.string(), z.unknown())).optional(),
    rowCount: z.number().optional(),
    importId: z.string().optional(),
    matched: z.number().optional(),
    exceptions: z.number().optional(),
    line: z.record(z.string(), z.unknown()).optional(),
    plan: z.record(z.string(), z.unknown()).optional(),
    limits: z.record(z.string(), z.number().nullable()).optional(),
    rule: z.record(z.string(), z.unknown()).optional(),
    override: z.record(z.string(), z.unknown()).optional(),
    proration: z.number().optional(),
    status: z.string().optional(),
    failed: z.number().optional(),
    checks: z.array(z.record(z.string(), z.unknown())).optional(),
    changed: z.boolean().optional(),
    requestId: z.string().optional(),
  })
  .passthrough();

export const financeCommandSpec = {
  path: 'finance',
  input: financeActionSchema,
  output: financeResultSchema,
  mutating: true,
} as const;

/** One job, one command. Named here so the cron, the dev gateway and the edge function agree. */
export const FINANCE_JOB_FN = {
  outbox: 'cmd_consume_outbox',
  renewals: 'cmd_renew_subscriptions',
  expiry: 'cmd_expire_subscriptions',
  'usage-snapshot': 'cmd_snapshot_usage',
  integrity: 'cmd_run_integrity_check',
} as const;

/**
 * The commission for a gross fare, computed the way `app.commission_yer` computes it.
 *
 * This exists because the *editor* has to show the effect of a rate before it is saved, and showing a
 * rate's effect by writing it and reading back is not a preview. The unit test pins it to the SQL rules:
 * floor at one rial when the rate is non-zero, then the rule's floor and cap, never more than the fare.
 */
export function commissionYer(
  gross: number,
  basisPoints: number,
  cap?: { min?: number; max?: number },
): number {
  if (!Number.isFinite(gross) || gross <= 0) return 0;
  let value = Math.floor((gross * basisPoints) / 10_000);
  if (value === 0 && basisPoints > 0) value = 1;
  if (cap?.min != null) value = Math.max(value, cap.min);
  if (cap?.max != null) value = Math.min(value, cap.max);
  return Math.min(Math.max(value, 0), gross);
}

/** The plan discount, applied after the rule and before the caps — the order the SQL uses. */
export function effectiveBasisPoints(
  basisPoints: number,
  plan: 'basic' | 'pro' | 'business',
): number {
  const discount = plan === 'pro' ? 100 : plan === 'business' ? 200 : 0;
  return Math.max(0, basisPoints - discount);
}

/**
 * The prorated difference for a mid-period upgrade: what the remaining days at the new price cost, less
 * what was already paid for them.
 *
 * Truncated toward zero, exactly like the SQL's integer division, so the two never disagree by a rial — and
 * so a partial rial lands on the platform's side of the rounding, never the customer's.
 */
export function prorationYer(
  oldPrice: number,
  newPrice: number,
  daysLeft: number,
  daysTotal: number,
): number {
  if (daysTotal <= 0) return 0;
  const remaining = Math.max(0, Math.min(daysLeft, daysTotal));
  return Math.trunc(((newPrice - oldPrice) * remaining) / daysTotal);
}

/**
 * The reconciliation file, as the desk pastes it: `amount,date,reference` per line.
 *
 * Pure, and in the shared package rather than the page, because a malformed line has to be reported by line
 * number before anything is written — and because the mobile desk will read the same file. `amount` is
 * digits with any separators stripped; the date is `YYYY-MM-DD`, which is what a bank export gives and what
 * the column stores.
 */
export function parseStatementText(text: string):
  | {
      readonly ok: true;
      readonly lines: {
        amountYer: number;
        occurredOn: string;
        externalRef: string | null;
      }[];
    }
  | { readonly ok: false; readonly line: number } {
  const lines: {
    amountYer: number;
    occurredOn: string;
    externalRef: string | null;
  }[] = [];
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row !== '');
  for (let index = 0; index < rows.length; index += 1) {
    const [rawAmount, rawDate, rawRef] = (rows[index] ?? '').split(',');
    const amountYer = Number((rawAmount ?? '').replace(/[^0-9]/g, ''));
    const occurredOn = (rawDate ?? '').trim();
    if (!Number.isInteger(amountYer) || amountYer <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
      return { ok: false, line: index + 1 };
    }
    lines.push({
      amountYer,
      occurredOn,
      externalRef: (rawRef ?? '').trim() === '' ? null : (rawRef ?? '').trim(),
    });
  }
  return { ok: true, lines };
}

/** The operator's profit for a period, in the one order the dashboard and the statement both use. */
export function profitYer(input: {
  revenue: number;
  commission: number;
  expenses: number;
}): number {
  return input.revenue - input.commission - input.expenses;
}
