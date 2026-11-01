# Phase 10 — finance: one ledger, and what a plan is allowed to cost

**Date:** 2026-11-01 · **Branch:** `arena/143af8a0-maak`
**Scope:** `IMPLEMENTATION_PLAN.md` Phase 10. What shipped, what was decided differently, what broke when it
was actually run, and what is still open — §6 is the honest list.

Phase 9 recorded money movement and left a seam (`payment_outbox`) with no consumer. This phase is the
consumer: a double-entry ledger everything financial reads from, an invoice for each bill, a commission engine
with an effective-dated rule table, a reconciliation desk, a daily integrity job, and the plans and
subscriptions the platform actually sells. The design rule throughout is that **the ledger is the only place
money is counted** — the dashboard, the statement, the payout cap and the platform's profit are four readings
of the same rows, and four readings of one thing cannot disagree.

---

## 1. What shipped

### Schema (`00031_finance.sql`, ~3 700 lines, 24 commands, 25 helpers)

| Object | Purpose |
| --- | --- |
| `ledger_accounts` | The platform's chart of accounts, seeded with ten codes (`platform_cash`, `platform_bank`, `agent_receivable`, `operator_receivable`, `operator_payable`, `commission_revenue`, `subscription_revenue`, `refund_expense`, `payout_clearing`, `suspense`). **No per-owner chart**: every journal carries its owner, so an owner's balance is a `sum` over their journals; materialising one row per owner per account would be a second copy of the same facts, and the copy is what goes stale. |
| `journal_entries` | Header: `code`, `posting_date`, `description`, `source_kind`, `(source_table, source_id)`, owner scope, `reverses_id`, `reason`. A deferred constraint trigger refuses to commit a journal whose debits do not equal its credits, so a two-statement post cannot fail the balance check it passes in isolation. |
| `ledger_entries` | Lines: `seq`, `account_code`, `direction`, positive `amount_yer`. Both tables are write-once — `app.reject_ledger_mutation()` is a `BEFORE UPDATE OR DELETE` trigger, and a correction is a reversing journal with a reason, never an edit. |
| `invoices` | Booking and subscription bills with a **frozen `snapshot`** (the trip, the passengers, the commission, the plan) and a `code`. An invoice is a statement about a moment: a later edit to a trip must not change what somebody was billed. |
| `commission_rules` | Effective-dated rows, global or per organization: `basis_points`, `min_yer`, `max_yer`. Resolution order is rate → one-rial floor → plan discount → rule floor/cap → never above the fare. |
| `plans`, `plan_limits` | Basic (0), Pro (7 500), Business (25 000) YER, trial 14 days. Limits per metric — vehicles 1/5/null, `finance_exports` 1/10/null, `fleet_reports` 0/1/null — as data an admin edits. |
| `subscriptions`, `subscription_events` | One live subscription per owner, enforced by a partial unique index on `coalesce(owner_user_id, owner_org_id)`; `trialing → active → past_due → grace → expired`, plus `pending_plan_code` and `cancel_at_period_end`. Every transition writes an event row, so the history is the table, not a log. |
| `quota_overrides`, `usage_counters`, `quota_violations` | Support grants that expire, counted usage per metric per period, and a row every time a limit refused somebody — the last one is what turns "the plan is too small" into a decision with evidence. |
| `expenses` | Already existed from Phase 8; this phase adds the ledger treatment. Owner-paid expenses create **no** journal; `settle_from_balance` posts a settlement. |
| `reconciliation_imports`, `reconciliation_lines` | A pasted bank statement, matcher output, and the exception queue. |
| `finance_exports` | The export log. It is also the quota: `finance_exports` is counted from this table, so an export that is not logged does not count. |
| `payment_outbox` (Phase 9) | Drained by `cmd_consume_outbox`; this is how Phase 9's backlog becomes postings. |

Enums: `ledger_account_kind`, `journal_source_kind`, `invoice_kind`, `invoice_status`, `subscription_status`,
`subscription_event_kind`, `reconciliation_status`; five new `notification_kind` values
(`invoice_issued`, `subscription_activated`, `subscription_past_due`, `subscription_expired`, `finance_alert`).

