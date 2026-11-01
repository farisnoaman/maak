-- 0015 — Phase 10: the ledger, the commission, the plans, and the bills
--
-- The promises verified here, in the order money moves through the system:
--   1. a confirmed payment posts exactly once, and the journal balances to the riyal
--   2. an unbalanced journal is refused by the writer *and* by the deferred trigger
--   3. posted rows cannot be edited or deleted; a correction is a reversing journal with a reason
--   4. commission follows the rule, the cap, the floor, and the plan's discount
--   5. the payout cap agrees with the ledger, which it did not in Phase 9
--   6. quotas: Basic blocks, an override raises the ceiling until it expires, exports are a rate
--   7. subscription: trial → invoice → paid → renewed, and the dunning ladder to expired → Basic
--   8. a downgrade is scheduled, an upgrade is prorated, and no plan change deletes anything
--   9. the integrity job is green, and goes red when one amount is tampered with
--  10. RLS: an owner reads their own books; finance reads everything; a stranger reads nothing
--
-- Run with: supabase test db   (requires Docker), or `npm run sql:check` (embedded Postgres).

begin;

create extension if not exists pgtap;

select plan(104);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('10610001-0000-4000-8000-000000000001', 'fin-passenger@example.test', '+967733930001', '{"locale":"ar"}'),
  ('10610002-0000-4000-8000-000000000002', 'fin-operator@example.test', '+967733930002', '{"locale":"ar"}'),
  ('10610003-0000-4000-8000-000000000003', 'fin-finance@example.test', '+967733930003', '{"locale":"ar"}'),
  ('10610004-0000-4000-8000-000000000004', 'fin-stranger@example.test', '+967733930004', '{"locale":"ar"}'),
  ('10610005-0000-4000-8000-000000000005', 'fin-admin@example.test', '+967733930005', '{"locale":"ar"}');

update public.profiles set verification_status = 'verified' where id::text like '1061%';

insert into public.user_roles (user_id, role)
values ('10610003-0000-4000-8000-000000000003', 'finance_officer'),
       -- Quota overrides and the plans editor are an admin's, not a finance officer's: an exception to a
       -- commercial rule belongs to the person who owns the commercial rule.
       ('10610005-0000-4000-8000-000000000005', 'platform_admin');

insert into public.organizations (id, name, owner_id, verification_status, plan)
values ('1061aa00-0000-4000-8000-00000000000a', 'Fin Co',
        '10610002-0000-4000-8000-000000000002', 'verified', 'basic');

insert into public.organization_members (org_id, user_id, role, status, joined_at)
values ('1061aa00-0000-4000-8000-00000000000a', '10610002-0000-4000-8000-000000000002',
        'owner', 'active', now());

insert into public.vehicles (
  id, owner_org_id, make, model, model_year, plate_number, plate_governorate_id,
  fuel_type, seats_passenger, seats_total, odometer_km, status, verification_status,
  insurance_expiry, inspection_expiry, registration_expiry, created_by
)
values (
  '1061c001-0000-4000-8000-000000000001', '1061aa00-0000-4000-8000-00000000000a',
  'Toyota', 'Hiace', 2019, '10-1001',
  (select id from public.governorates where code = 'YE-AD'),
  'diesel', 12, 13, 40_000, 'active', 'verified',
  current_date + 200, current_date + 200, current_date + 200,
  '10610002-0000-4000-8000-000000000002'
);

insert into public.trips (
  id, code, owner_org_id, vehicle_id, origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, price_per_seat_yer, discount_kind, discount_value,
  payment_policy, deposit_percent, status, verification_status, published_at
)
values (
  '1061b001-0000-4000-8000-000000000001', 'P10-AA-0001',
  '1061aa00-0000-4000-8000-00000000000a', '1061c001-0000-4000-8000-000000000001',
  (select id from public.governorates where code = 'YE-AD'),
  (select id from public.governorates where code = 'YE-SA'),
  now() + interval '3 days', 12, 12, 10_000, 'none', 0,
  'transfer', 30, 'published', 'verified', now()
);

select public.cmd_create_booking(
  '10610001-0000-4000-8000-000000000001', '1061b001-0000-4000-8000-000000000001',
  1, null, null, 'مسافر مالي', '+967733939001', null, null, 'p10-fixture', null
);

-- A confirmed payment, as Phase 9 leaves it: the intent is a fact, the outbox row is the seam.
insert into public.payment_intents (
  id, code, purpose, booking_id, payer_id, method, amount_yer, status,
  confirmed_by, confirmed_at
)
values (
  '1061e001-0000-4000-8000-000000000001', 'PI-FI0001', 'booking',
  (select id from public.bookings where trip_id = '1061b001-0000-4000-8000-000000000001'),
  '10610001-0000-4000-8000-000000000001', 'jaib', 10_000, 'confirmed',
  '10610003-0000-4000-8000-000000000003', now()
);

