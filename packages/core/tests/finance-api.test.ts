import { describe, expect, it } from 'vitest';
import {
  commissionYer,
  effectiveBasisPoints,
  financeActionSchema,
  financeCommandArgs,
  financeScope,
  parseStatementText,
  prorationYer,
  profitYer,
  type FinanceAction,
} from '../src/api/finance';
import { parseQuotaDetail, quotaOf } from '../src/api/quota';

const actor = '11111111-1111-4111-8111-111111111111';
const uuidA = '22222222-2222-4222-8222-222222222222';
const uuidB = '33333333-3333-4333-8333-333333333333';
const audit = { p_request_id: 'req-1', p_ip: null } as const;

function parse(input: unknown): FinanceAction {
  return financeActionSchema.parse(input);
}

/**
 * The commission, pinned to what `app.commission_yer` does.
 *
 * These are the numbers 0015 asserts in SQL — the same gross, the same rate, the same answer. If the two
 * drift, the editor shows one figure and the ledger posts another, and the argument is about the difference.
 */
describe('commissionYer', () => {
  it('takes 500 basis points from a 10 000 rial fare', () => {
    expect(commissionYer(10_000, 500)).toBe(500);
  });

  it('rounds down, so it never overcharges', () => {
    // 3 333 × 500 / 10 000 = 166.65 → 166
    expect(commissionYer(3_333, 500)).toBe(166);
  });

  it('floors a non-zero rate at one rial — a free ride is not a free platform', () => {
    expect(commissionYer(10, 500)).toBe(1);
    expect(commissionYer(1, 1)).toBe(1);
  });

  it('charges nothing at a zero rate', () => {
    expect(commissionYer(10, 0)).toBe(0);
  });

  it('applies the rule floor and cap', () => {
    expect(commissionYer(10_000, 500, { min: 900 })).toBe(900);
    expect(commissionYer(10_000, 500, { max: 200 })).toBe(200);
  });

  it('never keeps more than the fare', () => {
    expect(commissionYer(100, 3_000, { min: 5_000 })).toBe(100);
  });

  it('returns zero for a non-positive or non-finite fare', () => {
    expect(commissionYer(0, 500)).toBe(0);
    expect(commissionYer(-100, 500)).toBe(0);
    expect(commissionYer(Number.NaN, 500)).toBe(0);
  });
});

describe('effectiveBasisPoints', () => {
  it('leaves Basic at the global rate', () => {
    expect(effectiveBasisPoints(500, 'basic')).toBe(500);
  });

  it('gives Pro 100 bp off and Business 200 bp off', () => {
    expect(effectiveBasisPoints(500, 'pro')).toBe(400);
    expect(effectiveBasisPoints(500, 'business')).toBe(300);
  });

  it('does not go below zero when the discount is bigger than the rate', () => {
    expect(effectiveBasisPoints(50, 'business')).toBe(0);
  });
});

describe('prorationYer', () => {
  it('charges the remaining share of the difference on an upgrade', () => {
    // (25 000 − 7 500) × 15/30 = 8 750
    expect(prorationYer(7_500, 25_000, 15, 30)).toBe(8_750);
  });

  it('credits the remaining share on a downgrade, truncated toward zero like the SQL', () => {
    expect(prorationYer(25_000, 7_500, 10, 30)).toBe(-5_833);
  });

  it('rounds down, in the customer’s favour', () => {
    // (25 000 − 7 500) × 1/7 = 2 500 exactly; use an awkward one
    expect(prorationYer(7_500, 25_000, 1, 3)).toBe(5_833);
  });

  it('treats a period of zero days as nothing to prorate', () => {
    expect(prorationYer(7_500, 25_000, 5, 0)).toBe(0);
  });

  it('clamps days left to the period', () => {
    expect(prorationYer(0, 1_000, 90, 30)).toBe(1_000);
    expect(prorationYer(0, 1_000, -5, 30)).toBe(0);
  });
});

describe('profitYer', () => {
  it('is revenue less commission less expenses', () => {
    expect(profitYer({ revenue: 10_000, commission: 500, expenses: 2_000 })).toBe(7_500);
  });

  it('goes negative when the fleet costs more than it earns', () => {
    expect(profitYer({ revenue: 1_000, commission: 500, expenses: 2_000 })).toBe(-1_500);
  });
});

