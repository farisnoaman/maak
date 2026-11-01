-- 0014 — Phase 9: money that moves without a card gateway
--
-- The promises verified here, in the order a passenger meets them:
--   1. only finance may open a platform account, and a verified account is the only one that can receive
--   2. the amount is computed from the booking, never from the request
--   3. one receipt pays once, and one bank reference belongs to one payment
--   4. confirming twice does nothing the second time — one outbox row, one notification
--   5. a trip that asks for money up front cannot have a seat held without it
--   6. a refund is requested, decided and paid by three different hands
--   7. a payout cannot be approved by the person who asked for it
--   8. an agent cannot hold more float than their credit limit
--   9. RLS: a passenger reads their own payments; finance reads all of them
--
-- Run with: supabase test db   (requires Docker), or `npm run sql:check` (embedded Postgres).

begin;

create extension if not exists pgtap;

select plan(58);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('9c9c0001-1111-4111-8111-9c9c9c9c9c9c', 'pay-passenger@example.test', '+967733920001', '{"locale":"ar"}'),
  ('9c9c0002-2222-4222-8222-9c9c9c9c9c9c', 'pay-operator@example.test', '+967733920002', '{"locale":"ar"}'),
  ('9c9c0003-3333-4333-8333-9c9c9c9c9c9c', 'pay-finance@example.test', '+967733920003', '{"locale":"ar"}'),
  ('9c9c0004-4444-4444-8444-9c9c9c9c9c9c', 'pay-agent@example.test', '+967733920004', '{"locale":"ar"}'),
  ('9c9c0005-5555-4555-8555-9c9c9c9c9c9c', 'pay-stranger@example.test', '+967733920005', '{"locale":"ar"}'),
  ('9c9c0006-6666-4666-8666-9c9c9c9c9c9c', 'pay-finance2@example.test', '+967733920006', '{"locale":"ar"}');

update public.profiles
set verification_status = 'verified'
where id::text like '9c9c%';

insert into public.user_roles (user_id, role)
values
  ('9c9c0003-3333-4333-8333-9c9c9c9c9c9c', 'finance_officer'),
  ('9c9c0006-6666-4666-8666-9c9c9c9c9c9c', 'finance_officer');
-- An agent is not a platform role: the `agents` row inserted below *is* the role, which is why the
-- command re-derives it from the row rather than from a claim.

insert into public.organizations (id, name, owner_id, verification_status, plan)
values ('9c9caa00-0000-4000-8000-00000000000a', 'Pay Co',
        '9c9c0002-2222-4222-8222-9c9c9c9c9c9c', 'verified', 'pro');

insert into public.organization_members (org_id, user_id, role, status, joined_at)
values ('9c9caa00-0000-4000-8000-00000000000a', '9c9c0002-2222-4222-8222-9c9c9c9c9c9c',
        'owner', 'active', now());

insert into public.vehicles (
  id, owner_org_id, make, model, model_year, plate_number, plate_governorate_id,
  fuel_type, seats_passenger, seats_total, odometer_km, status, verification_status,
  insurance_expiry, inspection_expiry, registration_expiry, created_by
)
values (
  '9c9cc001-0000-4000-8000-9c9c9c9c9c9c', '9c9caa00-0000-4000-8000-00000000000a',
  'Toyota', 'Hiace', 2019, '9-9001',
  (select id from public.governorates where code = 'YE-AD'),
  'diesel', 12, 13, 40_000, 'active', 'verified',
  current_date + 200, current_date + 200, current_date + 200,
  '9c9c0002-2222-4222-8222-9c9c9c9c9c9c'
);

