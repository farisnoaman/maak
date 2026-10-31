-- 0008 — Phase 5: bookings, seat holds, passenger documents and refunds
--
-- The promises verified here:
--   1. a booking is priced by the server, and a fare that moved is PRICE_CHANGED, not an overcharge
--   2. a seat is sold once: the last seat cannot be sold twice, and the refusal is NO_SEATS_LEFT
--   3. a request holds its seats for 30 minutes; expiry returns them, and running the sweeper twice is a
--      no-op
--   4. BR-09: 48 h → 100 %, 24 h → 75 %, 2 h → 50 %, inside 2 h → CANCEL_WINDOW_CLOSED
--   5. an operator cancellation refunds in full, and cancelling the *trip* cancels its bookings by
--      trigger — not by remembering to
--   6. passenger identity: the ID image is readable by the passenger, the trip operator and staff, and
--      by nobody else; every read writes an audit row
--   7. a share link is for the operator, expires in 72 hours, and its views are logged
--   8. refund math matches computeRefund() in @maak/core, case for case
--
-- Run with: supabase test db   (or `npm run sql:check`, which needs no Docker)

begin;

create extension if not exists pgtap;

select plan(91);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('ffff0001-1111-4111-8111-ffffffffffff', 'bk-owner@example.test', '+967733500001', '{"locale":"ar"}'),
  ('ffff0002-2222-4222-8222-ffffffffffff', 'bk-passenger@example.test', '+967733500002', '{"locale":"ar"}'),
  ('ffff0003-3333-4333-8333-ffffffffffff', 'bk-passenger2@example.test', '+967733500003', '{"locale":"ar"}'),
  ('ffff0004-4444-4444-8444-ffffffffffff', 'bk-rival@example.test', '+967733500004', '{"locale":"ar"}'),
  ('ffff0005-5555-4555-8555-ffffffffffff', 'bk-staff@example.test', '+967733500005', '{"locale":"ar"}');

insert into public.user_roles (user_id, role)
values ('ffff0005-5555-4555-8555-ffffffffffff', 'platform_staff');

update public.profiles
set verification_status = 'verified',
    full_name = case id
      when 'ffff0001-1111-4111-8111-ffffffffffff' then 'مالك الحجوزات'
      when 'ffff0002-2222-4222-8222-ffffffffffff' then 'مسافر أول'
      when 'ffff0003-3333-4333-8333-ffffffffffff' then 'مسافرة ثانية'
      when 'ffff0004-4444-4444-8444-ffffffffffff' then 'مشغّل منافس'
      else 'موظف المنصة'
    end
where id in (
  'ffff0001-1111-4111-8111-ffffffffffff', 'ffff0002-2222-4222-8222-ffffffffffff',
  'ffff0003-3333-4333-8333-ffffffffffff', 'ffff0004-4444-4444-8444-ffffffffffff',
  'ffff0005-5555-4555-8555-ffffffffffff'
);

insert into public.vehicles (
  id, owner_user_id, make, model, model_year, plate_number,
  seats_passenger, seats_total, status, verification_status, is_active,
  insurance_expiry, inspection_expiry, registration_expiry
)
values
  ('ffff00a1-0000-4000-8000-ffffffffffff', 'ffff0001-1111-4111-8111-ffffffffffff',
   'Toyota', 'Hiace', 2019, 'BKG-1001', 12, 13, 'active', 'verified', true,
   current_date + 120, current_date + 120, current_date + 300),
  ('ffff00a2-0000-4000-8000-ffffffffffff', 'ffff0004-4444-4444-8444-ffffffffffff',
   'Toyota', 'Coaster', 2018, 'BKG-1002', 20, 21, 'active', 'verified', true,
   current_date + 120, current_date + 120, current_date + 300);