select app.queue_money_event(
  'payment_confirmed', 'payment_intents', '1061e001-0000-4000-8000-000000000001', 10_000,
  '{}'::jsonb, '10610003-0000-4000-8000-000000000003', null,
  '1061aa00-0000-4000-8000-00000000000a'
);

-- ---------------------------------------------------------------------------
-- 1. Posting: one journal, balanced, with an invoice that says what it was for
-- ---------------------------------------------------------------------------

select is(
  (select public.cmd_consume_outbox(null, 10) ->> 'posted'),
  '1',
  'draining the outbox posts exactly one journal'
);

select is(
  (select count(*)::int from public.journal_entries where source_kind = 'payment'),
  1,
  'one payment, one journal'
);

select is(
  (select sum(case when direction = 'debit' then amount_yer else -amount_yer end)::int
     from public.ledger_entries
    where journal_id = (select id from public.journal_entries where source_kind = 'payment')),
  0,
  'and the journal balances to zero'
);

select is(
  (select l.amount_yer from public.ledger_entries l
    where l.account_code = 'platform_cash' and l.direction = 'debit'
      and l.journal_id = (select id from public.journal_entries where source_kind = 'payment')),
  10_000,
  'the cash debit is the whole fare'
);

select is(
  (select l.amount_yer from public.ledger_entries l
    where l.account_code = 'operator_payable' and l.direction = 'credit'
      and l.journal_id = (select id from public.journal_entries where source_kind = 'payment')),
  9_500,
  'the operator is owed the fare minus the 5 % commission'
);

select is(
  (select l.amount_yer from public.ledger_entries l
    where l.account_code = 'commission_revenue' and l.direction = 'credit'
      and l.journal_id = (select id from public.journal_entries where source_kind = 'payment')),
  500,
  'and the platform keeps 500'
);

select is(
  (select total_yer from public.invoices where intent_id = '1061e001-0000-4000-8000-000000000001'),
  10_000,
  'the passenger''s invoice is the fare they paid, not the fare plus the fee'
);

select is(
  (select commission_yer from public.invoices where intent_id = '1061e001-0000-4000-8000-000000000001'),
  500,
  'with the commission shown *inside* it, on the operator''s statement'
);

select is(
  (select snapshot ->> 'bookingCode' from public.invoices
    where intent_id = '1061e001-0000-4000-8000-000000000001'),
  (select code from public.bookings where trip_id = '1061b001-0000-4000-8000-000000000001'),
  'and the snapshot froze the booking it was issued against'
);

select is(
  (select status::text from public.invoices where intent_id = '1061e001-0000-4000-8000-000000000001'),
  'paid',
  'a booking invoice is born paid: the money cleared before the document existed'
);

-- ---------------------------------------------------------------------------
-- 2. Double posting is impossible
-- ---------------------------------------------------------------------------

select is(
  (select public.cmd_consume_outbox(null, 10) ->> 'posted'),
  '0',
  'draining the outbox again posts nothing'
);

select is(
  (select count(*)::int from public.journal_entries where source_kind = 'payment'),
  1,
  'and there is still exactly one journal for the payment'
);

select is(
  (select count(*)::int from public.invoices where kind = 'booking'),
  1,
  'and exactly one bill for the passenger'
);

select is(
  app.post_journal(
    'payment', 'payment_intents', '1061e001-0000-4000-8000-000000000001',
    current_date, 'تحصيل دفعة / payment received',
    '[{"account":"platform_cash","direction":"debit","amount":10000},
      {"account":"operator_payable","direction":"credit","amount":9500},
      {"account":"commission_revenue","direction":"credit","amount":500}]'::jsonb,
    '10610003-0000-4000-8000-000000000003', null, '1061aa00-0000-4000-8000-00000000000a'
  ),
  (select id from public.journal_entries where source_kind = 'payment'),
  'even a hand-built second posting returns the first journal instead of writing another'
);

-- ---------------------------------------------------------------------------
-- 3. A journal must balance, and posted rows are frozen
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select app.post_journal(
       'adjustment', 'manual', gen_random_uuid(), current_date, 'unbalanced',
       '[{"account":"platform_cash","direction":"debit","amount":100},
         {"account":"suspense","direction":"credit","amount":90}]'::jsonb
     ) $$,
  '23514',
  null,
  'the writer refuses a journal whose debits and credits differ'
);

-- The same failure, one level lower: the deferred constraint trigger. Tested with the constraint forced
-- immediate, because a deferred check only fires at commit and pgTAP cannot commit.
set constraints journal_entries_balanced immediate;

select throws_ok(
  $$ with j as (
       insert into public.journal_entries (code, posting_date, description, source_kind, source_table, source_id)
       values ('JE-TEST01', current_date, 'one line only', 'adjustment', 'manual', gen_random_uuid())
       returning id
     )
     insert into public.ledger_entries (journal_id, seq, account_code, direction, amount_yer)
     select id, 1, 'platform_cash', 'debit', 100 from j $$,
  '23514',
  null,
  'a journal with a single line cannot be committed, even without going through the writer'
);