### Helpers that carry the invariants

| Helper | Why it exists |
| --- | --- |
| `app.post_journal(...)` | The single writer. Idempotent on `(source_kind, source_table, source_id)`: a replayed outbox row returns the existing journal, it does not post a second. |
| `app.commission_yer(owner, gross)` | The whole rate cascade in one place, including the plan discount, the rule floor and cap, and the "never above the fare" clamp. |
| `app.owner_effective_plan` / `app.org_effective_plan` | Replaces the Phase 1 stub. Trial, past due, grace and expired all resolve here, and expiry falls back to Basic **without deleting anything**. |
| `app.quota_state` / `app.assert_quota` | One function answers "how much is left", and the same function refuses; the badge on the billing screen and the refusal at the creation path cannot drift. |
| `app.owner_ledger_balance_yer` / `app.owner_available_yer` | The balance and the payout cap. Phase 9's cap was computed from payments alone and disagreed with the ledger after a refund; this one is derived from postings, so it cannot. |
| `app.ledger_totals(owner_user, owner_org, from, to)` | Per-account debit/credit/net with the sign convention decided by `ledger_account_kind`. Called with no owner it totals the whole ledger — that is finance's platform view. |
| `app.issue_subscription_invoice`, `app.issue_booking_invoice` | Billing, in the two places money is owed. Both are idempotent per period (a partial unique index on `(subscription_id, due_on)` excluding prorations), so a renewal job that runs twice bills once. |
| `app.subscription_event(...)` | Writes the event row and the notification together, so a transition and its message cannot come apart. |

### Commands — 19 actions on the `finance` edge function (24 `cmd_*` SQL functions)

| Action | Function | Notes |
| --- | --- | --- |
| `finance.journal.post` | `cmd_post_manual_journal` | Finance only, `adjustment`/`expense` source kinds only. `clientReference` makes a double click one journal. |
| `finance.journal.reverse` | `cmd_reverse_journal` | Requires a reason; the original is untouched; a second reversal is a duplicate key. |
| `expense.record` / `expense.void` | `cmd_record_expense` / `cmd_void_expense` | Owner, org manager or finance records; voiding is a soft delete plus a reversing journal when the expense was settled. |
| `subscription.start` | `cmd_start_subscription` | Basic is refused — it is the floor, not a purchase. A trial bills when it ends; a paid start bills now. |
| `subscription.changePlan` | `cmd_change_plan` | Upgrade now with a prorated invoice; downgrade scheduled to the period end, and `now` for a cheaper plan is refused. |
| `subscription.cancel` | `cmd_cancel_subscription` | At period end by default; immediate cancellation is explicit. |
| `invoice.pay` / `invoice.void` | `cmd_pay_invoice` / `cmd_void_invoice` | Paying a subscription invoice posts subscription revenue and opens the next period. A paid invoice cannot be voided. |
| `finance.export` | `cmd_export_finance` | Logged, quota-counted, and shaped like the screen it came from. |
| `finance.reconciliation.import` / `.resolve` | `cmd_import_reconciliation` / `cmd_resolve_reconciliation_line` | Conservative matcher, audited manual resolution. |
| `plan.update` | `cmd_update_plan` | Price, trial, soft-limit flag and per-metric limits. No deploy, by design. |
| `commission.rule.save` | `cmd_upsert_commission_rule` | Global or per organization, effective-dated. |
| `quota.override.grant` / `.revoke` | `cmd_grant_quota_override` / `cmd_revoke_quota_override` | Expiring grants, with a reason. |
| `finance.dashboard` / `finance.statement` | `cmd_get_finance_dashboard` / `cmd_get_statement` | Reads, computed from the ledger every time. The dashboard also answers the quota list. |
| `finance.job.run` | `cmd_consume_outbox`, `cmd_renew_subscriptions`, `cmd_expire_subscriptions`, `cmd_snapshot_usage`, `cmd_run_integrity_check` | The five jobs, callable and rate-limited (12/h for `integrity`, 120/h otherwise). |

### Clients

