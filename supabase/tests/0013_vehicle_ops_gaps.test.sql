-- 0013 — Phase 8.1: the gaps Phase 8 left open
--
-- The promises verified here:
--   1. fuel is measured per trip (from that trip's own odometer readings) and per month (including months
--      with no fills, which must show a zero rather than disappear)
--   2. kilometres per litre is derived from the same segments as litres per 100 km, so they cannot disagree
--   3. a fill can name a station from the directory, and a station that does not exist is refused
--   4. a driver may upload the odometer photograph of the van they drive — and only that folder
--   5. an anomalous fill rings a bell once a week per vehicle, not once per fill
--   6. the printable report is a plan feature: Basic is refused, Pro and Business are not, and the CSV
--      stays free for everybody
--   7. the date-ranged cost ledger the CSV exports reconciles exactly with the rows it was built from
--
-- Run with: supabase test db   (requires Docker), or `npm run sql:check` (embedded Postgres).

begin;

create extension if not exists pgtap;

select plan(41);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('9b9b0001-1111-4111-8111-9b9b9b9b9b9b', 'gaps-basic@example.test', '+967733910001', '{"locale":"ar"}'),
  ('9b9b0002-2222-4222-8222-9b9b9b9b9b9b', 'gaps-pro@example.test', '+967733910002', '{"locale":"ar"}'),
  ('9b9b0003-3333-4333-8333-9b9b9b9b9b9b', 'gaps-driver@example.test', '+967733910003', '{"locale":"ar"}'),
  ('9b9b0004-4444-4444-8444-9b9b9b9b9b9b', 'gaps-other@example.test', '+967733910004', '{"locale":"ar"}');

update public.profiles
set verification_status = 'verified'
where id in (
  '9b9b0001-1111-4111-8111-9b9b9b9b9b9b',
  '9b9b0002-2222-4222-8222-9b9b9b9b9b9b',
  '9b9b0003-3333-4333-8333-9b9b9b9b9b9b',
  '9b9b0004-4444-4444-8444-9b9b9b9b9b9b'
);

-- A Basic organization (no printable report) and a Pro one (yes).
insert into public.organizations (id, name, owner_id, verification_status, plan)
values
  ('9b9baa00-0000-4000-8000-00000000000a', 'Basic Co', '9b9b0001-1111-4111-8111-9b9b9b9b9b9b', 'verified', 'basic'),
  ('9b9baa00-0000-4000-8000-00000000000b', 'Pro Co', '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', 'verified', 'pro');

insert into public.organization_members (org_id, user_id, role, status, joined_at)
values
  ('9b9baa00-0000-4000-8000-00000000000a', '9b9b0001-1111-4111-8111-9b9b9b9b9b9b', 'owner', 'active', now()),
  ('9b9baa00-0000-4000-8000-00000000000b', '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', 'owner', 'active', now());

insert into public.vehicles (
  id, owner_org_id, make, model, model_year, plate_number, plate_governorate_id,
  fuel_type, seats_passenger, seats_total, odometer_km, status, verification_status,
  insurance_expiry, inspection_expiry, registration_expiry, created_by
)
values (
  '9b9bc001-0000-4000-8000-9b9b9b9b9b9b',
  '9b9baa00-0000-4000-8000-00000000000b',
  'Hyundai', 'County', 2021, '9-8101',
  (select id from public.governorates where code = 'YE-AD'),
  'diesel', 25, 26, 88_800, 'active', 'verified',
  current_date + 300, current_date + 200, current_date + 400,
  '9b9b0002-2222-4222-8222-9b9b9b9b9b9b'
);

insert into public.driver_profiles (
  id, user_id, invited_phone, full_name, org_id, invited_by, status, verification_status
)
values (
  '9b9bd001-0000-4000-8000-9b9b9b9b9b9b',
  '9b9b0003-3333-4333-8333-9b9b9b9b9b9b',
  '+967733910003', 'سائق الفجوات',
  '9b9baa00-0000-4000-8000-00000000000b',
  '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', 'active', 'verified'
);

insert into public.vehicle_driver_assignments (vehicle_id, driver_id, assigned_by)
values (
  '9b9bc001-0000-4000-8000-9b9b9b9b9b9b',
  '9b9bd001-0000-4000-8000-9b9b9b9b9b9b',
  '9b9b0002-2222-4222-8222-9b9b9b9b9b9b'
);

