/**
 * Finance reads (Phase 10).
 *
 * Two kinds of read, and the split matters:
 *
 *   · **Aggregates** (dashboard, statement) go through the `finance` edge function via `callGateway`, because
 *     a month of ledger rows summed in JavaScript is a second implementation of the accounting rules — and
 *     the statement and the dashboard would eventually disagree by a rial.
 *   · **Rows** (invoices, subscriptions, plans, overrides, expenses, reconciliation) are RLS-filtered
 *     PostgREST reads with the visitor's own cookie: the policies already say "you, your organization, or
 *     finance", so a page cannot leak somebody's bill even if a route forgets a check.
 *
 * Amounts leave this module as integers in rials, and every one of them is rendered with its currency at the
 * edge of the UI.
 */

import { callGateway } from './gateway';
import { getServerClient } from './supabase/server';

export interface MoneySummary {
  readonly grossYer: number;
  readonly commissionYer: number;
  readonly subscriptionYer: number;
  readonly refundsYer: number;
  readonly expensesYer: number;
  readonly payoutsYer: number;
  readonly profitYer: number;
  readonly netYer: number;
  readonly payableYer: number;
  readonly availableYer: number;
  readonly pendingPayoutsYer: number;
  readonly unpaidInvoices: number;
}

export interface SubscriptionView {
  readonly id: string;
  readonly planCode: 'basic' | 'pro' | 'business';
  readonly pendingPlanCode: 'basic' | 'pro' | 'business' | null;
  readonly status: string;
  readonly priceYer: number;
  readonly trialEndsAt: string | null;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly ownerOrgId: string | null;
  readonly ownerUserId: string | null;
}

export interface DashboardView {
  readonly platform: boolean;
  readonly period: { readonly from: string; readonly to: string };
  readonly summary: MoneySummary;
  readonly plan: 'basic' | 'pro' | 'business' | null;
  readonly subscription: SubscriptionView | null;
  readonly quota: readonly {
    readonly metric: string;
    readonly limit: number | null;
    readonly used: number;
  }[];
  readonly totals: Record<string, { debit: number; credit: number; net: number }>;
}

export interface StatementView {
  readonly currency: string;
  readonly from: string;
  readonly to: string;
  readonly totals: Record<string, { debit: number; credit: number; net: number }>;
  readonly balance: number;
  readonly journals: readonly {
    readonly id: string;
    readonly code: string;
    readonly postingDate: string;
    readonly description: string;
    readonly sourceKind: string;
    readonly reversesId: string | null;
    readonly amountYer: number;
    readonly lines: readonly {
      readonly account: string;
      readonly direction: 'debit' | 'credit';
      readonly amountYer: number;
    }[];
  }[];
  readonly expenses: readonly {
    readonly id: string;
    readonly incurredOn: string;
    readonly category: string;
    readonly amountYer: number;
    readonly description: string | null;
  }[];
}

/**
 * The scope, as the wire wants it: exactly one owner, or the platform.
 *
 * The schema refuses `orgId` and `ownerUserId` together — a scope is one owner — so the pair is normalised
 * here instead of at every call site. Sending both was what made the dashboard answer "unavailable" and the
 * billing page then say "no subscription", which is a lie about the plan rather than a bug report.
 */
function scopePayload(scope: FinanceScope): Record<string, unknown> {
  if (scope.platform) return { orgId: null, ownerUserId: null, platform: true };
  if (scope.orgId) return { orgId: scope.orgId, ownerUserId: null };
  return { orgId: null, ownerUserId: scope.ownerUserId ?? null };
}

export interface FinanceScope {
  readonly orgId?: string | null;
  readonly ownerUserId?: string | null;
  readonly platform?: boolean;
}