-- Published trips, inserted directly: these tests are about bookings, and going through the publish
-- command here would only re-test Phase 4.
insert into public.trips (
  id, code, owner_user_id, vehicle_id,
  origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, price_per_seat_yer,
  discount_kind, discount_value, status, verification_status, published_at
)
values
  ('ffff00b1-0000-4000-8000-ffffffffffff', 'BKG-AA-0001', 'ffff0001-1111-4111-8111-ffffffffffff',
   'ffff00a1-0000-4000-8000-ffffffffffff',
   (select id from public.governorates where code = 'YE-SA'),
   (select id from public.governorates where code = 'YE-AD'),
   now() + interval '3 days', 12, 12, 10000, 'none', 0, 'published', 'verified', now()),
  -- One seat only: the last-seat test.
  ('ffff00b2-0000-4000-8000-ffffffffffff', 'BKG-AA-0002', 'ffff0001-1111-4111-8111-ffffffffffff',
   'ffff00a1-0000-4000-8000-ffffffffffff',
   (select id from public.governorates where code = 'YE-SA'),
   (select id from public.governorates where code = 'YE-AD'),
   now() + interval '3 days', 1, 1, 10000, 'none', 0, 'published', 'verified', now()),
  -- Departure offsets chosen to hit each refund tier exactly.
  ('ffff00b3-0000-4000-8000-ffffffffffff', 'BKG-AA-0003', 'ffff0001-1111-4111-8111-ffffffffffff',
   'ffff00a1-0000-4000-8000-ffffffffffff',
   (select id from public.governorates where code = 'YE-SA'),
   (select id from public.governorates where code = 'YE-AD'),
   now() + interval '50 hours', 12, 12, 10000, 'none', 0, 'published', 'verified', now()),
  ('ffff00b4-0000-4000-8000-ffffffffffff', 'BKG-AA-0004', 'ffff0001-1111-4111-8111-ffffffffffff',
   'ffff00a1-0000-4000-8000-ffffffffffff',
   (select id from public.governorates where code = 'YE-SA'),
   (select id from public.governorates where code = 'YE-AD'),
   now() + interval '30 hours', 12, 12, 10000, 'none', 0, 'published', 'verified', now()),
  ('ffff00b5-0000-4000-8000-ffffffffffff', 'BKG-AA-0005', 'ffff0001-1111-4111-8111-ffffffffffff',
   'ffff00a1-0000-4000-8000-ffffffffffff',
   (select id from public.governorates where code = 'YE-SA'),
   (select id from public.governorates where code = 'YE-AD'),
   now() + interval '3 hours', 12, 12, 10000, 'none', 0, 'published', 'verified', now()),
  -- Women only, and a 10 % discount to check the fare is recomputed rather than trusted.
  ('ffff00b6-0000-4000-8000-ffffffffffff', 'BKG-AA-0006', 'ffff0001-1111-4111-8111-ffffffffffff',
   'ffff00a1-0000-4000-8000-ffffffffffff',
   (select id from public.governorates where code = 'YE-SA'),
   (select id from public.governorates where code = 'YE-AD'),
   now() + interval '4 days', 12, 12, 10000,
   'percent', 1000, 'published', 'verified', now()),
  -- The rival's trip: everything about it must be refused to owner 1, and vice versa.
  ('ffff00b7-0000-4000-8000-ffffffffffff', 'BKG-AA-0007', 'ffff0004-4444-4444-8444-ffffffffffff',
   'ffff00a2-0000-4000-8000-ffffffffffff',
   (select id from public.governorates where code = 'YE-SA'),
   (select id from public.governorates where code = 'YE-AD'),
   now() + interval '3 days', 12, 12, 10000, 'none', 0, 'published', 'verified', now()),
  -- Leaves in one hour: inside the booking cutoff.
  ('ffff00b9-0000-4000-8000-ffffffffffff', 'BKG-AA-0009', 'ffff0001-1111-4111-8111-ffffffffffff',
   'ffff00a1-0000-4000-8000-ffffffffffff',
   (select id from public.governorates where code = 'YE-SA'),
   (select id from public.governorates where code = 'YE-AD'),
   now() + interval '1 hour', 12, 12, 10000, 'none', 0, 'published', 'verified', now()),
  -- Still a draft.
  ('ffff00b8-0000-4000-8000-ffffffffffff', 'BKG-AA-0008', 'ffff0001-1111-4111-8111-ffffffffffff',
   'ffff00a1-0000-4000-8000-ffffffffffff',
   (select id from public.governorates where code = 'YE-SA'),
   (select id from public.governorates where code = 'YE-AD'),
   now() + interval '3 days', 12, 12, 10000, 'none', 0, 'draft', 'unverified', null);

update public.trips
set gender_policy = 'women_only'
where id = 'ffff00b6-0000-4000-8000-ffffffffffff';

create function pg_temp.book(
  p_actor uuid,
  p_trip uuid,
  p_seats integer default 1,
  p_claimed integer default null,
  p_name text default 'مسافر',
  p_phone text default '+967733500002',
  p_gender text default null
)
returns jsonb
language sql
as $$
  select public.cmd_create_booking(
    p_actor, p_trip, p_seats, null, p_claimed, p_name, p_phone, p_gender, null, 'test', null
  );
$$;

create function pg_temp.booking_of(p_trip uuid, p_actor uuid)
returns uuid
language sql
stable
as $$
  select b.id from public.bookings b
  where b.trip_id = p_trip and b.passenger_id = p_actor
  order by b.created_at desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 1. A booking on a trip that is not for sale
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select pg_temp.book('ffff0002-2222-4222-8222-ffffffffffff', 'ffff00b8-0000-4000-8000-ffffffffffff') $$,
  '23505',
  null,
  'a draft is not bookable'
);

-- ---------------------------------------------------------------------------
-- 2. The fare is the server's, not the client's
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select pg_temp.book('ffff0002-2222-4222-8222-ffffffffffff', 'ffff00b1-0000-4000-8000-ffffffffffff', 1, 9000) $$,
  '22023',
  null,
  'a claimed fare that does not match the trip is PRICE_CHANGED'
);

create temp table b1 as
select pg_temp.book(
  'ffff0002-2222-4222-8222-ffffffffffff', 'ffff00b1-0000-4000-8000-ffffffffffff', 2, 20000,
  'مسافر أول', '+967733500002'
) as result;