-- A station in the directory, so "linked" means a real row rather than free text.
insert into public.places (id, kind, name_ar, name_en, governorate_id, is_public, verification_status,
                           created_by, created_by_org)
values (
  '9b9be001-0000-4000-8000-9b9b9b9b9b9b', 'station', 'محطة الروضة', 'Al Rawdah Station',
  (select id from public.governorates where code = 'YE-AD'),
  true, 'verified', '9b9b0002-2222-4222-8222-9b9b9b9b9b9b',
  '9b9baa00-0000-4000-8000-00000000000b'
);

-- ---------------------------------------------------------------------------
-- 1. Fuel by trip, and by month
-- ---------------------------------------------------------------------------

-- A completed trip whose odometer readings are its own evidence of distance.
insert into public.trips (
  id, code, owner_org_id, vehicle_id, driver_id, status,
  origin_governorate_id, destination_governorate_id, departure_at, arrive_estimate_minutes,
  seats_total, seats_available, booking_mode, pricing_mode, price_per_seat_yer,
  verification_status, started_at, completed_at
)
values (
  '9b9bf001-0000-4000-8000-9b9b9b9b9b9b', 'AD-SA-9B01',
  '9b9baa00-0000-4000-8000-00000000000b',
  '9b9bc001-0000-4000-8000-9b9b9b9b9b9b',
  '9b9bd001-0000-4000-8000-9b9b9b9b9b9b', 'completed',
  (select id from public.governorates where code = 'YE-AD'),
  (select id from public.governorates where code = 'YE-SA'),
  now() - interval '5 days', 480,
  25, 25, 'per_seat', 'flat', 8000, 'verified',
  now() - interval '5 days', now() - interval '4 days'
);

-- The trip leaves at 88 800 and arrives at 90 000; the fills happen between those two readings, in that
-- order, because the odometer guard does not care that a test would find it convenient otherwise.
insert into public.odometer_readings (vehicle_id, reading_km, kind, trip_id, recorded_by)
values
  ('9b9bc001-0000-4000-8000-9b9b9b9b9b9b', 88_800, 'trip_start', '9b9bf001-0000-4000-8000-9b9b9b9b9b9b',
   '9b9b0003-3333-4333-8333-9b9b9b9b9b9b');

-- Two fills attributed to the trip: 60 litres over 1 200 km.
select public.cmd_log_fuel(
  '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b',
  jsonb_build_object(
    'odometerKm', 88_850, 'litres', 30, 'pricePerLitreYer', 500,
    'tripId', '9b9bf001-0000-4000-8000-9b9b9b9b9b9b',
    'stationPlaceId', '9b9be001-0000-4000-8000-9b9b9b9b9b9b',
    'stationName', 'محطة الروضة'
  ),
  'req-gap-1', null
);

insert into public.odometer_readings (vehicle_id, reading_km, kind, trip_id, recorded_by)
values
  ('9b9bc001-0000-4000-8000-9b9b9b9b9b9b', 90_000, 'trip_end', '9b9bf001-0000-4000-8000-9b9b9b9b9b9b',
   '9b9b0003-3333-4333-8333-9b9b9b9b9b9b');

select public.cmd_log_fuel(
  '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b',
  jsonb_build_object(
    'odometerKm', 90_000, 'litres', 30, 'pricePerLitreYer', 500,
    'tripId', '9b9bf001-0000-4000-8000-9b9b9b9b9b9b'
  ),
  'req-gap-2', null
);

select is(
  (select litres from app.trip_fuel('9b9bc001-0000-4000-8000-9b9b9b9b9b9b', 5) limit 1),
  60::numeric,
  'the trip carries the fills attributed to it'
);

select is(
  (select distance_km from app.trip_fuel('9b9bc001-0000-4000-8000-9b9b9b9b9b9b', 5) limit 1),
  1200,
  'and its distance is measured from its own start and end readings, not from the route'
);

select is(
  (select l_per_100km from app.trip_fuel('9b9bc001-0000-4000-8000-9b9b9b9b9b9b', 5) limit 1),
  5.00::numeric,
  '60 litres over 1 200 km is 5.00 L/100km'
);

select is(
  (select cost_yer from app.trip_fuel('9b9bc001-0000-4000-8000-9b9b9b9b9b9b', 5) limit 1),
  30_000::bigint,
  'and the fuel on that trip cost 30 000'
);

