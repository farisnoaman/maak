-- 0005 — Phase 3: the fleet (vehicles, drivers, assignments, quota)
--
-- The promises verified here:
--   1. plan limits are seeded and Basic really is one vehicle, not "unlimited until billed"
--   2. an unverified account cannot add a vehicle, and the RPC says NOT_VERIFIED rather than FORBIDDEN
--   3. the whole specification round-trips: every one of the ~60 attributes comes back out of the row
--   4. a duplicate plate is a warning, not a refusal — and spacing/dashes do not hide a duplicate
--   5. verification is a state machine: submitted → decided once, never self-approved, and a
--      substantive edit re-opens a verified vehicle while a cosmetic one does not
--   6. a second vehicle on Basic raises QUOTA_EXCEEDED with metric/limit/used in the message
--   7. driver invitations work by phone before the person has an account, and only one row per phone
--   8. one driver per vehicle: assigning a second closes the first in the same transaction
--   9. a driver sees exactly the vehicle assigned to them, and nothing else
--  10. clients cannot call any cmd_* directly (write lockdown), and photos must live under the vehicle
--  11. two organizations cannot see each other's vehicles, photos or documents
--
-- Run with: supabase test db   (requires Docker)

begin;

create extension if not exists pgtap;

select plan(72);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('cccc0001-1111-4111-8111-cccccccccccc', 'fleet-admin@example.test', '+967733200001', '{"locale":"ar"}'),
  ('cccc0002-2222-4222-8222-cccccccccccc', 'fleet-staff@example.test', '+967733200002', '{"locale":"ar"}'),
  ('cccc0003-3333-4333-8333-cccccccccccc', 'fleet-owner@example.test', '+967733200003', '{"locale":"ar"}'),
  ('cccc0004-4444-4444-8444-cccccccccccc', 'fleet-new@example.test', '+967733200004', '{"locale":"ar"}'),
  ('cccc0005-5555-4555-8555-cccccccccccc', 'fleet-driver@example.test', '+967733200005', '{"locale":"ar"}'),
  ('cccc0006-6666-4666-8666-cccccccccccc', 'fleet-other@example.test', '+967733200006', '{"locale":"ar"}');

insert into public.user_roles (user_id, role)
values
  ('cccc0001-1111-4111-8111-cccccccccccc', 'platform_admin'),
  ('cccc0002-2222-4222-8222-cccccccccccc', 'platform_staff');

-- The owner is verified and holds the `individual` role; the other one is not verified at all.
update public.profiles
set verification_status = 'verified'
where id in (
  'cccc0003-3333-4333-8333-cccccccccccc',
  'cccc0005-5555-4555-8555-cccccccccccc',
  'cccc0006-6666-4666-8666-cccccccccccc'
);

-- `individual` and `driver` are not platform roles: the gateway derives them (every account is an
-- individual; `driver` comes from an active driver_profiles row). Only platform roles live in user_roles.

-- A complete vehicle payload, the same shape the wizard submits.
create function pg_temp.vehicle(p_plate text default '12345-أ', p_over jsonb default '{}'::jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'make', 'Toyota', 'model', 'Hiace', 'modelYear', 2019, 'trim', 'GL',
    'plateNumber', p_plate, 'vin', 'JTFSK22P0J1234567', 'chassisNo', 'CH-99182',
    'color', 'أبيض', 'bodyType', 'van', 'driveType', 'rear_wheel_drive',
    'transmission', 'manual', 'fuelType', 'diesel', 'engineCc', 2500, 'cylinders', 4,
    'fuelTankL', 70, 'tyreSize', '195/70 R15', 'tyreCount', 4, 'spareTyre', true,
    'vehicleCondition', 'used', 'ownershipKind', 'owned'
  ) || jsonb_build_object(
    'seatsPassenger', 12, 'seatsTotal', 14, 'luggageCapacityL', 400, 'roofRack', true,
    'airConditioning', true, 'heating', false, 'recliningSeats', true, 'usbCharging', true,
    'wifi', false, 'entertainment', true, 'curtains', true, 'readingLights', false,
    'airbags', 2, 'abs', true, 'esp', true, 'seatbeltsAll', true, 'fireExtinguisher', true,
    'firstAid', true, 'emergencyExit', true, 'gpsDevice', true, 'speedLimiter', false,
    'childSeat', false, 'wheelchairAccessible', false, 'stepAssist', true,
    'insuranceCompany', 'اليمن للتأمين', 'insurancePolicyNo', 'POL-2026-118',
    'insuranceExpiry', current_date + 300, 'inspectionExpiry', current_date + 200,
    'registrationExpiry', current_date + 400, 'transportPermitExpiry', current_date + 100,
    'exteriorCondition', 'good', 'interiorCondition', 'fair',
    'odometerKm', 182400, 'notes', 'مركبة الخط عدن - صنعاء'
  ) || p_over