set constraints journal_entries_balanced deferred;

select throws_ok(
  $$ update public.journal_entries set description = 'edited after the fact' $$,
  '23514',
  null,
  'a posted journal cannot be edited'
);

select throws_ok(
  $$ delete from public.ledger_entries $$,
  '23514',
  null,
  'and a posted line cannot be deleted'
);

-- ---------------------------------------------------------------------------
-- 4. Corrections: a manual journal, and the reversal that undoes it
-- ---------------------------------------------------------------------------

create temporary table t_manual on commit drop as
select public.cmd_post_manual_journal(
  '10610003-0000-4000-8000-000000000003',
  jsonb_build_object(
    'sourceKind', 'adjustment',
    'description', 'تصحيح افتتاحي / opening correction',
    'clientReference', 'p10-manual-1',
    'reason', 'opening balance adjustment',
    'lines', jsonb_build_array(
      jsonb_build_object('account', 'platform_cash', 'direction', 'debit', 'amount', 1_000),
      jsonb_build_object('account', 'commission_revenue', 'direction', 'credit', 'amount', 1_000)
    )
  ),
  null, null
) as result;

select is(
  (select result -> 'journal' ->> 'source_kind' from t_manual),
  'adjustment',
  'finance may post a manual adjustment'
);

select is(
  public.cmd_post_manual_journal(
    '10610003-0000-4000-8000-000000000003',
    jsonb_build_object(
      'sourceKind', 'adjustment',
      'description', 'تصحيح افتتاحي / opening correction',
      'clientReference', 'p10-manual-1',
      'lines', jsonb_build_array(
        jsonb_build_object('account', 'platform_cash', 'direction', 'debit', 'amount', 1_000),
        jsonb_build_object('account', 'commission_revenue', 'direction', 'credit', 'amount', 1_000)
      )
    ),
    null, null
  ) -> 'journal' ->> 'code',
  (select result -> 'journal' ->> 'code' from t_manual),
  'and a retry with the same client reference returns the same journal'
);

select throws_ok(
  $$ select public.cmd_post_manual_journal(
       '10610003-0000-4000-8000-000000000003',
       '{"sourceKind":"payment","description":"nope",
         "lines":[{"account":"platform_cash","direction":"debit","amount":1},
                  {"account":"suspense","direction":"credit","amount":1}]}'::jsonb,
       null, null) $$,
  '22023',
  null,
  'but not under the name of a payment: a manual journal is an adjustment or an expense'
);

select throws_ok(
  $$ select public.cmd_reverse_journal(
       '10610003-0000-4000-8000-000000000003',
       ((select result -> 'journal' ->> 'id' from t_manual))::uuid,
       'no', null, null) $$,
  '22023',
  null,
  'a reversal without a reason is refused'
);

select is(
  (select public.cmd_reverse_journal(
     '10610003-0000-4000-8000-000000000003',
     ((select result -> 'journal' ->> 'id' from t_manual))::uuid,
     'the opening figure was wrong', null, null
   ) -> 'journal' ->> 'reverses_id'),
  (select result -> 'journal' ->> 'id' from t_manual),
  'a reversal names the journal it reverses'
);

select is(
  (select sum(case when l.direction = 'credit' then l.amount_yer else -l.amount_yer end)::int
     from public.ledger_entries l
    where l.account_code = 'commission_revenue'),
  500,
  'and the pair nets to the original: the correction removes the 1 000 it added'
);

select throws_ok(
  $$ select public.cmd_reverse_journal(
       '10610003-0000-4000-8000-000000000003',
       ((select result -> 'journal' ->> 'id' from t_manual))::uuid,
       'again', null, null) $$,
  '23505',
  null,
  'the same journal cannot be reversed twice'
);

-- ---------------------------------------------------------------------------
-- 5. Commission: the rule, the floor, the cap, then the plan's discount
-- ---------------------------------------------------------------------------

select is(
  app.commission_yer(null, '1061aa00-0000-4000-8000-00000000000a', 10_000),
  500,
  'the seeded global rule is 5 %'
);

insert into public.commission_rules (owner_org_id, basis_points, effective_from, created_by)
values ('1061aa00-0000-4000-8000-00000000000a', 800, current_date, '10610003-0000-4000-8000-000000000003');

select is(
  app.commission_yer(null, '1061aa00-0000-4000-8000-00000000000a', 10_000),
  800,
  'a negotiated rate for this organization wins over the global one'
);

insert into public.commission_rules (owner_org_id, basis_points, max_yer, effective_from, created_by)
values ('1061aa00-0000-4000-8000-00000000000a', 800, 50, current_date + 1,
        '10610003-0000-4000-8000-000000000003');