create temp table booking1 as
select (result -> 'booking' ->> 'id')::uuid as id,
       result -> 'booking' ->> 'code' as code,
       result -> 'booking' ->> 'status' as status,
       (result -> 'booking' ->> 'total_yer')::int as total,
       (result ->> 'seatsAvailable')::int as seats_available
from b1;

-- Stashed in a setting rather than only a temp table: later sections switch to `authenticated`, and a
-- role that is not the owner cannot read another session's temp table.
select set_config('test.booking1', (select id::text from booking1), false);

-- ---------------------------------------------------------------------------
-- 2b. One live booking per passenger per trip — and a sentence, not a constraint name
-- ---------------------------------------------------------------------------

-- The unique index `bookings_one_active_per_trip` already refused the second booking. What it did not
-- do was explain it: the insert retried the violation five times (it is written to retry *code*
-- collisions) and then surfaced a bare 23505, which the gateway maps to `DUPLICATE_REFERENCE` — "an
-- entry with this name already exists", a message about organization names, shown above the fold of a
-- booking form whose button is at the bottom. To a passenger, that is a dead button. The command now
-- checks first and raises `ALREADY_BOOKED` naming the booking that exists.

create temp table duplicate_attempt (
  state text,
  message text,
  seats_before integer,
  seats_after integer
);

insert into duplicate_attempt (seats_before)
values (app.recompute_seats_available('ffff00b1-0000-4000-8000-ffffffffffff'));

do $$
begin
  perform pg_temp.book(
    'ffff0002-2222-4222-8222-ffffffffffff',
    'ffff00b1-0000-4000-8000-ffffffffffff',
    1, null, 'مسافر ثانٍ', '+967733500003'
  );
exception when others then
  update duplicate_attempt set state = sqlstate, message = sqlerrm;
end $$;

update duplicate_attempt
set seats_after = app.recompute_seats_available('ffff00b1-0000-4000-8000-ffffffffffff');

select ok(
  (select state = '23505' from duplicate_attempt),
  'a second live booking on the same trip is refused'
);

select ok(
  (select message from duplicate_attempt)
    like 'ALREADY_BOOKED: booking BK-' || '% is already pending on this trip',
  'and the refusal names the booking that already exists'
);

select is(
  (select count(*)::int from public.bookings b
    where b.trip_id = 'ffff00b1-0000-4000-8000-ffffffffffff'
      and b.passenger_id = 'ffff0002-2222-4222-8222-ffffffffffff'),
  1,
  'no second booking row was written'
);

select is(
  (select seats_before = seats_after from duplicate_attempt),
  true,
  'and the refused attempt held no seats'
);

select is(
  (select status from booking1), 'pending',
  'a request starts pending, waiting for the operator'
);

select is(
  (select total from booking1), 20000,
  'the fare is computed from the trip: 2 seats × 10 000'
);

select is(
  (select seats_available from booking1), 10,
  'and the held seats disappear from availability immediately'
);

select ok(
  (select code ~ '^BK-[A-Z0-9]{6}$' from booking1),
  'with a short human reference'
);

select is(
  (select hold_expires_at from public.bookings where id = current_setting('test.booking1')::uuid)
    between now() + interval '29 minutes' and now() + interval '31 minutes',
  true,
  'BR-10: the hold lives for 30 minutes'
);

select is(
  (select count(*)::int from public.booking_events where booking_id = current_setting('test.booking1')::uuid and kind = 'created'),
  1,
  'the request is recorded in the booking trail'
);

select is(
  (select count(*)::int from public.notifications
   where user_id = 'ffff0001-1111-4111-8111-ffffffffffff' and kind = 'booking_requested'),
  1,
  'and the operator is told about it in-app'
);

select throws_ok(
  $$ select pg_temp.book('ffff0002-2222-4222-8222-ffffffffffff', 'ffff00b1-0000-4000-8000-ffffffffffff', 1, 10000) $$,
  '23505',
  null,
  'the same passenger cannot hold two bookings on one trip'
);

select throws_ok(
  $$ select pg_temp.book('ffff0002-2222-4222-8222-ffffffffffff', 'ffff00b9-0000-4000-8000-ffffffffffff', 1, 10000, 'مسافر أول', '+967733500002', 'male') $$,
  '23505',
  null,
  'a trip leaving within two hours is no longer bookable'
);

select throws_ok(
  $$ select pg_temp.book('ffff0003-3333-4333-8333-ffffffffffff', 'ffff00b6-0000-4000-8000-ffffffffffff', 1, 10000, 'x', '+967733500003', 'male') $$,
  '22023',
  null,
  'a women-only trip refuses a male passenger at the database, not just in the form'
);

create temp table b2 as
select pg_temp.book(
  'ffff0003-3333-4333-8333-ffffffffffff', 'ffff00b6-0000-4000-8000-ffffffffffff', 1, 9000,
  'مسافرة ثانية', '+967733500003', 'female'
) as result;