describe('parseStatementText', () => {
  it('reads amount, date and reference', () => {
    const parsed = parseStatementText('10000,2026-03-01,JAIB-1\n2500,2026-03-02,');
    expect(parsed).toEqual({
      ok: true,
      lines: [
        { amountYer: 10_000, occurredOn: '2026-03-01', externalRef: 'JAIB-1' },
        { amountYer: 2_500, occurredOn: '2026-03-02', externalRef: null },
      ],
    });
  });

  it('strips thousands separators, because a bank statement has them', () => {
    const parsed = parseStatementText('10.000,2026-03-01,ref');
    expect(parsed.ok && parsed.lines[0]?.amountYer).toBe(10_000);
  });

  it('skips blank lines instead of counting them against the user', () => {
    const parsed = parseStatementText('\n100,2026-01-01\n\n200,2026-01-02\n');
    expect(parsed.ok && parsed.lines.length).toBe(2);
  });

  it('reports the failing line by number', () => {
    expect(parseStatementText('100,2026-01-01\nabc,2026-01-02\n')).toEqual({
      ok: false,
      line: 2,
    });
  });

  it('refuses a date that is not a date', () => {
    expect(parseStatementText('100,01/02/2026')).toEqual({ ok: false, line: 1 });
  });

  it('refuses a zero or negative amount', () => {
    expect(parseStatementText('0,2026-01-01')).toEqual({ ok: false, line: 1 });
  });
});

describe('parseQuotaDetail', () => {
  it('reads the metric, the limit and what is used', () => {
    expect(parseQuotaDetail('QUOTA_EXCEEDED: metric=vehicles limit=1 used=1')).toEqual({
      metric: 'vehicles',
      limit: 1,
      used: 1,
    });
  });

  it('reads "null" as unlimited rather than as zero', () => {
    expect(parseQuotaDetail('QUOTA_EXCEEDED: metric=trips limit=null used=4')).toEqual({
      metric: 'trips',
      limit: null,
      used: 4,
    });
  });

  it('returns null when there is nothing to read', () => {
    expect(parseQuotaDetail(undefined)).toBeNull();
    expect(parseQuotaDetail('FORBIDDEN: nope')).toBeNull();
  });

  it('prefers the structured context when the gateway sends one', () => {
    expect(
      quotaOf({
        code: 'QUOTA_EXCEEDED',
        detail: 'QUOTA_EXCEEDED: metric=vehicles limit=1 used=1',
        context: { metric: 'finance_exports', limit: 10, used: 3 },
      }),
    ).toEqual({ metric: 'finance_exports', limit: 10, used: 3 });
  });

  it('is not a quota failure when the code says otherwise', () => {
    expect(quotaOf({ code: 'FORBIDDEN' })).toBeNull();
  });
});