insert into public.trips (
  id, code, owner_org_id, vehicle_id, origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, price_per_seat_yer, discount_kind, discount_value,
  payment_policy, deposit_percent, status, verification_status, published_at
)
values
  -- Transfer: the whole fare must be confirmed before the seat is held.
  ('9c9cb001-0000-4000-8000-9c9c9c9c9c9c', 'P9-AA-0001',
   '9c9caa00-0000-4000-8000-00000000000a', '9c9cc001-0000-4000-8000-9c9c9c9c9c9c',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '3 days', 12, 12, 10_000, 'none', 0, 'transfer', 30, 'published', 'verified', now()),
  -- Deposit: 30 % up front, the rest on boarding.
  ('9c9cb002-0000-4000-8000-9c9c9c9c9c9c', 'P9-AA-0002',
   '9c9caa00-0000-4000-8000-00000000000a', '9c9cc001-0000-4000-8000-9c9c9c9c9c9c',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '3 days', 12, 12, 10_000, 'none', 0, 'deposit', 30, 'published', 'verified', now()),
  -- Cash: nobody owes anything before boarding, so the gate must not block it.
  ('9c9cb003-0000-4000-8000-9c9c9c9c9c9c', 'P9-AA-0003',
   '9c9caa00-0000-4000-8000-00000000000a', '9c9cc001-0000-4000-8000-9c9c9c9c9c9c',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '3 days', 12, 12, 10_000, 'none', 0, 'cash', 30, 'published', 'verified', now());

-- One booking per scenario, through the real command.
select public.cmd_create_booking(
  '9c9c0001-1111-4111-8111-9c9c9c9c9c9c', '9c9cb001-0000-4000-8000-9c9c9c9c9c9c',
  1, null, null, 'مسافر تجريبي', '+967733929001', null, null, 'p9-fixture', null
);
select public.cmd_create_booking(
  '9c9c0001-1111-4111-8111-9c9c9c9c9c9c', '9c9cb002-0000-4000-8000-9c9c9c9c9c9c',
  1, null, null, 'مسافر تجريبي', '+967733929001', null, null, 'p9-fixture', null
);
select public.cmd_create_booking(
  '9c9c0001-1111-4111-8111-9c9c9c9c9c9c', '9c9cb003-0000-4000-8000-9c9c9c9c9c9c',
  1, null, null, 'مسافر تجريبي', '+967733929001', null, null, 'p9-fixture', null
);

insert into public.agents (id, user_id, float_balance_yer, credit_limit_yer)
values ('9c9cd001-0000-4000-8000-9c9c9c9c9c9c', '9c9c0004-4444-4444-8444-9c9c9c9c9c9c', 0, 1_000);

-- ---------------------------------------------------------------------------
-- 1. Accounts: who may open one, and what "active" means
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_create_payment_account(
       '9c9c0002-2222-4222-8222-9c9c9c9c9c9c',
       '{"kind":"platform","method":"jaib","accountNumber":"777111222","holderName":"Maak"}'::jsonb,
       null, null
     ) $$,
  '42501',
  null,
  'an operator cannot open a platform account — only finance may'
);

select is(
  (
    select public.cmd_create_payment_account(
      '9c9c0003-3333-4333-8333-9c9c9c9c9c9c',
      '{"kind":"platform","method":"jaib","accountNumber":"777111222","holderName":"Maak",
        "isDefault":true,"instructionsAr":"حوّل إلى رقم جيب 777111222","instructionsEn":"Send to Jaib 777111222"}'::jsonb,
      null, null
    ) -> 'account' ->> 'status'
  ),
  'active',
  'a platform account opened by finance is live immediately — there is nobody above them to verify'
);

select is(
  (
    select public.cmd_create_payment_account(
      '9c9c0003-3333-4333-8333-9c9c9c9c9c9c',
      '{"kind":"platform","method":"jaib","accountNumber":"777333444","holderName":"Maak 2",
        "isDefault":true}'::jsonb,
      null, null
    ) -> 'account' ->> 'id'
  ) is not null,
  true,
  'a second platform account may be opened'
);

select is(
  (
    select count(*)::int from public.payment_accounts
    where method = 'jaib' and kind = 'platform' and is_default and status = 'active'
  ),
  1,
  'exactly one default per method: the new default demotes the old one'
);

select is(
  (
    select public.cmd_create_payment_account(
      '9c9c0002-2222-4222-8222-9c9c9c9c9c9c',
      '{"kind":"owner","method":"kuraimi","accountNumber":"1234567890","holderName":"Pay Co",
        "orgId":"9c9caa00-0000-4000-8000-00000000000a"}'::jsonb,
      null, null
    ) -> 'account' ->> 'status'
  ),
  'pending_verification',
  'an operator account waits for finance before it can receive money'
);