select is(
  (select (result -> 'booking' ->> 'total_yer')::int from b2), 9000,
  'a 10 % trip discount is applied to the recomputed fare'
);

select is(
  (select (result -> 'booking' ->> 'discount_yer')::int from b2), 1000,
  'and the discount is recorded as its own number'
);

-- ---------------------------------------------------------------------------
-- 3. Last seat: exactly one buyer
-- ---------------------------------------------------------------------------

create temp table b3 as
select pg_temp.book(
  'ffff0002-2222-4222-8222-ffffffffffff', 'ffff00b2-0000-4000-8000-ffffffffffff', 1, 10000,
  'مسافر أول', '+967733500002'
) as result;

create temp table b3_id as select (result -> 'booking' ->> 'id')::uuid as id from b3;

select is(
  (select (result ->> 'seatsAvailable')::int from b3), 0,
  'the last seat is taken by the first request'
);

select throws_ok(
  $$ select pg_temp.book('ffff0003-3333-4333-8333-ffffffffffff', 'ffff00b2-0000-4000-8000-ffffffffffff', 1, 10000, 'مسافرة ثانية', '+967733500003') $$,
  '23505',
  null,
  'and the second passenger gets NO_SEATS_LEFT rather than a second seat'
);

select is(
  (select seats_available from public.trips where id = 'ffff00b2-0000-4000-8000-ffffffffffff'),
  0::smallint,
  'the trip itself never goes negative'
);

-- ---------------------------------------------------------------------------
-- 4. Accept, reject, and who may do either
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_accept_booking('ffff0004-4444-4444-8444-ffffffffffff', current_setting('test.booking1')::uuid, 'test', null) $$,
  '42501',
  null,
  'the operator of a different trip cannot accept this booking'
);

select throws_ok(
  $$ select public.cmd_accept_booking('ffff0002-2222-4222-8222-ffffffffffff', current_setting('test.booking1')::uuid, 'test', null) $$,
  '42501',
  null,
  'the passenger cannot accept their own request'
);

select is(
  (select public.cmd_accept_booking('ffff0001-1111-4111-8111-ffffffffffff', current_setting('test.booking1')::uuid, 'test', null)
     -> 'booking' ->> 'status'),
  'accepted',
  'the trip owner accepts it'
);

select is(
  (select hold_expires_at from public.bookings where id = current_setting('test.booking1')::uuid),
  null::timestamptz,
  'an accepted booking no longer holds a timer'
);

select is(
  (select count(*)::int from public.notifications
   where user_id = 'ffff0002-2222-4222-8222-ffffffffffff' and kind = 'booking_accepted'),
  1,
  'and the passenger is told in their own inbox'
);

select is(
  (select seats_available from public.trips where id = 'ffff00b1-0000-4000-8000-ffffffffffff'),
  10::smallint,
  'accepting keeps the seats: they are sold, not released'
);

select throws_ok(
  $$ select public.cmd_reject_booking('ffff0001-1111-4111-8111-ffffffffffff', current_setting('test.booking1')::uuid, 'no', 'test', null) $$,
  '22023',
  null,
  'a rejection needs a real reason'
);

select is(
  (select public.cmd_reject_booking(
     'ffff0001-1111-4111-8111-ffffffffffff', (select id from b3_id), 'المركبة ممتلئة بالكامل', 'test', null
   ) -> 'booking' ->> 'status'),
  'rejected',
  'the operator rejects the last-seat request'
);

select is(
  (select seats_available from public.trips where id = 'ffff00b2-0000-4000-8000-ffffffffffff'),
  1::smallint,
  'a rejection releases the seat immediately'
);

-- ---------------------------------------------------------------------------
-- 5. Holds expire and the seat comes back
-- ---------------------------------------------------------------------------

create temp table b4 as
select pg_temp.book(
  'ffff0003-3333-4333-8333-ffffffffffff', 'ffff00b3-0000-4000-8000-ffffffffffff', 1, 10000,
  'مسافرة ثانية', '+967733500003'
) as result;

create temp table b4_id as select (result -> 'booking' ->> 'id')::uuid as id from b4;

update public.bookings
set hold_expires_at = now() - interval '1 minute'
where id = (select id from b4_id);

select is(
  (select (public.cmd_expire_booking_holds() ->> 'expired')::int), 1,
  'the sweeper expires the hold that ran out'
);

select is(
  (select status from public.bookings where id = (select id from b4_id)),
  'expired'::public.booking_status,
  'and the booking says so'
);

select is(
  (select seats_available from public.trips where id = 'ffff00b3-0000-4000-8000-ffffffffffff'),
  12::smallint,
  'with the seat back on sale'
);

select is(
  (select (public.cmd_expire_booking_holds() ->> 'expired')::int), 0,
  'running the sweeper again changes nothing'
);

-- ---------------------------------------------------------------------------
-- 6. BR-09 — cancellation tiers, from the passenger's side
-- ---------------------------------------------------------------------------