select is(
  (select count(*)::int from app.monthly_fuel('9b9bc001-0000-4000-8000-9b9b9b9b9b9b', 3)),
  3,
  'three months are returned, not just the ones with fills'
);

select is(
  (
    select months.fills from app.monthly_fuel('9b9bc001-0000-4000-8000-9b9b9b9b9b9b', 3) months
    where months.month_start = date_trunc('month', (now() at time zone 'Asia/Aden'))::date
  ),
  2,
  'this month holds both fills'
);

select is(
  (
    select months.litres from app.monthly_fuel('9b9bc001-0000-4000-8000-9b9b9b9b9b9b', 3) months
    order by months.month_start desc limit 1
  ),
  60::numeric,
  'and 60 litres'
);

select is(
  (
    select months.distance_km from app.monthly_fuel('9b9bc001-0000-4000-8000-9b9b9b9b9b9b', 3) months
    order by months.month_start desc limit 1
  ),
  1200,
  'the month distance is the span of the readings inside it'
);

select is(
  (
    select months.fills from app.monthly_fuel('9b9bc001-0000-4000-8000-9b9b9b9b9b9b', 3) months
    order by months.month_start asc limit 1
  ),
  0,
  'an empty month is reported, with a zero'
);

-- ---------------------------------------------------------------------------
-- 2. km/L from the same segments
-- ---------------------------------------------------------------------------

-- The newest segment is 1 150 km on the 30 litres filled at its end: 2.61 L/100km, or 38.33 km/L.
select is(
  (
    public.get_vehicle_health(
      '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b'
    ) -> 'fuel' ->> 'recentLPer100Km'
  )::numeric,
  2.61::numeric,
  'the newest segment reads 2.61 L/100km'
);

select is(
  (
    public.get_vehicle_health(
      '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b'
    ) -> 'fuel' ->> 'recentKmPerLitre'
  )::numeric,
  38.33::numeric,
  'and 38.33 km/L — the same tank, the other way up'
);

select is(
  abs(
    (
      public.get_vehicle_health(
        '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b'
      ) -> 'fuel' ->> 'recentLPer100Km'
    )::numeric
    * (
      public.get_vehicle_health(
        '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b'
      ) -> 'fuel' ->> 'recentKmPerLitre'
    )::numeric
    - 100
  ) <= 0.1,
  true,
  'the two figures multiply back to 100, so neither was computed from a different segment'
);

select is(
  (
    public.get_vehicle_health(
      '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b'
    ) -> 'fuel' -> 'monthly'
  ) is not null,
  true,
  'the health card carries the monthly trend'
);

select is(
  jsonb_array_length(
    public.get_vehicle_health(
      '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b'
    ) -> 'fuel' -> 'monthly'
  ),
  6,
  'six months of it'
);

select is(
  jsonb_array_length(
    public.get_vehicle_health(
      '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b'
    ) -> 'fuel' -> 'byTrip'
  ),
  1,
  'and one completed trip'
);

-- A third fill, attributed by the *code* the phone sends rather than by a uuid.
select is(
  (
    public.cmd_log_fuel(
      '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b',
      '{"odometerKm":90100,"litres":10,"pricePerLitreYer":500,"tripCode":"ad-sa-9b01"}'::jsonb,
      null, null
    ) -> 'fuelLog' ->> 'trip_id'
  ),
  '9b9bf001-0000-4000-8000-9b9b9b9b9b9b',
  'a fill may name its trip by the printed code, case-insensitively'
);

select throws_ok(
  $$ select public.cmd_log_fuel(
       '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b',
       '{"odometerKm":90150,"litres":5,"pricePerLitreYer":500,"tripCode":"AD-SA-9999"}'::jsonb,
       null, null
     ) $$,
  'P0002',
  null,
  'a code that is not a trip of this vehicle is refused, not silently dropped'
);

-- ---------------------------------------------------------------------------
-- 3. Station linking
-- ---------------------------------------------------------------------------

select is(
  (
    select f.station_place_id from public.fuel_logs f
    where f.vehicle_id = '9b9bc001-0000-4000-8000-9b9b9b9b9b9b' and f.odometer_km = 88_850
  ),
  '9b9be001-0000-4000-8000-9b9b9b9b9b9b'::uuid,
  'a fill stores the station it was linked to'
);

