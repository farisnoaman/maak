-- 0017 — Phase 11's missing job and Phase 12's platform sweep
--
-- Two jobs, both of which exist so that somebody hears about something:
--   A. the maintenance sweep Phase 8 wrote and nothing ever called (`cmd_run_maintenance_scan`)
--   B. the six launch alerts (`cmd_run_ops_alerts`) — stale trips, dead deliveries, unbalanced journals,
--      verification backlog, payment decision SLA, and a burst of refused commands
--
-- Both are staff jobs, both are idempotent by dedupe key, and both are checked here for the same three things:
-- the first run speaks, the second run is silent, and a passenger cannot make the platform page itself.
--
-- Run with: supabase test db   (requires Docker), or `npm run sql:check` (embedded Postgres).

begin;

create extension if not exists pgtap;

select plan(25);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('11700001-0000-4000-8000-000000000001', 'ops-owner@example.test', '+967733950001', '{"locale":"ar"}'),
  ('11700002-0000-4000-8000-000000000002', 'ops-staff@example.test', '+967733950002', '{"locale":"ar"}'),
  ('11700003-0000-4000-8000-000000000003', 'ops-finance@example.test', '+967733950003', '{"locale":"ar"}'),
  ('11700004-0000-4000-8000-000000000004', 'ops-passenger@example.test', '+967733950004', '{"locale":"en"}');

update public.profiles set verification_status = 'verified' where id::text like '1170%';

insert into public.user_roles (user_id, role)
values
  ('11700002-0000-4000-8000-000000000002', 'platform_staff'),
  ('11700003-0000-4000-8000-000000000003', 'finance_officer');

insert into public.organizations (id, name, owner_id, verification_status, plan)
values ('1170aa00-0000-4000-8000-00000000000a', 'Ops Co',
        '11700001-0000-4000-8000-000000000001', 'verified', 'basic');

insert into public.vehicles (
  id, owner_org_id, make, model, model_year, plate_number, plate_governorate_id,
  fuel_type, seats_passenger, seats_total, odometer_km, status, verification_status,
  insurance_expiry, inspection_expiry, registration_expiry, created_by
)
values (
  '1170c001-0000-4000-8000-000000000001', '1170aa00-0000-4000-8000-00000000000a',
  'Toyota', 'Hiace', 2018, '11-2001',
  (select id from public.governorates where code = 'YE-AD'),
  'diesel', 12, 13, 120_000, 'active', 'verified',
  current_date + 200, current_date + 200, current_date + 200,
  '11700001-0000-4000-8000-000000000001'
);

-- A service schedule 5 000 km in the past: the van is overdue the moment the fixture lands.
insert into public.maintenance_schedules (id, vehicle_id, kind, interval_km, last_done_km, created_by)
values ('1170d001-0000-4000-8000-000000000001', '1170c001-0000-4000-8000-000000000001',
        'oil_change', 10_000, 105_000, '11700001-0000-4000-8000-000000000001');

-- A trip that went in progress yesterday and never came back.
insert into public.trips (
  id, code, owner_org_id, vehicle_id, origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, price_per_seat_yer, discount_kind, discount_value,
  payment_policy, deposit_percent, status, verification_status, published_at, started_at
)
values (
  '1170b001-0000-4000-8000-000000000001', 'P12-AD-0001',
  '1170aa00-0000-4000-8000-00000000000a', '1170c001-0000-4000-8000-000000000001',
  (select id from public.governorates where code = 'YE-AD'),
  (select id from public.governorates where code = 'YE-SA'),
  now() - interval '30 hours', 12, 9, 10_000, 'none', 0,
  'cash', 30, 'in_progress', 'verified', now() - interval '40 hours', now() - interval '30 hours'
);

-- ---------------------------------------------------------------------------
-- A. The maintenance sweep
-- ---------------------------------------------------------------------------

select ok(
  to_regprocedure('public.cmd_run_maintenance_scan(uuid, integer)') is not null,
  'the maintenance sweep has a command, which is what it was missing'
);

select ok(
  not has_function_privilege('authenticated', 'public.cmd_run_maintenance_scan(uuid, integer)', 'execute'),
  'and a client cannot call it'
);

select throws_ok(
  $$ select public.cmd_run_maintenance_scan('11700004-0000-4000-8000-000000000004', 100) $$,
  '42501',
  null,
  'a passenger cannot make the platform sweep the fleet'
);

-- The owner of the vehicle is a member of the organization, so the sweep addresses them through the org.
insert into public.organization_members (org_id, user_id, role, status, joined_at)
values ('1170aa00-0000-4000-8000-00000000000a', '11700001-0000-4000-8000-000000000001',
        'owner', 'active', now())