create temp table c1 as
select pg_temp.book('ffff0002-2222-4222-8222-ffffffffffff', 'ffff00b3-0000-4000-8000-ffffffffffff', 1, 10000) as result;
create temp table c2 as
select pg_temp.book('ffff0002-2222-4222-8222-ffffffffffff', 'ffff00b4-0000-4000-8000-ffffffffffff', 1, 10000) as result;
create temp table c3 as
select pg_temp.book('ffff0002-2222-4222-8222-ffffffffffff', 'ffff00b5-0000-4000-8000-ffffffffffff', 2, 20000) as result;
create temp table c1_id as select (result -> 'booking' ->> 'id')::uuid as id from c1;
create temp table c2_id as select (result -> 'booking' ->> 'id')::uuid as id from c2;
create temp table c3_id as select (result -> 'booking' ->> 'id')::uuid as id from c3;

select is(
  (select (public.cmd_cancel_booking_by_passenger(
     'ffff0002-2222-4222-8222-ffffffffffff', (select id from c1_id), null, 'test', null
   ) -> 'refund' ->> 'appliedBasisPoints')::int),
  10000,
  '50 hours before departure refunds in full'
);

select is(
  (select refund_yer from public.bookings where id = (select id from c1_id)),
  10000,
  'and the refund amount is stored on the booking for Phase 9 to pay'
);

select is(
  (select (public.cmd_cancel_booking_by_passenger(
     'ffff0002-2222-4222-8222-ffffffffffff', (select id from c2_id), null, 'test', null
   ) -> 'refund' ->> 'appliedBasisPoints')::int),
  7500,
  '30 hours before departure refunds 75 %'
);

select is(
  (select refund_yer from public.bookings where id = (select id from c2_id)),
  7500,
  'which is 7 500 of 10 000'
);

select is(
  (select (public.cmd_cancel_booking_by_passenger(
     'ffff0002-2222-4222-8222-ffffffffffff', (select id from c3_id), null, 'test', null
   ) -> 'refund' ->> 'appliedBasisPoints')::int),
  5000,
  '3 hours before departure refunds 50 %'
);

select is(
  (select refund_yer from public.bookings where id = (select id from c3_id)),
  10000,
  'of both seats — 20 000 paid, 10 000 back'
);

select is(
  (select seats_available from public.trips where id = 'ffff00b5-0000-4000-8000-ffffffffffff'),
  12::smallint,
  'and cancelling releases the seats'
);

-- A booking made while the trip was still far away, then the trip moves inside the cutoff.
create temp table c4 as
select pg_temp.book('ffff0003-3333-4333-8333-ffffffffffff', 'ffff00b1-0000-4000-8000-ffffffffffff', 1, 10000) as result;
create temp table c4_id as select (result -> 'booking' ->> 'id')::uuid as id from c4;

update public.trips set departure_at = now() + interval '1 hour'
where id = 'ffff00b1-0000-4000-8000-ffffffffffff';

select throws_ok(
  $$ select public.cmd_cancel_booking_by_passenger(
       'ffff0003-3333-4333-8333-ffffffffffff', (select id from c4_id), null, 'test', null
     ) $$,
  '23505',
  null,
  '1 hour before departure the window is closed'
);

select throws_ok(
  $$ select public.cmd_cancel_booking_by_passenger(
       'ffff0004-4444-4444-8444-ffffffffffff', (select id from c4_id), null, 'test', null
     ) $$,
  '42501',
  null,
  'and only the passenger can cancel their own booking'
);

-- ---------------------------------------------------------------------------
-- 7. Refund math matches @maak/core, case for case
--
-- These four numbers are the ones `computeRefund()` is tested with in
-- `packages/core/tests/finance.test.ts`. If either side moves, one suite fails.
-- ---------------------------------------------------------------------------

select is(
  (app.compute_refund(10000, 48) ->> 'amountMinor')::int, 10000,
  'exactly 48 hours is the full-refund tier'
);

select is(
  (app.compute_refund(10000, 24) ->> 'amountMinor')::int, 7500,
  'exactly 24 hours is the 75 % tier'
);

select is(
  (app.compute_refund(10000, 2) ->> 'amountMinor')::int, 5000,
  'exactly 2 hours is the 50 % tier'
);

select is(
  (app.compute_refund(10000, 1.9) ->> 'eligible')::boolean, false,
  'inside the cutoff nothing is refundable'
);

select is(
  (app.compute_refund(0, 10) ->> 'reason'), 'nothing_paid',
  'nothing paid means nothing to refund'
);

-- ---------------------------------------------------------------------------
-- 8. Passenger identity: one document, three audiences, every read logged
-- ---------------------------------------------------------------------------

create temp table doc_path as
select current_setting('test.booking1')::uuid::text || '/id-front.jpg' as path;

insert into storage.objects (bucket_id, name, owner)
select 'passenger-ids', path, 'ffff0002-2222-4222-8222-ffffffffffff' from doc_path;

select is(
  (select public.cmd_set_passenger_document(
     'ffff0002-2222-4222-8222-ffffffffffff', current_setting('test.booking1')::uuid,
     'national_id', '01-2345678', 'عدن', date '1990-04-12', (select path from doc_path), 'test', null
   ) -> 'document' ->> 'idType'),
  'national_id',
  'the passenger records their identity document'
);