select is(
  app.commission_yer(null, '1061aa00-0000-4000-8000-00000000000a', 10_000, current_date + 1),
  50,
  'and a cap is a cap: never more than 50 rials, whatever the rate says'
);

select is(
  app.commission_yer(null, '1061aa00-0000-4000-8000-00000000000a', 5),
  1,
  'a non-zero rate on a tiny fare never rounds away to zero'
);

select throws_ok(
  $$ select public.cmd_upsert_commission_rule(
       '10610003-0000-4000-8000-000000000003',
       '{"orgId":"1061aa00-0000-4000-8000-00000000000a","basisPoints":4000}'::jsonb,
       null, null) $$,
  '22023',
  null,
  'a 40 % commission is a typo, not a policy'
);

-- ---------------------------------------------------------------------------
-- 6. Refunds, and the payout cap the ledger now agrees with
-- ---------------------------------------------------------------------------

insert into public.refunds (
  id, code, booking_id, intent_id, amount_yer, status, reason, requested_by, decided_by, decided_at,
  paid_by, paid_at
)
values (
  '1061f001-0000-4000-8000-000000000001', 'RF-FI0001',
  (select id from public.bookings where trip_id = '1061b001-0000-4000-8000-000000000001'),
  '1061e001-0000-4000-8000-000000000001', 4_000, 'paid', 'الرحلة أُلغيت',
  '10610001-0000-4000-8000-000000000001', '10610003-0000-4000-8000-000000000003', now(),
  '10610003-0000-4000-8000-000000000003', now()
);

select app.queue_money_event(
  'refund_paid', 'refunds', '1061f001-0000-4000-8000-000000000001', 4_000,
  '{}'::jsonb, '10610003-0000-4000-8000-000000000003', null,
  '1061aa00-0000-4000-8000-00000000000a'
);

select is(
  (select public.cmd_consume_outbox(null, 10) ->> 'posted'),
  '1',
  'a paid refund is one more posting'
);

select is(
  (select l.amount_yer from public.ledger_entries l
    where l.account_code = 'operator_payable' and l.direction = 'debit'
      and l.journal_id = (select id from public.journal_entries where source_kind = 'refund')),
  4_000,
  'and it reduces what the operator is owed, not what the platform earns'
);

select is(
  app.owner_ledger_balance_yer(null, '1061aa00-0000-4000-8000-00000000000a'),
  5_500,
  'the ledger says 9 500 owed, less the 4 000 refund'
);

select is(
  app.owner_available_yer(null, '1061aa00-0000-4000-8000-00000000000a'),
  5_500,
  'and the payout cap agrees with it — Phase 9 let this number be 6 000'
);

-- ---------------------------------------------------------------------------
-- 7. Quotas: Basic blocks, an override lifts the ceiling, exports are a rate
-- ---------------------------------------------------------------------------

select is(
  (app.quota_state(null, '1061aa00-0000-4000-8000-00000000000a', 'vehicles') ->> 'limit')::int,
  1,
  'Basic allows one vehicle'
);

select is(
  (app.quota_state(null, '1061aa00-0000-4000-8000-00000000000a', 'vehicles') ->> 'used')::int,
  1,
  'for an owner who has one'
);

select throws_ok(
  $$ select app.assert_quota(null, '1061aa00-0000-4000-8000-00000000000a', 'vehicles', 1) $$,
  'P0001',
  null,
  'so a second vehicle is refused with the structured code the UI explains'
);

select is(
  (public.cmd_grant_quota_override(
     '10610005-0000-4000-8000-000000000005',
     '{"orgId":"1061aa00-0000-4000-8000-00000000000a","metric":"vehicles","limitValue":3,
       "expiresAt":"2030-01-01T00:00:00Z","reason":"seasonal fleet expansion"}'::jsonb,
     null, null
   ) -> 'override' ->> 'metric'),
  'vehicles',
  'an admin may grant an override, with a reason and an expiry'
);

select is(
  (app.quota_state(null, '1061aa00-0000-4000-8000-00000000000a', 'vehicles') ->> 'limit')::int,
  3,
  'and the ceiling is now the override, not the plan'
);

select lives_ok(
  $$ select app.assert_quota(null, '1061aa00-0000-4000-8000-00000000000a', 'vehicles', 1) $$,
  'so the second vehicle is allowed while the override is live'
);

select is(
  (app.quota_state(null, '1061aa00-0000-4000-8000-00000000000a', 'vehicles') ->> 'override')::boolean,
  true,
  'and the state says why, so the UI can explain it'
);

select throws_ok(
  $$ select public.cmd_grant_quota_override(
       '10610002-0000-4000-8000-000000000002',
       '{"orgId":"1061aa00-0000-4000-8000-00000000000a","metric":"vehicles","limitValue":99,
         "reason":"because I said so"}'::jsonb, null, null) $$,
  '42501',
  null,
  'but an operator cannot grant themselves a bigger plan'
);

