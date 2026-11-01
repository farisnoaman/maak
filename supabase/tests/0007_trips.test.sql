-- 0007 — Phase 4: trips, pricing and the public marketplace
--
-- The promises verified here:
--   1. an unverified account cannot create a trip, and the refusal is NOT_VERIFIED (42501)
--   2. a trip is a draft until it is published, and only a published trip is in the marketplace
--   3. the payload is checked, not trusted: same origin and destination, no seats, a departure in the
--      past, another owner's vehicle, an unverified vehicle, a vehicle whose papers have lapsed, a
--      driver who was never invited
--   4. stops are ordered, priced, replaced (never patched), and never the same place twice in a row
--   5. pricing matches @maak/core: flat, per-stop, whole-trip, percent (basis points), fixed, scopes
--   6. the 2-hour lock is a database rule — a stale tab gets EDIT_WINDOW_CLOSED from the RPC itself
--   7. Basic is five trips a month and one live trip; the 6th trip and the 2nd publication are refused
--   8. the marketplace hides drafts, cancelled and rejected trips, and its facets cascade
--   9. keyset pagination neither repeats nor skips a row
--  10. verification is staff-only, needs a pending submission, and a substantive edit re-opens it
--  11. trip_events is append-only, and the public projection follows a cancellation immediately
--
-- Run with: supabase test db   (or `npm run sql:check`, which needs no Docker)

begin;

create extension if not exists pgtap;

select plan(119);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('eeee0001-1111-4111-8111-eeeeeeeeeeee', 'trips-owner@example.test', '+967733400001', '{"locale":"ar"}'),
  ('eeee0002-2222-4222-8222-eeeeeeeeeeee', 'trips-new@example.test', '+967733400002', '{"locale":"ar"}'),
  ('eeee0003-3333-4333-8333-eeeeeeeeeeee', 'trips-staff@example.test', '+967733400003', '{"locale":"ar"}'),
  ('eeee0004-4444-4444-8444-eeeeeeeeeeee', 'trips-rival@example.test', '+967733400004', '{"locale":"ar"}'),
  ('eeee0005-5555-4555-8555-eeeeeeeeeeee', 'trips-driver@example.test', '+967733400005', '{"locale":"ar"}'),
  ('eeee0006-6666-4666-8666-eeeeeeeeeeee', 'trips-pro@example.test', '+967733400006', '{"locale":"ar"}');

insert into public.user_roles (user_id, role)
values ('eeee0003-3333-4333-8333-eeeeeeeeeeee', 'platform_staff');

update public.profiles
set verification_status = 'verified'
where id in (
  'eeee0001-1111-4111-8111-eeeeeeeeeeee',
  'eeee0003-3333-4333-8333-eeeeeeeeeeee',
  'eeee0004-4444-4444-8444-eeeeeeeeeeee',
  'eeee0006-6666-4666-8666-eeeeeeeeeeee'
);

update public.profiles
set full_name = case id
  when 'eeee0001-1111-4111-8111-eeeeeeeeeeee' then 'مالك الرحلات'
  when 'eeee0003-3333-4333-8333-eeeeeeeeeeee' then 'موظف المنصة'
  else 'مشغّل آخر'
end
where id in (
  'eeee0001-1111-4111-8111-eeeeeeeeeeee',
  'eeee0002-2222-4222-8222-eeeeeeeeeeee',
  'eeee0003-3333-4333-8333-eeeeeeeeeeee',
  'eeee0004-4444-4444-8444-eeeeeeeeeeee',
  'eeee0005-5555-4555-8555-eeeeeeeeeeee',
  'eeee0006-6666-4666-8666-eeeeeeeeeeee'
);

insert into public.organizations (id, name, owner_id, verification_status, plan)
values ('eeee00a0-0000-4000-8000-eeeeeeeeeeee', 'Pro Trips Co', 'eeee0006-6666-4666-8666-eeeeeeeeeeee', 'verified', 'pro');

insert into public.vehicles (
  id, owner_user_id, make, model, model_year, plate_number,
  seats_passenger, seats_total, status, verification_status, is_active,
  insurance_expiry, inspection_expiry, registration_expiry
)
values
  ('eeee00a1-0000-4000-8000-eeeeeeeeeeee', 'eeee0001-1111-4111-8111-eeeeeeeeeeee',
   'Toyota', 'Hiace', 2019, 'TRP-1001', 12, 13, 'active', 'verified', true,
   current_date + 120, current_date + 120, current_date + 300),
  -- Owner 1's second vehicle, still awaiting review: it may not be scheduled.
  ('eeee00a2-0000-4000-8000-eeeeeeeeeeee', 'eeee0001-1111-4111-8111-eeeeeeeeeeee',
   'Hyundai', 'Starex', 2016, 'TRP-1002', 10, 11, 'active', 'pending', true,
   current_date + 120, current_date + 120, current_date + 300),
  ('eeee00a3-0000-4000-8000-eeeeeeeeeeee', 'eeee0004-4444-4444-8444-eeeeeeeeeeee',
   'Toyota', 'Coaster', 2018, 'TRP-1003', 20, 21, 'active', 'verified', true,
   current_date + 120, current_date + 120, current_date + 300);

insert into public.driver_profiles (
  id, user_id, invited_phone, full_name, invited_by, licence_no, licence_expiry,
  status, verification_status
)
values
  ('eeee00b1-0000-4000-8000-eeeeeeeeeeee', 'eeee0005-5555-4555-8555-eeeeeeeeeeee',
   '+967733400005', 'سائق الرحلات', 'eeee0001-1111-4111-8111-eeeeeeeeeeee',
   'YE-DL-770011', current_date + 300, 'active', 'verified'),
  -- Invited by the rival, so owner 1 cannot put him behind the wheel.
  ('eeee00b2-0000-4000-8000-eeeeeeeeeeee', null,
   '+967733400006', 'سائق الغير', 'eeee0004-4444-4444-8444-eeeeeeeeeeee',
   'YE-DL-770012', current_date + 300, 'active', 'verified');

-- The payload the wizard submits. Overrides are merged onto it, so a test bends exactly one field.
create function pg_temp.trip(p_over jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'vehicleId', 'eeee00a1-0000-4000-8000-eeeeeeeeeeee',
    'driverId', 'eeee00b1-0000-4000-8000-eeeeeeeeeeee',
    'originGovernorateId', (select id from public.governorates where code = 'YE-SA'),
    'destinationGovernorateId', (select id from public.governorates where code = 'YE-AD'),
    'departureAt', now() + interval '2 days',
    'arriveEstimateMinutes', 480,
    'seatsTotal', 12,
    'pricePerSeatYer', 10000,
    'bookingMode', 'per_seat',
    'pricingMode', 'flat',
    'paymentPolicy', 'cash',
    'genderPolicy', 'any'
  ) || p_over;
$$;