select throws_ok(
  $$ select public.cmd_set_passenger_document(
       'ffff0002-2222-4222-8222-ffffffffffff', current_setting('test.booking1')::uuid,
       'passport', 'P-998877', null, null, 'someone-else/photo.jpg', 'test', null
     ) $$,
  '22023',
  null,
  'a photo path outside this booking''s folder is refused'
);

select throws_ok(
  $$ select public.cmd_set_passenger_document(
       'ffff0002-2222-4222-8222-ffffffffffff', current_setting('test.booking1')::uuid,
       'passport', 'P-998877', null, null, current_setting('test.booking1') || '/never-uploaded.jpg', 'test', null
     ) $$,
  '22023',
  null,
  'and so is a path that names no stored object'
);

select throws_ok(
  $$ select public.cmd_set_passenger_document(
       'ffff0004-4444-4444-8444-ffffffffffff', current_setting('test.booking1')::uuid,
       'passport', 'P-998877', null, null, null, 'test', null
     ) $$,
  '42501',
  null,
  'an operator cannot write a passenger''s identity'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"ffff0002-2222-4222-8222-ffffffffffff","role":"authenticated"}';

select is(
  (select count(*)::int from public.passenger_documents where booking_id = current_setting('test.booking1')::uuid),
  1,
  'the passenger reads their own document'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"ffff0001-1111-4111-8111-ffffffffffff","role":"authenticated"}';

select is(
  (select count(*)::int from public.passenger_documents where booking_id = current_setting('test.booking1')::uuid),
  1,
  'the trip operator reads it too — the manifest needs it'
);

select is(
  (select public.log_document_access(current_setting('test.booking1')::uuid, 'test-agent', null)),
  true,
  'and opening it is recorded'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"ffff0004-4444-4444-8444-ffffffffffff","role":"authenticated"}';

select is(
  (select count(*)::int from public.passenger_documents where booking_id = current_setting('test.booking1')::uuid),
  0,
  'a different operator sees no document at all'
);

select throws_ok(
  $$ select public.log_document_access(current_setting('test.booking1')::uuid, 'rival', null) $$,
  '42501',
  null,
  'and cannot write an access row for a booking it may not read'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"ffff0005-5555-4555-8555-ffffffffffff","role":"authenticated"}';

select is(
  (select count(*)::int from public.passenger_documents where booking_id = current_setting('test.booking1')::uuid),
  1,
  'platform staff can read it for a verification decision'
);

reset role;

select is(
  (select count(*)::int from public.document_access_log where booking_id = current_setting('test.booking1')::uuid),
  1,
  'with exactly one audit row for the one recorded read'
);

select is(
  (select kind from public.document_access_log where booking_id = current_setting('test.booking1')::uuid),
  'operator'::public.document_access_kind,
  'attributed to the operator who opened it'
);

-- `set local` claims survive `reset role`, so identity is stated explicitly here rather than inherited
-- from the last block that happened to set it. The link's audience is the trip operator, so the happy
-- path runs as the owner.
set local request.jwt.claims = '{"sub":"ffff0001-1111-4111-8111-ffffffffffff","role":"authenticated"}';

-- ---------------------------------------------------------------------------
-- 9. The WhatsApp share link: 72 hours, one audience, counted views
-- ---------------------------------------------------------------------------

create temp table share1 as
select public.create_id_share_link(
  'ffff0002-2222-4222-8222-ffffffffffff', current_setting('test.booking1')::uuid, 'test', null
) as result;

select ok(
  (select (result ->> 'token') ~ '^[0-9a-f]{32}$' from share1),
  'the link carries an unguessable token'
);

select is(
  (select (result ->> 'expiresAt')::timestamptz from share1)
    between now() + interval '71 hours' and now() + interval '73 hours',
  true,
  'and lives for 72 hours'
);

select is(
  (select public.resolve_id_share_token((select result ->> 'token' from share1), 'test', null) ->> 'idNumber'),
  '01-2345678',
  'the trip operator resolves it to the document'
);

select is(
  (select view_count from public.booking_share_tokens where token = (select result ->> 'token' from share1)),
  1,
  'and the view is counted'
);

select is(
  (select count(*)::int from public.document_access_log
   where booking_id = current_setting('test.booking1')::uuid and kind = 'share_link'),
  1,
  'and logged as a share-link access'
);

-- A different signed-in user with the right token: refused, because the token narrows the audience to
-- the trip's operator rather than widening it.
set local request.jwt.claims = '{"sub":"ffff0003-3333-4333-8333-ffffffffffff","role":"authenticated"}';

select throws_ok(
  $$ select public.resolve_id_share_token((select result ->> 'token' from share1), 'test', null) $$,
  '42501',
  null,
  'a non-operator cannot open the link even with the right token'
);

set local request.jwt.claims = '{"sub":"ffff0001-1111-4111-8111-ffffffffffff","role":"authenticated"}';