select is(
  (app.quota_state(null, '1061aa00-0000-4000-8000-00000000000a', 'finance_exports') ->> 'limit')::int,
  1,
  'Basic includes one export a month'
);

select lives_ok(
  $$ select public.cmd_export_finance(
       '10610002-0000-4000-8000-000000000002',
       '{"orgId":"1061aa00-0000-4000-8000-00000000000a","kind":"statement"}'::jsonb,
       null, null) $$,
  'the first export of the month is produced'
);

select throws_ok(
  $$ select public.cmd_export_finance(
       '10610002-0000-4000-8000-000000000002',
       '{"orgId":"1061aa00-0000-4000-8000-00000000000a","kind":"statement"}'::jsonb,
       null, null) $$,
  'P0001',
  null,
  'the second is refused: exports are counted from the log, so the limit is real'
);

select is(
  ((select public.cmd_revoke_quota_override(
     '10610005-0000-4000-8000-000000000005',
     (select id from public.quota_overrides where metric = 'vehicles' and revoked_at is null),
     'season ended', null, null
   ) -> 'override') ->> 'metric'),
  'vehicles',
  'an override can be withdrawn when the reason for it ends'
);

select is(
  (app.quota_state(null, '1061aa00-0000-4000-8000-00000000000a', 'vehicles') ->> 'limit')::int,
  1,
  'and the plan is the ceiling again'
);

select is(
  (public.cmd_update_plan(
     '10610005-0000-4000-8000-000000000005',
     '{"code":"basic","limits":{"vehicles":2}}'::jsonb, null, null
   ) -> 'limits' ->> 'vehicles')::int,
  2,
  'an admin edits a plan limit'
);

select is(
  (app.quota_state(null, '1061aa00-0000-4000-8000-00000000000a', 'vehicles') ->> 'limit')::int,
  2,
  'and enforcement follows immediately, because nothing caches the plan'
);

select throws_ok(
  $$ select public.cmd_update_plan(
       '10610002-0000-4000-8000-000000000002',
       '{"code":"basic","limits":{"vehicles":99}}'::jsonb, null, null) $$,
  '42501',
  null,
  'but an operator cannot rewrite the price list'
);

select public.cmd_update_plan(
  '10610005-0000-4000-8000-000000000005',
  '{"code":"basic","limits":{"vehicles":1}}'::jsonb, null, null
);

-- ---------------------------------------------------------------------------
-- 8. Subscriptions: trial, invoice, payment, renewal
-- ---------------------------------------------------------------------------

select is(
  (public.cmd_start_subscription(
     '10610002-0000-4000-8000-000000000002',
     '{"orgId":"1061aa00-0000-4000-8000-00000000000a","planCode":"pro"}'::jsonb,
     null, null
   ) -> 'subscription' ->> 'status'),
  'trialing',
  'a new Pro subscription starts with the 14-day trial'
);

select is(
  (select count(*)::int from public.invoices where kind = 'subscription'),
  0,
  'and a trial is not billed'
);

select is(
  app.org_effective_plan('1061aa00-0000-4000-8000-00000000000a')::text,
  'pro',
  'but the trial already grants the powers: the plan is Pro from day one'
);

select is(
  (app.quota_state(null, '1061aa00-0000-4000-8000-00000000000a', 'vehicles') ->> 'limit')::int,
  5,
  'which is visible in the limits immediately'
);

-- The trial ends: the period is over, and the renewal job is what notices.
update public.subscriptions
set trial_ends_at = now() - interval '1 hour',
    current_period_start = now() - interval '15 days',
    current_period_end = now() - interval '1 hour'
where owner_org_id = '1061aa00-0000-4000-8000-00000000000a';

select is(
  (public.cmd_renew_subscriptions(null, 50) ->> 'trialsEnded')::int,
  1,
  'the renewal job ends the trial'
);

select is(
  (select status::text from public.subscriptions where owner_org_id = '1061aa00-0000-4000-8000-00000000000a'),
  'active',
  'and the subscription becomes active'
);

select is(
  (select count(*)::int from public.invoices where kind = 'subscription' and status <> 'void'),
  1,
  'with one invoice for the first real period'
);

select is(
  (select total_yer from public.invoices where kind = 'subscription' and status <> 'void'),
  7_500,
  'at the plan''s price'
);

select is(
  (select due_on from public.invoices where kind = 'subscription' and status <> 'void'),
  (now() at time zone 'Asia/Aden')::date + 7,
  'due in seven days: billed in advance, paid net seven'
);

select is(
  (public.cmd_pay_invoice(
     '10610003-0000-4000-8000-000000000003',
     (select id from public.invoices where kind = 'subscription' and status <> 'void'),
     'bank-ref-1', null, null
   ) -> 'invoice' ->> 'status'),
  'paid',
  'finance settles it'
);