create function pg_temp.create_trip(p_actor uuid, p_payload jsonb)
returns jsonb
language sql
as $$
  select public.cmd_create_trip(p_actor, null, p_payload, 'test', null);
$$;

-- ---------------------------------------------------------------------------
-- 1. Who may create a trip, and what a trip payload may say
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select pg_temp.create_trip('eeee0002-2222-4222-8222-eeeeeeeeeeee', pg_temp.trip()) $$,
  '42501',
  null,
  'an unverified account cannot create a trip'
);

create temp table first as
select pg_temp.create_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee', pg_temp.trip()) as result;

create temp table trip1 as
select (result -> 'trip' ->> 'id')::uuid as id, result -> 'trip' ->> 'code' as code from first;

select is(
  (select result -> 'trip' ->> 'status' from first),
  'draft',
  'a verified owner creates a draft'
);

select ok(
  (select code ~ '^[A-Z0-9]{2,4}-[A-Z0-9]{2,4}-[A-Z0-9]{4}$' from trip1),
  'with a short, shareable, uppercase code'
);

select is(
  (select (result -> 'trip' ->> 'seats_available')::int from first),
  12,
  'and every seat is available on a trip nobody has booked'
);

select is(
  (select count(*)::int from public.trip_events where trip_id = (select id from trip1) and kind = 'created'),
  1,
  'creation is recorded in the trip trail'
);

select is(
  (select jsonb_array_length(result -> 'warnings') from first),
  0,
  'a Basic owner creating their first trip gets no soft warning'
);

select throws_ok(
  $$ select pg_temp.create_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee',
       pg_temp.trip(jsonb_build_object(
         'destinationGovernorateId', (select id from public.governorates where code = 'YE-SA')
       ))) $$,
  '22023',
  null,
  'origin and destination may not be the same governorate'
);

select throws_ok(
  $$ select pg_temp.create_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee', pg_temp.trip('{"seatsTotal": 0}'::jsonb)) $$,
  '22023',
  null,
  'a trip with no seats is refused'
);

select throws_ok(
  $$ select pg_temp.create_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee',
       pg_temp.trip(jsonb_build_object('departureAt', now() - interval '1 hour'))) $$,
  '22023',
  null,
  'a departure in the past is refused'
);

select throws_ok(
  $$ select pg_temp.create_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee',
       pg_temp.trip('{"vehicleId": "eeee00a3-0000-4000-8000-eeeeeeeeeeee"}'::jsonb)) $$,
  '42501',
  null,
  'another owner''s vehicle cannot be scheduled'
);

select throws_ok(
  $$ select pg_temp.create_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee',
       pg_temp.trip('{"vehicleId": "eeee00a2-0000-4000-8000-eeeeeeeeeeee"}'::jsonb)) $$,
  '42501',
  null,
  'an unverified vehicle cannot be scheduled'
);

select throws_ok(
  $$ select pg_temp.create_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee',
       pg_temp.trip('{"driverId": "eeee00b2-0000-4000-8000-eeeeeeeeeeee"}'::jsonb)) $$,
  '42501',
  null,
  'a driver who was never invited by this operator cannot be assigned'
);

-- ---------------------------------------------------------------------------
-- 2. Stops: ordered, contiguous, and replaced rather than patched
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.trip_stops where trip_id = (select id from trip1)),
  0,
  'a trip created without stops has none'
);

select public.cmd_set_trip_stops(
  'eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from trip1),
  '[
    {"nameAr": "تعز", "arriveOffsetMinutes": 180, "priceFromOriginYer": 6000},
    {"nameAr": "الراهدة", "arriveOffsetMinutes": 300, "priceFromOriginYer": 8000},
    {"nameAr": "عدن", "arriveOffsetMinutes": 480, "priceFromOriginYer": 9000}
  ]'::jsonb,
  'test-stops', null
);

select is(
  (select array_agg(seq order by seq)::int[] from public.trip_stops where trip_id = (select id from trip1)),
  array[1, 2, 3],
  'three stops are numbered from one, contiguously'
);

select throws_ok(
  $$ select public.cmd_set_trip_stops(
       'eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from trip1),
       '[{"nameAr": "عدن", "arriveOffsetMinutes": 400},
         {"nameAr": "تعز", "arriveOffsetMinutes": 200}]'::jsonb
     ) $$,
  '22023',
  null,
  'stops that go backwards in time are refused'
);

select throws_ok(
  $$ select public.cmd_set_trip_stops(
       'eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from trip1),
       '[{"nameAr": "تعز", "arriveOffsetMinutes": 300},
         {"nameAr": "تعز", "arriveOffsetMinutes": 400}]'::jsonb
     ) $$,
  '22023',
  null,
  'two consecutive stops at the same place are refused'
);

select throws_ok(
  $$ select public.cmd_set_trip_stops(
       'eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from trip1),
       '[{"nameAr": "a1", "arriveOffsetMinutes": 10}, {"nameAr": "b2", "arriveOffsetMinutes": 20},
         {"nameAr": "c3", "arriveOffsetMinutes": 30}, {"nameAr": "d4", "arriveOffsetMinutes": 40},
         {"nameAr": "e5", "arriveOffsetMinutes": 50}, {"nameAr": "f6", "arriveOffsetMinutes": 60},
         {"nameAr": "g7", "arriveOffsetMinutes": 70}, {"nameAr": "h8", "arriveOffsetMinutes": 80},
         {"nameAr": "i9", "arriveOffsetMinutes": 90}, {"nameAr": "j0", "arriveOffsetMinutes": 100},
         {"nameAr": "k1", "arriveOffsetMinutes": 110}]'::jsonb
     ) $$,
  '22023',
  null,
  'a route with more than ten stops is refused'
);

select is(
  (select count(*)::int from public.trip_stops where trip_id = (select id from trip1)),
  3,
  'a refused stop list leaves the previous route untouched'
);

select is(
  public.cmd_set_trip_stops(
    'eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from trip1),
    '[{"nameAr": "تعز", "arriveOffsetMinutes": 180, "priceFromOriginYer": 6000}]'::jsonb,
    'test-stops', null
  ) ->> 'tripId',
  (select id::text from trip1),
  'setting stops replaces the whole list'
);

select is(
  (select count(*)::int from public.trip_stops where trip_id = (select id from trip1)),
  1,
  'and the list is shorter afterwards, not appended to'
);

-- ---------------------------------------------------------------------------
-- 3. Pricing: the SQL and @maak/core must agree to the riyal
-- ---------------------------------------------------------------------------

select public.cmd_set_trip_stops(
  'eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from trip1),
  '[
    {"nameAr": "تعز", "arriveOffsetMinutes": 180, "priceFromOriginYer": 6000},
    {"nameAr": "عدن", "arriveOffsetMinutes": 480, "priceFromOriginYer": 9000}
  ]'::jsonb,
  'test-stops', null
);

