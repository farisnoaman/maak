-- 0019 — the road, when a road is known
--
-- `0010` proved the straight-line chain and the ETA maths that use it. `00042` adds the provider half, and the
-- promises verified here are the ones that make it safe to have:
--
--   1. with nothing stored, `app.trip_route_for()` is exactly what it was — the straight line between stops
--   2. a stored route wins over the straight line, and a corridor cached once is reused by a *second* trip on
--      the same road without another provider call
--   3. the write validates what came off the network: a one-point polyline, a point off the planet and a
--      negative distance are all refused, so garbage never becomes geometry
--   4. the corridor key rounds (a hand-entered pin still hits) and keeps direction (A→B is not B→A)
--   5. the queue only offers public, upcoming trips that have two located stops and no geometry
--   6. none of it is callable by a client: the queue and both writes are service_role only
--
-- Run with: `npm run sql:check`.

begin;

create extension if not exists pgtap;

select plan(24);

-- ---------------------------------------------------------------------------
-- Fixtures: one owner, one verified vehicle, three located places, two trips on the same corridor
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values ('c2c20001-1111-4111-8111-c2c2c2c2c2c2', 'route-owner@example.test', '+967733710001', '{"locale":"ar"}');

update public.profiles set verification_status = 'verified'
 where id = 'c2c20001-1111-4111-8111-c2c2c2c2c2c2';

insert into public.organizations (id, name, name_en, kind, registration_no, phone, owner_id, verification_status)
values ('c2c2aaaa-0000-4000-8000-aaaaaaaaaaaa', 'شركة الطرق', 'Route Co', 'company', 'CR-ROUTE-1',
        '+967733710001', 'c2c20001-1111-4111-8111-c2c2c2c2c2c2', 'verified');

insert into public.vehicles (
  id, owner_org_id, make, model, model_year, plate_number, plate_governorate_id,
  seats_passenger, seats_total, odometer_km, status, verification_status, created_by
)
values ('c2c2bbbb-0000-4000-8000-bbbbbbbbbbbb', 'c2c2aaaa-0000-4000-8000-aaaaaaaaaaaa',
        'Toyota', 'Hiace', 2021, '5-9011', (select id from public.governorates where code = 'YE-AD'),
        13, 14, 120000, 'active', 'verified', 'c2c20001-1111-4111-8111-c2c2c2c2c2c2');

insert into public.places (id, kind, name_ar, name_en, district_id, lat, lng)
values
  ('c2c2f001-0000-4000-8000-fffffffffff1', 'station', 'عدن', 'Aden',
   (select d.id from public.districts d join public.governorates g on g.id = d.governorate_id
     where g.code = 'YE-AD' limit 1), 12.7855, 45.0187),
  ('c2c2f002-0000-4000-8000-fffffffffff2', 'station', 'صنعاء', 'Sanaa',
   (select d.id from public.districts d join public.governorates g on g.id = d.governorate_id
     where g.code = 'YE-SA' limit 1), 15.3694, 44.1910),
  ('c2c2f003-0000-4000-8000-fffffffffff3', 'station', 'المكلا', 'Mukalla',
   (select d.id from public.districts d join public.governorates g on g.id = d.governorate_id
     where g.code = 'YE-HD' limit 1), 14.5425, 49.1242);

insert into public.trips (
  id, code, owner_org_id, vehicle_id, origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, booking_mode, pricing_mode, price_per_seat_yer,
  discount_kind, discount_value, gender_policy, payment_policy, status, verification_status, published_at
)
values
  ('c2c2cccc-0000-4000-8000-ccccccccccc1', 'RTE-AA-0001',
   'c2c2aaaa-0000-4000-8000-aaaaaaaaaaaa', 'c2c2bbbb-0000-4000-8000-bbbbbbbbbbbb',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '2 days', 14, 14, 'per_seat', 'flat', 9000, 'none', 0, 'any', 'cash',
   'published', 'verified', now()),
  ('c2c2cccc-0000-4000-8000-ccccccccccc2', 'RTE-AA-0002',
   'c2c2aaaa-0000-4000-8000-aaaaaaaaaaaa', 'c2c2bbbb-0000-4000-8000-bbbbbbbbbbbb',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '3 days', 14, 14, 'per_seat', 'flat', 9000, 'none', 0, 'any', 'cash',
   'published', 'verified', now()),
  -- A different corridor, so "attach a cache that is not there" has a trip to be refused on.
  ('c2c2cccc-0000-4000-8000-ccccccccccc3', 'RTE-AA-0003',
   'c2c2aaaa-0000-4000-8000-aaaaaaaaaaaa', 'c2c2bbbb-0000-4000-8000-bbbbbbbbbbbb',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-HD'),
   now() + interval '4 days', 14, 14, 'per_seat', 'flat', 12000, 'none', 0, 'any', 'cash',
   'published', 'verified', now());