select throws_ok(
  $$ select public.cmd_verify_payment_account(
       '9c9c0002-2222-4222-8222-9c9c9c9c9c9c',
       (select id from public.payment_accounts where method = 'kuraimi' limit 1),
       true, null, null, null
     ) $$,
  '42501',
  null,
  'an operator cannot verify their own account'
);

select throws_ok(
  $$ select public.cmd_verify_payment_account(
       '9c9c0003-3333-4333-8333-9c9c9c9c9c9c',
       (select id from public.payment_accounts where method = 'kuraimi' limit 1),
       false, null, null, null
     ) $$,
  '22023',
  null,
  'refusing an account requires a reason'
);

select is(
  (
    select public.cmd_verify_payment_account(
      '9c9c0003-3333-4333-8333-9c9c9c9c9c9c',
      (select id from public.payment_accounts where method = 'kuraimi' limit 1),
      true, null, null, null
    ) -> 'account' ->> 'status'
  ),
  'active',
  'finance verifies the account, and only then may it receive money'
);

-- ---------------------------------------------------------------------------
-- 2. The amount is computed, not requested
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_create_payment_intent(
       '9c9c0001-1111-4111-8111-9c9c9c9c9c9c',
       jsonb_build_object(
         'bookingId', (select id from public.bookings where trip_id = '9c9cb001-0000-4000-8000-9c9c9c9c9c9c'),
         'method', 'jaib', 'purpose', 'booking', 'claimedAmountYer', 1,
         'clientReference', 'fixture-claim'
       ),
       null, null
     ) $$,
  '23514',
  null,
  'a client that claims the wrong amount is refused with PRICE_CHANGED, not quietly charged the real one'
);

select is(
  (
    select public.cmd_create_payment_intent(
      '9c9c0001-1111-4111-8111-9c9c9c9c9c9c',
      jsonb_build_object(
        'bookingId', (select id from public.bookings where trip_id = '9c9cb001-0000-4000-8000-9c9c9c9c9c9c'),
        'method', 'jaib', 'purpose', 'booking', 'claimedAmountYer', 10_000,
        'clientReference', 'fixture-transfer'
      ),
      null, null
    ) -> 'intent' ->> 'amount_yer'
  ),
  '10000',
  'a transfer trip asks for the whole fare'
);

select is(
  (
    select public.cmd_create_payment_intent(
      '9c9c0001-1111-4111-8111-9c9c9c9c9c9c',
      jsonb_build_object(
        'bookingId', (select id from public.bookings where trip_id = '9c9cb001-0000-4000-8000-9c9c9c9c9c9c'),
        'method', 'jaib', 'purpose', 'booking', 'claimedAmountYer', 10_000,
        'clientReference', 'fixture-transfer'
      ),
      null, null
    ) ->> 'created'
  ),
  'false',
  'the same clientReference returns the same intent instead of creating a second one'
);

select is(
  (
    select count(*)::int from public.payment_intents
    where client_reference = 'fixture-transfer'
  ),
  1,
  'idempotency is a database fact: one row, however many times the client asked'
);

select is(
  (
    select public.cmd_create_payment_intent(
      '9c9c0001-1111-4111-8111-9c9c9c9c9c9c',
      jsonb_build_object(
        'bookingId', (select id from public.bookings where trip_id = '9c9cb002-0000-4000-8000-9c9c9c9c9c9c'),
        'method', 'jaib', 'purpose', 'deposit', 'clientReference', 'fixture-deposit'
      ),
      null, null
    ) -> 'intent' ->> 'amount_yer'
  ),
  '3000',
  'a 30 % deposit on a 10 000 fare is 3 000, rounded up by the database rather than the client'
);

select throws_ok(
  $$ select public.cmd_create_payment_intent(
       '9c9c0005-5555-4555-8555-9c9c9c9c9c9c',
       jsonb_build_object(
         'bookingId', (select id from public.bookings where trip_id = '9c9cb001-0000-4000-8000-9c9c9c9c9c9c'),
         'method', 'jaib', 'purpose', 'booking', 'clientReference', 'fixture-stranger'
       ),
       null, null
     ) $$,
  '42501',
  null,
  'nobody can open a payment against somebody else''s booking'
);