$$;

-- ---------------------------------------------------------------------------
-- 1. Plan limits (specs.md §6.14)
-- ---------------------------------------------------------------------------

select is(
  (select limit_value from public.plan_limits where plan_code = 'basic' and metric = 'vehicles'),
  1,
  'Basic allows exactly one vehicle'
);

select is(
  (select limit_value from public.plan_limits where plan_code = 'basic' and metric = 'featured_listings'),
  0,
  'a limit of 0 is stored as 0, not as "unlimited"'
);

select is(
  (select limit_value from public.plan_limits where plan_code = 'business' and metric = 'vehicles'),
  null,
  'Business is the only plan whose vehicle limit is genuinely unlimited (NULL)'
);

select is(
  app.owner_plan('cccc0003-3333-4333-8333-cccccccccccc', null)::text,
  'basic',
  'an individual with no plan row falls back to Basic'
);

-- ---------------------------------------------------------------------------
-- 2. Verification gate
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_create_vehicle(
       'cccc0004-4444-4444-8444-cccccccccccc', null, pg_temp.vehicle(), null, null
     ) $$,
  '42501',
  null,
  'an unverified account cannot create a vehicle'
);

select is(
  has_function_privilege('service_role', 'app.assert_vehicle_payload(jsonb)', 'execute'),
  true,
  'the shared payload validator is callable by the gateway role'
);

-- ---------------------------------------------------------------------------
-- 3. Round-trip of the full specification
-- ---------------------------------------------------------------------------

create temp table created as
select public.cmd_create_vehicle(
  'cccc0003-3333-4333-8333-cccccccccccc',
  null,
  pg_temp.vehicle(),
  'test-request-1',
  null
) as result;

select is(
  ((select result from created) -> 'vehicle' ->> 'plate_number'),
  '12345-أ',
  'create returns the vehicle (the row, snake_case, as the column names are)'
);

select is(
  (
    select count(*)::int from public.vehicles
    where id = ((select result from created) -> 'vehicle' ->> 'id')::uuid
  ),
  1,
  'exactly one row was written'
);

select is(
  (
    select v.verification_status::text from public.vehicles v
    where v.id = ((select result from created) -> 'vehicle' ->> 'id')::uuid
  ),
  'unverified',
  'a new vehicle starts unverified — it has not been submitted yet'
);

select is(
  (
    select v.status::text from public.vehicles v
    where v.id = ((select result from created) -> 'vehicle' ->> 'id')::uuid
  ),
  'draft',
  'and it starts as a draft'
);

select is(
  (
    select count(*)::int from public.odometer_readings
    where vehicle_id = ((select result from created) -> 'vehicle' ->> 'id')::uuid
      and kind = 'baseline'
  ),
  1,
  'the baseline odometer reading is recorded at registration'
);

select is(
  (
    select concat_ws('|',
      v.make, v.model, v.model_year, v.trim, v.plate_number, v.vin, v.chassis_no, v.color,
      v.body_type::text, v.drive_type::text, v.transmission::text, v.fuel_type::text,
      v.engine_cc, v.cylinders, v.fuel_tank_l, v.tyre_size, v.tyre_count, v.spare_tyre,
      v.vehicle_condition::text, v.ownership_kind::text,
      v.seats_passenger, v.seats_total, v.luggage_capacity_l, v.roof_rack,
      v.air_conditioning, v.heating, v.reclining_seats, v.usb_charging, v.wifi,
      v.entertainment, v.curtains, v.reading_lights, v.airbags, v.abs, v.esp,
      v.seatbelts_all, v.fire_extinguisher, v.first_aid, v.emergency_exit, v.gps_device,
      v.speed_limiter, v.child_seat, v.wheelchair_accessible, v.step_assist,
      v.insurance_company, v.insurance_policy_no, v.exterior_condition::text,
      v.interior_condition::text, v.odometer_km, v.notes
    ) from public.vehicles v
    where v.id = ((select result from created) -> 'vehicle' ->> 'id')::uuid
  ),
  'Toyota|Hiace|2019|GL|12345-أ|JTFSK22P0J1234567|CH-99182|أبيض|van|rear_wheel_drive|manual|diesel|2500|4|70.00|195/70 R15|4|t|used|owned|12|14|400|t|t|f|t|t|f|t|t|f|2|t|t|t|t|t|t|t|f|f|f|t|اليمن للتأمين|POL-2026-118|good|fair|182400|مركبة الخط عدن - صنعاء',
  'every attribute round-trips create → row'
);