select is(
  (select l.amount_yer from public.ledger_entries l
    where l.account_code = 'subscription_revenue'
      and l.journal_id = (select id from public.journal_entries where source_kind = 'subscription')),
  7_500,
  'and subscription revenue is recognised when the money arrives, not when the invoice is printed'
);

select is(
  app.commission_basis_points(null, '1061aa00-0000-4000-8000-00000000000a', current_date),
  700,
  'Pro takes 100 basis points off the commission: 800 – 100'
);

select throws_ok(
  $$ select public.cmd_start_subscription(
       '10610002-0000-4000-8000-000000000002',
       '{"orgId":"1061aa00-0000-4000-8000-00000000000a","planCode":"business"}'::jsonb,
       null, null) $$,
  '23505',
  null,
  'a second live subscription is impossible: one owner, one plan'
);

select is(
  (public.cmd_change_plan(
     '10610002-0000-4000-8000-000000000002',
     (select id from public.subscriptions where owner_org_id = '1061aa00-0000-4000-8000-00000000000a'),
     'business', 'now', null, null
   ) -> 'immediate')::boolean,
  true,
  'an upgrade applies immediately'
);

select ok(
  (public.cmd_change_plan(
     '10610002-0000-4000-8000-000000000002',
     (select id from public.subscriptions where owner_org_id = '1061aa00-0000-4000-8000-00000000000a'),
     'pro', 'period_end', null, null
   ) -> 'subscription' ->> 'pending_plan_code') = 'pro',
  'and a downgrade is scheduled for the end of the paid period, not applied over a period already paid for'
);

select throws_ok(
  $$ select public.cmd_change_plan(
       '10610002-0000-4000-8000-000000000002',
       (select id from public.subscriptions where owner_org_id = '1061aa00-0000-4000-8000-00000000000a'),
       'basic', 'now', null, null) $$,
  '22023',
  null,
  'an immediate downgrade is refused rather than silently refunding a period nobody asked to cancel'
);

-- ---------------------------------------------------------------------------
-- 9. The dunning ladder: past_due → grace → expired → Basic
-- ---------------------------------------------------------------------------

-- A period ends with its invoice paid: the job renews and bills the next one.
update public.subscriptions
set current_period_start = now() - interval '31 days',
    current_period_end = now() - interval '1 hour'
where owner_org_id = '1061aa00-0000-4000-8000-00000000000a';

select is(
  (public.cmd_renew_subscriptions(null, 50) ->> 'renewed')::int,
  1,
  'a period that ended paid is renewed'
);

-- The upgrade a few screens up left its own prorated invoice open, and it is not this assertion's business.
-- Counting *every* issued subscription invoice really asserted "nothing else has been billed yet", which stopped
-- being true the moment the proration case was added — and it only showed up in a run where the two invoices
-- landed on different days. What a renewal must produce is one new invoice for a period, which the snapshot
-- distinguishes from a proration.
select is(
  (select count(*)::int from public.invoices
    where kind = 'subscription' and status = 'issued'
      and (snapshot ->> 'proration') is null),
  1,
  'with the next period billed in advance'
);

select is(
  (select plan_code::text from public.subscriptions where owner_org_id = '1061aa00-0000-4000-8000-00000000000a'),
  'pro',
  'and the scheduled downgrade applied at the boundary, as promised'
);

-- Now the same period ends with that invoice still unpaid.
update public.invoices
set due_on = current_date - 1
where kind = 'subscription' and status = 'issued';

update public.subscriptions
set current_period_start = now() - interval '31 days',
    current_period_end = now() - interval '1 hour'
where owner_org_id = '1061aa00-0000-4000-8000-00000000000a';

select is(
  (public.cmd_renew_subscriptions(null, 50) ->> 'dunned')::int,
  1,
  'a period that ended with its invoice unpaid is dunned, not renewed'
);

select is(
  (select status::text from public.subscriptions where owner_org_id = '1061aa00-0000-4000-8000-00000000000a'),
  'past_due',
  'the subscription is past due'
);

select is(
  app.org_effective_plan('1061aa00-0000-4000-8000-00000000000a')::text,
  'pro',
  'and keeps its powers: late is not cancelled'
);

update public.subscriptions
set grace_ends_at = now() - interval '1 minute'
where owner_org_id = '1061aa00-0000-4000-8000-00000000000a';

select is(
  (public.cmd_expire_subscriptions(null, 500) ->> 'movedToGrace')::int,
  1,
  'after the grace window the subscription moves to its final notice'
);

select is(
  (select status::text from public.subscriptions where owner_org_id = '1061aa00-0000-4000-8000-00000000000a'),
  'grace',
  'which is the last week of service'
);

update public.subscriptions
set grace_ends_at = now() - interval '1 minute'
where owner_org_id = '1061aa00-0000-4000-8000-00000000000a';

select is(
  (public.cmd_expire_subscriptions(null, 500) ->> 'expired')::int,
  1,
  'and then it expires'
);