/** A subscription row as the database stores it, converted to the shape the screens read. */
function toSubscription(row: Record<string, unknown>): SubscriptionView {
  return {
    id: String(row.id),
    planCode: row.plan_code as SubscriptionView['planCode'],
    pendingPlanCode: (row.pending_plan_code ?? null) as SubscriptionView['pendingPlanCode'],
    status: String(row.status),
    priceYer: Number(row.price_yer ?? 0),
    trialEndsAt: (row.trial_ends_at as string | null) ?? null,
    currentPeriodStart: String(row.current_period_start),
    currentPeriodEnd: String(row.current_period_end),
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    ownerOrgId: (row.owner_org_id as string | null) ?? null,
    ownerUserId: (row.owner_user_id as string | null) ?? null,
  };
}

/** The dashboard. `null` when the gateway is unavailable, so a page can say so instead of throwing. */
export async function loadFinanceDashboard(scope: FinanceScope): Promise<DashboardView | null> {
  const result = await callGateway<Record<string, unknown>>('finance', {
    action: 'finance.dashboard',
    ...scopePayload(scope),
    platform: scope.platform ?? false,
  });
  if (!result.ok) return null;

  const summary = (result.data.summary ?? {}) as Record<string, number>;
  const subscription = result.data.subscription as Record<string, unknown> | null;

  return {
    platform: Boolean(result.data.platform),
    period: (result.data.period ?? { from: '', to: '' }) as DashboardView['period'],
    summary: {
      grossYer: Number(summary.grossYer ?? 0),
      commissionYer: Number(summary.commissionYer ?? 0),
      subscriptionYer: Number(summary.subscriptionYer ?? 0),
      refundsYer: Number(summary.refundsYer ?? 0),
      expensesYer: Number(summary.expensesYer ?? 0),
      payoutsYer: Number(summary.payoutsYer ?? 0),
      profitYer: Number(summary.profitYer ?? 0),
      netYer: Number(summary.netYer ?? 0),
      payableYer: Number(summary.payableYer ?? 0),
      availableYer: Number(summary.availableYer ?? 0),
      pendingPayoutsYer: Number(summary.pendingPayoutsYer ?? 0),
      unpaidInvoices: Number(summary.unpaidInvoices ?? 0),
    },
    plan: (result.data.plan as DashboardView['plan']) ?? null,
    subscription: subscription ? toSubscription(subscription) : null,
    quota: ((result.data.quota ?? []) as Record<string, unknown>[]).map((row) => ({
      metric: String(row.metric),
      limit: row.limit === null || row.limit === undefined ? null : Number(row.limit),
      used: Number(row.used ?? 0),
    })),
    totals: (result.data.totals ?? {}) as DashboardView['totals'],
  };
}

export async function loadStatement(
  scope: FinanceScope,
  from: string,
  to: string,
): Promise<StatementView | null> {
  // The contract's dates are `YYYY-MM-DD`; pages hold timestamps, so the day is taken here rather than in
  // three call sites. A rejected date used to surface as "no movements in this period", which reads as an
  // empty ledger instead of a bug.
  const day = (value: string) => value.slice(0, 10);
  const result = await callGateway<Record<string, unknown>>('finance', {
    action: 'finance.statement',
    ...scopePayload(scope),
    from: day(from),
    to: day(to),
  });
  if (!result.ok) return null;
  return result.data as unknown as StatementView;
}

export interface InvoiceRow {
  readonly id: string;
  readonly code: string;
  readonly kind: 'booking' | 'subscription';
  readonly status: string;
  readonly totalYer: number;
  readonly commissionYer: number;
  readonly issuedAt: string;
  readonly dueOn: string | null;
  readonly paidAt: string | null;
  readonly ownerOrgId: string | null;
}

const INVOICE_COLUMNS =
  'id, code, kind, status, total_yer, commission_yer, issued_at, due_on, paid_at, owner_org_id';

