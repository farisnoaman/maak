-- 0010 — Phase 6.2: where the vehicle is
--
-- The promises verified here:
--   1. only this trip's driver (or its operator) may report a position, and only while it is running
--   2. a ping is stored with its own `recorded_at`, and a phone with a fast clock cannot report from tomorrow
--   3. an out-of-order ping is kept, but does not move the trip backwards
--   4. progress is derived once: nearest stop, km to it, km remaining, percent, ETA from rolling speed
--   5. "the location is stale" is 21 minutes old computed at read time, not a stored flag
--   6. `get_trip_progress` answers the driver, the operator and the booked passenger — and nobody else
--   7. none of the writers is callable by a client
--
-- Run with: supabase test db   (requires Docker), or `npm run sql:check` (embedded Postgres).

begin;

create extension if not exists pgtap;

select plan(39);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('e2e20001-1111-4111-8111-e2e2e2e2e2e2', 'track-driver@example.test', '+967733700001', '{"locale":"ar"}'),
  ('e2e20002-2222-4222-8222-e2e2e2e2e2e2', 'track-other@example.test', '+967733700002', '{"locale":"ar"}'),
  ('e2e20003-3333-4333-8333-e2e2e2e2e2e2', 'track-owner@example.test', '+967733700003', '{"locale":"ar"}'),
  ('e2e20004-4444-4444-8444-e2e2e2e2e2e2', 'track-pax@example.test', '+967733700004', '{"locale":"ar"}'),
  ('e2e20005-5555-4555-8555-e2e2e2e2e2e2', 'track-stranger@example.test', '+967733700005', '{"locale":"ar"}');

update public.profiles
set verification_status = 'verified'
where id in (
  'e2e20001-1111-4111-8111-e2e2e2e2e2e2',
  'e2e20002-2222-4222-8222-e2e2e2e2e2e2',
  'e2e20003-3333-4333-8333-e2e2e2e2e2e2',
  'e2e20004-4444-4444-8444-e2e2e2e2e2e2',
  'e2e20005-5555-4555-8555-e2e2e2e2e2e2'
);

insert into public.organizations (id, name, name_en, kind, registration_no, phone, owner_id, verification_status)
values (
  'e2e2aaaa-0000-4000-8000-aaaaaaaaaaaa', 'شركة التتبع', 'Track Co', 'company', 'CR-TRACK-1',
  '+967733700003', 'e2e20003-3333-4333-8333-e2e2e2e2e2e2', 'verified'
);

insert into public.organization_members (org_id, user_id, role, status)
values ('e2e2aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e2e20003-3333-4333-8333-e2e2e2e2e2e2', 'owner', 'active');

insert into public.vehicles (
  id, owner_org_id, make, model, model_year, plate_number, plate_governorate_id,
  seats_passenger, seats_total, odometer_km, status, verification_status, created_by
)
values (
  'e2e2bbbb-0000-4000-8000-bbbbbbbbbbbb',
  'e2e2aaaa-0000-4000-8000-aaaaaaaaaaaa',
  'Toyota', 'Hiace', 2020, '5-7001',
  (select id from public.governorates where code = 'YE-AD'),
  13, 14, 200000, 'active', 'verified', 'e2e20003-3333-4333-8333-e2e2e2e2e2e2'
);

insert into public.driver_profiles (
  id, user_id, invited_phone, full_name, org_id, invited_by, status, verification_status
)
values
  ('e2e2dddd-0000-4000-8000-ddddddddddd1', 'e2e20001-1111-4111-8111-e2e2e2e2e2e2',
   '+967733700001', 'سائق التتبع', 'e2e2aaaa-0000-4000-8000-aaaaaaaaaaaa',
   'e2e20003-3333-4333-8333-e2e2e2e2e2e2', 'active', 'verified'),
  ('e2e2dddd-0000-4000-8000-ddddddddddd2', 'e2e20002-2222-4222-8222-e2e2e2e2e2e2',
   '+967733700002', 'سائق آخر', 'e2e2aaaa-0000-4000-8000-aaaaaaaaaaaa',
   'e2e20003-3333-4333-8333-e2e2e2e2e2e2', 'active', 'verified');

-- Three real places, so the geometry is a real chain rather than three nulls.
insert into public.places (id, kind, name_ar, name_en, district_id, lat, lng)
values
  ('e2e2f001-0000-4000-8000-fffffffffff1', 'station', 'عدن', 'Aden',
   (select d.id from public.districts d join public.governorates g on g.id = d.governorate_id
    where g.code = 'YE-AD' limit 1), 12.7855, 45.0187),
  ('e2e2f002-0000-4000-8000-fffffffffff2', 'station', 'تعز', 'Taiz',
   (select d.id from public.districts d join public.governorates g on g.id = d.governorate_id
    where g.code = 'YE-TA' limit 1), 13.5795, 44.0209),
  ('e2e2f003-0000-4000-8000-fffffffffff3', 'station', 'صنعاء', 'Sanaa',
   (select d.id from public.districts d join public.governorates g on g.id = d.governorate_id
    where g.code = 'YE-SA' limit 1), 15.3694, 44.1910);