select is(
  app.org_effective_plan('1061aa00-0000-4000-8000-00000000000a')::text,
  'basic',
  'the organization is back on Basic'
);

select is(
  (select plan::text from public.organizations where id = '1061aa00-0000-4000-8000-00000000000a'),
  'basic',
  'which is written where everything else already reads it'
);

select is(
  (select count(*)::int from public.vehicles
    where owner_org_id = '1061aa00-0000-4000-8000-00000000000a'),
  1,
  'and nothing the operator built was deleted: the vehicle is still there'
);

select is(
  (app.quota_state(null, '1061aa00-0000-4000-8000-00000000000a', 'vehicles') ->> 'limit')::int,
  1,
  'only the ceiling came back to Basic'
);

-- ---------------------------------------------------------------------------
-- 10. The integrity job: green on a clean ledger, red on a tampered one
-- ---------------------------------------------------------------------------

select is(
  public.cmd_run_integrity_check(null, null, null) ->> 'status',
  'ok',
  'the integrity job is green on a ledger that balances'
);

select is(
  (select count(*)::int from public.ledger_entries l
    where l.account_code = 'suspense'),
  0,
  'with nothing parked in suspense'
);

-- Tampering: the immutability trigger is the thing that normally prevents this, so it has to be disabled to
-- prove the *check* works. A test that can only fail the way it is supposed to fail proves nothing.
alter table public.ledger_entries disable trigger ledger_entries_immutable;
update public.ledger_entries
set amount_yer = amount_yer + 1
where account_code = 'platform_cash' and direction = 'debit'
  and journal_id = (select id from public.journal_entries where source_kind = 'payment');
alter table public.ledger_entries enable trigger ledger_entries_immutable;

select is(
  public.cmd_run_integrity_check(null, null, null) ->> 'status',
  'alert',
  'one riyal of tampering turns the alarm red'
);

-- The alarm has to *go* somewhere. Until 00037 this function wrote straight into `public.notifications`, which
-- produces a row the worker never claims: no push, no email, no retry, no dedupe — a bell that only rings if
-- somebody happens to open it. These assertions are what stops that regression coming back, because the first
-- three are exactly the delivery rows the old code never created.
select is(
  (
    select count(*)::int
    from public.notification_deliveries d
    join public.notifications n on n.id = d.notification_id
    where n.kind = 'finance_alert'
      and n.user_id = '10610003-0000-4000-8000-000000000003'
      and d.channel = 'in_app'
      and d.status = 'sent'
  ),
  1,
  'the integrity alarm reaches the pipeline: an in-app delivery for the finance officer'
);

select is(
  (
    select count(*)::int
    from public.notification_deliveries d
    join public.notifications n on n.id = d.notification_id
    where n.kind = 'finance_alert' and n.user_id = '10610003-0000-4000-8000-000000000003'
      and d.channel in ('push', 'email')
  ),
  2,
  'and a push and an email are queued behind it, because the event is critical'
);

select is(
  (
    select n.link
    from public.notifications n
    where n.kind = 'finance_alert' and n.user_id = '10610003-0000-4000-8000-000000000003'
  ),
  '/finance/dashboard',
  'the deep link goes to the screen that answers the question'
);

-- Dedupe: the check runs every night on a ledger that may stay broken for a week. One message per day per
-- person, with the current count inside it — not one per run.
select public.cmd_run_integrity_check(null, null, null);

select is(
  (
    select count(*)::int
    from public.notifications n
    where n.kind = 'finance_alert' and n.user_id = '10610003-0000-4000-8000-000000000003'
  ),
  1,
  'a second run on the same day does not ring the same bell twice'
);

select is(
  (
    select count(*)::int
    from public.notifications n
    where n.kind = 'finance_alert'
      and not exists (select 1 from public.notification_deliveries d where d.notification_id = n.id)
  ),
  0,
  'no finance alert exists without a delivery behind it — the old bug in one assertion'
);

alter table public.ledger_entries disable trigger ledger_entries_immutable;
update public.ledger_entries
set amount_yer = amount_yer - 1
where account_code = 'platform_cash' and direction = 'debit'
  and journal_id = (select id from public.journal_entries where source_kind = 'payment');
alter table public.ledger_entries enable trigger ledger_entries_immutable;

select is(
  public.cmd_run_integrity_check(null, null, null) ->> 'status',
  'ok',
  'and green again once the row is put back'
);

-- ---------------------------------------------------------------------------
-- 11. Statement, dashboard and expenses: one set of numbers
-- ---------------------------------------------------------------------------

select is(
  (public.cmd_get_statement(
     '10610002-0000-4000-8000-000000000002',
     '{"orgId":"1061aa00-0000-4000-8000-00000000000a"}'::jsonb,
     date_trunc('month', now() at time zone 'Asia/Aden')::date,
     (now() at time zone 'Asia/Aden')::date
   ) -> 'balance')::int,
  5_500,
  'the statement''s closing balance is the ledger''s balance'
);