select throws_ok(
  $$ select public.cmd_create_payment_intent(
       '9c9c0001-1111-4111-8111-9c9c9c9c9c9c',
       jsonb_build_object(
         'bookingId', (select id from public.bookings where trip_id = '9c9cb001-0000-4000-8000-9c9c9c9c9c9c'),
         'method', 'cash_one', 'purpose', 'booking', 'clientReference', 'fixture-no-account'
       ),
       null, null
     ) $$,
  'P0002',
  null,
  'a method with no active account is refused rather than offered and then failed'
);

-- ---------------------------------------------------------------------------
-- 3. One receipt, one payment
-- ---------------------------------------------------------------------------

select is(
  (
    select public.cmd_submit_payment_proof(
      '9c9c0001-1111-4111-8111-9c9c9c9c9c9c',
      (select id from public.payment_intents where client_reference = 'fixture-transfer'),
      'intent/one/receipt.jpg',
      repeat('a', 64),
      'TRX-1001',
      10_000,
      null, null
    ) -> 'intent' ->> 'status'
  ),
  'awaiting_confirmation',
  'submitting a proof moves the intent into a human queue'
);

select throws_ok(
  $$ select public.cmd_submit_payment_proof(
       '9c9c0005-5555-4555-8555-9c9c9c9c9c9c',
       (select id from public.payment_intents where client_reference = 'fixture-deposit'),
       'intent/two/receipt.jpg', repeat('b', 64), 'TRX-2002', null, null, null
     ) $$,
  '42501',
  null,
  'only the payer may upload against an intent'
);

select throws_ok(
  $$ select public.cmd_submit_payment_proof(
       '9c9c0001-1111-4111-8111-9c9c9c9c9c9c',
       (select id from public.payment_intents where client_reference = 'fixture-deposit'),
       'intent/two/receipt.jpg',
       repeat('a', 64),
       'TRX-2002', null, null, null
     ) $$,
  '23505',
  null,
  'the same receipt image cannot pay for a second booking (PROOF_ALREADY_USED)'
);

select throws_ok(
  $$ select public.cmd_submit_payment_proof(
       '9c9c0001-1111-4111-8111-9c9c9c9c9c9c',
       (select id from public.payment_intents where client_reference = 'fixture-deposit'),
       'intent/two/receipt.jpg',
       repeat('c', 64),
       'TRX-1001', null, null, null
     ) $$,
  '23505',
  null,
  'one bank reference belongs to one payment (REFERENCE_ALREADY_USED)'
);

select is(
  (
    select public.cmd_submit_payment_proof(
      '9c9c0001-1111-4111-8111-9c9c9c9c9c9c',
      (select id from public.payment_intents where client_reference = 'fixture-deposit'),
      'intent/two/receipt.jpg', repeat('c', 64), 'TRX-2002', 3_000, null, null
    ) -> 'intent' ->> 'status'
  ),
  'awaiting_confirmation',
  'a clean proof with its own reference and its own image is accepted'
);

-- ---------------------------------------------------------------------------
-- 4. Confirming twice does nothing the second time
-- ---------------------------------------------------------------------------

select is(
  (
    select public.cmd_confirm_payment(
      '9c9c0002-2222-4222-8222-9c9c9c9c9c9c',
      (select id from public.payment_intents where client_reference = 'fixture-transfer'),
      null, null, null
    ) ->> 'bookingPaymentStatus'
  ),
  'paid',
  'confirming the full fare marks the booking paid'
);

select is(
  (
    select public.cmd_confirm_payment(
      '9c9c0002-2222-4222-8222-9c9c9c9c9c9c',
      (select id from public.payment_intents where client_reference = 'fixture-transfer'),
      null, null, null
    ) ->> 'changed'
  ),
  'false',
  'a second confirmation reports that nothing changed'
);

select is(
  (
    select count(*)::int from public.payment_outbox
    where kind = 'payment_confirmed'
      and source_id = (select id from public.payment_intents where client_reference = 'fixture-transfer')
  ),
  1,
  'and writes exactly one ledger event — the outbox key is what makes double posting impossible'
);

select is(
  (
    select count(*)::int from public.notifications
    where user_id = '9c9c0001-1111-4111-8111-9c9c9c9c9c9c'
      and title_key = 'notifications.paymentConfirmed'
  ),
  1,
  'the passenger is told once, not once per click'
);