update public.trips set discount_kind = 'percent', discount_value = 1000 where id = (select id from trip1);

select is(
  (select (app.trip_total(t, null, 2) ->> 'subtotalMinor')::int from public.trips t where t.id = (select id from trip1)),
  20000,
  'two seats at 10 000 are a 20 000 subtotal'
);

select is(
  (select (app.trip_total(t, null, 2) ->> 'discountMinor')::int from public.trips t where t.id = (select id from trip1)),
  2000,
  'a 10% discount is 1 000 basis points and 2 000 riyal'
);

select is(
  (select (app.trip_total(t, null, 2) ->> 'totalMinor')::int from public.trips t where t.id = (select id from trip1)),
  18000,
  'and the total is what the passenger pays'
);

-- Half a riyal rounds up, exactly like Math.round(0.5) in TypeScript.
update public.trips
set price_per_seat_yer = 5000, discount_kind = 'percent', discount_value = 1
where id = (select id from trip1);

select is(
  (select (app.trip_total(t, null, 1) ->> 'discountMinor')::int from public.trips t where t.id = (select id from trip1)),
  1,
  'a fractional discount rounds to the nearest riyal, like computeDiscountMinor()'
);

update public.trips
set price_per_seat_yer = 10000, discount_kind = 'fixed', discount_value = 3000
where id = (select id from trip1);

select is(
  (select (app.trip_total(t, null, 2) ->> 'totalMinor')::int from public.trips t where t.id = (select id from trip1)),
  17000,
  'a fixed discount is subtracted once from the subtotal'
);

update public.trips set discount_value = 999999 where id = (select id from trip1);

select is(
  (select (app.trip_total(t, null, 1) ->> 'totalMinor')::int from public.trips t where t.id = (select id from trip1)),
  0,
  'a discount larger than the fare stops at zero, never a negative total'
);

update public.trips
set booking_mode = 'whole_trip', whole_trip_price_yer = 60000,
    discount_kind = 'percent', discount_value = 1000, discount_scope = 'per_seat'
where id = (select id from trip1);

select is(
  (select (app.trip_total(t, null, 4) ->> 'subtotalMinor')::int from public.trips t where t.id = (select id from trip1)),
  60000,
  'a whole-trip booking costs the whole-trip price, however many seats are chosen'
);

select is(
  (select (app.trip_total(t, null, 4) ->> 'discountMinor')::int from public.trips t where t.id = (select id from trip1)),
  0,
  'and a per-seat discount does not apply to a whole-trip booking'
);

update public.trips
set booking_mode = 'per_seat', pricing_mode = 'per_stop',
    discount_kind = 'none', discount_value = 0, discount_scope = 'all'
where id = (select id from trip1);

select is(
  (select app.trip_unit_fare(t, 2) from public.trips t where t.id = (select id from trip1)),
  9000,
  'per-stop pricing reads the fare of that stop'
);

select is(
  app.trip_price_from((select id from trip1)),
  6000,
  'and the advertised "from" price is the cheapest stop'
);

-- ---------------------------------------------------------------------------
-- 4. An expired document grounds the vehicle
-- ---------------------------------------------------------------------------
-- Phase 3 warns on the roster; this is where the warning becomes a rule, because this is where a seat is
-- sold. `app.assert_trip_vehicle` is called by create, update *and* publish.

update public.vehicles
set inspection_expiry = current_date - 1
where id = 'eeee00a1-0000-4000-8000-eeeeeeeeeeee';

select throws_ok(
  $$ select pg_temp.create_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee', pg_temp.trip()) $$,
  '23505',
  null,
  'a verified van whose inspection lapsed cannot be scheduled'
);

update public.vehicles
set inspection_expiry = current_date + 120, insurance_expiry = current_date - 1
where id = 'eeee00a1-0000-4000-8000-eeeeeeeeeeee';

select throws_ok(
  $$ select pg_temp.create_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee', pg_temp.trip()) $$,
  '23505',
  null,
  'nor can one whose insurance lapsed'
);

update public.vehicles
set insurance_expiry = current_date + 120, registration_expiry = current_date - 1
where id = 'eeee00a1-0000-4000-8000-eeeeeeeeeeee';

select throws_ok(
  $$ select pg_temp.create_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee', pg_temp.trip()) $$,
  '23505',
  null,
  'nor one whose registration lapsed — the same three documents the wizard disables'
);

update public.vehicles
set registration_expiry = current_date + 300
where id = 'eeee00a1-0000-4000-8000-eeeeeeeeeeee';

select lives_ok(
  $$ select app.assert_trip_vehicle(
       'eeee00a1-0000-4000-8000-eeeeeeeeeeee', 'eeee0001-1111-4111-8111-eeeeeeeeeeee', null
     ) $$,
  'renewing both documents makes the same vehicle schedulable again'
);

-- An unknown expiry is not an expired one: a vehicle whose papers were never recorded stays usable.
update public.vehicles
set inspection_expiry = null, insurance_expiry = null, registration_expiry = null
where id = 'eeee00a1-0000-4000-8000-eeeeeeeeeeee';

select lives_ok(
  $$ select app.assert_trip_vehicle(
       'eeee00a1-0000-4000-8000-eeeeeeeeeeee', 'eeee0001-1111-4111-8111-eeeeeeeeeeee', null
     ) $$,
  'and a vehicle with no recorded expiry is not silently grounded'
);

update public.vehicles
set inspection_expiry = current_date + 120, insurance_expiry = current_date + 120,
    registration_expiry = current_date + 300
where id = 'eeee00a1-0000-4000-8000-eeeeeeeeeeee';

-- ---------------------------------------------------------------------------
-- 5. Publishing, and the two-hour lock
-- ---------------------------------------------------------------------------

select is(
  public.cmd_publish_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from trip1), 'test', null)
    -> 'trip' ->> 'status',
  'published',
  'a draft becomes published'
);

select ok(
  (
    select (t.published_at is not null) from public.trips t where t.id = (select id from trip1)
  ),
  'and gets a publication timestamp'
);

select is(
  (select is_public from public.trips_search where trip_id = (select id from trip1)),
  true,
  'the search projection marks it public'
);

select ok(
  (
    select t.featured_until is null from public.trips t where t.id = (select id from trip1)
  ),
  'a plan with no featured slots publishes without a boost rather than failing'
);

select throws_ok(
  $$ select public.cmd_publish_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from trip1)) $$,
  '23505',
  null,
  'publishing twice is a conflict, not a second publication'
);

create temp table soon as
select (pg_temp.create_trip(
  'eeee0001-1111-4111-8111-eeeeeeeeeeee',
  pg_temp.trip(jsonb_build_object('departureAt', now() + interval '110 minutes'))
) -> 'trip' ->> 'id')::uuid as id;