on conflict do nothing;

select is(
  (public.cmd_run_maintenance_scan('11700002-0000-4000-8000-000000000002', 100) ->> 'sent')::int,
  1,
  'the first sweep tells the owner once about the overdue van'
);

select is(
  (select count(*)::int from public.notifications
    where user_id = '11700001-0000-4000-8000-000000000001'
      and kind = 'vehicle_maintenance_overdue'),
  1,
  'and exactly one notification exists for it'
);

select is(
  (public.cmd_run_maintenance_scan('11700002-0000-4000-8000-000000000002', 100) ->> 'sent')::int,
  0,
  'a second sweep in the same state says nothing: the transition is the news, not the condition'
);

select is(
  (select count(*)::int from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.kind = 'vehicle_maintenance_overdue' and d.channel = 'in_app'),
  1,
  'the reminder went through the delivery pipeline, not straight into the bell'
);

-- ---------------------------------------------------------------------------
-- B. The platform sweep
-- ---------------------------------------------------------------------------

select ok(
  to_regprocedure('public.cmd_run_ops_alerts(uuid, timestamptz)') is not null,
  'the launch alert sweep exists'
);

select throws_ok(
  $$ select public.cmd_run_ops_alerts('11700004-0000-4000-8000-000000000004', now()) $$,
  '42501',
  null,
  'a passenger cannot ask the platform to page itself'
);

select is(
  array_length(app.ops_checks(), 1),
  6,
  'the sweep covers the six conditions docs/runbook.md lists'
);

-- A dead delivery, so `dead_deliveries` has something to count.
insert into public.notifications (id, user_id, kind, title_key, params, link, priority, dedupe_key)
values ('1170e001-0000-4000-8000-000000000001', '11700001-0000-4000-8000-000000000001',
        'booking_accepted', 'notifications.bookingAccepted', '{"code":"P12-AD-0001"}',
        '/account/bookings', 'normal', 'ops-fixture:dead');

insert into public.notification_deliveries (notification_id, user_id, channel, status, attempts, last_error)
values ('1170e001-0000-4000-8000-000000000001', '11700001-0000-4000-8000-000000000001',
        'email', 'dead', 5, 'provider 500');

-- One unbalanced journal. The deferred trigger refuses this through the normal writer, so the fixture writes
-- the two lines directly — which is exactly the state the sweep is here to notice.
insert into public.journal_entries (id, code, posting_date, description, source_kind, source_table, source_id)
values ('1170f001-0000-4000-8000-000000000001', 'OPS-FIXTURE-1', current_date, 'ops fixture',
        'payment', 'payment_intents', '1170e001-0000-4000-8000-000000000001');

insert into public.ledger_entries (journal_id, seq, account_code, direction, amount_yer)
values
  ('1170f001-0000-4000-8000-000000000001', 1, 'platform_cash', 'debit', 1_000),
  ('1170f001-0000-4000-8000-000000000001', 2, 'operator_payable', 'credit', 900);

-- A verification request that has been waiting three days: the backlog condition.
insert into public.verification_requests (id, subject_type, subject_id, requested_by, status, created_at)
values ('1170aa01-0000-4000-8000-000000000001', 'individual',
        '11700001-0000-4000-8000-000000000001', '11700001-0000-4000-8000-000000000001',
        'pending', now() - interval '3 days');

-- Twenty refused commands inside the hour: the closest thing to an error rate this system has.
insert into audit.log (actor_id, action, entity_type, entity_id, outcome, created_at)
select '11700004-0000-4000-8000-000000000004', 'ops.fixture.refused', 'test', null, 'denied',
       now() - interval '5 minutes'
  from generate_series(1, 20);

-- A receipt nobody has decided on for eight hours.
insert into public.payment_intents (
  id, code, payer_id, purpose, amount_yer, status, proof_path, proof_hash, proof_uploaded_at,
  method, reference_no
)
values ('1170a001-0000-4000-8000-000000000001', 'PI-OPS001',
        '11700001-0000-4000-8000-000000000001', 'subscription', 10_000, 'awaiting_confirmation',
        'proofs/ops-fixture.jpg', repeat('a', 64), now() - interval '8 hours',
        'jaib', 'OPS-FIXTURE-1');

select is(
  (public.cmd_run_ops_alerts('11700002-0000-4000-8000-000000000002', now()) ->> 'counts')::jsonb
    ->> 'stale_trips',
  '1',
  'the trip abandoned in progress is counted'
);