export async function loadInvoices(
  options: {
    readonly orgId?: string | null;
    readonly statuses?: readonly string[];
    readonly limit?: number;
  } = {},
): Promise<InvoiceRow[]> {
  const client = await getServerClient();
  if (!client) return [];
  let query = client
    .from('invoices')
    .select(INVOICE_COLUMNS)
    .order('issued_at', { ascending: false });
  if (options.orgId) query = query.eq('owner_org_id', options.orgId);
  if (options.statuses && options.statuses.length > 0) {
    query = query.in('status', [...options.statuses]);
  }
  const { data } = await query.limit(options.limit ?? 100);
  return (data ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    kind: row.kind as InvoiceRow['kind'],
    status: row.status,
    totalYer: row.total_yer,
    commissionYer: row.commission_yer,
    issuedAt: row.issued_at,
    dueOn: row.due_on,
    paidAt: row.paid_at,
    ownerOrgId: row.owner_org_id,
  }));
}

const SUBSCRIPTION_COLUMNS =
  'id, owner_user_id, owner_org_id, plan_code, pending_plan_code, status, price_yer, trial_ends_at, ' +
  'current_period_start, current_period_end, cancel_at_period_end';

export async function loadSubscriptions(limit = 200): Promise<SubscriptionView[]> {
  const client = await getServerClient();
  if (!client) return [];
  const { data } = await client
    .from('subscriptions')
    .select(SUBSCRIPTION_COLUMNS)
    .order('current_period_end', { ascending: true })
    .limit(limit);
  return (data ?? []).map((row) => toSubscription(row as unknown as Record<string, unknown>));
}

/** The live subscription for one owner, or nothing. RLS already narrows the rows to theirs. */
export async function loadOwnSubscription(orgId: string | null): Promise<SubscriptionView | null> {
  const client = await getServerClient();
  if (!client) return null;
  let query = client
    .from('subscriptions')
    .select(SUBSCRIPTION_COLUMNS)
    .in('status', ['trialing', 'active', 'past_due', 'grace']);
  query = orgId ? query.eq('owner_org_id', orgId) : query.is('owner_org_id', null);
  const { data } = await query.limit(1).maybeSingle();
  return data ? toSubscription(data as unknown as Record<string, unknown>) : null;
}

export interface PlanRow {
  readonly code: 'basic' | 'pro' | 'business';
  readonly nameAr: string;
  readonly nameEn: string;
  readonly priceYer: number;
  readonly trialDays: number;
  readonly softLimit: boolean;
  readonly limits: Record<string, number | null>;
}

/** Every plan with its limits, in one pair of queries — the editor needs the whole matrix to render. */
export async function loadPlans(): Promise<PlanRow[]> {
  const client = await getServerClient();
  if (!client) return [];
  const [plans, limits] = await Promise.all([
    client
      .from('plans')
      .select('code, name_ar, name_en, price_yer, trial_days, soft_limit')
      .order('price_yer'),
    client.from('plan_limits').select('plan_code, metric, limit_value'),
  ]);
  const byPlan = new Map<string, Record<string, number | null>>();
  for (const row of limits.data ?? []) {
    const bucket = byPlan.get(row.plan_code) ?? {};
    bucket[row.metric] = row.limit_value;
    byPlan.set(row.plan_code, bucket);
  }
  return (plans.data ?? []).map((row) => ({
    code: row.code as PlanRow['code'],
    nameAr: row.name_ar,
    nameEn: row.name_en,
    priceYer: row.price_yer,
    trialDays: row.trial_days,
    softLimit: row.soft_limit,
    limits: byPlan.get(row.code) ?? {},
  }));
}

export interface QuotaOverrideRow {
  readonly id: string;
  readonly metric: string;
  readonly limitValue: number | null;
  readonly expiresAt: string | null;
  readonly reason: string;
  readonly ownerOrgId: string | null;
  readonly createdAt: string;
}

export async function loadQuotaOverrides(orgId?: string | null): Promise<QuotaOverrideRow[]> {
  const client = await getServerClient();
  if (!client) return [];
  let query = client
    .from('quota_overrides')
    .select('id, metric, limit_value, expires_at, reason, owner_org_id, created_at')
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (orgId) query = query.eq('owner_org_id', orgId);
  const { data } = await query.limit(100);
  return (data ?? []).map((row) => ({
    id: row.id,
    metric: row.metric,
    limitValue: row.limit_value,
    expiresAt: row.expires_at,
    reason: row.reason,
    ownerOrgId: row.owner_org_id,
    createdAt: row.created_at,
  }));
}