| Piece | Where |
| --- | --- |
| Contract, 19-action union, dispatch table, helpers (`commissionYer`, `effectiveBasisPoints`, `prorationYer`, `profitYer`, `parseStatementText`) | `packages/core/src/api/finance.ts` |
| Error codes `UNBALANCED_JOURNAL` (422) and `IMMUTABLE` (409), translated in both locales | `packages/core/src/api/errors.ts`, `dictionaries.ts` |
| ~240 new keys per locale across twelve blocks (`financeNav.*`, `financeDash.*`, `invoices.*`, `statement.*`, `ledger.*`, `recon.*`, `billing.*`, `expenses.*`, `cat.*`, `plans.*`, `subs.*`, `metric.*`, `plan.*`, `sub.status.*`) | `packages/core/src/i18n/dictionaries.ts` |
| Six new capabilities | `packages/core/src/domain/policy.ts` |
| Server reads, RLS-shaped | `apps/web/src/lib/finance.ts` |
| Desks: `SummaryCards`, `InvoiceDesk`, `JournalDesk`, `ReconciliationDesk`, `BillingPanel`, `ExpensesPanel`, `PlansEditor`, `StatementExport`, `useFinanceCommand` | `apps/web/src/components/finance/` |
| Routes | `/finance/{dashboard,invoices,statements,ledger,reconciliation}`, `/operator/{billing,expenses}`, `/admin/{plans,subscriptions}` |
| Demo data, through the commands | `scripts/dev-backend/db.mjs` → `seedDemoFinance()` |

---

## 2. Decisions that differ from the plan, and why

1. **Payouts did not move.** The plan lists "request → approve → mark paid" under Phase 10. Those commands
   shipped in Phase 9 and are already segregation-of-duties enforced (`payouts_not_self_approved`). This phase
   changed the *cap* — `app.owner_available_yer` is now derived from the ledger instead of from payments minus
   payouts — because the old expression disagreed with the books after a refund. Re-implementing the queue
   would have been churn with a regression risk.
2. **PDF invoices and statements are not rendered.** The plan asks for AR/EN PDFs. What shipped is the same
   data through `cmd_get_statement` and `cmd_export_finance` (CSV, both locales). A PDF template pipeline is a
   rendering decision (fonts, RTL shaping, page breaks) whose output nobody can check in CI; the CSV is the
   source of truth either way. §6 keeps it open.
3. **The commission engine is not per-trip.** Rules are global or per organization, effective-dated. A
   per-vehicle or per-trip override is a pricing product decision with an abuse surface (an operator setting
   their own rate), and nothing in the acceptance criteria needed it.
4. **Reconciliation matches on amount, date and uniqueness only.** Deliberately: a matcher that guesses turns
   a known gap into an unknown one. A line matches when exactly one unclaimed payment (or paid payout) is
   equal within ±3 days; anything else becomes an exception a person resolves, and the resolution is audited.
5. **The integrity job counts, it does not sum.** `suspense_empty` originally added the suspense balance to
   the failure total, so 1 000 riyals of unaudited money reported as 1 000 failures. Found by running the job
   against a database that had a suspense posting — see §3.
6. **`finance_exports` quota applies to an owner's export, not to finance's own.** A plan limits an operator;
   finance is not on a plan. A platform-wide export is logged with no owner scope and skips the plan check.
7. **The subscription is cash-basis.** Revenue is recognised when an invoice is paid, not when it is issued.
   Accrual would have meant a deferred-revenue account and a monthly amortisation job for a business that takes
   bank transfers from a dozen operators — cost without a decision it changes.

---

## 3. Bugs found by running it, not by reading it

Every one of these was caught by exercising the deployed path against the dev backend, and each is now covered
by a test or by a check that would fail again:

1. **A client component imported the server module.** `ReconciliationDesk` imported `parseStatementText` from
   `apps/web/src/lib/finance.ts`, which imports `next/headers`. Type-only imports of that module are erased, but
   a *value* import dragged the server module into the client bundle, and five screens answered 500. The parser
   moved into `packages/core` (where it is also unit-tested), and the components now import types only.