insert into public.trip_stops (trip_id, seq, place_id, arrive_offset_minutes)
values
  ('c2c2cccc-0000-4000-8000-ccccccccccc1', 1, 'c2c2f001-0000-4000-8000-fffffffffff1', 0),
  ('c2c2cccc-0000-4000-8000-ccccccccccc1', 2, 'c2c2f002-0000-4000-8000-fffffffffff2', 480),
  ('c2c2cccc-0000-4000-8000-ccccccccccc2', 1, 'c2c2f001-0000-4000-8000-fffffffffff1', 0),
  ('c2c2cccc-0000-4000-8000-ccccccccccc2', 2, 'c2c2f002-0000-4000-8000-fffffffffff2', 480),
  ('c2c2cccc-0000-4000-8000-ccccccccccc3', 1, 'c2c2f001-0000-4000-8000-fffffffffff1', 0),
  ('c2c2cccc-0000-4000-8000-ccccccccccc3', 2, 'c2c2f003-0000-4000-8000-fffffffffff3', 240);

-- ---------------------------------------------------------------------------
-- 1. The corridor key
-- ---------------------------------------------------------------------------

select is(
  app.route_key(12.78551, 45.01871, 15.36941, 44.19101),
  '12.7855,45.0187;15.3694,44.1910',
  'the corridor key rounds to four decimals, so a hand-entered pin still hits the cache'
);

select isnt(
  app.route_key(12.7855, 45.0187, 15.3694, 44.1910),
  app.route_key(15.3694, 44.1910, 12.7855, 45.0187),
  'and it keeps direction: Aden→Sanaa is not Sanaa→Aden'
);

-- ---------------------------------------------------------------------------
-- 2. With nothing stored, nothing changes
-- ---------------------------------------------------------------------------

select is(
  jsonb_array_length(app.trip_route_for('c2c2cccc-0000-4000-8000-ccccccccccc1')),
  2,
  'with no provider answer the route is the straight line between the stops — two points, as before'
);

select is(
  (select count(*)::int from public.get_trips_needing_routes(50) q
    where q.trip_id in ('c2c2cccc-0000-4000-8000-ccccccccccc1', 'c2c2cccc-0000-4000-8000-ccccccccccc2')),
  2,
  'both public upcoming trips with two located stops are in the router queue'
);

select is(
  (select bool_and(not q.cached) from public.get_trips_needing_routes(50) q
    where q.trip_id in ('c2c2cccc-0000-4000-8000-ccccccccccc1', 'c2c2cccc-0000-4000-8000-ccccccccccc2')),
  true,
  'and the queue says the corridor is not cached yet'
);

-- ---------------------------------------------------------------------------
-- 3. Validation — a network answer is the least trustworthy input here
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_store_trip_route(
       'c2c20001-1111-4111-8111-c2c2c2c2c2c2',
       'c2c2cccc-0000-4000-8000-ccccccccccc1', 'osrm',
       '[{"lat": 12.78, "lng": 45.01}]'::jsonb, 300) $$,
  '22023',
  null,
  'a single-point polyline is refused: it would replace a real fallback with a worse answer'
);

select throws_ok(
  $$ select public.cmd_store_trip_route(
       'c2c20001-1111-4111-8111-c2c2c2c2c2c2',
       'c2c2cccc-0000-4000-8000-ccccccccccc1', 'osrm',
       '[{"lat": 12.78, "lng": 45.01}, {"lat": 95.0, "lng": 45.0}]'::jsonb, 300) $$,
  '22023',
  null,
  'a point off the planet is refused'
);

select throws_ok(
  $$ select public.cmd_store_trip_route(
       'c2c20001-1111-4111-8111-c2c2c2c2c2c2',
       'c2c2cccc-0000-4000-8000-ccccccccccc1', 'osrm',
       '[{"lat": 12.78, "lng": 45.01}, {"lat": 15.36, "lng": 44.19}]'::jsonb, -1) $$,
  '22023',
  null,
  'a negative distance is refused'
);

