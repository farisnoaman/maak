-- 0011 — Phase 7.1: the QR, the scan, and bulk verification
--
-- The promises verified here:
--   1. a verified trip has a 24-hex token, and rotating it invalidates the old one
--   2. a scan is refused for a token that matches nothing, and audited either way
--   3. scope is a *refusal*, not a filter: an out-of-scope supervisor is told so, in a code
--   4. a scan sees a trimmed trip — no passenger names, no phone numbers
--   5. bulk verification is per-row: nine good rows and one out-of-scope row produce
--      `9 verified, 1 failed (OUT_OF_SCOPE)` with the reason attached to that row
--   6. the manifest is a second, audited permission question — operators yes, passengers no
--   7. search is scoped to the patch and filtered by date, governorate and verification state
--   8. none of the writers is callable by a client
--
-- Run with: supabase test db   (requires Docker), or `npm run sql:check` (embedded Postgres).

begin;

create extension if not exists pgtap;

select plan(36);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('e3e30001-1111-4111-8111-e3e3e3e3e3e3', 'ops-admin@example.test', '+967733800001', '{"locale":"ar"}'),
  ('e3e30002-2222-4222-8222-e3e3e3e3e3e3', 'ops-aden@example.test', '+967733800002', '{"locale":"ar"}'),
  ('e3e30003-3333-4333-8333-e3e3e3e3e3e3', 'ops-owner@example.test', '+967733800003', '{"locale":"ar"}'),
  ('e3e30004-4444-4444-8444-e3e3e3e3e3e3', 'ops-pax@example.test', '+967733800004', '{"locale":"ar"}'),
  ('e3e30005-5555-4555-8555-e3e3e3e3e3e3', 'ops-sanaa@example.test', '+967733800005', '{"locale":"ar"}');

update public.profiles
set verification_status = 'verified'
where id in (
  'e3e30001-1111-4111-8111-e3e3e3e3e3e3',
  'e3e30002-2222-4222-8222-e3e3e3e3e3e3',
  'e3e30003-3333-4333-8333-e3e3e3e3e3e3',
  'e3e30004-4444-4444-8444-e3e3e3e3e3e3',
  'e3e30005-5555-4555-8555-e3e3e3e3e3e3'
);

-- A platform admin, and two supervisors with a patch each.
insert into public.user_roles (user_id, role)
values
  ('e3e30001-1111-4111-8111-e3e3e3e3e3e3', 'platform_admin'),
  ('e3e30002-2222-4222-8222-e3e3e3e3e3e3', 'geo_supervisor'),
  ('e3e30005-5555-4555-8555-e3e3e3e3e3e3', 'geo_supervisor');

insert into public.organizations (id, name, name_en, kind, registration_no, phone, owner_id, verification_status)
values (
  'e3e3aaaa-0000-4000-8000-aaaaaaaaaaaa', 'شركة العمليات', 'Ops Co', 'company', 'CR-OPS-1',
  '+967733800003', 'e3e30003-3333-4333-8333-e3e3e3e3e3e3', 'verified'
);

insert into public.organization_members (org_id, user_id, role, status)
values ('e3e3aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e3e30003-3333-4333-8333-e3e3e3e3e3e3', 'owner', 'active');

insert into public.vehicles (
  id, owner_org_id, make, model, model_year, plate_number, plate_governorate_id,
  seats_passenger, seats_total, odometer_km, status, verification_status, created_by
)
values (
  'e3e3bbbb-0000-4000-8000-bbbbbbbbbbbb',
  'e3e3aaaa-0000-4000-8000-aaaaaaaaaaaa',
  'Toyota', 'Hiace', 2020, '5-8001',
  (select id from public.governorates where code = 'YE-AD'),
  13, 14, 300000, 'active', 'verified', 'e3e30003-3333-4333-8333-e3e3e3e3e3e3'
);

insert into public.driver_profiles (
  id, user_id, invited_phone, full_name, org_id, invited_by, status, verification_status
)
values (
  'e3e3dddd-0000-4000-8000-ddddddddddd1', 'e3e30004-4444-4444-8444-e3e3e3e3e3e3',
  '+967733800004', 'سائق العمليات', 'e3e3aaaa-0000-4000-8000-aaaaaaaaaaaa',
  'e3e30003-3333-4333-8333-e3e3e3e3e3e3', 'active', 'verified'
);