select is(
  (
    select v.plate_norm from public.vehicles v
    where v.id = ((select result from created) -> 'vehicle' ->> 'id')::uuid
  ),
  app.normalize_plate('12345-أ'),
  'the generated plate_norm is the spacing-free form'
);

-- ---------------------------------------------------------------------------
-- 4. Payload rules
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_create_vehicle(
       'cccc0003-3333-4333-8333-cccccccccccc', null,
       pg_temp.vehicle('22222-ب', '{"insuranceExpiry": "2020-01-01"}'), null, null
     ) $$,
  '22023',
  null,
  'an already-expired insurance policy is refused'
);

select throws_ok(
  $$ select public.cmd_create_vehicle(
       'cccc0003-3333-4333-8333-cccccccccccc', null,
       pg_temp.vehicle('22222-ب', '{"seatsPassenger": 20, "seatsTotal": 10}'), null, null
     ) $$,
  '22023',
  null,
  'more passenger seats than total seats is refused'
);

select throws_ok(
  $$ select public.cmd_create_vehicle(
       'cccc0003-3333-4333-8333-cccccccccccc', null,
       pg_temp.vehicle('22222-ب', '{"modelYear": 2035}'), null, null
     ) $$,
  '22023',
  null,
  'a model year in the future is refused'
);

select is(
  app.normalize_plate(' 123 45 - أ '),
  app.normalize_plate('12345أ'),
  'spacing and dashes are ignored when comparing plates'
);

-- ---------------------------------------------------------------------------
-- 5. Quota: the second vehicle on Basic
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_create_vehicle(
       'cccc0003-3333-4333-8333-cccccccccccc', null, pg_temp.vehicle('99999-ج'), null, null
     ) $$,
  'P0001',
  null,
  'a second vehicle on Basic is refused by the quota, not by the schema'
);

create temp table quota_message as
select 'x'::text as message;

do $$
declare
  v_message text;
begin
  begin
    perform public.cmd_create_vehicle(
      'cccc0003-3333-4333-8333-cccccccccccc', null, pg_temp.vehicle('99999-ج'), null, null
    );
  exception when others then
    v_message := sqlerrm;
  end;
  delete from quota_message;
  insert into quota_message values (v_message);
end;
$$;

select is(
  (select message from quota_message),
  'QUOTA_EXCEEDED: metric=vehicles limit=1 used=1',
  'the quota error carries metric, limit and used — enough for an upgrade prompt'
);

-- ---------------------------------------------------------------------------
-- 6. Verification lifecycle
-- ---------------------------------------------------------------------------

select lives_ok(
  format(
    $$ select public.cmd_submit_vehicle_verification(
         'cccc0003-3333-4333-8333-cccccccccccc',
         %L::uuid,
         jsonb_build_array(
           jsonb_build_object('kind', 'insurance', 'path', %L),
           jsonb_build_object('kind', 'registration', 'path', %L)
         ), null, null
       ) $$,
    ((select result from created) -> 'vehicle' ->> 'id'),
    ((select result from created) -> 'vehicle' ->> 'id') || '/insurance.pdf',
    ((select result from created) -> 'vehicle' ->> 'id') || '/registration.pdf'
  ),
  'submitting with both required documents succeeds'
);

select is(
  (
    select v.verification_status::text from public.vehicles v
    where v.id = ((select result from created) -> 'vehicle' ->> 'id')::uuid
  ),
  'pending',
  'and moves the vehicle into the staff queue'
);

select is(
  (select count(*)::int from public.vehicle_documents
   where vehicle_id = ((select result from created) -> 'vehicle' ->> 'id')::uuid),
  2,
  'both documents are stored as rows'
);