select throws_ok(
  $$ select public.cmd_reject_payment(
       '9c9c0002-2222-4222-8222-9c9c9c9c9c9c',
       (select id from public.payment_intents where client_reference = 'fixture-transfer'),
       'too late', null, null
     ) $$,
  '23505',
  null,
  'a confirmed payment cannot be rejected afterwards — that is what a refund is for'
);

-- ---------------------------------------------------------------------------
-- 5. Prepayment is a gate, not a suggestion
-- ---------------------------------------------------------------------------

-- A second passenger asks for a seat on the transfer trip and is not paid up: the seat may not be held.
select public.cmd_create_booking(
  '9c9c0005-5555-4555-8555-9c9c9c9c9c9c', '9c9cb001-0000-4000-8000-9c9c9c9c9c9c',
  1, null, null, 'مسافر آخر', '+967733929005', null, null, 'p9-fixture-2', null
);

select throws_ok(
  format(
    $$ update public.bookings set status = 'accepted' where id = %L $$,
    (select id from public.bookings
      where trip_id = '9c9cb001-0000-4000-8000-9c9c9c9c9c9c'
        and passenger_id = '9c9c0005-5555-4555-8555-9c9c9c9c9c9c')
  ),
  '23514',
  null,
  'a transfer trip cannot accept a booking before the fare is confirmed — the trigger, not a branch'
);

select is(
  public.cmd_confirm_payment(
    '9c9c0002-2222-4222-8222-9c9c9c9c9c9c',
    (select id from public.payment_intents where client_reference = 'fixture-deposit'),
    null, null, null
  ) ->> 'bookingPaymentStatus',
  'deposit_paid',
  'paying the deposit leaves the booking deposit-paid, not paid'
);

select is(
  (
    select public.cmd_request_refund(
      '9c9c0001-1111-4111-8111-9c9c9c9c9c9c',
      (select id from public.bookings where trip_id = '9c9cb002-0000-4000-8000-9c9c9c9c9c9c'),
      3_000, 'تغيير في الخطة', null, null
    ) -> 'refund' ->> 'status'
  ),
  'requested',
  'a passenger may ask for the deposit back'
);

select throws_ok(
  $$ select public.cmd_request_refund(
       '9c9c0001-1111-4111-8111-9c9c9c9c9c9c',
       (select id from public.bookings where trip_id = '9c9cb002-0000-4000-8000-9c9c9c9c9c9c'),
       1, 'مرة أخرى', null, null
     ) $$,
  '23505',
  null,
  'a second refund request while the first is undecided is a duplicate, not a second entitlement'
);

select throws_ok(
  $$ select public.cmd_request_refund(
       '9c9c0001-1111-4111-8111-9c9c9c9c9c9c',
       (select id from public.bookings
         where trip_id = '9c9cb001-0000-4000-8000-9c9c9c9c9c9c'
           and passenger_id = '9c9c0001-1111-4111-8111-9c9c9c9c9c9c'),
       10_001, 'أكثر من المدفوع', null, null
     ) $$,
  '22023',
  null,
  'a refund larger than the money actually received is refused'
);

-- The cash trip owes nothing up front, so accepting is allowed with no payment at all.
select is(
  (
    select public.cmd_accept_booking(
      '9c9c0002-2222-4222-8222-9c9c9c9c9c9c',
      (select id from public.bookings where trip_id = '9c9cb003-0000-4000-8000-9c9c9c9c9c9c'),
      null, null
    ) -> 'booking' ->> 'status'
  ),
  'accepted',
  'a cash trip still works: the driver collects on boarding and nothing is blocked'
);

-- ---------------------------------------------------------------------------
-- 6. Refunds: requested, decided, paid — three hands
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_decide_refund(
       '9c9c0003-3333-4333-8333-9c9c9c9c9c9c',
       (select id from public.refunds limit 1), false, null, null, null
     ) $$,
  '22023',
  null,
  'refusing a refund requires a reason the passenger can read'
);