select throws_ok(
  $$ select public.cmd_update_trip(
       'eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from soon),
       pg_temp.trip(jsonb_build_object('departureAt', now() + interval '110 minutes', 'seatsTotal', 10))
     ) $$,
  'P0001',
  null,
  'editing 1h50m before departure fails with EDIT_WINDOW_CLOSED from the command itself'
);

select throws_ok(
  $$ select public.cmd_publish_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from soon)) $$,
  'P0001',
  null,
  'and a trip inside the window cannot be announced either'
);

create temp table later as
select (pg_temp.create_trip(
  'eeee0001-1111-4111-8111-eeeeeeeeeeee',
  pg_temp.trip(jsonb_build_object('departureAt', now() + interval '3 days'))
) -> 'trip' ->> 'id')::uuid as id;

select is(
  public.cmd_update_trip(
    'eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from later),
    pg_temp.trip(jsonb_build_object('departureAt', now() + interval '3 days', 'notes', 'تحديث')),
    'test', null
  ) -> 'trip' ->> 'notes',
  'تحديث',
  'a trip three days out is still editable'
);

-- ---------------------------------------------------------------------------
-- 6. Quotas: five trips a month, one live trip
-- ---------------------------------------------------------------------------

create temp table rival as
select (pg_temp.create_trip(
  'eeee0004-4444-4444-8444-eeeeeeeeeeee',
  pg_temp.trip('{"vehicleId": "eeee00a3-0000-4000-8000-eeeeeeeeeeee", "driverId": null}'::jsonb)
) -> 'trip' ->> 'id')::uuid as id;

select is(
  app.quota_usage('eeee0004-4444-4444-8444-eeeeeeeeeeee', null, 'trips'),
  1,
  'the first trip of the calendar month is counted'
);

select pg_temp.create_trip(
  'eeee0004-4444-4444-8444-eeeeeeeeeeee',
  pg_temp.trip('{"vehicleId": "eeee00a3-0000-4000-8000-eeeeeeeeeeee", "driverId": null}'::jsonb)
    || jsonb_build_object('departureAt', now() + interval '4 days')
);

select pg_temp.create_trip(
  'eeee0004-4444-4444-8444-eeeeeeeeeeee',
  pg_temp.trip('{"vehicleId": "eeee00a3-0000-4000-8000-eeeeeeeeeeee", "driverId": null}'::jsonb)
    || jsonb_build_object('departureAt', now() + interval '5 days')
);

select pg_temp.create_trip(
  'eeee0004-4444-4444-8444-eeeeeeeeeeee',
  pg_temp.trip('{"vehicleId": "eeee00a3-0000-4000-8000-eeeeeeeeeeee", "driverId": null}'::jsonb)
    || jsonb_build_object('departureAt', now() + interval '6 days')
);

select pg_temp.create_trip(
  'eeee0004-4444-4444-8444-eeeeeeeeeeee',
  pg_temp.trip('{"vehicleId": "eeee00a3-0000-4000-8000-eeeeeeeeeeee", "driverId": null}'::jsonb)
    || jsonb_build_object('departureAt', now() + interval '7 days')
);

select is(
  app.quota_usage('eeee0004-4444-4444-8444-eeeeeeeeeeee', null, 'trips'),
  5,
  'five trips fill the Basic month'
);

select throws_ok(
  $$ select pg_temp.create_trip(
       'eeee0004-4444-4444-8444-eeeeeeeeeeee',
       pg_temp.trip('{"vehicleId": "eeee00a3-0000-4000-8000-eeeeeeeeeeee", "driverId": null}'::jsonb)
         || jsonb_build_object('departureAt', now() + interval '8 days')
     ) $$,
  'P0001',
  null,
  'the sixth trip in a month is refused'
);

select is(
  (app.quota_state('eeee0004-4444-4444-8444-eeeeeeeeeeee', null, 'trips') ->> 'limit')::int,
  5,
  'and the state carries the limit the operator hit'
);

select public.cmd_publish_trip('eeee0004-4444-4444-8444-eeeeeeeeeeee', (select id from rival));

select is(
  app.quota_usage('eeee0004-4444-4444-8444-eeeeeeeeeeee', null, 'active_trips'),
  1,
  'publishing one future trip uses the single Basic live-trip slot'
);

select throws_ok(
  $$ select public.cmd_publish_trip(
       'eeee0004-4444-4444-8444-eeeeeeeeeeee',
       (select id from public.trips
        where owner_user_id = 'eeee0004-4444-4444-8444-eeeeeeeeeeee' and status = 'draft'
        order by departure_at limit 1)
     ) $$,
  'P0001',
  null,
  'a second live trip is refused on Basic'
);

-- A Pro organization sees the same wall at 100%, but gets a warning before it: 7 warnings per metric...
-- no. The warning is arithmetic — 39 of 50 trips is 78%, 40 is 80%.
insert into public.trips (
  code, owner_org_id, vehicle_id, origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, price_per_seat_yer
)
select
  'PR' || lpad(i::text, 2, '0') || '-PRO1-PRO1',
  'eeee00a0-0000-4000-8000-eeeeeeeeeeee',
  'eeee00a1-0000-4000-8000-eeeeeeeeeeee',
  (select id from public.governorates where code = 'YE-SA'),
  (select id from public.governorates where code = 'YE-AD'),
  now() + interval '20 days', 12, 12, 9000
from generate_series(1, 38) i;

select is(
  (app.quota_state('eeee0006-6666-4666-8666-eeeeeeeeeeee', 'eeee00a0-0000-4000-8000-eeeeeeeeeeee', 'trips') ->> 'warning')::boolean,
  false,
  'a Pro owner at 38 of 50 trips is not warned yet'
);

insert into public.trips (
  code, owner_org_id, vehicle_id, origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, price_per_seat_yer
)
values (
  'PRO1-PRO2-PRO3', 'eeee00a0-0000-4000-8000-eeeeeeeeeeee', 'eeee00a1-0000-4000-8000-eeeeeeeeeeee',
  (select id from public.governorates where code = 'YE-SA'),
  (select id from public.governorates where code = 'YE-AD'),
  now() + interval '20 days', 12, 12, 9000
);

select is(
  (app.quota_state('eeee0006-6666-4666-8666-eeeeeeeeeeee', 'eeee00a0-0000-4000-8000-eeeeeeeeeeee', 'trips') ->> 'warning')::boolean,
  true,
  'and is warned at 40 of 50 — 80% is where a soft limit speaks up'
);

-- The notice is not a soft-plan privilege. `soft_limit` decides whether *overage is charged*; it used to
-- decide whether anybody was told at all, which left a Basic operator — at 80% of a hard limit, two trips
-- from being blocked — the one person never told. `threshold` is the boundary itself, so no caller (the
-- response, the monthly job) has an arithmetic of its own to drift from.
update public.plans set soft_limit = false where code = 'pro';