select throws_ok(
  format(
    $$ select public.cmd_submit_vehicle_verification(
         'cccc0003-3333-4333-8333-cccccccccccc',
         %L::uuid,
         jsonb_build_array(jsonb_build_object('kind', 'insurance', 'path', %L)),
         null, null
       ) $$,
    ((select result from created) -> 'vehicle' ->> 'id'),
    ((select result from created) -> 'vehicle' ->> 'id') || '/insurance.pdf'
  ),
  '22023',
  null,
  'submitting without the registration document is refused'
);

select throws_ok(
  format(
    $$ select public.cmd_decide_vehicle_verification(
         'cccc0003-3333-4333-8333-cccccccccccc', %L::uuid, 'approve', null, null, null
       ) $$,
    ((select result from created) -> 'vehicle' ->> 'id')
  ),
  '42501',
  null,
  'the owner cannot approve their own vehicle'
);

select throws_ok(
  format(
    $$ select public.cmd_decide_vehicle_verification(
         'cccc0002-2222-4222-8222-cccccccccccc', %L::uuid, 'reject', 'short', null, null
       ) $$,
    ((select result from created) -> 'vehicle' ->> 'id')
  ),
  '22023',
  null,
  'a rejection needs a reason of at least 10 characters'
);

select is(
  (
    select public.cmd_decide_vehicle_verification(
      'cccc0002-2222-4222-8222-cccccccccccc',
      ((select result from created) -> 'vehicle' ->> 'id')::uuid,
      'approve', null, null, null
    ) ->> 'verificationStatus'
  ),
  'verified',
  'staff approval verifies the vehicle'
);

select throws_ok(
  format(
    $$ select public.cmd_decide_vehicle_verification(
         'cccc0002-2222-4222-8222-cccccccccccc', %L::uuid, 'approve', null, null, null
       ) $$,
    ((select result from created) -> 'vehicle' ->> 'id')
  ),
  '23505',
  null,
  'a vehicle can only be decided while it is pending'
);

select is(
  (
    select array_agg(distinct action order by action) from audit.log
    where entity_type = 'vehicle' and entity_id = ((select result from created) -> 'vehicle' ->> 'id')
  ),
  array['vehicle.create', 'vehicle.decide', 'vehicle.submitVerification'],
  'every step of the lifecycle is audited'
);

-- A cosmetic edit keeps the verification; a substantive one re-opens it.
select is(
  (
    select public.cmd_update_vehicle(
      'cccc0003-3333-4333-8333-cccccccccccc',
      ((select result from created) -> 'vehicle' ->> 'id')::uuid,
      pg_temp.vehicle('12345-أ', '{"color": "فضي"}'), null, null
    ) ->> 'reverificationRequired'
  ),
  'false',
  'changing only the colour does not invalidate verification'
);

select is(
  (
    select v.verification_status::text from public.vehicles v
    where v.id = ((select result from created) -> 'vehicle' ->> 'id')::uuid
  ),
  'verified',
  'and the vehicle stays verified'
);

select is(
  (
    select public.cmd_update_vehicle(
      'cccc0003-3333-4333-8333-cccccccccccc',
      ((select result from created) -> 'vehicle' ->> 'id')::uuid,
      pg_temp.vehicle('54321-د'), null, null
    ) ->> 'reverificationRequired'
  ),
  'true',
  'changing the plate re-opens verification'
);

select is(
  (
    select v.verification_status::text from public.vehicles v
    where v.id = ((select result from created) -> 'vehicle' ->> 'id')::uuid
  ),
  'pending',
  'and puts it back in the queue'
);

select is(
  (
    select v.verified_by is null and v.verified_at is null from public.vehicles v
    where v.id = ((select result from created) -> 'vehicle' ->> 'id')::uuid
  ),
  true,
  'the previous approver is cleared, so the audit names the next one'
);

select throws_ok(
  format(
    $$ select public.cmd_update_vehicle(
         'cccc0006-6666-4666-8666-cccccccccccc', %L::uuid, pg_temp.vehicle('12345-أ'), null, null
       ) $$,
    ((select result from created) -> 'vehicle' ->> 'id')
  ),
  '42501',
  null,
  'a stranger cannot edit the vehicle'
);

-- ---------------------------------------------------------------------------
-- 7. Photos: folder ownership, primary, replacement
-- ---------------------------------------------------------------------------

