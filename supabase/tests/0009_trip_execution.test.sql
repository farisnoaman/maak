-- 0009 — Phase 6.1: the trip starts, moves and ends
--
-- The promises verified here:
--   1. a trip starts only when verified, close to departure, and for the person assigned to it
--   2. the odometer only goes forward, and the refusal says so (`ODO_REGRESSION`)
--   3. starting writes the reading, the event and the status in one transaction
--   4. stops are monotonic: a reconnecting phone cannot walk the trip backwards
--   5. ending advances the vehicle, closes the passengers' bookings, and flags an implausible distance
--   6. none of it is callable by a client
--
-- Run with: supabase test db   (requires Docker), or `npm run sql:check` (embedded Postgres).

begin;

create extension if not exists pgtap;

select plan(30);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'exec-driver@example.test', '+967733600001', '{"locale":"ar"}'),
  ('e1e10002-2222-4222-8222-e1e1e1e1e1e1', 'exec-other@example.test', '+967733600002', '{"locale":"ar"}'),
  ('e1e10003-3333-4333-8333-e1e1e1e1e1e1', 'exec-owner@example.test', '+967733600003', '{"locale":"ar"}'),
  ('e1e10004-4444-4444-8444-e1e1e1e1e1e1', 'exec-pax@example.test', '+967733600004', '{"locale":"ar"}');

update public.profiles
set verification_status = 'verified'
where id in (
  'e1e10001-1111-4111-8111-e1e1e1e1e1e1',
  'e1e10002-2222-4222-8222-e1e1e1e1e1e1',
  'e1e10003-3333-4333-8333-e1e1e1e1e1e1',
  'e1e10004-4444-4444-8444-e1e1e1e1e1e1'
);

insert into public.organizations (id, name, name_en, kind, registration_no, phone, owner_id, verification_status)
values (
  'e1e1aaaa-0000-4000-8000-aaaaaaaaaaaa', 'شركة الاختبار', 'Exec Co', 'company', 'CR-EXEC-1',
  '+967733600003', 'e1e10003-3333-4333-8333-e1e1e1e1e1e1', 'verified'
);

insert into public.organization_members (org_id, user_id, role, status)
values ('e1e1aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e1e10003-3333-4333-8333-e1e1e1e1e1e1', 'owner', 'active');

insert into public.vehicles (
  id, owner_org_id, make, model, model_year, plate_number, plate_governorate_id,
  seats_passenger, seats_total, odometer_km, status, verification_status, created_by
)
values (
  'e1e1bbbb-0000-4000-8000-bbbbbbbbbbbb',
  'e1e1aaaa-0000-4000-8000-aaaaaaaaaaaa',
  'Toyota', 'Hiace', 2019, '5-6001',
  (select id from public.governorates where code = 'YE-AD'),
  13, 14, 100000, 'active', 'verified', 'e1e10003-3333-4333-8333-e1e1e1e1e1e1'
);

insert into public.driver_profiles (
  id, user_id, invited_phone, full_name, org_id, invited_by, status, verification_status
)
values
  ('e1e1dddd-0000-4000-8000-ddddddddddd1', 'e1e10001-1111-4111-8111-e1e1e1e1e1e1',
   '+967733600001', 'السائق المعني', 'e1e1aaaa-0000-4000-8000-aaaaaaaaaaaa',
   'e1e10003-3333-4333-8333-e1e1e1e1e1e1', 'active', 'verified'),
  ('e1e1dddd-0000-4000-8000-ddddddddddd2', 'e1e10002-2222-4222-8222-e1e1e1e1e1e1',
   '+967733600002', 'سائق آخر', 'e1e1aaaa-0000-4000-8000-aaaaaaaaaaaa',
   'e1e10003-3333-4333-8333-e1e1e1e1e1e1', 'active', 'verified');