select throws_ok(
  $$ select public.cmd_decide_refund(
       '9c9c0002-2222-4222-8222-9c9c9c9c9c9c',
       (select id from public.refunds limit 1), true, null, null, null
     ) $$,
  '42501',
  null,
  'the operator cannot decide a refund on their own trip'
);

select is(
  (
    select public.cmd_decide_refund(
      '9c9c0003-3333-4333-8333-9c9c9c9c9c9c',
      (select id from public.refunds limit 1), true, 'موافقة', null, null
    ) -> 'refund' ->> 'status'
  ),
  'approved',
  'finance approves'
);

select is(
  (
    select public.cmd_pay_refund(
      '9c9c0003-3333-4333-8333-9c9c9c9c9c9c',
      (select id from public.refunds limit 1), 'REFUND-1', null, null
    ) -> 'refund' ->> 'status'
  ),
  'paid',
  'and pays it — a decision and a transfer are two different days with two different pieces of evidence'
);

select is(
  (
    select payment_status::text from public.bookings
    where trip_id = '9c9cb002-0000-4000-8000-9c9c9c9c9c9c'
  ),
  'unpaid',
  'returning the whole deposit leaves nothing paid, and the booking says so'
);

select is(
  (
    select count(*)::int from public.payment_outbox where kind = 'refund_paid'
  ),
  1,
  'the refund is in the ledger seam exactly once'
);

-- ---------------------------------------------------------------------------
-- 7. Payouts: never approved by the person who asked
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_request_payout(
       '9c9c0002-2222-4222-8222-9c9c9c9c9c9c',
       jsonb_build_object('orgId', '9c9caa00-0000-4000-8000-00000000000a', 'amountYer', 999_000),
       null, null
     ) $$,
  '22023',
  null,
  'a payout larger than the confirmed money on the books is refused'
);

select is(
  (
    select public.cmd_request_payout(
      '9c9c0002-2222-4222-8222-9c9c9c9c9c9c',
      jsonb_build_object('orgId', '9c9caa00-0000-4000-8000-00000000000a', 'amountYer', 2_000),
      null, null
    ) -> 'payout' ->> 'status'
  ),
  'requested',
  'an operator may request what their confirmed bookings earned'
);

select throws_ok(
  $$ select public.cmd_approve_payout(
       '9c9c0002-2222-4222-8222-9c9c9c9c9c9c',
       (select id from public.payouts limit 1), null, null, null
     ) $$,
  '42501',
  null,
  'an operator cannot approve any payout at all — that is finance''s decision'
);

select is(
  (
    select public.cmd_approve_payout(
      '9c9c0003-3333-4333-8333-9c9c9c9c9c9c',
      (select id from public.payouts limit 1), 'موافقة', null, null
    ) -> 'payout' ->> 'status'
  ),
  'approved',
  'finance approves it'
);

select is(
  (
    select public.cmd_mark_payout_paid(
      '9c9c0006-6666-4666-8666-9c9c9c9c9c9c',
      (select id from public.payouts limit 1), 'BANK-1', null, null
    ) -> 'payout' ->> 'status'
  ),
  'paid',
  'a second finance officer marks it paid after the transfer'
);

select is(
  (
    select public.cmd_mark_payout_paid(
      '9c9c0006-6666-4666-8666-9c9c9c9c9c9c',
      (select id from public.payouts limit 1), 'BANK-1', null, null
    ) ->> 'changed'
  ),
  'false',
  'marking it paid twice changes nothing'
);

-- The self-approval rule is in the schema as well as the command: the constraint cannot be bypassed.
select throws_ok(
  $$ update public.payouts
       set approved_by = requested_by
     where id = (select id from public.payouts limit 1) $$,
  '23514',
  null,
  'the schema refuses a payout approved by the person who requested it'
);

-- ---------------------------------------------------------------------------
-- 8. Agents: the float has a ceiling
-- ---------------------------------------------------------------------------

select is(
  (
    select public.cmd_agent_cash_in(
      '9c9c0004-4444-4444-8444-9c9c9c9c9c9c',
      '9c9cd001-0000-4000-8000-9c9c9c9c9c9c', 600, 'دفعة نقدية', null, null
    ) -> 'transaction' ->> 'balance_after_yer'
  ),
  '600',
  'the statement carries the balance after each row, not a total somebody has to trust'
);