select throws_ok(
  $$ select public.cmd_log_fuel(
       '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b',
       '{"odometerKm":90200,"litres":10,"pricePerLitreYer":500,
         "stationPlaceId":"00000000-0000-4000-8000-000000000000"}'::jsonb, null, null
     ) $$,
  'P0002',
  null,
  'a station that is not in the directory is refused rather than silently ignored'
);

-- ---------------------------------------------------------------------------
-- 4. The driver's photograph
-- ---------------------------------------------------------------------------

select is(
  (
    select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'vehicle_documents_write_own'
      and with_check like '%odometer%'
  ),
  1,
  'a driver may write into the odometer folder of a vehicle they are assigned'
);

select is(
  (
    select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'vehicle_documents_write_own'
      and with_check like '%owns_vehicle%'
  ),
  1,
  'and the owner may still write anywhere under their vehicle'
);

select is(
  (
    select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'vehicle_documents_write_own'
      and with_check like '%is_assigned_driver%'
  ),
  1,
  'the driver clause is scoped to the assignment, not to the bucket'
);

-- ---------------------------------------------------------------------------
-- 5. The anomaly bell
-- ---------------------------------------------------------------------------

-- A baseline of 5.00 L/100km exists; 30 litres over 200 km is 15 L/100km, three times the average.
select lives_ok(
  $$ select public.cmd_log_fuel(
       '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b',
       '{"odometerKm":90200,"litres":30,"pricePerLitreYer":500,"isFullTank":true}'::jsonb, null, null
     ) $$,
  'an anomalous fill is still recorded'
);

select is(
  (
    select count(*)::int from public.notifications n
    where n.kind = 'vehicle_fuel_anomaly'
      and n.params ->> 'plate' = '9-8101'
  ),
  1,
  'and it rings the bell once'
);

select is(
  (
    select st.last_fuel_anomaly_at is not null
    from public.vehicle_maintenance_status st
    where st.vehicle_id = '9b9bc001-0000-4000-8000-9b9b9b9b9b9b'
  ),
  true,
  'the moment it rang is remembered'
);

-- A second anomaly inside the week: recorded, not repeated.
select public.cmd_log_fuel(
  '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b',
  '{"odometerKm":90400,"litres":30,"pricePerLitreYer":500,"isFullTank":true}'::jsonb, null, null
);

select is(
  (
    select count(*)::int from public.notifications n
    where n.kind = 'vehicle_fuel_anomaly'
  ),
  1,
  'a second bad fill in the same week does not ring it again'
);

select is(
  (
    public.cmd_log_fuel(
      '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b',
      '{"odometerKm":90600,"litres":30,"pricePerLitreYer":500,"isFullTank":true}'::jsonb, null, null
    ) ->> 'anomalyNotified'
  ),
  'false',
  'and the answer says so, rather than pretending it was delivered'
);

-- ---------------------------------------------------------------------------
-- 6. The printable report is a plan feature; the CSV is not
-- ---------------------------------------------------------------------------

select is(
  app.plan_allows(null, '9b9baa00-0000-4000-8000-00000000000a', 'fleet_reports'),
  false,
  'Basic does not include the printable report'
);

select is(
  app.plan_allows(null, '9b9baa00-0000-4000-8000-00000000000b', 'fleet_reports'),
  true,
  'Pro does'
);

select is(
  app.plan_allows(null, null, 'not_a_metric'),
  false,
  'and a metric no plan defines is refused rather than granted by accident'
);

select is(
  app.plan_allows('9b9b0004-4444-4444-8444-9b9b9b9b9b9b', null, 'fleet_reports'),
  false,
  'an individual falls back to Basic, which is refused'
);

-- The session-bound wrapper the report route actually calls.
set local request.jwt.claims =
  '{"sub":"9b9b0002-2222-4222-8222-9b9b9b9b9b9b","role":"authenticated"}';

select is(
  public.fleet_report_access('9b9baa00-0000-4000-8000-00000000000b') ->> 'allowed',
  'true',
  'the Pro owner can open the printable report'
);

select is(
  public.fleet_report_access('9b9baa00-0000-4000-8000-00000000000b') ->> 'csv',
  'true',
  'and the CSV is reported as free alongside it'
);