select is(
  (app.quota_state('eeee0006-6666-4666-8666-eeeeeeeeeeee', 'eeee00a0-0000-4000-8000-eeeeeeeeeeee', 'trips') ->> 'warning')::boolean,
  true,
  'the 80% notice does not depend on the plan being soft'
);

select is(
  (app.quota_state('eeee0006-6666-4666-8666-eeeeeeeeeeee', 'eeee00a0-0000-4000-8000-eeeeeeeeeeee', 'trips') ->> 'threshold')::int,
  80,
  'and names the boundary, so nothing downstream re-derives it'
);

update public.plans set soft_limit = true where code = 'pro';

-- ---------------------------------------------------------------------------
-- 7. The marketplace: what is visible, what is filterable, how it pages
-- ---------------------------------------------------------------------------

-- The unfiltered facet counts are the *maintained* ones (`search_counts`, refreshed at most every thirty
-- seconds by whoever notices they are stale). A test that has just built a marketplace has to say when that
-- happened, so every assertion below is about the counts and not about the clock.
select app.refresh_search_counts();

select is(
  (public.search_public_trips('ar', '{}'::jsonb, 'soonest', null, 20) ->> 'total')::int,
  2,
  'only the two published trips are public — drafts and the rival''s unpublished trips are not'
);

select is(
  (
    select item ->> 'code'
    from jsonb_array_elements(public.search_public_trips('ar', '{}'::jsonb, 'soonest', null, 20) -> 'items') item
    where item ->> 'id' = (select id::text from trip1)
  ),
  (select code from trip1),
  'and the published trip is one of them, under its code'
);

select is(
  (
    select item ->> 'operatorName'
    from jsonb_array_elements(public.search_public_trips('ar', '{}'::jsonb, 'soonest', null, 20) -> 'items') item
    where item ->> 'id' = (select id::text from trip1)
  ),
  (select full_name from public.profiles where id = 'eeee0001-1111-4111-8111-eeeeeeeeeeee'),
  'the card names the operator'
);

select is(
  public.get_trip_public((select code from trip1), 'ar') ->> 'code',
  (select code from trip1),
  'the detail payload is reachable by its code'
);

select is(
  public.get_trip_public((select t.code from public.trips t where t.id = (select id from later)), 'ar'),
  null::jsonb,
  'a draft has no public detail page'
);

select is(
  jsonb_array_length(public.get_trip_public((select code from trip1), 'ar') -> 'stops'),
  2,
  'the detail payload lists the route stops'
);

select is(
  (
    select item -> 'origin' ->> 'code'
    from jsonb_array_elements(
      public.search_public_trips(
        'ar', '{}'::jsonb, 'soonest', null, 20
      ) -> 'items'
    ) item
    where item ->> 'id' = (select id::text from trip1)
  ),
  'YE-SA',
  'the card carries the origin governorate'
);

select is(
  (
    select (f ->> 'count')::int
    from jsonb_array_elements(
      public.search_public_trips('ar', '{}'::jsonb, 'soonest', null, 20) -> 'facets' -> 'origins'
    ) f
    where f ->> 'code' = 'YE-SA'
  ),
  2,
  'the origin facet counts the trips that leave from there'
);

select is(
  (public.search_public_trips(
    'ar', jsonb_build_object('origin', jsonb_build_array((select id::text from public.governorates where code = 'YE-SD'))),
    'soonest', null, 20
  ) ->> 'total')::int,
  0,
  'filtering by an origin nobody serves narrows the list to nothing'
);

-- Cascading facets: the origin counts are computed with every filter *except* the origin one, so a
-- user can widen their own search instead of landing on a dead end.
select ok(
  jsonb_array_length(
    public.search_public_trips(
      'ar', jsonb_build_object('origin', jsonb_build_array((select id::text from public.governorates where code = 'YE-SD'))),
      'soonest', null, 20
    ) -> 'facets' -> 'origins'
  ) > 0,
  'while the origin facet keeps its own dimension unfiltered'
);

select is(
  (public.search_public_trips('ar', '{"q": "تعز"}'::jsonb, 'soonest', null, 20) ->> 'total')::int,
  1,
  'a text search matches a stop name as well as a governorate'
);

select is(
  (public.search_public_trips('ar', '{"direct": true}'::jsonb, 'soonest', null, 20) -> 'facets' -> 'direct' ->> 'withStops')::int,
  1,
  '«بدون توقف» counts the trips with stops separately, even when filtered out'
);

select is(
  public.search_public_trips('ar', '{}'::jsonb, 'soonest', null, 1) ->> 'nextCursor' is not null,
  true,
  'a page shorter than the total hands back a cursor'
);

select is(
  (
    select count(distinct p.id)::int
    from (
      select item ->> 'id' as id
      from jsonb_array_elements(public.search_public_trips('ar', '{}'::jsonb, 'soonest', null, 1) -> 'items') item
      union all
      select item ->> 'id' as id
      from jsonb_array_elements(
        public.search_public_trips(
          'ar', '{}'::jsonb, 'soonest',
          public.search_public_trips('ar', '{}'::jsonb, 'soonest', null, 1) ->> 'nextCursor', 1
        ) -> 'items'
      ) item
    ) p
  ),
  2,
  'and the second page neither repeats the first nor skips a trip'
);

select is(
  (
    select item ->> 'priceFromYer'
    from jsonb_array_elements(public.search_public_trips('ar', '{}'::jsonb, 'cheapest', null, 20) -> 'items') item
    where item ->> 'id' = (select id::text from trip1)
  ),
  '6000',
  'sorting by price advertises the cheapest stop, not the flat fare'
);

-- ---------------------------------------------------------------------------
-- 7b. The fast path agrees with the function it replaced
-- ---------------------------------------------------------------------------
-- 00036 rewrote `search_public_trips` for volume: filters are evaluated once per row in a materialised
-- projection instead of once per row per facet. `app.trip_matches()` stays as the readable definition of what
-- a filter means, and these assertions are the contract between the two — the rewrite may be faster, and must
-- be identical. Without them a facet would be free to drift, and the drift would only show as a wrong number
-- in a dropdown.

select is(
  (public.search_public_trips('ar', '{"priceMax": 7000}'::jsonb, 'soonest', null, 50) ->> 'total')::int,
  (
    select count(*)::int from public.trips_search s
    where s.is_public and s.departure_at > now()
      and app.trip_matches(s, '{"priceMax": 7000}'::jsonb, null)
  ),
  'the total under a price cap matches the reference filter'
);

select is(
  (public.search_public_trips('ar', '{"q": "تعز"}'::jsonb, 'soonest', null, 50) ->> 'total')::int,
  (
    select count(*)::int from public.trips_search s
    where s.is_public and s.departure_at > now() and app.trip_matches(s, '{"q": "تعز"}'::jsonb, null)
  ),
  'the total under a text query matches the reference filter'
);