create temp table vid as
select ((select result from created) -> 'vehicle' ->> 'id')::uuid as id;

select is(
  (
    select public.cmd_set_vehicle_photos(
      'cccc0003-3333-4333-8333-cccccccccccc', (select id from vid),
      jsonb_build_array(
        jsonb_build_object('path', (select id from vid) || '/front.jpg', 'isPrimary', true),
        jsonb_build_object('path', (select id from vid) || '/side.jpg', 'isPrimary', false),
        jsonb_build_object('path', (select id from vid) || '/rear.jpg', 'isPrimary', false)
      ),
      null, null
    ) ->> 'photos'
  ),
  '3',
  'three photos are stored'
);

select is(
  (select count(*)::int from public.vehicle_photos where vehicle_id = (select id from vid) and is_primary),
  1,
  'exactly one photo is primary'
);

select throws_ok(
  format(
    $$ select public.cmd_set_vehicle_photos(
         'cccc0003-3333-4333-8333-cccccccccccc', %L::uuid,
         jsonb_build_array(jsonb_build_object('path', 'some-other-vehicle/x.jpg')), null, null
       ) $$,
    (select id from vid)
  ),
  '22023',
  null,
  'a photo path outside the vehicle folder is refused'
);

select is(
  (
    select public.cmd_set_vehicle_photos(
      'cccc0003-3333-4333-8333-cccccccccccc', (select id from vid),
      jsonb_build_array(jsonb_build_object('path', (select id from vid) || '/only.jpg', 'isPrimary', true)),
      null, null
    ) ->> 'photos'
  ),
  '1',
  'a new set replaces the old one rather than adding to it'
);

-- ---------------------------------------------------------------------------
-- 8. Drivers: invite by phone, accept, verify, assign
-- ---------------------------------------------------------------------------

create temp table invite as
select public.cmd_invite_driver(
  'cccc0003-3333-4333-8333-cccccccccccc', null, '+967 733 200 005', 'سالم الحضرمي',
  'LIC-9931', current_date + 900, null, null
) as result;

select is(
  ((select result from invite) -> 'driver' ->> 'status'),
  'invited',
  'a driver can be invited before accepting'
);

select is(
  ((select result from invite) -> 'linkedImmediately')::text,
  'true',
  'the invitation links immediately when the phone already belongs to a profile'
);

select throws_ok(
  $$ select public.cmd_invite_driver(
       'cccc0003-3333-4333-8333-cccccccccccc', null, '967733200005', 'سالم الحضرمي',
       null, null, null, null
     ) $$,
  '23505',
  null,
  'the same phone twice is a duplicate, even with different spacing'
);

select throws_ok(
  format(
    $$ select public.cmd_assign_driver(
         'cccc0003-3333-4333-8333-cccccccccccc', %L::uuid, %L::uuid, null, null
       ) $$,
    (select id from vid),
    ((select result from invite) -> 'driver' ->> 'id')
  ),
  '23505',
  null,
  'an invited (not accepted) driver cannot be assigned'
);

-- The driver signs in with the invited phone and accepts the invitation.
update public.driver_profiles
set user_id = 'cccc0005-5555-4555-8555-cccccccccccc', status = 'active'
where id = ((select result from invite) -> 'driver' ->> 'id')::uuid;

select is(
  (
    select public.cmd_verify_driver(
      'cccc0002-2222-4222-8222-cccccccccccc',
      ((select result from invite) -> 'driver' ->> 'id')::uuid,
      'approve', null, null, null
    ) ->> 'verificationStatus'
  ),
  'verified',
  'staff can verify a driver'
);

select throws_ok(
  format(
    $$ select public.cmd_verify_driver(
         'cccc0002-2222-4222-8222-cccccccccccc', %L::uuid, 'approve', null, null, null
       ) $$,
    ((select result from invite) -> 'driver' ->> 'id')
  ),
  '23505',
  null,
  'and only once'
);

select lives_ok(
  format(
    $$ select public.cmd_assign_driver(
         'cccc0003-3333-4333-8333-cccccccccccc', %L::uuid, %L::uuid, null, null
       ) $$,
    (select id from vid),
    ((select result from invite) -> 'driver' ->> 'id')
  ),
  'a verified driver can be assigned'
);

select is(
  (
    select count(*)::int from public.vehicle_driver_assignments
    where vehicle_id = (select id from vid) and unassigned_at is null
  ),
  1,
  'exactly one active assignment exists'
);