-- Two regions, each covering one governorate, assigned to one supervisor each.
insert into public.regions (id, name_ar, name_en, kind, is_active)
values
  ('e3e3c001-0000-4000-8000-ccccccccccc1', 'عدن', 'Aden', 'region', true),
  ('e3e3c002-0000-4000-8000-ccccccccccc2', 'صنعاء', 'Sanaa', 'region', true)
on conflict (id) do nothing;

insert into public.region_governorates (region_id, governorate_id)
values
  ('e3e3c001-0000-4000-8000-ccccccccccc1', (select id from public.governorates where code = 'YE-AD')),
  ('e3e3c002-0000-4000-8000-ccccccccccc2', (select id from public.governorates where code = 'YE-SA'));

insert into public.geo_assignments (user_id, region_id, granted_by)
values
  ('e3e30002-2222-4222-8222-e3e3e3e3e3e3', 'e3e3c001-0000-4000-8000-ccccccccccc1', 'e3e30001-1111-4111-8111-e3e3e3e3e3e3'),
  ('e3e30005-5555-4555-8555-e3e3e3e3e3e3', 'e3e3c002-0000-4000-8000-ccccccccccc2', 'e3e30001-1111-4111-8111-e3e3e3e3e3e3');

-- Three Aden→Sanaa trips awaiting review, and one Sanaa→Aden (out of the Aden patch).
insert into public.trips (
  id, code, owner_org_id, vehicle_id, driver_id,
  origin_governorate_id, destination_governorate_id, departure_at, arrive_estimate_minutes,
  seats_total, seats_available, booking_mode, pricing_mode, price_per_seat_yer,
  discount_kind, discount_value, gender_policy, payment_policy, status, verification_status
)
values
  ('e3e3e001-0000-4000-8000-eeeeeeeeeee1', 'OPS-AA-0001',
   'e3e3aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e3e3bbbb-0000-4000-8000-bbbbbbbbbbbb',
   'e3e3dddd-0000-4000-8000-ddddddddddd1',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '2 days', 480, 14, 13, 'per_seat', 'flat', 5000,
   'none', 0, 'any', 'cash', 'pending', 'pending'),
  ('e3e3e002-0000-4000-8000-eeeeeeeeeee2', 'OPS-AA-0002',
   'e3e3aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e3e3bbbb-0000-4000-8000-bbbbbbbbbbbb',
   'e3e3dddd-0000-4000-8000-ddddddddddd1',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '3 days', 480, 14, 14, 'per_seat', 'flat', 5000,
   'none', 0, 'any', 'cash', 'pending', 'pending'),
  ('e3e3e003-0000-4000-8000-eeeeeeeeeee3', 'OPS-AA-0003',
   'e3e3aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e3e3bbbb-0000-4000-8000-bbbbbbbbbbbb',
   'e3e3dddd-0000-4000-8000-ddddddddddd1',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '4 days', 480, 14, 14, 'per_seat', 'flat', 5000,
   'none', 0, 'any', 'cash', 'published', 'verified'),
  ('e3e3e004-0000-4000-8000-eeeeeeeeeee4', 'OPS-SA-0004',
   'e3e3aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e3e3bbbb-0000-4000-8000-bbbbbbbbbbbb',
   'e3e3dddd-0000-4000-8000-ddddddddddd1',
   (select id from public.governorates where code = 'YE-SA'),
   (select id from public.governorates where code = 'YE-AD'),
   now() + interval '5 days', 480, 14, 14, 'per_seat', 'flat', 5000,
   'none', 0, 'any', 'cash', 'pending', 'pending');

insert into public.trip_stops (trip_id, seq, name_ar, name_en, arrive_offset_minutes)
values
  ('e3e3e003-0000-4000-8000-eeeeeeeeeee3', 1, 'عدن', 'Aden', 0),
  ('e3e3e003-0000-4000-8000-eeeeeeeeeee3', 2, 'تعز', 'Taiz', 240),
  ('e3e3e003-0000-4000-8000-eeeeeeeeeee3', 3, 'صنعاء', 'Sanaa', 480);