2. **The scope guard rejected the shape the pages sent.** `finance.dashboard` and `finance.statement` were
   called with both `orgId` and `ownerUserId`; the schema refuses both. The failure was swallowed as `null`, so
   `/operator/billing` confidently said "no active subscription — you are on Basic" for an organization on Pro.
   A single `scopePayload()` now normalises the pair, and the union-level refinement is tested.
3. **Every statement was empty.** The page passed ISO timestamps to a contract whose dates are `YYYY-MM-DD`, so
   validation failed and the screen said "no movements in this period". `loadStatement` now takes the day.
4. **The statement had no lines.** It returned journal headers with an `amountYer`, which is enough for a total
   and not enough for a ledger screen. The lines now travel with the journal from the same query.
5. **A platform-wide dashboard totalled nothing.** `app.ledger_totals` filtered on `owner_user_id = null`, which
   is never true — a silent zero for the one caller who legitimately has no owner. Fixed with an explicit
   "no owner means everyone" branch, and pinned by a new assertion.
6. **The reconciliation import 500'd on its first real use.** A `CASE` returns `text`, and `text` does not
   assign to an enum column implicitly. Two lines of the same amount in one statement are exactly the case the
   suite now covers.
7. **`prorationYer` truncated differently from SQL.** JavaScript `Math.floor` and Postgres integer division
   disagree on negative numbers, which meant a downgrade credit off by one riyal. Both truncate toward zero now,
   and the test asserts it.

---

## 4. Verification

| Gate | Result |
| --- | --- |
| `npm run sql:check` | 31 migrations applied · **15 pgTAP suites, 774 assertions** (99 new) · `database.types.ts` in sync (31 files) · write lockdown intact |
| `npm test` | **522 tests**, 24 files (36 new in `packages/core/tests/finance-api.test.ts`) |
| `npm run test:coverage` | thresholds met: 95.8% statements / 87.1% branches (`api/finance.ts` 96.8% statements) |
| `npm run check:guards` | 29 core files · 163 style files · 31 migrations · **105 commands** · notification keys present · gateway and edge capability maps identical (19 finance actions each) |
| `npm run check:responsive` | 52 media queries, no hidden navigation, no unguarded grid tracks, 7 tap targets, every wide table in `.table-scroll`, stacked card tables labelled |
| `npm run check:a11y` | **101 routes** in both directions, including the 18 new money screens and 12 discovered detail pages |
| `npm run lint` · `format:check` · `typecheck` | clean (web, core, mobile) |
| `npm run check:functions` | 10 bundled functions, including `finance` |
| `npm run db:types:check` | matches 31 migrations |

End-to-end against the running dev backend (the numbers are what the screens show after `dev:api:reset`):

1. The seed confirms the receipt Phase 9 left pending and drains the outbox: one payment journal
   (`platform_cash` 2 500 debit; `operator_payable` 2 400 + `commission_revenue` 100 credit), one booking
   invoice (`INV-684967`, 2 500 total, 100 commission inside it).
2. `/finance/dashboard` reads the same month from the ledger: gross 2 500, commission 100, subscription 7 500,
   profit 7 600; the integrity card is green; the account balances are listed (they were empty before bug 5).
3. `/operator/billing` shows Pro · active · 7 500 YER · 01/11 → 01/12, the quota table, and two buttons — change
   now, change at period end.
4. `/admin/subscriptions` lists the live subscription and the override table; `/admin/plans` edits a price and a
   limit; `/operator/expenses` records a fuel expense settled from the balance and a maintenance expense from
   the operator's own pocket (the second posts no journal).
5. `finance.journal.post` through the gateway posts a balanced adjustment (`JE-EE386F`); replaying the same
   `clientReference` returns the same code and posts nothing; an unbalanced one returns
   `422 UNBALANCED_JOURNAL` — "debits 1000 but credits 900".
6. `finance.reconciliation.import` with three lines (2 500, 2 500, 2 499) against one unclaimed confirmed
   payment of 2 500 matches **one** and queues two exceptions, which the desk lists with their references.
7. `finance.job.run` → `integrity` returns `failed: 0` on a clean database.

---

## 5. What the pgTAP suite actually promises (99 assertions)

Written in the order money moves: posting → immutability → commission → quotas → billing → dunning → integrity
→ reconciliation → RLS.