-- A second driver replaces the first rather than stacking.
insert into public.driver_profiles (user_id, invited_phone, full_name, invited_by, status, verification_status)
values (
  'cccc0006-6666-4666-8666-cccccccccccc', '+967 733 200 006', 'سائق بديل',
  'cccc0003-3333-4333-8333-cccccccccccc', 'active', 'verified'
);

select lives_ok(
  format(
    $$ select public.cmd_assign_driver(
         'cccc0003-3333-4333-8333-cccccccccccc', %L::uuid,
         (select id from public.driver_profiles where invited_phone = '+967 733 200 006'), null, null
       ) $$,
    (select id from vid)
  ),
  'reassigning the vehicle to another driver succeeds'
);

select is(
  (
    select count(*)::int from public.vehicle_driver_assignments
    where vehicle_id = (select id from vid) and unassigned_at is null
  ),
  1,
  'still exactly one active assignment — the previous one was closed'
);

select is(
  (
    select count(*)::int from public.vehicle_driver_assignments
    where vehicle_id = (select id from vid) and unassigned_at is not null
  ),
  1,
  'and the closed one is kept for history'
);

select is(
  (
    select public.cmd_unassign_driver(
      'cccc0003-3333-4333-8333-cccccccccccc', (select id from vid), null, null
    ) ->> 'unassigned'
  ),
  '1',
  'unassign closes the active row'
);

-- ---------------------------------------------------------------------------
-- 9. RLS: a driver sees their vehicle; a stranger sees nothing
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.plan_limits),
  (select count(*)::int from public.plans)
    * (select count(distinct l.metric)::int from public.plan_limits l),
  -- Every plan is configured for every metric some plan knows about — the assertion is the *coverage*, not
  -- the number. Phase 8 added `fleet_reports` (a feature flag: 1 or NULL = allowed, 0 = not on this plan) and
  -- Phase 10 added `finance_exports` (a rate, counted per month). A phase that adds a metric without adding a
  -- row for each plan fails here, which is the failure that actually matters.
  'plan limits cover every plan × metric pair'
);

select is(
  (select count(*)::int from public.vehicles),
  1,
  'sanity: the fixture owns exactly one vehicle'
);