select is(
  (public.search_public_trips('ar', '{"direct": true}'::jsonb, 'soonest', null, 50) ->> 'total')::int,
  (
    select count(*)::int from public.trips_search s
    where s.is_public and s.departure_at > now() and app.trip_matches(s, '{"direct": true}'::jsonb, null)
  ),
  'the total under a direct-only filter matches the reference filter'
);

-- The origin facet applies every filter *except* the origin: that is what makes it cascade, and it is the
-- dimension most likely to be quietly wrong after a rewrite because the page still looks correct.
select is(
  (
    select count(*)::int
    from jsonb_array_elements(
      public.search_public_trips(
        'ar', '{"priceMax": 7000, "origin": ["11111111-1111-4111-8111-111111111111"]}'::jsonb,
        'soonest', null, 50
      ) -> 'facets' -> 'origins'
    ) facet
  ),
  (
    select count(*)::int
    from (
      select s.origin_governorate_id
      from public.trips_search s
      where s.is_public and s.departure_at > now()
        and app.trip_matches(s, '{"priceMax": 7000}'::jsonb, 'origin')
      group by s.origin_governorate_id
    ) grouped
  ),
  'the origin facet groups by every filter except the origin'
);

-- The scalar overload inlines; the composite one cannot. They must still produce the same key, or a page
-- fetched before 00036 and its cursor after it would disagree about where to continue.
select is(
  (
    select count(*)::int from public.trips_search s
    where app.trip_rank(s.price_from_yer, s.departure_at, s.is_featured, 'cheapest')
            is distinct from app.trip_rank(s, 'cheapest')
       or app.trip_rank(s.price_from_yer, s.departure_at, s.is_featured, 'featured')
            is distinct from app.trip_rank(s, 'featured')
       or app.trip_rank(s.price_from_yer, s.departure_at, s.is_featured, 'soonest')
            is distinct from app.trip_rank(s, 'soonest')
  ),
  0,
  'the inlineable sort key is identical to the row-shaped one'
);

select is(
  (public.search_public_trips('ar', '{"booking": ["whole_trip"]}'::jsonb, 'soonest', null, 50) -> 'facets' -> 'direct'),
  (
    select jsonb_build_object(
      'direct', (
        select count(*)::int from public.trips_search s
        where s.is_public and s.departure_at > now() and s.stop_count = 0
          and app.trip_matches(s, '{"booking": ["whole_trip"]}'::jsonb, 'direct')
      ),
      'withStops', (
        select count(*)::int from public.trips_search s
        where s.is_public and s.departure_at > now() and s.stop_count > 0
          and app.trip_matches(s, '{"booking": ["whole_trip"]}'::jsonb, 'direct')
      )
    )
  ),
  'the direct and with-stops counts match the reference filter'
);

-- ---------------------------------------------------------------------------
-- 7c. The counts are counted once, and the page comes from an index
-- ---------------------------------------------------------------------------
-- 00038 stopped recounting the marketplace per request: the facets are one grouping pass per filter set, the
-- unfiltered ones are stored in `search_counts`, and the page is an index scan over a generated rank column.
-- Faster is only allowed to mean faster — these are the contracts with the definitions it replaced.

select is(
  (
    select count(*)::int from public.trips_search s
    where s.rank_soonest is distinct from app.trip_rank(s.price_from_yer, s.departure_at, s.is_featured, 'soonest')
       or s.rank_cheapest is distinct from app.trip_rank(s.price_from_yer, s.departure_at, s.is_featured, 'cheapest')
       or s.rank_featured is distinct from app.trip_rank(s.price_from_yer, s.departure_at, s.is_featured, 'featured')
  ),
  0,
  'the generated rank columns are the sort keys, to the digit — a cursor is a rank'
);

-- The bucketed counts must equal the reference definition, with a filter on, so the cascading skip is
-- exercised rather than the unfiltered identity.
select is(
  (
    select jsonb_object_agg(c.value, c.n)
    from app.search_facet_counts(p_direct => true) c
    where c.dimension = 'origin'
  ),
  (
    select jsonb_object_agg(g.id::text, g.n)
    from (
      select s.origin_governorate_id as id, count(*)::int as n
      from public.trips_search s
      where s.is_public and s.departure_at > now()
        and app.trip_matches(s, '{"direct": true}'::jsonb, 'origin')
      group by s.origin_governorate_id
    ) g
  ),
  'the bucketed origin counts equal the reference filter, cascading included'
);

select is(
  (select c.n from app.search_facet_counts(p_booking => array['whole_trip']) c where c.dimension = 'total'),
  (
    select count(*)::int from public.trips_search s
    where s.is_public and s.departure_at > now()
      and app.trip_matches(s, '{"booking": ["whole_trip"]}'::jsonb, null)
  ),
  'and its total is the reference total for the same filter'
);

select is(
  (
    select count(*)::int from (
      select dimension, value, count from public.search_counts
      except
      select dimension, value, n from app.search_facet_counts() where dimension <> 'total'
    ) drifted
  ),
  0,
  'every stored facet count is what the counting function currently answers'
);

select is(
  (select count(*)::int from public.search_counts),
  (select count(*)::int from app.search_facet_counts() where dimension <> 'total'),
  'and the stored table has a row per live dimension value — nothing stale, nothing missing'
);

select is(
  app.ensure_search_counts(),
  false,
  'a counts refresh that is not due does not happen'
);

update public.search_counts set refreshed_at = now() - interval '1 day';

select is(
  app.ensure_search_counts(),
  true,
  'and a stale aggregate is refreshed by the first request that notices'
);

-- The page is read from the index, so the cursor has to be the rank the sorted scan would have produced.
select is(
  (
    select array_agg(item ->> 'id' order by ordinality)
    from jsonb_array_elements(
      public.search_public_trips('ar', '{}'::jsonb, 'cheapest', null, 2) -> 'items'
    ) with ordinality as t(item, ordinality)
  ),
  (
    select array_agg(x.trip_id::text)
    from (
      select s.trip_id from public.trips_search s
      where s.is_public and s.departure_at > now()
      order by s.rank_cheapest, s.trip_id
      limit 2
    ) x
  ),
  'the cheapest page is the first two trips of the stored ordering, in order'
);

select is(
  (
    select item ->> 'id'
    from jsonb_array_elements(
      public.search_public_trips(
        'ar', '{}'::jsonb, 'soonest',
        public.search_public_trips('ar', '{}'::jsonb, 'soonest', null, 1) ->> 'nextCursor', 1
      ) -> 'items'
    ) item
  ),
  (
    select s.trip_id::text from public.trips_search s
    where s.is_public and s.departure_at > now()
    order by s.rank_soonest, s.trip_id
    offset 1 limit 1
  ),
  'and a cursor page is the row after the last one page 1 showed'
);

select public.search_public_trips('ar', '{"priceMax": 7000}'::jsonb, 'soonest', null, 5);