create temp table share2 as
select public.create_id_share_link(
  'ffff0002-2222-4222-8222-ffffffffffff', current_setting('test.booking1')::uuid, 'test', null
) as result;

select throws_ok(
  $$ select public.resolve_id_share_token((select result ->> 'token' from share1), 'test', null) $$,
  'P0002',
  null,
  'asking for a new link revokes the old one'
);

-- Backdate both columns: the table refuses a link whose expiry precedes its creation.
update public.booking_share_tokens
set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
where token = (select result ->> 'token' from share2);

select throws_ok(
  $$ select public.resolve_id_share_token((select result ->> 'token' from share2), 'test', null) $$,
  'P0002',
  null,
  'and an expired link is simply not found'
);

-- A link belongs to a live booking. Cancelling the seat must kill the link, not leave the operator able
-- to open the passenger's ID for another 71 hours.
insert into public.trips (
  id, code, owner_user_id, vehicle_id, origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, price_per_seat_yer, discount_kind, discount_value,
  status, verification_status, published_at
)
values (
  'ffff00c2-0000-4000-8000-ffffffffffff', 'BKG-CC-0013', 'ffff0001-1111-4111-8111-ffffffffffff',
  'ffff00a1-0000-4000-8000-ffffffffffff',
  (select id from public.governorates where code = 'YE-SA'),
  (select id from public.governorates where code = 'YE-AD'),
  now() + interval '5 days', 12, 12, 10000, 'none', 0, 'published', 'verified', now()
);

create temp table clink_b as
select pg_temp.book(
  'ffff0002-2222-4222-8222-ffffffffffff', 'ffff00c2-0000-4000-8000-ffffffffffff', 1, 10000,
  'مسافر رابع', '+967733500002'
) as result;

create temp table clink as
select public.create_id_share_link(
  'ffff0002-2222-4222-8222-ffffffffffff', (select (result -> 'booking' ->> 'id')::uuid from clink_b),
  'test', null
) as result;

select public.cmd_cancel_booking_by_passenger(
  'ffff0002-2222-4222-8222-ffffffffffff', (select (result -> 'booking' ->> 'id')::uuid from clink_b),
  null, 'test', null
);

select ok(
  (select revoked_at is not null from public.booking_share_tokens
   where token = (select result ->> 'token' from clink)),
  'cancelling the booking revokes its ID link'
);

select throws_ok(
  $$ select public.resolve_id_share_token((select result ->> 'token' from clink), 'test', null) $$,
  'P0002',
  null,
  'and the revoked link no longer resolves'
);

set local request.jwt.claims = '{}';

-- ---------------------------------------------------------------------------
-- 10. Operator cancellation, and a cancelled trip cancelling its bookings
-- ---------------------------------------------------------------------------

create temp table b7 as
select pg_temp.book(
  'ffff0002-2222-4222-8222-ffffffffffff', 'ffff00b7-0000-4000-8000-ffffffffffff', 2, 20000,
  'مسافر أول', '+967733500002'
) as result;

create temp table b7_id as select (result -> 'booking' ->> 'id')::uuid as id from b7;

select public.cmd_accept_booking('ffff0004-4444-4444-8444-ffffffffffff', (select id from b7_id), 'test', null);

select throws_ok(
  $$ select public.cmd_cancel_booking_by_operator(
       'ffff0001-1111-4111-8111-ffffffffffff', (select id from b7_id), 'سبب غير مصرح به', 'test', null
     ) $$,
  '42501',
  null,
  'one operator cannot cancel another operator''s sale'
);

select is(
  jsonb_array_length(public.get_trip_manifest_data(
     'ffff0004-4444-4444-8444-ffffffffffff', 'ffff00b7-0000-4000-8000-ffffffffffff'
   ) -> 'passengers'),
  1,
  'the manifest lists the accepted passenger'
);

select is(
  (select public.cmd_cancel_booking_by_operator(
     'ffff0004-4444-4444-8444-ffffffffffff', (select id from b7_id), 'تعطلت المركبة اليوم', 'test', null
   ) -> 'booking' ->> 'refund_yer')::int,
  20000,
  'an operator cancellation refunds in full'
);

select is(
  (select status from public.bookings where id = (select id from b7_id)),
  'cancelled_by_operator'::public.booking_status,
  'and the booking says who cancelled it'
);

select is(
  (select seats_available from public.trips where id = 'ffff00b7-0000-4000-8000-ffffffffffff'),
  12::smallint,
  'the seats return to the trip'
);

select is(
  (select count(*)::int from public.notifications
   where user_id = 'ffff0002-2222-4222-8222-ffffffffffff' and kind = 'booking_cancelled'),
  1,
  'the passenger is notified with a reason they can read'
);

-- Trip-level cancellation: two live bookings on one trip, cancelled by the trip, not by a loop.
select public.cmd_cancel_trip(
  'ffff0001-1111-4111-8111-ffffffffffff', 'ffff00b4-0000-4000-8000-ffffffffffff',
  'لا توجد مركبة صالحة لهذا اليوم', 'test', null
);