insert into public.trips (
  id, code, owner_org_id, vehicle_id, driver_id,
  origin_governorate_id, destination_governorate_id, departure_at, arrive_estimate_minutes,
  seats_total, seats_available, booking_mode, pricing_mode, price_per_seat_yer,
  discount_kind, discount_value, gender_policy, payment_policy, status, verification_status,
  published_at, started_at
)
values
  -- The trip under test: published, then started, so pings are legal.
  ('e2e2cccc-0000-4000-8000-ccccccccccc1', 'TRK-AA-0001',
   'e2e2aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e2e2bbbb-0000-4000-8000-bbbbbbbbbbbb',
   'e2e2dddd-0000-4000-8000-ddddddddddd1',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '30 minutes', 480, 14, 13, 'per_seat', 'flat', 5000,
   'none', 0, 'any', 'cash', 'in_progress', 'verified', now(), now() - interval '2 hours'),
  -- Not started: pings must be refused.
  ('e2e2cccc-0000-4000-8000-ccccccccccc2', 'TRK-AA-0002',
   'e2e2aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e2e2bbbb-0000-4000-8000-bbbbbbbbbbbb',
   'e2e2dddd-0000-4000-8000-ddddddddddd1',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '1 day', 480, 14, 14, 'per_seat', 'flat', 5000,
   'none', 0, 'any', 'cash', 'published', 'verified', now(), null),
  -- The same route, driven by somebody else.
  ('e2e2cccc-0000-4000-8000-ccccccccccc3', 'TRK-AA-0003',
   'e2e2aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e2e2bbbb-0000-4000-8000-bbbbbbbbbbbb',
   'e2e2dddd-0000-4000-8000-ddddddddddd2',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '30 minutes', 480, 14, 14, 'per_seat', 'flat', 5000,
   'none', 0, 'any', 'cash', 'in_progress', 'verified', now(), now() - interval '5 minutes');

insert into public.trip_stops (trip_id, seq, place_id, arrive_offset_minutes)
values
  ('e2e2cccc-0000-4000-8000-ccccccccccc1', 1, 'e2e2f001-0000-4000-8000-fffffffffff1', 0),
  ('e2e2cccc-0000-4000-8000-ccccccccccc1', 2, 'e2e2f002-0000-4000-8000-fffffffffff2', 240),
  ('e2e2cccc-0000-4000-8000-ccccccccccc1', 3, 'e2e2f003-0000-4000-8000-fffffffffff3', 480);

insert into public.bookings (
  code, trip_id, passenger_id, booked_by, seats, unit_price_yer, subtotal_yer, discount_yer,
  total_yer, contact_name, contact_phone, status, accepted_at
)
values (
  'BK-TRACK1', 'e2e2cccc-0000-4000-8000-ccccccccccc1',
  'e2e20004-4444-4444-8444-e2e2e2e2e2e2', 'e2e20004-4444-4444-8444-e2e2e2e2e2e2',
  1, 5000, 5000, 0, 5000, 'مسافر', '+967733700004', 'accepted', now()
);

-- ---------------------------------------------------------------------------
-- 1. Geometry
-- ---------------------------------------------------------------------------

select is(
  round(app.haversine_km(12.7855, 45.0187, 12.7855, 45.0187)::numeric, 3),
  0::numeric,
  'haversine of a point with itself is zero'
);

select ok(
  app.haversine_km(12.7855, 45.0187, 15.3694, 44.1910) between 300 and 400,
  'Aden to Sanaa as the crow flies is 300–400 km'
);

-- ---------------------------------------------------------------------------
-- 2. Who may report, and when
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_record_ping(
       'e2e20001-1111-4111-8111-e2e2e2e2e2e2', 'e2e2cccc-0000-4000-8000-ccccccccccc2',
       12.79, 45.02, now(), 10, 60, 'app', 't', null
     ) $$,
  '23505',
  null,
  'a trip that has not started refuses pings'
);

select throws_ok(
  $$ select public.cmd_record_ping(
       'e2e20001-1111-4111-8111-e2e2e2e2e2e2', 'e2e2cccc-0000-4000-8000-ccccccccccc3',
       12.79, 45.02, now(), 10, 60, 'app', 't', null
     ) $$,
  '42501',
  null,
  'a driver cannot report a position for somebody else''s trip'
);