select is(
  (
    public.search_public_trips('ar', '{"priceMax": 7000}'::jsonb, 'soonest', null, 5) ->> 'cached'
  )::boolean,
  true,
  'a repeated search is served from the cache — the page and the counts are cached separately'
);

-- ---------------------------------------------------------------------------
-- 7d. A dimension-only filter is arithmetic over the buckets, not a scan
-- ---------------------------------------------------------------------------
-- 00040 materialises the buckets the counts are projections of, so "what is left if I also choose Aden" is a
-- sum over ~30 rows instead of a pass over every public trip. These assertions are the contract that keeps the
-- faster answer the same answer: bucket arithmetic must equal row arithmetic for every combination of the
-- dimensions, and the stored homepage chips must be their projections.

select app.refresh_search_counts();

select is(
  (select coalesce(sum(b.trips), 0)::int from public.search_buckets b),
  (select count(*)::int from public.trips_search s where s.is_public and s.departure_at > now()),
  'the buckets sum to the public future trips — nothing missing, nothing counted twice'
);

select is(
  (
    select count(*)::int from (
      select dimension, value, n from app.search_facet_counts_from_buckets(
        null, null, array['any'], null, null
      )
      except
      select dimension, value, n from app.search_facet_counts(
        null, null, array['any'], null, null, null, null, null, null
      )
    ) drifted
  ),
  0,
  'counting the buckets answers exactly what counting the trips answers, for a gender filter'
);

select is(
  (
    select count(*)::int from (
      select dimension, value, n from app.search_facet_counts_from_buckets(
        (select array_agg(id) from public.governorates), null, null, array['per_seat'], true
      )
      except
      select dimension, value, n from app.search_facet_counts(
        (select array_agg(id) from public.governorates), null, null, array['per_seat'], true,
        null, null, null, null
      )
    ) drifted
  ),
  0,
  'three dimensions at once, including the direct flag, still agree with the row-by-row count'
);

select is(
  (
    select count(*)::int
    from jsonb_array_elements(
      public.search_public_trips('ar', '{"direct": true}'::jsonb, 'soonest', null, 50) -> 'facets' -> 'origins'
    ) facet
  ),
  (
    select count(*)::int
    from (
      select s.origin_governorate_id
      from public.trips_search s
      where s.is_public and s.departure_at > now()
        and app.trip_matches(s, '{"direct": true}'::jsonb, 'origin')
      group by s.origin_governorate_id
    ) grouped
  ),
  'and a dimension-filtered search cascades the origin facet over the reference filter'
);

-- ---------------------------------------------------------------------------
-- 8. Verification: staff-only, needs a pending submission, re-opens on a real change
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_decide_trip_verification(
       'eeee0003-3333-4333-8333-eeeeeeeeeeee', (select id from later), 'approve', null, 'test', null
     ) $$,
  '23505',
  null,
  'a trip that was never submitted cannot be approved'
);

select is(
  public.cmd_submit_trip_verification(
    'eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from later), 'من فضلكم راجعوا الأسعار', 'test', null
  ) ->> 'verificationStatus',
  'pending',
  'the owner submits a trip for review'
);

select throws_ok(
  $$ select public.cmd_decide_trip_verification(
       'eeee0004-4444-4444-8444-eeeeeeeeeeee', (select id from later), 'approve', null, 'test', null
     ) $$,
  '42501',
  null,
  'a rival cannot approve it'
);

select throws_ok(
  $$ select public.cmd_decide_trip_verification(
       'eeee0003-3333-4333-8333-eeeeeeeeeeee', (select id from later), 'reject', 'غالي', 'test', null
     ) $$,
  '22023',
  null,
  'a rejection needs a reason someone can act on'
);

select is(
  public.cmd_decide_trip_verification(
    'eeee0003-3333-4333-8333-eeeeeeeeeeee', (select id from later), 'approve', null, 'test', null
  ) -> 'trip' ->> 'verification_status',
  'verified',
  'platform staff can approve it'
);

select is(
  (
    select (result ->> 'reverificationRequired')::boolean
    from (
      select public.cmd_update_trip(
        'eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from later),
        pg_temp.trip(jsonb_build_object('departureAt', now() + interval '3 days', 'pricePerSeatYer', 12500)),
        'test', null
      ) as result
    ) x
  ),
  true,
  'and a substantive change — a new price — puts it back in the review queue'
);

select is(
  (select verification_status from public.trips where id = (select id from later)),
  'pending',
  'the approved stamp is gone, not merely annotated'
);

-- ---------------------------------------------------------------------------
-- 9. Cancelling: out of the marketplace in the same transaction, still in the staff view
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_cancel_trip('eeee0001-1111-4111-8111-eeeeeeeeeeee', (select id from soon), 'لا', 'test', null) $$,
  '22023',
  null,
  'a cancellation needs a reason'
);

select is(
  public.cmd_cancel_trip(
    'eeee0004-4444-4444-8444-eeeeeeeeeeee', (select id from rival),
    'تعطلت المركبة', 'test', null
  ) -> 'trip' ->> 'status',
  'cancelled',
  'the owner can cancel a published trip'
);

select is(
  (select is_public from public.trips_search where trip_id = (select id from rival)),
  false,
  'a cancelled trip leaves the public projection immediately'
);

select is(
  (public.search_public_trips('ar', '{}'::jsonb, 'soonest', null, 20) ->> 'total')::int,
  1,
  'and the marketplace total drops with it'
);

select throws_ok(
  $$ select public.staff_search_trips('eeee0001-1111-4111-8111-eeeeeeeeeeee', '{}'::jsonb) $$,
  '42501',
  null,
  'the staff search is staff-only'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(
      public.staff_search_trips('eeee0003-3333-4333-8333-eeeeeeeeeeee', '{"status": ["cancelled"]}'::jsonb) -> 'items'
    ) item
    where item ->> 'id' = (select id::text from rival)
  ),
  'but staff can still find the cancelled trip'
);

select throws_ok(
  $$ update public.trip_events set detail = '{}'::jsonb where id = (select id from public.trip_events order by id limit 1) $$,
  '42501',
  null,
  'the trip trail is append-only'
);

select ok(
  (select count(*)::int from public.trip_events where trip_id = (select id from trip1)) > 1,
  'and it recorded the life of the trip'
);

-- ---------------------------------------------------------------------------
-- 10. RLS and grants: the marketplace is open, the workshop is not
-- ---------------------------------------------------------------------------

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select is(
  (select count(*)::int from public.trips),
  1,
  'an anonymous visitor sees the one published trip — and none of the drafts or the cancellation'
);

reset role;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';

select is(
  (select count(*)::int from public.trip_verifications),
  0,
  'a signed-in stranger never sees the verification trail'
);

reset role;

select is(
  has_function_privilege('authenticated', 'public.cmd_create_trip(uuid, uuid, jsonb, text, inet)', 'execute'),
  false,
  'a client cannot call the trip commands directly'
);