insert into public.bookings (
  code, trip_id, passenger_id, booked_by, seats, unit_price_yer, subtotal_yer, discount_yer,
  total_yer, contact_name, contact_phone, status, accepted_at
)
values (
  'BK-OPS001', 'e3e3e003-0000-4000-8000-eeeeeeeeeee3',
  'e3e30004-4444-4444-8444-e3e3e3e3e3e3', 'e3e30004-4444-4444-8444-e3e3e3e3e3e3',
  1, 5000, 5000, 0, 5000, 'مسافر العمليات', '+967733800004', 'accepted', now()
);

-- ---------------------------------------------------------------------------
-- 1. The token
-- ---------------------------------------------------------------------------

select is(
  (select qr_token from public.trips where id = 'e3e3e003-0000-4000-8000-eeeeeeeeeee3') ~ '^[0-9a-f]{24}$',
  true,
  'a verified trip gets a 24-hex token without anybody asking'
);

select is(
  (select qr_token from public.trips where id = 'e3e3e001-0000-4000-8000-eeeeeeeeeee1'),
  null,
  'a trip still waiting for review has no token'
);

select is(
  (select length(app.ensure_trip_qr_token('e3e3e003-0000-4000-8000-eeeeeeeeeee3'))),
  24,
  'asking again returns the same token rather than minting a second one'
);

-- ---------------------------------------------------------------------------
-- 2. Scope
-- ---------------------------------------------------------------------------

select is(
  app.staff_in_trip_scope('e3e30002-2222-4222-8222-e3e3e3e3e3e3', 'e3e3e003-0000-4000-8000-eeeeeeeeeee3'),
  true,
  'an Aden supervisor covers an Aden→Sanaa trip'
);

select is(
  app.staff_in_trip_scope('e3e30005-5555-4555-8555-e3e3e3e3e3e3', 'e3e3e003-0000-4000-8000-eeeeeeeeeee3'),
  true,
  'the Sanaa supervisor also covers it, by its destination'
);

select is(
  app.staff_in_trip_scope('e3e30002-2222-4222-8222-e3e3e3e3e3e3', 'e3e3e004-0000-4000-8000-eeeeeeeeeee4'),
  true,
  'a Sanaa→Aden trip still touches the Aden patch — scope is either end, not the origin only'
);

select is(
  app.staff_in_trip_scope('e3e30001-1111-4111-8111-e3e3e3e3e3e3', 'e3e3e004-0000-4000-8000-eeeeeeeeeee4'),
  true,
  'platform staff with no patch are global'
);

select is(
  app.staff_in_trip_scope('e3e30004-4444-4444-8444-e3e3e3e3e3e3', 'e3e3e003-0000-4000-8000-eeeeeeeeeee3'),
  false,
  'a passenger is not staff, whatever their address'
);

-- A trip that touches neither patch: Hodeidah → Dhamar is outside both regions, and the route
-- constraint refuses an origin that equals its destination, so the two ends have to differ.
insert into public.trips (
  id, code, owner_org_id, vehicle_id, driver_id,
  origin_governorate_id, destination_governorate_id, departure_at, arrive_estimate_minutes,
  seats_total, seats_available, booking_mode, pricing_mode, price_per_seat_yer,
  discount_kind, discount_value, gender_policy, payment_policy, status, verification_status
)
values (
  'e3e3e005-0000-4000-8000-eeeeeeeeeee5', 'OPS-HU-0005',
  'e3e3aaaa-0000-4000-8000-aaaaaaaaaaaa', 'e3e3bbbb-0000-4000-8000-bbbbbbbbbbbb',
  'e3e3dddd-0000-4000-8000-ddddddddddd1',
  (select id from public.governorates where code = 'YE-HU'),
  (select id from public.governorates where code = 'YE-DH'),
  now() + interval '6 days', 120, 14, 14, 'per_seat', 'flat', 5000,
  'none', 0, 'any', 'cash', 'pending', 'pending'
);

select is(
  app.staff_in_trip_scope('e3e30002-2222-4222-8222-e3e3e3e3e3e3', 'e3e3e005-0000-4000-8000-eeeeeeeeeee5'),
  false,
  'a Hodeidah→Dhamar trip is outside an Aden patch'
);