create temp table c5 as
select pg_temp.book('ffff0003-3333-4333-8333-ffffffffffff', 'ffff00b3-0000-4000-8000-ffffffffffff', 1, 10000) as result;

select public.cmd_cancel_trip(
  'ffff0001-1111-4111-8111-ffffffffffff', 'ffff00b3-0000-4000-8000-ffffffffffff',
  'إلغاء الرحلة لظروف الطريق', 'test', null
);

select is(
  (select status from public.bookings
   where id = (select (result -> 'booking' ->> 'id')::uuid from c5)),
  'cancelled_by_operator'::public.booking_status,
  'cancelling the trip cancels the pending request on it'
);

select is(
  (select refund_yer from public.bookings
   where id = (select (result -> 'booking' ->> 'id')::uuid from c5)),
  10000,
  'in full, because the passenger did nothing wrong'
);

select is(
  (select seats_available from public.trips where id = 'ffff00b3-0000-4000-8000-ffffffffffff'),
  12::smallint,
  'and every held seat is back'
);

-- ---------------------------------------------------------------------------
-- 11. No-show and the end of a trip
-- ---------------------------------------------------------------------------

create temp table ns as
select pg_temp.book('ffff0003-3333-4333-8333-ffffffffffff', 'ffff00b2-0000-4000-8000-ffffffffffff', 1, 10000) as result;

select public.cmd_accept_booking(
  'ffff0001-1111-4111-8111-ffffffffffff', (select (result -> 'booking' ->> 'id')::uuid from ns), 'test', null
);

-- The vehicle left an hour ago and this passenger was not on it.
update public.trips set departure_at = now() - interval '1 hour'
where id = 'ffff00b2-0000-4000-8000-ffffffffffff';

select is(
  (select public.cmd_mark_no_show(
     'ffff0001-1111-4111-8111-ffffffffffff', (select (result -> 'booking' ->> 'id')::uuid from ns), 'test', null
   ) -> 'booking' ->> 'status'),
  'no_show',
  'after departure an operator can record a no-show'
);

select is(
  (select refund_yer from public.bookings where id = (select (result -> 'booking' ->> 'id')::uuid from ns)),
  0,
  'and a no-show is not refunded'
);

select is(
  (select (public.cmd_finalize_trip_bookings('ffff00b2-0000-4000-8000-ffffffffffff', 'test') ->> 'completed')::int),
  0,
  'finalising a trip leaves no-shows alone'
);

-- ---------------------------------------------------------------------------
-- 12. The scheduled sweeps (00020) are the same commands, and clients cannot run them
-- ---------------------------------------------------------------------------

select ok(
  to_regprocedure('app.job_expire_holds(integer)') is not null,
  'the hold sweeper exists as a function a scheduler can call'
);
select ok(
  to_regprocedure('app.job_finalize_trips(integer)') is not null,
  'so does the end-of-trip sweep'
);
select ok(
  to_regprocedure('app.job_purge_documents(integer)') is not null,
  'and the document purge'
);
select ok(
  not has_function_privilege('authenticated', 'app.job_expire_holds(integer)', 'execute'),
  'no signed-in client may trigger a sweep on demand'
);

-- A trip of its own: by this point every fixture above has been cancelled, moved or filled.
insert into public.trips (
  id, code, owner_user_id, vehicle_id, origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, price_per_seat_yer, discount_kind, discount_value,
  status, verification_status, published_at
)
values (
  'ffff00c1-0000-4000-8000-ffffffffffff', 'BKG-CC-0012', 'ffff0001-1111-4111-8111-ffffffffffff',
  'ffff00a1-0000-4000-8000-ffffffffffff',
  (select id from public.governorates where code = 'YE-SA'),
  (select id from public.governorates where code = 'YE-AD'),
  now() + interval '3 days', 12, 12, 10000, 'none', 0, 'published', 'verified', now()
);

create temp table jb as
select pg_temp.book(
  'ffff0003-3333-4333-8333-ffffffffffff', 'ffff00c1-0000-4000-8000-ffffffffffff', 2, 20000,
  'مسافرة ثالثة', '+967733500003'
) as result;

-- The hold is over. The job is what a scheduler would have run two minutes later.
update public.bookings
set hold_expires_at = now() - interval '1 minute'
where id = (select (result -> 'booking' ->> 'id')::uuid from jb);

select is(
  app.job_expire_holds(500) >= 1, true,
  'the sweeper reports the hold it released'
);

select is(
  (select status from public.bookings where id = (select (result -> 'booking' ->> 'id')::uuid from jb)),
  'expired',
  'the stale request is expired rather than left pending'
);

select is(
  (select t.seats_available from public.trips t where t.id = 'ffff00c1-0000-4000-8000-ffffffffffff'),
  12::smallint,
  'and both seats are back on sale'
);

select is(
  app.job_expire_holds(500), 0,
  'a second run finds nothing to do'
);

select is(
  app.job_purge_documents(90), 0,
  'the purge keeps a young document'
);

select * from finish();
rollback;