set local request.jwt.claims =
  '{"sub":"9b9b0001-1111-4111-8111-9b9b9b9b9b9b","role":"authenticated"}';

select is(
  public.fleet_report_access('9b9baa00-0000-4000-8000-00000000000a') ->> 'allowed',
  'false',
  'the Basic owner is refused the printable report'
);

set local request.jwt.claims =
  '{"sub":"9b9b0004-4444-4444-8444-9b9b9b9b9b9b","role":"authenticated"}';

select is(
  public.fleet_report_access('9b9baa00-0000-4000-8000-00000000000a') ->> 'allowed',
  'false',
  'and a stranger reads nothing about somebody else''s plan'
);

-- A service with its invoice attached: the path is stored and the card hands it back, because an invoice
-- nobody can open is not a record, it is a promise.
select is(
  public.cmd_log_maintenance(
    '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b',
    '{"kind":"oil_change","performedOn":"2026-01-15","odometerKm":91000,"costYer":9000,
      "vendor":"ورشة الدائري","note":"زيت وفلاتر",
      "attachmentPath":"9b9bc001-0000-4000-8000-9b9b9b9b9b9b/maintenance/invoice.jpg"}'::jsonb,
    null, null
  ) -> 'record' ->> 'attachment_path',
  '9b9bc001-0000-4000-8000-9b9b9b9b9b9b/maintenance/invoice.jpg',
  'a service records the invoice it was paid against'
);

select is(
  (
    select r ->> 'attachmentPath'
    from jsonb_array_elements(
      public.get_vehicle_health(
        '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9bc001-0000-4000-8000-9b9b9b9b9b9b'
      ) -> 'maintenance' -> 'recentRecords'
    ) r
    where r ->> 'attachmentPath' is not null
    limit 1
  ),
  '9b9bc001-0000-4000-8000-9b9b9b9b9b9b/maintenance/invoice.jpg',
  'and the health card returns the path so the invoice can be opened'
);

-- ---------------------------------------------------------------------------
-- 7. The date-ranged ledger reconciles with the logs
-- ---------------------------------------------------------------------------

-- The whole history, so the window cannot accidentally be the thing under test.
select is(
  (
    select coalesce(sum((row ->> 'amountYer')::bigint), 0)
    from jsonb_array_elements(
      public.fleet_cost_detail(
        '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9baa00-0000-4000-8000-00000000000b',
        '2020-01-01', '2099-12-31'
      ) -> 'rows'
    ) row
  ),
  (
    select coalesce(sum(fl.total_cost_yer), 0) from public.fuel_logs fl
    where fl.vehicle_id = '9b9bc001-0000-4000-8000-9b9b9b9b9b9b'
  ) + (
    select coalesce(sum(mr.cost_yer), 0) from public.maintenance_records mr
    where mr.vehicle_id = '9b9bc001-0000-4000-8000-9b9b9b9b9b9b' and mr.deleted_at is null
  ),
  'the export sums to exactly what the fills and the services add up to'
);

select is(
  public.fleet_cost_detail(
    '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9baa00-0000-4000-8000-00000000000b',
    '2099-12-31', '2020-01-01'
  ) -> 'range' ->> 'from',
  '2020-01-01',
  'a range entered backwards is swapped, not rejected'
);

select is(
  (
    public.fleet_cost_detail(
      '9b9b0002-2222-4222-8222-9b9b9b9b9b9b', '9b9baa00-0000-4000-8000-00000000000b',
      '2020-01-01', '2099-12-31'
    ) -> 'totals' ->> 'rows'
  )::int,
  (
    select count(*)::int from public.fuel_logs fl
    where fl.vehicle_id = '9b9bc001-0000-4000-8000-9b9b9b9b9b9b'
  ) + (
    select count(*)::int from public.maintenance_records mr
    where mr.vehicle_id = '9b9bc001-0000-4000-8000-9b9b9b9b9b9b' and mr.deleted_at is null
  ),
  'one row per fill and per service — nothing is collapsed or double-counted'
);

select throws_ok(
  $$ select public.fleet_cost_detail(
       '9b9b0004-4444-4444-8444-9b9b9b9b9b9b', '9b9baa00-0000-4000-8000-00000000000b',
       '2020-01-01', '2099-12-31'
     ) $$,
  '42501',
  null,
  'and a stranger cannot export another organization''s costs'
);

select * from finish();

rollback;