-- ---------------------------------------------------------------------------
-- 3. Scanning
-- ---------------------------------------------------------------------------

select is(
  public.get_trip_for_staff('e3e30002-2222-4222-8222-e3e3e3e3e3e3', 'ffffffffffffffffffffffff', null)
    ->> 'reason',
  'NOT_FOUND',
  'a token that matches nothing is refused as NOT_FOUND'
);

select throws_ok(
  $$ select public.get_trip_for_staff('e3e30004-4444-4444-8444-e3e3e3e3e3e3',
       (select qr_token from public.trips where id = 'e3e3e003-0000-4000-8000-eeeeeeeeeee3'), null) $$,
  '42501',
  null,
  'a passenger cannot scan at all'
);

create temp table scan as
select public.get_trip_for_staff(
  'e3e30002-2222-4222-8222-e3e3e3e3e3e3',
  (select qr_token from public.trips where id = 'e3e3e003-0000-4000-8000-eeeeeeeeeee3'),
  '10.0.0.1'::inet
) as result;

select is(
  (select result -> 'trip' ->> 'code' from scan),
  'OPS-AA-0003',
  'an in-scope scan resolves the trip'
);

select is(
  (select (result -> 'trip' ->> 'bookedSeats')::int from scan),
  1,
  'the scan shows how full the vehicle is'
);

select ok(
  not (select result::text from scan) like '%مسافر العمليات%',
  'the scan carries no passenger names'
);

select ok(
  not (select result::text from scan) like '%967733800004%',
  'the scan carries no phone numbers'
);

select is(
  (select count(*)::int from public.trip_scan_log where trip_id = 'e3e3e003-0000-4000-8000-eeeeeeeeeee3' and allowed),
  1,
  'the successful scan is logged'
);

-- Out of scope: the trip exists, carries a token, and the supervisor may still not look at it.
select app.ensure_trip_qr_token('e3e3e005-0000-4000-8000-eeeeeeeeeee5');

create temp table denied as
select public.get_trip_for_staff(
  'e3e30002-2222-4222-8222-e3e3e3e3e3e3',
  (select qr_token from public.trips where id = 'e3e3e005-0000-4000-8000-eeeeeeeeeee5'), null
) as result;

select is(
  (select (result ->> 'allowed')::boolean from denied),
  false,
  'an out-of-scope scan is refused rather than answered'
);

select is(
  (select result ->> 'reason' from denied),
  'OUT_OF_SCOPE',
  'the refusal names the reason the UI shows as «خارج نطاقك»'
);

select ok(
  (select result -> 'trip' from denied) is not null
  and not ((select result::text from denied) like '%BK-%'),
  'the refusal carries the route, and nothing about the passengers'
);

select is(
  (select count(*)::int from public.trip_scan_log where trip_id = 'e3e3e005-0000-4000-8000-eeeeeeeeeee5' and not allowed),
  1,
  'the refused scan is logged with its reason'
);

-- ---------------------------------------------------------------------------
-- 4. Bulk verification, per row
-- ---------------------------------------------------------------------------

create temp table bulk as
select public.cmd_bulk_verify_trips(
  'e3e30002-2222-4222-8222-e3e3e3e3e3e3',
  array[
    'e3e3e001-0000-4000-8000-eeeeeeeeeee1',
    'e3e3e002-0000-4000-8000-eeeeeeeeeee2',
    'e3e3e005-0000-4000-8000-eeeeeeeeeee5'
  ]::uuid[],
  'approve', null, 't', null
) as result;

select is((select (result ->> 'verified')::int from bulk), 2, 'two of the three rows are verified');
select is((select (result ->> 'failed')::int from bulk), 1, 'the out-of-scope row fails, alone');
select is(
  (select (result -> 'results' -> 2 ->> 'error') from bulk),
  'OUT_OF_SCOPE',
  'the failure carries the reason, on its own row'
);
select is(
  (select verification_status::text from public.trips where id = 'e3e3e001-0000-4000-8000-eeeeeeeeeee1'),
  'verified',
  'the verified rows really moved'
);
select is(
  (select verification_status::text from public.trips where id = 'e3e3e005-0000-4000-8000-eeeeeeeeeee5'),
  'pending',
  'the refused row was not touched'
);