select is(
  has_function_privilege('anon', 'public.search_public_trips(text, jsonb, text, text, integer)', 'execute'),
  true,
  'but the marketplace reader is open, because the marketplace is'
);

-- A read that only `service_role` may execute is a read nobody can use: the staff search shipped revoked
-- from `authenticated` alongside the commands, so the console's search box answered 42501. pgTAP could
-- not see it, because the suite runs as `postgres` and never consults a grant.
select is(
  has_function_privilege('authenticated', 'public.staff_search_trips(uuid, jsonb, integer)', 'execute'),
  true,
  'staff search is callable by a signed-in user'
);

select is(
  has_function_privilege('anon', 'public.staff_search_trips(uuid, jsonb, integer)', 'execute'),
  false,
  'and not by a visitor, who has no staff role to claim'
);

-- The invariant behind the two grants above, in one assertion: in `public`, every function this
-- project defines — everything that is neither a `cmd_*` command, an `app_*` internal wrapper, nor an
-- extension member — must be executable by a signed-in user. A new read granted only to `service_role`
-- fails here instead of failing in a console nobody exercised.
select is(
  (
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname not like 'cmd\_%'
      and p.proname not like 'app\_%'
      -- Two Phase 5 writes whose names the implementation plan fixes: both are commands in every
      -- sense that matters (one transaction, audited, reachable only through the gateway), so they are
      -- service-only exactly like `cmd_*`.
      -- Phase 7's staff reads take the actor explicitly because the gateway resolves it from the
      -- bearer token and the service role does the work — a client with a session cannot call them
      -- with somebody else's id, because it cannot call them at all.
      -- Phase 8's two vehicle reads take the actor the same way: the gateway resolves it from the
      -- bearer token, and the session-bound wrappers (`vehicle_health`, `fleet_summary`) are what a
      -- browser is given instead.
      and p.proname not in (
        'create_id_share_link', 'get_trip_manifest_data',
        'get_trip_for_staff', 'get_trip_manifest', 'staff_scope_summary',
        'get_vehicle_health', 'get_fleet_summary'
      )
      and not exists (
        select 1
        from pg_depend d
        where d.classid = 'pg_proc'::regclass
          and d.objid = p.oid
          and d.deptype = 'e'
      )
      and not has_function_privilege('authenticated', p.oid, 'execute')
  ),
  0,
  'every non-command public function is callable by a signed-in user'
);

-- ---------------------------------------------------------------------------
-- 11. The fare is the JavaScript fare, in SQL
-- ---------------------------------------------------------------------------
-- `app.trip_total` is the number the screen renders and the number the booking command will charge. The
-- market it prices is a market of trust, so "the card said 24 300 and the ticket said 27 000" is not a
-- cosmetic bug. Every case below is also asserted by `packages/core/tests/pricing.test.ts`; if the two
-- implementations drift, one side of this block fails.
create function pg_temp.trip_total(p jsonb)
returns jsonb
language sql
stable
as $$
  select app.trip_total(
    jsonb_populate_record(null::public.trips, p - 'seats'),
    null,
    (p ->> 'seats')::int
  );
$$;

select is(
  pg_temp.trip_total(
    '{"booking_mode":"per_seat","pricing_mode":"flat","price_per_seat_yer":9000,"discount_kind":"none","discount_value":0,"discount_scope":"all","seats":3}'
  ),
  '{"currency":"YER","unitFareMinor":9000,"seats":3,"subtotalMinor":27000,"discountMinor":0,"totalMinor":27000}'::jsonb,
  'three seats at 9 000 is 27 000'
);

select is(
  pg_temp.trip_total(
    '{"booking_mode":"per_seat","pricing_mode":"flat","price_per_seat_yer":9000,"discount_kind":"percent","discount_value":1000,"discount_scope":"all","seats":3}'
  ) ->> 'totalMinor',
  '24300',
  'and a 10% discount takes 2 700 off the subtotal, not off one seat'
);

select is(
  pg_temp.trip_total(
    '{"booking_mode":"per_seat","pricing_mode":"flat","price_per_seat_yer":9000,"discount_kind":"fixed","discount_value":100000,"discount_scope":"all","seats":3}'
  ) ->> 'discountMinor',
  '27000',
  'a fixed discount larger than the fare is clamped to the fare, never a negative total'
);

select is(
  pg_temp.trip_total(
    '{"booking_mode":"whole_trip","pricing_mode":"flat","price_per_seat_yer":9000,"whole_trip_price_yer":45000,"discount_kind":"none","discount_value":0,"discount_scope":"all","seats":3}'
  ),
  '{"currency":"YER","unitFareMinor":45000,"seats":3,"subtotalMinor":45000,"discountMinor":0,"totalMinor":45000}'::jsonb,
  'a whole-trip booking costs the whole-trip price whatever the seat count'
);

select is(
  pg_temp.trip_total(
    '{"booking_mode":"whole_trip","pricing_mode":"flat","price_per_seat_yer":9000,"whole_trip_price_yer":45000,"discount_kind":"percent","discount_value":1000,"discount_scope":"per_seat","seats":3}'
  ) ->> 'discountMinor',
  '0',
  'a per-seat discount does not apply to a whole-trip booking'
);

select is(
  pg_temp.trip_total(
    '{"booking_mode":"per_seat","pricing_mode":"flat","price_per_seat_yer":9000,"discount_kind":"percent","discount_value":1000,"discount_scope":"whole_trip","seats":3}'
  ) ->> 'discountMinor',
  '0',
  'and a whole-trip discount does not apply to a per-seat booking'
);

select is(
  pg_temp.trip_total(
    '{"booking_mode":"whole_trip","pricing_mode":"flat","price_per_seat_yer":9000,"whole_trip_price_yer":45000,"discount_kind":"fixed","discount_value":4500,"discount_scope":"whole_trip","seats":3}'
  ) ->> 'totalMinor',
  '40500',
  'a whole-trip discount does apply to a whole-trip booking'
);

select is(
  pg_temp.trip_total(
    '{"booking_mode":"per_seat","pricing_mode":"flat","price_per_seat_yer":5,"discount_kind":"percent","discount_value":1000,"discount_scope":"all","seats":1}'
  ),
  '{"currency":"YER","unitFareMinor":5,"seats":1,"subtotalMinor":5,"discountMinor":1,"totalMinor":4}'::jsonb,
  'half a minor unit rounds up, exactly as Math.round does in TypeScript'
);

select throws_ok(
  $$ select pg_temp.trip_total(
       '{"booking_mode":"per_seat","pricing_mode":"flat","price_per_seat_yer":9000,"discount_kind":"none","discount_value":0,"discount_scope":"all","seats":0}'
     ) $$,
  '22023',
  null,
  'a fare for zero seats is an error, not a free ride'
);

select * from finish();
rollback;