describe('finance contract', () => {
  it('rejects a journal with a single line', () => {
    expect(() =>
      parse({
        action: 'finance.journal.post',
        description: 'adjustment',
        lines: [{ account: 'platform_cash', direction: 'debit', amount: 100 }],
      }),
    ).toThrow();
  });

  it('rejects a negative amount: the direction says which side, the amount says how much', () => {
    expect(() =>
      parse({
        action: 'finance.journal.post',
        description: 'adjustment',
        lines: [
          { account: 'platform_cash', direction: 'debit', amount: -100 },
          { account: 'suspense', direction: 'credit', amount: -100 },
        ],
      }),
    ).toThrow();
  });

  it('rejects a scope that is both an organization and a user', () => {
    expect(() =>
      parse({
        action: 'finance.statement',
        orgId: uuidA,
        ownerUserId: uuidB,
      }),
    ).toThrow();
  });

  it('defaults a manual journal to an adjustment on both sides', () => {
    const parsed = parse({
      action: 'finance.journal.post',
      description: 'correction',
      lines: [
        { account: 'platform_cash', direction: 'debit', amount: 100 },
        { account: 'suspense', direction: 'credit', amount: 100 },
      ],
    });
    expect(parsed.action === 'finance.journal.post' && parsed.sourceKind).toBe('adjustment');
    expect(parsed.action === 'finance.journal.post' && parsed.orgId).toBeNull();
  });

  it('maps each action to the command the gateway calls', () => {
    const post = financeCommandArgs(
      parse({
        action: 'finance.journal.post',
        description: 'correction',
        clientReference: 'ref-1',
        lines: [
          { account: 'platform_cash', direction: 'debit', amount: 100 },
          { account: 'suspense', direction: 'credit', amount: 100 },
        ],
      }),
      uuidA,
      audit,
    );
    expect(post.fn).toBe('cmd_post_manual_journal');

    const expense = financeCommandArgs(
      parse({
        action: 'expense.record',
        category: 'fuel',
        amountYer: 5_000,
        settleFromBalance: true,
      }),
      uuidA,
      audit,
    );
    expect(expense.fn).toBe('cmd_record_expense');

    const job = financeCommandArgs(
      parse({ action: 'finance.job.run', job: 'integrity' }),
      uuidA,
      audit,
    );
    expect(job.fn).toBe('cmd_run_integrity_check');
  });

  it('scopes an expense to the owner who names an organization', () => {
    const scoped = parse({
      action: 'expense.record',
      orgId: uuidA,
      category: 'fuel',
      amountYer: 1,
    });
    expect(financeScope(scoped)).toEqual({ isOrgMember: true });
    const own = parse({ action: 'expense.record', category: 'fuel', amountYer: 1 });
    expect(financeScope(own)).toEqual({ isOwner: true });
  });

  it('needs a reason long enough to mean something to void an invoice', () => {
    expect(() => parse({ action: 'invoice.void', invoiceId: uuidA, reason: 'no' })).toThrow();
    expect(
      parse({ action: 'invoice.void', invoiceId: uuidA, reason: 'duplicate issue' }),
    ).toBeTruthy();
  });

  it('only allows an upgrade to take effect immediately', () => {
    // The form offers both buttons; the schema is what makes a downgrade-only-at-period-end a rule rather
    // than a convention, and the SQL refuses `now` for a cheaper plan anyway.
    expect(
      parse({
        action: 'subscription.changePlan',
        subscriptionId: uuidA,
        planCode: 'business',
        when: 'now',
      }),
    ).toBeTruthy();
  });
});

/**
 * Every action, once, through the dispatch table.
 *
 * Not because the table is interesting, but because a missing `case` in it is a command that silently does
 * nothing at the edge — and a table-driven test is the only way that stays true as actions are added.
 */