select throws_ok(
  $$ select public.cmd_store_trip_route(
       'c2c20001-1111-4111-8111-c2c2c2c2c2c2',
       'c2c2cccc-0000-4000-8000-ccccccccccc1', 'osrm',
       '[{"lat": "12.78", "lng": 45.01}, {"lat": 15.36, "lng": 44.19}]'::jsonb, 300) $$,
  '22023',
  null,
  'a string coordinate is refused rather than coerced'
);

-- ---------------------------------------------------------------------------
-- 4. Storing it
-- ---------------------------------------------------------------------------

select is(
  (public.cmd_store_trip_route(
    'c2c20001-1111-4111-8111-c2c2c2c2c2c2',
    'c2c2cccc-0000-4000-8000-ccccccccccc1', 'osrm',
    '[{"lat": 12.7855, "lng": 45.0187}, {"lat": 13.2, "lng": 44.98}, {"lat": 15.3694, "lng": 44.191}]'::jsonb,
    318.4) ->> 'points')::int,
  3,
  'a well-formed answer is stored and reported back'
);

select is(
  jsonb_array_length(app.trip_route_for('c2c2cccc-0000-4000-8000-ccccccccccc1')),
  3,
  'and the trip now reads the road, not the straight line'
);

select is(
  (select provider from public.trip_route_geometry where trip_id = 'c2c2cccc-0000-4000-8000-ccccccccccc1'),
  'osrm',
  'with the provider recorded, so a bad answer can be traced to whoever produced it'
);

select is(
  (select count(*)::int from public.route_cache),
  1,
  'the corridor is cached exactly once'
);

select is(
  (select count(*)::int from public.route_cache
    where route_key = app.route_key(12.7855, 45.0187, 15.3694, 44.1910)),
  1,
  'under the key the second departure will look for'
);

select is(
  jsonb_array_length(app.trip_route_for('c2c2cccc-0000-4000-8000-ccccccccccc2')),
  3,
  'the second trip on the same road answers from the cache without a provider call'
);

select is(
  (select bool_and(q.cached) from public.get_trips_needing_routes(50) q
    where q.trip_id = 'c2c2cccc-0000-4000-8000-ccccccccccc2'),
  true,
  'and the queue tells the worker the corridor is warm'
);

select is(
  (public.cmd_attach_cached_route('c2c2cccc-0000-4000-8000-ccccccccccc2') ->> 'fromCache')::boolean,
  true,
  'attaching the cached corridor to the second trip needs no provider'
);

select is(
  (select count(*)::int from public.get_trips_needing_routes(50) q
    where q.trip_id in ('c2c2cccc-0000-4000-8000-ccccccccccc1', 'c2c2cccc-0000-4000-8000-ccccccccccc2')),
  0,
  'and both trips leave the queue once they have geometry'
);

select is(
  (select count(*)::int from audit.log where action = 'trip.route.stored'),
  1,
  'the write is audited, once'
);

-- Idempotence: the worker retrying a request must not be an error.
select lives_ok(
  $$ select public.cmd_store_trip_route(
       'c2c20001-1111-4111-8111-c2c2c2c2c2c2',
       'c2c2cccc-0000-4000-8000-ccccccccccc1', 'osrm',
       '[{"lat": 12.7855, "lng": 45.0187}, {"lat": 15.3694, "lng": 44.191}]'::jsonb, 317.2) $$,
  're-storing the same trip is an upsert, not a duplicate key error'
);

select is(
  (select count(*)::int from public.route_cache),
  1,
  'and the corridor is still one row'
);

-- ---------------------------------------------------------------------------
-- 5. Nobody with a session can do any of it
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"c2c20001-1111-4111-8111-c2c2c2c2c2c2","role":"authenticated"}';

select throws_ok(
  $$ select * from public.get_trips_needing_routes(10) $$,
  '42501',
  null,
  'the queue is not readable by an authenticated session'
);

select throws_ok(
  $$ select public.cmd_store_trip_route(
       'c2c20001-1111-4111-8111-c2c2c2c2c2c2', 'c2c2cccc-0000-4000-8000-ccccccccccc1',
       'osrm', '[{"lat": 12.78, "lng": 45.01}, {"lat": 15.36, "lng": 44.19}]'::jsonb, 300) $$,
  '42501',
  null,
  'and a client cannot write geometry even for its own trip'
);

reset role;

-- A cached-key guard: the attach command must not invent a route.
select throws_ok(
  $$ select public.cmd_attach_cached_route('c2c2cccc-0000-4000-8000-ccccccccccc3') $$,
  'P0002',
  null,
  'attaching a corridor that is not cached is refused, not faked'
);

select * from finish();
rollback;