export interface ExpenseRow {
  readonly id: string;
  readonly category: string;
  readonly amountYer: number;
  readonly incurredOn: string;
  readonly description: string | null;
  readonly vehicleId: string | null;
}

export async function loadExpenses(orgId: string | null, limit = 100): Promise<ExpenseRow[]> {
  const client = await getServerClient();
  if (!client) return [];
  let query = client
    .from('expenses')
    .select(
      'id, category, amount_yer, incurred_on, description, vehicle_id, owner_org_id, owner_user_id',
    )
    .is('deleted_at', null)
    .order('incurred_on', { ascending: false });
  query = orgId ? query.eq('owner_org_id', orgId) : query.is('owner_org_id', null);
  const { data } = await query.limit(limit);
  return (data ?? []).map((row) => ({
    id: row.id,
    category: row.category,
    amountYer: Number(row.amount_yer),
    incurredOn: row.incurred_on,
    description: row.description,
    vehicleId: row.vehicle_id,
  }));
}

export interface CommissionRuleRow {
  readonly id: string;
  readonly orgId: string | null;
  readonly basisPoints: number;
  readonly minYer: number | null;
  readonly maxYer: number | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly note: string | null;
}

export async function loadCommissionRules(): Promise<CommissionRuleRow[]> {
  const client = await getServerClient();
  if (!client) return [];
  const { data } = await client
    .from('commission_rules')
    .select('id, owner_org_id, basis_points, min_yer, max_yer, effective_from, effective_to, note')
    .order('effective_from', { ascending: false })
    .limit(100);
  return (data ?? []).map((row) => ({
    id: row.id,
    orgId: row.owner_org_id,
    basisPoints: row.basis_points,
    minYer: row.min_yer,
    maxYer: row.max_yer,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    note: row.note,
  }));
}

export interface ReconciliationView {
  readonly imports: readonly {
    readonly id: string;
    readonly source: string;
    readonly periodFrom: string;
    readonly periodTo: string;
    readonly linesTotal: number;
    readonly linesMatched: number;
    readonly createdAt: string;
  }[];
  readonly lines: readonly {
    readonly id: string;
    readonly importId: string;
    readonly externalRef: string | null;
    readonly amountYer: number;
    readonly occurredOn: string;
    readonly status: string;
    readonly intentId: string | null;
    readonly payoutId: string | null;
  }[];
}

export async function loadReconciliation(): Promise<ReconciliationView> {
  const client = await getServerClient();
  if (!client) return { imports: [], lines: [] };
  const [imports, lines] = await Promise.all([
    client
      .from('reconciliation_imports')
      .select('id, source, period_from, period_to, lines_total, lines_matched, created_at')
      .order('created_at', { ascending: false })
      .limit(20),
    client
      .from('reconciliation_lines')
      .select('id, import_id, external_ref, amount_yer, occurred_on, status, intent_id, payout_id')
      .order('occurred_on', { ascending: false })
      .limit(200),
  ]);
  return {
    imports: (imports.data ?? []).map((row) => ({
      id: row.id,
      source: row.source,
      periodFrom: row.period_from,
      periodTo: row.period_to,
      linesTotal: row.lines_total,
      linesMatched: row.lines_matched,
      createdAt: row.created_at,
    })),
    lines: (lines.data ?? []).map((row) => ({
      id: row.id,
      importId: row.import_id,
      externalRef: row.external_ref,
      amountYer: row.amount_yer,
      occurredOn: row.occurred_on,
      status: row.status,
      intentId: row.intent_id,
      payoutId: row.payout_id,
    })),
  };
}

export { parseStatementText } from '@maak/core';