insert into public.trips (
  id, code, owner_org_id, vehicle_id, driver_id,
  origin_governorate_id, destination_governorate_id, departure_at, arrive_estimate_minutes,
  seats_total, seats_available, booking_mode, pricing_mode, price_per_seat_yer,
  discount_kind, discount_value, gender_policy, payment_policy, status, verification_status, published_at
)
values
  -- Startable: published, verified, leaves in an hour, driver is ours.
  ('e1e1cccc-0000-4000-8000-ccccccccccc1', 'EXC-AA-0001',
   'e1e1aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e1e1bbbb-0000-4000-8000-bbbbbbbbbbbb',
   'e1e1dddd-0000-4000-8000-ddddddddddd1',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '1 hour', 480, 14, 14, 'per_seat', 'flat', 5000,
   'none', 0, 'any', 'cash', 'published', 'verified', now()),
  -- Never verified.
  ('e1e1cccc-0000-4000-8000-ccccccccccc2', 'EXC-AA-0002',
   'e1e1aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e1e1bbbb-0000-4000-8000-bbbbbbbbbbbb',
   'e1e1dddd-0000-4000-8000-ddddddddddd1',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '1 hour', 480, 14, 14, 'per_seat', 'flat', 5000,
   'none', 0, 'any', 'cash', 'published', 'unverified', now()),
  -- Six hours out: too early to start.
  ('e1e1cccc-0000-4000-8000-ccccccccccc3', 'EXC-AA-0003',
   'e1e1aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e1e1bbbb-0000-4000-8000-bbbbbbbbbbbb',
   'e1e1dddd-0000-4000-8000-ddddddddddd1',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '6 hours', 480, 14, 14, 'per_seat', 'flat', 5000,
   'none', 0, 'any', 'cash', 'published', 'verified', now()),
  -- Somebody else's trip.
  ('e1e1cccc-0000-4000-8000-ccccccccccc4', 'EXC-AA-0004',
   'e1e1aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e1e1bbbb-0000-4000-8000-bbbbbbbbbbbb',
   'e1e1dddd-0000-4000-8000-ddddddddddd2',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '1 hour', 480, 14, 14, 'per_seat', 'flat', 5000,
   'none', 0, 'any', 'cash', 'published', 'verified', now()),
  -- Still a draft.
  ('e1e1cccc-0000-4000-8000-ccccccccccc5', 'EXC-AA-0005',
   'e1e1aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e1e1bbbb-0000-4000-8000-bbbbbbbbbbbb',
   'e1e1dddd-0000-4000-8000-ddddddddddd1',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '1 hour', 480, 14, 14, 'per_seat', 'flat', 5000,
   'none', 0, 'any', 'cash', 'draft', 'unverified', null);

insert into public.trip_stops (trip_id, seq, name_ar, name_en, arrive_offset_minutes)
values
  ('e1e1cccc-0000-4000-8000-ccccccccccc1', 1, 'عدن', 'Aden', 0),
  ('e1e1cccc-0000-4000-8000-ccccccccccc1', 2, 'تعز', 'Taiz', 240),
  ('e1e1cccc-0000-4000-8000-ccccccccccc1', 3, 'صنعاء', 'Sanaa', 480);

-- An accepted passenger, so ending the trip has somebody to close.
insert into public.bookings (
  code, trip_id, passenger_id, booked_by, seats, unit_price_yer, subtotal_yer, discount_yer,
  total_yer, contact_name, contact_phone, status, accepted_at
)
values (
  'BK-EXEC01', 'e1e1cccc-0000-4000-8000-ccccccccccc1',
  'e1e10004-4444-4444-8444-e1e1e1e1e1e1', 'e1e10004-4444-4444-8444-e1e1e1e1e1e1',
  1, 5000, 5000, 0, 5000, 'مسافر', '+967733600004', 'accepted', now()
);

-- ---------------------------------------------------------------------------
-- 1. Refusals: the four reasons a trip must not start
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_start_trip(
       'e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc2', 100000, 't', null
     ) $$,
  '23505',
  null,
  'an unverified trip cannot start'
);

select throws_ok(
  $$ select public.cmd_start_trip(
       'e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc3', 100000, 't', null
     ) $$,
  '23505',
  null,
  'a trip six hours out cannot start'
);

select throws_ok(
  $$ select public.cmd_start_trip(
       'e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc4', 100000, 't', null
     ) $$,
  '42501',
  null,
  'a driver cannot start a trip assigned to somebody else'
);

select throws_ok(
  $$ select public.cmd_start_trip(
       'e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc5', 100000, 't', null
     ) $$,
  '23505',
  null,
  'a draft cannot start'
);

select throws_ok(
  $$ select public.cmd_start_trip(
       'e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc1', 99000, 't', null
     ) $$,
  '22023',
  null,
  'an odometer below the last reading is refused'
);

-- ---------------------------------------------------------------------------
-- 2. Starting writes three things in one transaction
-- ---------------------------------------------------------------------------

create temp table started as
select public.cmd_start_trip(
  'e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc1', 100120, 't', null
) as result;

select is(
  (select (result -> 'trip' ->> 'status') from started),
  'in_progress',
  'starting moves the trip to in_progress'
);

select isnt(
  (select (result -> 'trip' ->> 'started_at') from started),
  null,
  'and records when it started'
);

select is(
  (select reading_km from public.odometer_readings
    where trip_id = 'e1e1cccc-0000-4000-8000-ccccccccccc1' and kind = 'trip_start'),
  100120,
  'and appends the starting reading to the vehicle history'
);

select is(
  (select recorded_by from public.odometer_readings
    where trip_id = 'e1e1cccc-0000-4000-8000-ccccccccccc1' and kind = 'trip_start'),
  'e1e10001-1111-4111-8111-e1e1e1e1e1e1'::uuid,
  'attributed to whoever reported it'
);