- a confirmed payment posts **exactly once**; the journal's debits equal its credits to the riyal; replaying the
  outbox posts nothing and the row count does not move;
- an unbalanced journal is refused by `app.post_journal` **and** by the deferred trigger when the rows are
  written directly (with `set constraints … immediate`);
- `update`/`delete` on a posted journal or line raises `IMMUTABLE`; a reversal mirrors the lines, names the
  original, needs a reason of at least five characters, and a second reversal is a duplicate;
- commission: 500 bp of 10 000 is 500; a 10-rial fare still pays 1; the Pro discount takes it to 400 bp; a rule
  floor and cap apply; commission never exceeds the fare;
- the payout cap agrees with the ledger after a refund (it did not in Phase 9);
- quotas: Basic blocks the second vehicle with `QUOTA_EXCEEDED`, an override raises the ceiling, the override
  expires, and `finance_exports` is counted from the export log;
- billing: a trial issues no invoice; when it ends the renewal job issues one (7 500, due in 7 days) and flips
  the subscription to `active`; paying it posts subscription revenue; the second renewal bills once;
- dunning: unpaid past the due date becomes `past_due`, then `grace`, then `expired` — and the organization's
  effective plan is Basic while its vehicles are still there;
- a downgrade is stored as `pending_plan_code`, an upgrade bills a prorated amount, and neither deletes a row;
- the integrity job is green on fixtures and turns red when one amount is tampered with (the trigger disabled,
  amounts changed, then restored);
- the statement's closing balance equals the ledger's balance, and a platform-wide dashboard totals the whole
  ledger instead of nothing;
- reconciliation matches one line and queues two, and an operator cannot import a statement at all (`42501`);
- RLS: finance reads every journal and every invoice; an owner reads their own; a stranger reads nothing; and no
  client role can execute a `cmd_*` even one that exists.

---

## 6. Still open

1. **No scheduler.** The five jobs are callable, rate-limited, tested and run by `dev:api:reset`, but nothing
   runs them on a timer: this repo has no cron process, and Phase 12 is where the job runner lands. Until then
   the integrity alarm exists and nobody is woken by it.
2. **PDF invoices and statements.** CSV and JSON only, for the reason in §2.
3. **A proration credit is an invoice, not a refund.** Downgrading mid-period reduces a future bill through a
   negative-proration invoice that is issued and voided rather than credited to a balance. Correct on paper,
   awkward to explain; a credit-note type is the clean model.
4. **Reconciliation is import-only.** No bank API, no scheduled fetch, no automatic re-run: a person pastes the
   file. That is a market reality rather than an omission, but it means the exception queue is only as current
   as the last paste.
5. **`usage_counters` is not yet the enforcement path for every metric.** `assert_quota` recomputes usage from
   the source tables (vehicles, trips, staff, exports); the counters are snapshotted daily for reporting. Both
   are correct today; when a metric becomes too expensive to count, the counter has to become the authority and
   the snapshot job becomes load-bearing.
6. **Quota override UI is read-only.** The commands exist (`quota.override.grant`/`revoke`), `/admin/subscriptions`
   lists grants and their expiry, but granting is a support console screen away — deliberately, so a grant
   always carries a reason typed by a person.
7. **No ad-hoc trial extension.** A trial can be shortened by expiry, extended only by changing the plan's
   `trial_days` before the fact. Support will ask for "give this operator another week" on day two.
8. **Dunning notices are one notification, not a sequence.** `subscription_past_due` fires once; escalating
   reminders ("three days left") belong with Phase 11's notification matrix, which owns frequency and channels.

---

## 7. Where this leaves the money

The books are now closed in the only way that matters for a platform this size: every movement of money has a
journal, every journal balances, posted rows cannot be edited, and a correction is a new entry that says why.
Three things read from that ledger — the dashboard, the statement and the payout cap — and because they are
readings rather than copies, the number an operator argues about is the number finance can point at.

What is still missing is not accounting, it is *time*: nothing runs on a schedule yet, so renewals, expiry and
the integrity alarm wait for a person or a reset. That is Phase 12's job, and until it lands this phase should
be described as correct when exercised, not as self-running.