select is(
  (public.cmd_run_ops_alerts('11700002-0000-4000-8000-000000000002', now()) ->> 'counts')::jsonb
    ->> 'unbalanced_journals',
  '1',
  'the journal that does not balance is counted'
);

-- The job runner sends `p_now: null` explicitly, and an explicit null overrides a parameter default. Without the
-- `coalesce` inside the function every comparison is NULL, every count is zero, and the sweep reports a healthy
-- platform for ever — which is the worst bug an alerting job can have.
select is(
  (public.cmd_run_ops_alerts('11700002-0000-4000-8000-000000000002', null) ->> 'counts')::jsonb
    ->> 'stale_trips',
  '1',
  'a null clock means now, not "nothing is wrong"'
);

select is(
  (public.cmd_run_ops_alerts('11700002-0000-4000-8000-000000000002', now()) ->> 'counts')::jsonb
    ->> 'payment_sla',
  '1',
  'the receipt waiting eight hours is counted'
);

select is(
  (public.cmd_run_ops_alerts('11700002-0000-4000-8000-000000000002', now()) ->> 'counts')::jsonb
    ->> 'dead_deliveries',
  '1',
  'the dead delivery is counted'
);

-- Staff hear about the queue and the trips; money conditions go to finance as well.
select is(
  (select count(*)::int from public.notifications
    where kind = 'ops_alert' and user_id = '11700002-0000-4000-8000-000000000002'),
  4,
  'staff were told about the four conditions they own and not about the ledger'
);

select is(
  (select count(*)::int from public.notifications
    where kind = 'ops_alert' and user_id = '11700003-0000-4000-8000-000000000003'),
  2,
  'finance heard about the ledger and the payment SLA, and nothing else'
);

select is(
  (select count(*)::int from public.notifications
    where kind = 'ops_alert' and user_id = '11700001-0000-4000-8000-000000000001'),
  0,
  'the vehicle owner is not on the platform alert list'
);

select is(
  (public.cmd_run_ops_alerts('11700002-0000-4000-8000-000000000002', now()) ->> 'sent')::int,
  0,
  'a second sweep on the same day sends nothing'
);

select is(
  (select count(*)::int from public.notifications where kind = 'ops_alert'),
  6,
  'six alert rows in total — each condition once per recipient, deduped by day'
);

select is(
  (select count(*)::int from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.kind = 'ops_alert' and d.channel = 'in_app'),
  6,
  'each alert carries its delivery decision, so it can be pushed and audited'
);

-- The dedupe key is the day, so tomorrow is a new message and the count is fresh.
select ok(
  (public.cmd_run_ops_alerts('11700002-0000-4000-8000-000000000002', now() + interval '1 day')
    ->> 'sent')::int > 0,
  'the next day speaks again: an unresolved problem is not marked read'
);

-- A healthy platform says nothing at all.
update public.trips set status = 'completed', completed_at = now()
 where id = '1170b001-0000-4000-8000-000000000001';
update public.notification_deliveries set status = 'skipped' where status = 'dead';
update public.verification_requests
   set status = 'approved', decision_at = now(),
       decision_by = '11700002-0000-4000-8000-000000000002'
 where id = '1170aa01-0000-4000-8000-000000000001';
update public.payment_intents
   set status = 'confirmed', confirmed_at = now(),
       confirmed_by = '11700002-0000-4000-8000-000000000002'
 where id = '1170a001-0000-4000-8000-000000000001';
-- The ledger is immutable by design (a DELETE raises), so "fixed" here means a third line that makes the
-- journal balance — which is exactly how a real correction is posted.
insert into public.ledger_entries (journal_id, seq, account_code, direction, amount_yer)
values ('1170f001-0000-4000-8000-000000000001', 3, 'suspense', 'credit', 100);

select is(
  (public.cmd_run_ops_alerts('11700002-0000-4000-8000-000000000002', now() + interval '2 days')) ->> 'sent',
  '0',
  'a quiet platform produces no alerts, and the job still ran'
);

select is(
  (public.cmd_run_ops_alerts('11700002-0000-4000-8000-000000000002', now() + interval '2 days')) ->> 'alerts',
  '[]',
  'and the result names no failing check'
);

-- The sweep is audited: "did the alerting run last night" must be answerable.
select ok(
  exists (
    select 1 from audit.log
     where action = 'ops.alert_sweep' and actor_id = '11700002-0000-4000-8000-000000000002'
  ),
  'every sweep leaves an audit row, including the quiet ones'
);

select * from finish();

rollback;