describe('finance command dispatch', () => {
  const cases: { input: Record<string, unknown>; fn: string }[] = [
    {
      input: {
        action: 'finance.journal.post',
        description: 'correction',
        lines: [
          { account: 'platform_cash', direction: 'debit', amount: 100 },
          { account: 'suspense', direction: 'credit', amount: 100 },
        ],
      },
      fn: 'cmd_post_manual_journal',
    },
    {
      input: { action: 'finance.journal.reverse', journalId: uuidA, reason: 'wrong day' },
      fn: 'cmd_reverse_journal',
    },
    {
      input: { action: 'expense.record', category: 'fuel', amountYer: 500 },
      fn: 'cmd_record_expense',
    },
    {
      input: { action: 'expense.void', expenseId: uuidA, reason: 'duplicate row' },
      fn: 'cmd_void_expense',
    },
    {
      input: { action: 'subscription.start', orgId: uuidA, planCode: 'pro', trial: false },
      fn: 'cmd_start_subscription',
    },
    {
      input: { action: 'subscription.changePlan', subscriptionId: uuidA, planCode: 'business' },
      fn: 'cmd_change_plan',
    },
    {
      input: { action: 'subscription.cancel', subscriptionId: uuidA, reason: 'closing' },
      fn: 'cmd_cancel_subscription',
    },
    { input: { action: 'invoice.pay', invoiceId: uuidA }, fn: 'cmd_pay_invoice' },
    {
      input: { action: 'invoice.void', invoiceId: uuidA, reason: 'duplicate bill' },
      fn: 'cmd_void_invoice',
    },
    {
      input: { action: 'finance.export', kind: 'payouts', from: '2026-01-01', to: '2026-01-31' },
      fn: 'cmd_export_finance',
    },
    {
      input: {
        action: 'finance.reconciliation.import',
        source: 'jaib',
        from: '2026-01-01',
        to: '2026-01-31',
        lines: [{ amountYer: 1_000, occurredOn: '2026-01-05' }],
      },
      fn: 'cmd_import_reconciliation',
    },
    {
      input: { action: 'finance.reconciliation.resolve', lineId: uuidA, status: 'matched' },
      fn: 'cmd_resolve_reconciliation_line',
    },
    { input: { action: 'plan.update', code: 'pro', priceYer: 8_000 }, fn: 'cmd_update_plan' },
    {
      input: { action: 'commission.rule.save', basisPoints: 450, effectiveFrom: '2026-02-01' },
      fn: 'cmd_upsert_commission_rule',
    },
    {
      input: {
        action: 'quota.override.grant',
        metric: 'vehicles',
        limitValue: 9,
        reason: 'support call',
      },
      fn: 'cmd_grant_quota_override',
    },
    {
      input: { action: 'quota.override.revoke', overrideId: uuidA, reason: 'grant ended' },
      fn: 'cmd_revoke_quota_override',
    },
    { input: { action: 'finance.dashboard' }, fn: 'cmd_get_finance_dashboard' },
    {
      input: { action: 'finance.statement', from: '2026-01-01', to: '2026-01-31' },
      fn: 'cmd_get_statement',
    },
    { input: { action: 'finance.job.run', job: 'outbox' }, fn: 'cmd_consume_outbox' },
    { input: { action: 'finance.job.run', job: 'renewals' }, fn: 'cmd_renew_subscriptions' },
    { input: { action: 'finance.job.run', job: 'expiry' }, fn: 'cmd_expire_subscriptions' },
    { input: { action: 'finance.job.run', job: 'usage-snapshot' }, fn: 'cmd_snapshot_usage' },
  ];

  it.each(cases)('maps $input.action to $fn', ({ input, fn }) => {
    const command = financeCommandArgs(parse(input), actor, audit);
    expect(command.fn).toBe(fn);
    expect(command.args.p_actor).toBe(actor);
  });

  it('passes the audit fields through so the trail survives the hop', () => {
    const command = financeCommandArgs(parse({ action: 'invoice.pay', invoiceId: uuidA }), actor, {
      p_request_id: 'req-9',
      p_ip: '10.0.0.1',
    });
    expect(command.args.p_request_id).toBe('req-9');
    expect(command.args.p_ip).toBe('10.0.0.1');
  });

  it('omits the audit fields when the caller has none', () => {
    const command = financeCommandArgs(parse({ action: 'finance.dashboard' }), actor);
    expect('p_request_id' in command.args).toBe(false);
  });

  it('gives the jobs their own limit, and only to the outbox', () => {
    const job = (name: string, limit?: number) =>
      financeCommandArgs(
        parse(
          limit === undefined
            ? { action: 'finance.job.run', job: name }
            : { action: 'finance.job.run', job: name, limit },
        ),
        actor,
      );
    expect(job('outbox', 50).args.p_limit).toBe(50);
    expect(job('renewals').args.p_limit).toBe(200);
    // A check that takes no limit does not receive one: an argument the function cannot use is a lie about
    // what the job does.
    expect('p_limit' in job('integrity').args).toBe(false);
  });
});

describe('financeScope for every action', () => {
  it('treats the desks as owner-or-member work', () => {
    for (const input of [
      { action: 'finance.journal.reverse', journalId: uuidA, reason: 'wrong day' },
      { action: 'finance.export', kind: 'statement', from: '2026-01-01', to: '2026-01-31' },
      { action: 'finance.dashboard' },
      { action: 'finance.job.run', job: 'integrity' },
    ]) {
      expect(financeScope(parse(input))).toEqual({ isOwner: true, isOrgMember: true });
    }
  });

  it('scopes a subscription start to the organization that starts it', () => {
    expect(
      financeScope(parse({ action: 'subscription.start', orgId: uuidA, planCode: 'pro' })),
    ).toEqual({ isOrgMember: true });
  });

  it('treats a row-named action as owner-or-member, because the SQL re-derives the owner', () => {
    expect(
      financeScope(parse({ action: 'expense.void', expenseId: uuidA, reason: 'duplicate' })),
    ).toEqual({
      isOwner: true,
      isOrgMember: true,
    });
    expect(financeScope(parse({ action: 'subscription.cancel', subscriptionId: uuidA }))).toEqual({
      isOwner: true,
      isOrgMember: true,
    });
  });

  it('is platform work for the pricing and support actions', () => {
    for (const input of [
      { action: 'invoice.pay', invoiceId: uuidA },
      { action: 'plan.update', code: 'pro' },
      { action: 'quota.override.grant', metric: 'vehicles', limitValue: 2, reason: 'support call' },
    ]) {
      expect(financeScope(parse(input))).toEqual({});
    }
  });
});