select is(
  (
    select public.cmd_agent_cash_in(
      '9c9c0003-3333-4333-8333-9c9c9c9c9c9c',
      '9c9cd001-0000-4000-8000-9c9c9c9c9c9c', 300, 'دفعة ثانية', null, null
    ) -> 'agent' ->> 'float_balance_yer'
  ),
  '900',
  'finance may record a cash-in too, and the float adds up'
);

select throws_ok(
  $$ select public.cmd_agent_cash_in(
       '9c9c0003-3333-4333-8333-9c9c9c9c9c9c',
       '9c9cd001-0000-4000-8000-9c9c9c9c9c9c', 200, 'تجاوز الحد', null, null
     ) $$,
  '23514',
  null,
  'an agent may not hold more float than the credit limit the platform gave them'
);

select throws_ok(
  $$ select public.cmd_agent_cash_in(
       '9c9c0005-5555-4555-8555-9c9c9c9c9c9c',
       '9c9cd001-0000-4000-8000-9c9c9c9c9c9c', 10, 'ليس وكيلاً', null, null
     ) $$,
  '42501',
  null,
  'somebody else cannot move an agent''s float'
);

-- ---------------------------------------------------------------------------
-- 9. Expiry
-- ---------------------------------------------------------------------------

update public.payment_intents
   set expires_at = now() - interval '1 hour'
 where client_reference = 'fixture-transfer';

select is(
  public.cmd_expire_stale_payment_intents(100) >= 0,
  true,
  'the expiry sweep runs without touching a confirmed intent'
);

select is(
  (
    select status::text from public.payment_intents where client_reference = 'fixture-transfer'
  ),
  'confirmed',
  'a confirmed payment is never expired by housekeeping'
);

-- ---------------------------------------------------------------------------
-- 10. Reads: a passenger sees their own payments, finance sees the queue
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"9c9c0001-1111-4111-8111-9c9c9c9c9c9c","role":"authenticated"}';

select is(
  (select count(*)::int from public.payment_intents),
  2,
  'a passenger reads exactly their own two payments'
);

select is(
  (select count(*)::int from public.payment_accounts where method = 'kuraimi'),
  0,
  'and cannot read an operator''s account number'
);

set local request.jwt.claims = '{"sub":"9c9c0005-5555-4555-8555-9c9c9c9c9c9c","role":"authenticated"}';

select is(
  (select count(*)::int from public.payment_intents),
  0,
  'a stranger reads nobody''s payments'
);

set local request.jwt.claims = '{"sub":"9c9c0003-3333-4333-8333-9c9c9c9c9c9c","role":"authenticated"}';

select is(
  (select count(*)::int from public.payment_intents),
  2,
  'finance reads the whole queue'
);

select is(
  (select count(*)::int from public.payment_outbox where kind = 'payment_confirmed'),
  2,
  'and the ledger seam: one event per confirmed payment, no more'
);

select is(
  (select count(*)::int from public.payment_outbox where kind = 'refund_paid'),
  1,
  'and one for the refund that actually left'
);

set local request.jwt.claims = '{"sub":"9c9c0002-2222-4222-8222-9c9c9c9c9c9c","role":"authenticated"}';

select is(
  public.my_available_payout_yer('9c9caa00-0000-4000-8000-00000000000a'),
  -- Phase 10 corrected this number: the cap is now commission-aware, because Phase 9 let an operator withdraw
  -- money the platform had already kept. This org is on Pro, so the effective rate is 400 bp (500 global, less
  -- the 100 bp plan discount): 13 000 − 520 commission − 3 000 refunded − 2 000 withdrawn = 7 480, which is
  -- exactly what the ledger says is owed.
  7_480,
  'the payout screen''s number is the same formula as the cap: 13 000 confirmed, less commission, less 3 000 refunded and 2 000 withdrawn'
);

set local request.jwt.claims = '{"sub":"9c9c0005-5555-4555-8555-9c9c9c9c9c9c","role":"authenticated"}';

select throws_ok(
  $$ select public.my_available_payout_yer('9c9caa00-0000-4000-8000-00000000000a') $$,
  '42501',
  null,
  'and a stranger cannot ask what an organization has available'
);

reset role;

select * from finish();
rollback;