select is(
  (select count(*)::int from public.trip_events
    where trip_id = 'e1e1cccc-0000-4000-8000-ccccccccccc1' and kind = 'started'),
  1,
  'and writes exactly one started event'
);

select throws_ok(
  $$ select public.cmd_start_trip(
       'e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc1', 100120, 't', null
     ) $$,
  '23505',
  null,
  'a running trip cannot start again'
);

-- ---------------------------------------------------------------------------
-- 3. Stops are monotonic
-- ---------------------------------------------------------------------------

select is(
  (select public.cmd_mark_stop_reached(
     'e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc1', 2::smallint, 't', null
   ) -> 'trip' ->> 'last_stop_seq')::int,
  2,
  'reaching stop 2 advances the trip'
);

select is(
  (select public.cmd_mark_stop_reached(
     'e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc1', 1::smallint, 't', null
   ) ->> 'alreadyReached')::boolean,
  true,
  'a replayed "reached stop 1" is answered, not applied'
);

select is(
  (select last_stop_seq from public.trips where id = 'e1e1cccc-0000-4000-8000-ccccccccccc1'),
  2::smallint,
  'and the trip does not walk backwards'
);

select throws_ok(
  $$ select public.cmd_mark_stop_reached(
       'e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc1', 9::smallint, 't', null
     ) $$,
  'P0002',
  null,
  'a stop that is not on this trip is not found'
);

select throws_ok(
  $$ select public.cmd_mark_stop_reached(
       'e1e10002-2222-4222-8222-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc1', 3::smallint, 't', null
     ) $$,
  '42501',
  null,
  'a stranger cannot announce stops for this trip'
);

select is(
  (select count(*)::int from public.trip_events
    where trip_id = 'e1e1cccc-0000-4000-8000-ccccccccccc1' and kind = 'stop_reached'),
  1,
  'only the applied stop is audited'
);

-- ---------------------------------------------------------------------------
-- 4. Ending
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_end_trip(
       'e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc1', 100100, 't', null
     ) $$,
  '22023',
  null,
  'a trip cannot end below its starting reading'
);

create temp table ended as
select public.cmd_end_trip(
  'e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc1', 100300, 't', null
) as result;

select is(
  (select (result ->> 'distanceKm')::int from ended),
  180,
  'the distance is the difference, computed by the server'
);

select is(
  (select (result ->> 'flagged')::boolean from ended),
  true,
  'a 180 km hop in minutes is flagged as implausible'
);

select is(
  (select status from public.trips where id = 'e1e1cccc-0000-4000-8000-ccccccccccc1'),
  'completed'::public.trip_status,
  'ending completes the trip'
);

select is(
  (select odometer_km from public.vehicles where id = 'e1e1bbbb-0000-4000-8000-bbbbbbbbbbbb'),
  100300,
  'and the vehicle total moves with it'
);

select is(
  (select status from public.bookings where code = 'BK-EXEC01'),
  'completed'::public.booking_status,
  'and the passengers on it become history'
);

select is(
  (select count(*)::int from public.trip_events
    where trip_id = 'e1e1cccc-0000-4000-8000-ccccccccccc1' and kind = 'ended'),
  1,
  'with an ended event'
);

select is(
  (select count(*)::int from public.odometer_readings
    where trip_id = 'e1e1cccc-0000-4000-8000-ccccccccccc1'),
  2,
  'and exactly two readings for the trip'
);

select throws_ok(
  $$ select public.cmd_end_trip(
       'e1e10001-1111-4111-8111-e1e1e1e1e1e1', 'e1e1cccc-0000-4000-8000-ccccccccccc1', 100400, 't', null
     ) $$,
  '23505',
  null,
  'a completed trip cannot end again'
);

-- ---------------------------------------------------------------------------
-- 5. Nobody reaches these functions directly
-- ---------------------------------------------------------------------------

select is(
  has_function_privilege(
    'authenticated', 'public.cmd_start_trip(uuid, uuid, integer, text, inet)', 'execute'
  ),
  false,
  'a client cannot call cmd_start_trip'
);

select is(
  has_function_privilege(
    'authenticated', 'public.cmd_end_trip(uuid, uuid, integer, text, inet)', 'execute'
  ),
  false,
  'a client cannot call cmd_end_trip'
);

select is(
  has_function_privilege(
    'authenticated', 'public.cmd_mark_stop_reached(uuid, uuid, smallint, text, inet)', 'execute'
  ),
  false,
  'a client cannot call cmd_mark_stop_reached'
);

select is(
  has_function_privilege(
    'service_role', 'public.cmd_start_trip(uuid, uuid, integer, text, inet)', 'execute'
  ),
  true,
  'the gateway can'
);

select * from finish();

rollback;