-- ---------------------------------------------------------------------------
-- 3. A ping writes the point and the derived progress
-- ---------------------------------------------------------------------------

create temp table p1 as
select public.cmd_record_ping(
  'e2e20001-1111-4111-8111-e2e2e2e2e2e2', 'e2e2cccc-0000-4000-8000-ccccccccccc1',
  13.55, 44.05, now(), 8, 60, 'background', 't', null
) as result;

select is(
  (select count(*)::int from public.trip_location_pings
    where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1'),
  1,
  'the ping is stored'
);

select is(
  (select source from public.trip_location_pings
    where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1'),
  'background',
  'the source of the report is kept'
);

select isnt(
  (select last_ping_at from public.trips where id = 'e2e2cccc-0000-4000-8000-ccccccccccc1'),
  null,
  'the trip remembers when it was last heard from'
);

select is(
  (select nearest_stop_seq from public.trip_progress
    where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1'),
  2::smallint,
  'a ping near Taiz makes Taiz the next stop'
);

select ok(
  (select distance_to_next_km from public.trip_progress
    where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1') < 10,
  'the distance to the next stop is under 10 km when the vehicle is nearly there'
);

select ok(
  (select distance_remaining_km from public.trip_progress
    where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1') between 150 and 210,
  'the distance remaining includes the rest of the route to Sanaa'
);

select ok(
  (select progress_pct from public.trip_progress
    where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1') between 30 and 60,
  'progress is a little under half the route'
);

select ok(
  (select eta_next_seconds from public.trip_progress
    where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1') between 60 and 900,
  'the ETA to the next stop follows the reported 60 km/h'
);

select is(
  (select (result -> 'progress' ->> 'nearest_stop_seq')::smallint from p1),
  2::smallint,
  'the command returns the progress it just computed'
);

-- ---------------------------------------------------------------------------
-- 4. Time is the phone's, but not from the future
-- ---------------------------------------------------------------------------

create temp table p2 as
select public.cmd_record_ping(
  'e2e20001-1111-4111-8111-e2e2e2e2e2e2', 'e2e2cccc-0000-4000-8000-ccccccccccc1',
  12.79, 45.02, now() + interval '2 days', 8, 40, 'app', 't', null
) as result;

select ok(
  (select (result ->> 'recordedAt')::timestamptz from p2) <= now(),
  'a phone whose clock is two days fast cannot report from the future'
);

-- An out-of-order ping from back near Aden: kept, but it must not move the trip backwards.
select public.cmd_record_ping(
  'e2e20001-1111-4111-8111-e2e2e2e2e2e2', 'e2e2cccc-0000-4000-8000-ccccccccccc1',
  12.80, 45.03, now() - interval '30 minutes', 8, 20, 'background', 't', null
);

select is(
  (select count(*)::int from public.trip_location_pings
    where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1'),
  3,
  'a late ping from the queue is stored rather than dropped'
);

select ok(
  (select distance_remaining_km from public.trip_progress
    where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1') < 210,
  'a late ping does not move the trip backwards'
);

select ok(
  (select recorded_at from public.trip_location_pings
    where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1'
    order by recorded_at asc limit 1) < now() - interval '20 minutes',
  'the queued ping keeps the time it was taken'
);

-- Announcing the stop moves the target to Sanaa.
select public.cmd_mark_stop_reached(
  'e2e20001-1111-4111-8111-e2e2e2e2e2e2', 'e2e2cccc-0000-4000-8000-ccccccccccc1', 2::smallint, 't', null
);

select public.cmd_record_ping(
  'e2e20001-1111-4111-8111-e2e2e2e2e2e2', 'e2e2cccc-0000-4000-8000-ccccccccccc1',
  13.60, 44.10, now(), 8, 55, 'app', 't', null
);

select is(
  (select nearest_stop_seq from public.trip_progress
    where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1'),
  3::smallint,
  'after Taiz, the next stop is Sanaa'
);

select ok(
  (select distance_remaining_km from public.trip_progress
    where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1') between 150 and 230,
  'the remaining distance is the leg to Sanaa'
);

-- ---------------------------------------------------------------------------
-- 5. Staleness is computed when somebody looks
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub":"e2e20004-4444-4444-8444-e2e2e2e2e2e2","role":"authenticated"}';

select is(
  (public.get_trip_progress('TRK-AA-0001') ->> 'stale')::boolean,
  false,
  'a fresh ping is not stale'
);

select is(
  (public.get_trip_progress('TRK-AA-0001') -> 'trip' ->> 'status'),
  'in_progress',
  'the booked passenger can read the progress'
);

select is(
  jsonb_array_length(public.get_trip_progress('TRK-AA-0001') -> 'stops'),
  3,
  'the progress carries the route stops'
);

select is(
  jsonb_array_length(public.get_trip_progress('TRK-AA-0001') -> 'route'),
  3,
  'the route geometry falls back to the stop chain'
);

select is(
  (public.get_trip_progress('TRK-AA-0001') -> 'nextStop' ->> 'nameEn'),
  'Sanaa',
  'the next stop is named in both languages'
);

select is(
  (public.get_trip_progress('TRK-AA-0001') -> 'destination' ->> 'nameEn'),
  'Sanaa',
  'the destination is the last stop'
);

-- 21 minutes: two missed ten-minute reports plus a minute of grace.
update public.trip_location_pings
set recorded_at = recorded_at - interval '25 minutes'
where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1';

update public.trip_progress
set last_ping_at = last_ping_at - interval '25 minutes'
where trip_id = 'e2e2cccc-0000-4000-8000-ccccccccccc1';

select is(
  (public.get_trip_progress('TRK-AA-0001') ->> 'stale')::boolean,
  true,
  '25 minutes without a ping is stale'
);

select is(
  (public.get_trip_progress('TRK-AA-0001') ->> 'staleAfterSeconds')::int,
  1260,
  'the staleness threshold is 21 minutes'
);

select isnt(
  public.get_trip_progress('TRK-AA-0001') -> 'position',
  null,
  'a stale trip still shows the last known point'
);

-- ---------------------------------------------------------------------------
-- 6. Who may read it
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub":"e2e20005-5555-4555-8555-e2e2e2e2e2e2","role":"authenticated"}';

select throws_ok(
  $$ select public.get_trip_progress('TRK-AA-0001') $$,
  '42501',
  null,
  'a stranger cannot read a trip''s position'
);

set local request.jwt.claims = '{"sub":"e2e20001-1111-4111-8111-e2e2e2e2e2e2","role":"authenticated"}';

select is(
  (public.get_trip_progress('TRK-AA-0001') -> 'trip' ->> 'code'),
  'TRK-AA-0001',
  'the driver can read their own trip''s progress'
);

set local request.jwt.claims = '{"sub":"e2e20003-3333-4333-8333-e2e2e2e2e2e2","role":"authenticated"}';

select is(
  (public.get_trip_progress('TRK-AA-0001') -> 'trip' ->> 'code'),
  'TRK-AA-0001',
  'the operator can read their own trip''s progress'
);

set local request.jwt.claims = '{"sub":"e2e20005-5555-4555-8555-e2e2e2e2e2e2","role":"authenticated"}';

select throws_ok(
  $$ select public.get_trip_progress('TRK-AA-0002') $$,
  '42501',
  null,
  'a signed-in user without a booking is refused'
);

reset request.jwt.claims;

select throws_ok(
  $$ select public.get_trip_progress('TRK-AA-0001') $$,
  '42501',
  null,
  'an anonymous visitor is refused'
);

select throws_ok(
  $$ select public.get_trip_progress('TRK-NOPE-9') $$,
  'P0002',
  null,
  'an unknown code is a 404, not a permission error'
);

-- ---------------------------------------------------------------------------
-- 7. The driver can read the trip they are driving
-- ---------------------------------------------------------------------------
-- 00014's policy only matched `published`, so a driver's own console went blind the moment the trip
-- started — the one status it exists for. These two assertions pin the fix.

set local request.jwt.claims = '{"sub":"e2e20001-1111-4111-8111-e2e2e2e2e2e2","role":"authenticated"}';

select is(
  app.can_read_trip('e2e2cccc-0000-4000-8000-ccccccccccc1'),
  true,
  'the driver can read their own trip while it is in progress'
);

set local request.jwt.claims = '{"sub":"e2e20005-5555-4555-8555-e2e2e2e2e2e2","role":"authenticated"}';

select is(
  app.can_read_trip('e2e2cccc-0000-4000-8000-ccccccccccc1'),
  false,
  'a stranger cannot read a running trip'
);

reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- 8. Nobody writes through the API
-- ---------------------------------------------------------------------------

select is(
  has_function_privilege(
    'authenticated',
    'public.cmd_record_ping(uuid, uuid, double precision, double precision, timestamptz, double precision, double precision, text, text, inet)',
    'execute'
  ),
  false,
  'a client cannot call cmd_record_ping'
);

select is(
  has_function_privilege('anon', 'public.get_trip_progress(text)', 'execute'),
  false,
  'an anonymous visitor cannot call get_trip_progress at all'
);

select ok(
  not exists (
    select 1
    from information_schema.role_table_grants g
    where g.table_schema = 'public'
      and g.table_name in ('trip_location_pings', 'trip_progress', 'trip_route_geometry')
      and g.grantee = 'authenticated'
      and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  ),
  'no client may write pings or progress directly'
);

select * from finish();

rollback;