select is(
  (public.cmd_get_finance_dashboard(
     '10610002-0000-4000-8000-000000000002',
     '{"orgId":"1061aa00-0000-4000-8000-00000000000a"}'::jsonb
   ) -> 'summary' ->> 'payableYer')::int,
  5_500,
  'and the dashboard reads the same helper, so the two cannot drift'
);

select is(
  (public.cmd_record_expense(
     '10610002-0000-4000-8000-000000000002',
     '{"orgId":"1061aa00-0000-4000-8000-00000000000a","category":"fuel","amountYer":1200,
       "description":"ديزل","settleFromBalance":true}'::jsonb,
     null, null
   ) -> 'journalId') is not null,
  true,
  'an expense paid out of the platform balance posts a journal'
);

select is(
  app.owner_ledger_balance_yer(null, '1061aa00-0000-4000-8000-00000000000a'),
  4_300,
  'which reduces what the operator is owed: 5 500 – 1 200'
);

select is(
  (public.cmd_get_finance_dashboard(
     '10610002-0000-4000-8000-000000000002',
     '{"orgId":"1061aa00-0000-4000-8000-00000000000a"}'::jsonb
   ) -> 'summary' ->> 'expensesYer')::int,
  1_200,
  'and the dashboard counts the expense'
);

-- ---------------------------------------------------------------------------
-- 12. RLS: your books, and nobody else's
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"10610002-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::int from public.journal_entries) > 0,
  true,
  'an org owner reads the journals about their organization'
);

select is(
  (select count(*)::int from public.invoices where owner_org_id = '1061aa00-0000-4000-8000-00000000000a') > 0,
  true,
  'and their invoices'
);

set local request.jwt.claims = '{"sub":"10610004-0000-4000-8000-000000000004","role":"authenticated"}';

select is(
  (select count(*)::int from public.journal_entries),
  0,
  'a stranger reads nobody''s ledger'
);

select is(
  (select count(*)::int from public.invoices),
  0,
  'and nobody''s invoices'
);

set local request.jwt.claims = '{"sub":"10610003-0000-4000-8000-000000000003","role":"authenticated"}';

select is(
  (select count(*)::int from public.journal_entries) >= 4,
  true,
  'finance reads the whole ledger'
);

select throws_ok(
  $$ select public.cmd_pay_invoice(
       '10610002-0000-4000-8000-000000000002',
       (select id from public.invoices limit 1), null, null, null) $$,
  '42501',
  null,
  'and no client role can execute a command, even one that exists'
);

reset role;

-- ---------------------------------------------------------------------------
-- 11. The matcher: exact amount, three days, one unclaimed candidate
-- ---------------------------------------------------------------------------
-- Deliberately conservative. A reconciler that guesses turns a known gap into an unknown one, so the second
-- 10 000 line — the same amount on the same day — finds the payment already claimed and becomes an exception
-- rather than a second match.

select is(
  (public.cmd_import_reconciliation(
     '10610003-0000-4000-8000-000000000003',
     jsonb_build_object(
       'orgId', '1061aa00-0000-4000-8000-00000000000a',
       'source', 'jaib',
       'from', (current_date - 2)::text,
       'to', current_date::text,
       'lines', jsonb_build_array(
         jsonb_build_object('amountYer', 10000, 'occurredOn', current_date::text, 'externalRef', 'JAIB-1'),
         jsonb_build_object('amountYer', 10000, 'occurredOn', current_date::text, 'externalRef', 'JAIB-2'),
         jsonb_build_object('amountYer', 9999, 'occurredOn', current_date::text, 'externalRef', 'JAIB-3')
       ))
   ) ->> 'matched'),
  '1',
  'the matcher claims the one payment that fits and leaves the rest alone'
);

select is(
  (select lines_total - lines_matched from public.reconciliation_imports order by created_at desc limit 1),
  2,
  'two lines arrive as exceptions: the duplicate and the near-miss'
);

select is(
  (select count(*)::int from public.reconciliation_lines
    where status = 'exception' and external_ref in ('JAIB-2', 'JAIB-3')),
  2,
  'and an exception is a row somebody can see, not a silent pass'
);

select throws_ok(
  $$ select public.cmd_import_reconciliation(
       '10610002-0000-4000-8000-000000000002',
       '{"source":"jaib","from":"2026-01-01","to":"2026-01-31",
         "lines":[{"amountYer":100,"occurredOn":"2026-01-05"}]}'::jsonb, null, null) $$,
  '42501',
  null,
  'an operator cannot import a statement, even their own'
);

select ok(
  (select public.cmd_get_finance_dashboard(
     '10610003-0000-4000-8000-000000000003', '{"platform":true}'::jsonb) -> 'totals') <> '{}'::jsonb,
  'a platform-wide dashboard totals the whole ledger: no owner is a question, not an empty answer'
);

select * from finish();
rollback;