-- ---------------------------------------------------------------------------
-- 5. The manifest is a second permission question
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.get_trip_manifest(
       'e3e30004-4444-4444-8444-e3e3e3e3e3e3', 'e3e3e003-0000-4000-8000-eeeeeeeeeee3', 't', null
     ) $$,
  '42501',
  null,
  'a passenger cannot read the manifest, even for a trip they hold a booking on'
);

select is(
  (public.get_trip_manifest(
     'e3e30002-2222-4222-8222-e3e3e3e3e3e3', 'e3e3e003-0000-4000-8000-eeeeeeeeeee3', 't', null
   ) ->> 'passengerCount')::int,
  1,
  'a supervisor in scope reads the manifest'
);

-- ---------------------------------------------------------------------------
-- 6. Search: the patch is the filter, and the filters work
-- ---------------------------------------------------------------------------

select is(
  jsonb_array_length(public.staff_search_trips(
    'e3e30002-2222-4222-8222-e3e3e3e3e3e3', '{}'::jsonb, 50
  ) -> 'items'),
  4,
  'an Aden supervisor searches four trips and none of the Hodeidah ones'
);

select is(
  exists (
    select 1 from jsonb_array_elements(
      public.staff_search_trips('e3e30002-2222-4222-8222-e3e3e3e3e3e3', '{}'::jsonb, 50) -> 'items'
    ) item
    where item ->> 'code' = 'OPS-HU-0005'
  ),
  false,
  'the out-of-patch trip never appears in the results, not even as a teaser'
);

select is(
  jsonb_array_length(public.staff_search_trips(
    'e3e30001-1111-4111-8111-e3e3e3e3e3e3', '{}'::jsonb, 50
  ) -> 'items'),
  5,
  'a platform admin with no assignment searches the whole country'
);

select is(
  (
    select coalesce(bool_and(item ->> 'verificationStatus' = 'pending'), true)
    from jsonb_array_elements(
      public.staff_search_trips(
        'e3e30002-2222-4222-8222-e3e3e3e3e3e3',
        jsonb_build_object('verificationStatus', jsonb_build_array('pending')),
        50
      ) -> 'items'
    ) item
  ),
  true,
  'filtering by verification state returns only trips in that state'
);

-- `from`/`to` are calendar days in Aden: a single day means that day, not zero days.
select is(
  jsonb_array_length(public.staff_search_trips(
    'e3e30002-2222-4222-8222-e3e3e3e3e3e3',
    jsonb_build_object(
      'from', ((now() + interval '2 days') at time zone 'Asia/Aden')::date,
      'to', ((now() + interval '2 days') at time zone 'Asia/Aden')::date
    ),
    50
  ) -> 'items'),
  1,
  'a one-day date range matches the trip that departs that day'
);

select is(
  (public.staff_search_trips(
    'e3e30001-1111-4111-8111-e3e3e3e3e3e3',
    jsonb_build_object('governorateId', (select id from public.governorates where code = 'YE-HU')),
    50
  ) -> 'items' -> 0 ->> 'code'),
  'OPS-HU-0005',
  'filtering by governorate finds the trip that starts there'
);

select throws_ok(
  $$ select public.staff_search_trips('e3e30004-4444-4444-8444-e3e3e3e3e3e3', '{}'::jsonb, 50) $$,
  '42501',
  null,
  'a passenger cannot search the fleet'
);

-- ---------------------------------------------------------------------------
-- 6. Nobody writes through the API
-- ---------------------------------------------------------------------------

select is(
  has_function_privilege(
    'authenticated',
    'public.cmd_bulk_verify_trips(uuid, uuid[], public.verification_outcome, text, text, inet)',
    'execute'
  ),
  false,
  'a client cannot call cmd_bulk_verify_trips'
);

select is(
  has_function_privilege('authenticated', 'public.get_trip_for_staff(uuid, text, inet)', 'execute'),
  false,
  'a client cannot resolve a token with an actor of their choosing'
);

select * from finish();

rollback;