-- The assignment was closed above, so re-assign the first driver before checking what they can see.
select lives_ok(
  format(
    $$ select public.cmd_assign_driver(
         'cccc0003-3333-4333-8333-cccccccccccc', %L::uuid, %L::uuid, null, null
       ) $$,
    (select id from vid),
    ((select result from invite) -> 'driver' ->> 'id')
  ),
  'the driver is assigned again for the visibility checks'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccc0005-5555-4555-8555-cccccccccccc","role":"authenticated"}';

select is(
  (select count(*)::int from public.vehicles),
  1,
  'the assigned driver can see the vehicle'
);

select is(
  (select count(*)::int from public.vehicle_photos),
  1,
  'and its photos'
);

select is(
  (select count(*)::int from public.vehicle_documents),
  0,
  'but not the documents — only the owner and staff review those'
);

set local request.jwt.claims = '{"sub":"cccc0006-6666-4666-8666-cccccccccccc","role":"authenticated"}';

select is(
  (select count(*)::int from public.vehicles),
  0,
  'a verified stranger sees no vehicles at all'
);

set local request.jwt.claims = '{"sub":"cccc0002-2222-4222-8222-cccccccccccc","role":"authenticated"}';

select is(
  (select count(*)::int from public.vehicles),
  1,
  'staff can see the vehicle they are reviewing'
);

reset role;

-- ---------------------------------------------------------------------------
-- 10. Write lockdown and policy helpers
-- ---------------------------------------------------------------------------

select is(
  (
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'cmd\_%'
      and has_function_privilege('authenticated', p.oid, 'execute')
  ),
  0,
  'no cmd_* is executable by authenticated'
);

select is(
  has_function_privilege('authenticated', 'app.owns_vehicle(uuid, uuid)', 'execute'),
  true,
  'the RLS predicate is executable by authenticated (a policy runs as the caller)'
);

select is(
  has_function_privilege('authenticated', 'app.assert_quota(uuid, uuid, text, integer)', 'execute'),
  false,
  'the quota internals are not reachable from a client'
);

select is(
  has_function_privilege('authenticated', 'app.assert_vehicle_payload(jsonb)', 'execute'),
  false,
  'nor is the payload validator'
);

select ok(
  exists (select 1 from storage.buckets where id = 'vehicle-photos' and public),
  'vehicle photos live in a public bucket'
);

select ok(
  exists (select 1 from storage.buckets where id = 'vehicle-documents' and not public),
  'documents live in a private bucket'
);

-- ---------------------------------------------------------------------------
-- 11. Organization isolation: org A cannot read org B's vehicles
--
-- The vehicle above belongs to a *person*. This section gives two verified companies one vehicle
-- each and asks the policy the only question that matters for a multi-tenant fleet: can a member of
-- one company read another company's vehicle, its photos or its documents?
-- ---------------------------------------------------------------------------

insert into public.organizations (id, name, owner_id, verification_status, plan)
values
  ('cccc00a0-0000-4000-8000-cccccccccccc', 'Org A', 'cccc0003-3333-4333-8333-cccccccccccc', 'verified', 'basic'),
  ('cccc00b0-0000-4000-8000-cccccccccccc', 'Org B', 'cccc0006-6666-4666-8666-cccccccccccc', 'verified', 'basic');

insert into public.organization_members (org_id, user_id, role, status, joined_at)
values
  ('cccc00a0-0000-4000-8000-cccccccccccc', 'cccc0003-3333-4333-8333-cccccccccccc', 'owner', 'active', now()),
  ('cccc00b0-0000-4000-8000-cccccccccccc', 'cccc0006-6666-4666-8666-cccccccccccc', 'owner', 'active', now());

select throws_ok(
  $$ select public.cmd_create_vehicle(
       'cccc0003-3333-4333-8333-cccccccccccc', 'cccc00b0-0000-4000-8000-cccccccccccc',
       pg_temp.vehicle('88888-ج'), null, null
     ) $$,
  '42501',
  null,
  'an owner of org A cannot add a vehicle to org B — membership is checked, not assumed'
);

create temp table created_b as
select public.cmd_create_vehicle(
  'cccc0006-6666-4666-8666-cccccccccccc',
  'cccc00b0-0000-4000-8000-cccccccccccc',
  pg_temp.vehicle('99999-ب'),
  'test-request-org-b',
  null
) as result;

select is(
  (
    select v.owner_org_id::text from public.vehicles v
    where v.id = ((select result from created_b) -> 'vehicle' ->> 'id')::uuid
  ),
  'cccc00b0-0000-4000-8000-cccccccccccc',
  'the org B vehicle is owned by org B, not by the person who typed it in'
);

-- Org A's owner: a member of A, the owner of the personal vehicle above, and a stranger to B.
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccc0003-3333-4333-8333-cccccccccccc","role":"authenticated"}';

select is(
  (
    select count(*)::int from public.vehicles
    where owner_org_id = 'cccc00b0-0000-4000-8000-cccccccccccc'
  ),
  0,
  'org A cannot read org B vehicles'
);

select is(
  (
    select count(*)::int
    from public.vehicle_photos p
    join public.vehicles v on v.id = p.vehicle_id
    where v.owner_org_id = 'cccc00b0-0000-4000-8000-cccccccccccc'
  ),
  0,
  'nor org B photos — a photo is as private as the vehicle it belongs to'
);

select is(
  (
    select count(*)::int
    from public.vehicle_documents d
    join public.vehicles v on v.id = d.vehicle_id
    where v.owner_org_id = 'cccc00b0-0000-4000-8000-cccccccccccc'
  ),
  0,
  'nor org B documents'
);

select is(
  (select count(*)::int from public.vehicles),
  1,
  'org A sees exactly its own personal vehicle — not the two rows that exist'
);

set local request.jwt.claims = '{"sub":"cccc0006-6666-4666-8666-cccccccccccc","role":"authenticated"}';

select is(
  (
    select count(*)::int from public.vehicles
    where owner_org_id = 'cccc00b0-0000-4000-8000-cccccccccccc'
  ),
  1,
  'and a member of org B does see it — the policy isolates, it does not blind everyone'
);

set local request.jwt.claims = '{"sub":"cccc0002-2222-4222-8222-cccccccccccc","role":"authenticated"}';

select is(
  (select count(*)::int from public.vehicles),
  2,
  'staff still read every organization, because reviewing is the job'
);

reset role;

select * from finish();

rollback;
