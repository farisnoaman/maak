-- 0012 — Phase 8: fuel, maintenance and the money they cost
--
-- The promises verified here:
--   1. a fill advances the odometer, writes a reading, and produces exactly one expense
--   2. tank-to-tank consumption is 8.44 L/100km for 450 km on 38 litres, and partial fills count
--   3. the odometer only goes forward (BR-16) — with one owner override, on the record
--   4. a schedule's due point is generated, and its state is due/soon/overdue from the same function
--      the dashboard, the badge and the trip gate use
--   5. marking a service done moves the due point and clears the alarm
--   6. deleting the source soft-deletes the expense and leaves a reversal marker
--   7. the reminder job notifies once per state change, not once per day
--   8. an overdue vehicle is refused a trip only when the owner asked for that rule
--   9. the rollup reconciles with the rows it summarises, and clients cannot call the writers
--
-- Run with: supabase test db   (requires Docker), or `npm run sql:check` (embedded Postgres).

begin;

create extension if not exists pgtap;

select plan(52);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('8a8a0001-1111-4111-8111-8a8a8a8a8a8a', 'ops-owner@example.test', '+967733900001', '{"locale":"ar"}'),
  ('8a8a0002-2222-4222-8222-8a8a8a8a8a8a', 'ops-staff@example.test', '+967733900002', '{"locale":"ar"}'),
  ('8a8a0003-3333-4333-8333-8a8a8a8a8a8a', 'ops-driver@example.test', '+967733900003', '{"locale":"ar"}'),
  ('8a8a0004-4444-4444-8444-8a8a8a8a8a8a', 'ops-stranger@example.test', '+967733900004', '{"locale":"ar"}');

update public.profiles
set verification_status = 'verified'
where id in (
  '8a8a0001-1111-4111-8111-8a8a8a8a8a8a',
  '8a8a0003-3333-4333-8333-8a8a8a8a8a8a',
  '8a8a0004-4444-4444-8444-8a8a8a8a8a8a'
);

insert into public.user_roles (user_id, role)
values ('8a8a0002-2222-4222-8222-8a8a8a8a8a8a', 'platform_staff');

insert into public.vehicles (
  id, owner_user_id, make, model, model_year, plate_number, plate_governorate_id,
  fuel_type, seats_passenger, seats_total, odometer_km, status, verification_status,
  insurance_expiry, inspection_expiry, registration_expiry, created_by
)
values (
  '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
  '8a8a0001-1111-4111-8111-8a8a8a8a8a8a',
  'Toyota', 'Hiace', 2020, '5-9001',
  (select id from public.governorates where code = 'YE-AD'),
  'diesel', 13, 14, 120000, 'active', 'verified',
  current_date + 300, current_date + 200, current_date + 400,
  '8a8a0001-1111-4111-8111-8a8a8a8a8a8a'
);

insert into public.driver_profiles (
  id, user_id, invited_phone, full_name, invited_by, status, verification_status
)
values (
  '8a8a7001-0000-4000-8000-8a8a8a8a8a8a',
  '8a8a0003-3333-4333-8333-8a8a8a8a8a8a',
  '+967733900003', 'سائق العمليات',
  '8a8a0001-1111-4111-8111-8a8a8a8a8a8a', 'active', 'verified'
);

insert into public.vehicle_driver_assignments (vehicle_id, driver_id, assigned_by)
values (
  '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
  '8a8a7001-0000-4000-8000-8a8a8a8a8a8a',
  '8a8a0001-1111-4111-8111-8a8a8a8a8a8a'
);

-- Two full tanks 450 km apart, the second with 38 litres: 38 × 100 ÷ 450 = 8.44 L/100km.
create temp table fuel_one as
select public.cmd_log_fuel(
  '8a8a0001-1111-4111-8111-8a8a8a8a8a8a',
  '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
  '{"odometerKm":120000,"litres":40,"pricePerLitreYer":500,"stationName":"محطة الروضة","isFullTank":true}'::jsonb,
  'req-fuel-1', null
) as result;

create temp table fuel_two as
select public.cmd_log_fuel(
  '8a8a0001-1111-4111-8111-8a8a8a8a8a8a',
  '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
  '{"odometerKm":120450,"litres":38,"pricePerLitreYer":500,"isFullTank":true}'::jsonb,
  'req-fuel-2', null
) as result;

-- ---------------------------------------------------------------------------
-- 1. A fill writes four things that agree
-- ---------------------------------------------------------------------------

select is(
  ((select result from fuel_two) -> 'fuelLog' ->> 'total_cost_yer')::bigint,
  19000::bigint,
  'the generated total is litres × price: 38 × 500 = 19 000'
);

select is(
  (select odometer_km from public.vehicles where id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a'),
  120450,
  'the fill advances the vehicle odometer'
);

select is(
  (
    select count(*)::int from public.odometer_readings
    where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a' and kind = 'service'
  ),
  2,
  'and leaves one reading per fill in the odometer history'
);

select is(
  (
    select count(*)::int from public.expenses
    where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a' and category = 'fuel'
  ),
  2,
  'each fill produced exactly one expense'
);

select is(
  (
    select o.amount_yer
    from public.expenses o
    join public.fuel_logs f on f.id = o.source_id
    where o.source = 'fuel_log' and f.litres = 38
  ),
  19000::bigint,
  'the expense carries the same total the log does'
);

select is(
  (
    select o.deleted_at is null
    from public.expenses o
    join public.fuel_logs f on f.id = o.source_id
    where o.source = 'fuel_log' and f.litres = 38
  ),
  true,
  'the expense is keyed to its source log'
);

-- ---------------------------------------------------------------------------
-- 2. Consumption
-- ---------------------------------------------------------------------------

select is(
  (select s.distance_km from app.fuel_segments('8a8a9001-0000-4000-8000-8a8a8a8a8a8a', 1) s),
  450,
  'the segment between the two full tanks is 450 km'
);

select is(
  (select s.l_per_100km from app.fuel_segments('8a8a9001-0000-4000-8000-8a8a8a8a8a8a', 1) s),
  8.44::numeric,
  '38 litres over 450 km is 8.44 L/100km'
);

select is(
  (select s.cost_per_km_yer from app.fuel_segments('8a8a9001-0000-4000-8000-8a8a8a8a8a8a', 1) s),
  42.22::numeric,
  'and the fuel cost 42.22 fils per kilometre'
);

-- A partial fill inside the next segment still counts towards the litres.
select public.cmd_log_fuel(
  '8a8a0001-1111-4111-8111-8a8a8a8a8a8a',
  '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
  '{"odometerKm":120650,"litres":20,"pricePerLitreYer":500,"isFullTank":false}'::jsonb,
  'req-fuel-3', null
);

select public.cmd_log_fuel(
  '8a8a0001-1111-4111-8111-8a8a8a8a8a8a',
  '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
  '{"odometerKm":120900,"litres":20,"pricePerLitreYer":500,"isFullTank":true}'::jsonb,
  'req-fuel-4', null
);

select is(
  (select s.litres from app.fuel_segments('8a8a9001-0000-4000-8000-8a8a8a8a8a8a', 1) s),
  40.00::numeric,
  'a partial fill between two full tanks counts: 20 + 20 litres over 450 km'
);

select is(
  (select s.distance_km from app.fuel_segments('8a8a9001-0000-4000-8000-8a8a8a8a8a8a', 1) s),
  450,
  'and the distance is measured from full tank to full tank'
);

-- ---------------------------------------------------------------------------
-- 3. The odometer only goes forward
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_log_fuel(
       '8a8a0001-1111-4111-8111-8a8a8a8a8a8a',
       '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
       '{"odometerKm":119000,"litres":30,"pricePerLitreYer":500}'::jsonb, null, null
     ) $$,
  '22023',
  null,
  'a fill below the last reading is refused'
);

select throws_ok(
  $$ select public.cmd_record_manual_odometer(
       '8a8a0001-1111-4111-8111-8a8a8a8a8a8a',
       '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
       '{"odometerKm":119000}'::jsonb, null, null
     ) $$,
  '22023',
  null,
  'a manual reading below the last reading is refused without a reason'
);

select throws_ok(
  $$ select public.cmd_record_manual_odometer(
       '8a8a0003-3333-4333-8333-8a8a8a8a8a8a',
       '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
       '{"odometerKm":119000,"overrideReason":"odometer was replaced"}'::jsonb, null, null
     ) $$,
  '42501',
  null,
  'and a driver cannot override it, reason or no reason'
);

create temp table manual as
select public.cmd_record_manual_odometer(
  '8a8a0001-1111-4111-8111-8a8a8a8a8a8a',
  '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
  '{"odometerKm":119000,"overrideReason":"odometer was replaced"}'::jsonb,
  'req-manual-1', null
) as result;

select is(
  (select result from manual) ->> 'override',
  'true',
  'the owner may correct a lower reading with a reason'
);

select is(
  (select odometer_km from public.vehicles where id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a'),
  120900,
  'and the vehicle keeps its high-water mark: the van did not un-drive 1 500 km'
);

select is(
  (
    select reason from audit.log
    where action = 'vehicle.recordOdometer'
      and entity_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a'
    order by created_at desc limit 1
  ),
  'odometer was replaced',
  'the override is on the record, with its reason'
);

select throws_ok(
  $$ select public.cmd_log_fuel(
       '8a8a0004-4444-4444-8444-8a8a8a8a8a8a',
       '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
       '{"odometerKm":121500,"litres":30,"pricePerLitreYer":500}'::jsonb, null, null
     ) $$,
  '42501',
  null,
  'a stranger cannot log fuel against somebody else''s van'
);

select is(
  (
    public.cmd_log_fuel(
      '8a8a0003-3333-4333-8333-8a8a8a8a8a8a',
      '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
      '{"odometerKm":121500,"litres":10,"pricePerLitreYer":500}'::jsonb, null, null
    ) -> 'fuelLog' ->> 'driver_id'
  ),
  '8a8a7001-0000-4000-8000-8a8a8a8a8a8a',
  'the assigned driver may log fuel, and the row names them'
);

-- ---------------------------------------------------------------------------
-- 4. The schedule is a rule whose due point cannot drift
-- ---------------------------------------------------------------------------

insert into public.maintenance_schedules (
  vehicle_id, kind, interval_km, last_done_km, created_by
)
values (
  '8a8a9001-0000-4000-8000-8a8a8a8a8a8a', 'oil_change', 5000, 120000,
  '8a8a0001-1111-4111-8111-8a8a8a8a8a8a'
);

select is(
  (
    select due_km from public.maintenance_schedules
    where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a' and kind = 'oil_change'
  ),
  125000,
  'oil every 5 000 km, last done at 120 000, is due at 125 000'
);

select is(
  app.maintenance_state_for(125000, null, 124600, current_date, 500, 14)::text,
  'due_soon',
  '400 km before the due point is "due soon"'
);

select is(
  app.maintenance_state_for(125000, null, 125300, current_date, 500, 14)::text,
  'overdue',
  '300 km past it is "overdue"'
);

select is(
  app.maintenance_state_for(125000, null, 124000, current_date, 500, 14)::text,
  'ok',
  'a thousand kilometres out is still ok'
);

select is(
  app.maintenance_state_for(null, current_date + 3, 120000, current_date, 500, 14)::text,
  'due_soon',
  'a date-based schedule is due soon inside its reminder window'
);

select is(
  app.maintenance_state_for(null, current_date - 1, 120000, current_date, 500, 14)::text,
  'overdue',
  'and overdue the day after'
);

update public.vehicles
set odometer_km = 125300
where id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a';

-- No `recompute` call here on purpose: the odometer write is what has to move the badge, because a trip
-- ending at 125 300 is nobody's idea of a good moment to wait for the nightly sweep.
select is(
  (
    select state::text from public.vehicle_maintenance_status
    where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a'
  ),
  'overdue',
  'advancing the odometer past the due point flips the status without anybody running the job'
);

select is(
  (
    select overdue_count from public.vehicle_maintenance_status
    where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a'
  ),
  1,
  'and counts one overdue schedule'
);

-- ---------------------------------------------------------------------------
-- 5. Doing the work moves the rule
-- ---------------------------------------------------------------------------

create temp table done as
select public.cmd_mark_maintenance_done(
  '8a8a0001-1111-4111-8111-8a8a8a8a8a8a',
  (
    select id from public.maintenance_schedules
    where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a' and kind = 'oil_change'
  ),
  '{"odometerKm":125300,"costYer":4500,"vendor":"ورشة الدائري"}'::jsonb,
  'req-maint-1', null
) as result;

select is(
  (
    select last_done_km from public.maintenance_schedules
    where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a' and kind = 'oil_change'
  ),
  125300,
  'marking it done records where the vehicle was'
);

select is(
  (
    select due_km from public.maintenance_schedules
    where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a' and kind = 'oil_change'
  ),
  130300,
  'and the generated due point moves with it'
);

select is(
  (
    select state::text from public.vehicle_maintenance_status
    where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a'
  ),
  'ok',
  'the vehicle is healthy again without anybody clearing a flag'
);

select is(
  (select result from done) -> 'status' ->> 'state',
  'ok',
  'the response to "mark done" reports the state after the rule moved, not the one before it'
);

select is(
  (
    select amount_yer from public.expenses
    where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a' and category = 'maintenance'
    order by created_at desc limit 1
  ),
  4500::bigint,
  'the service is an expense like any other'
);

select is(
  (
    select count(*)::int from public.maintenance_records
    where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a' and schedule_id is not null
  ),
  1,
  'and the evidence names the schedule it closed'
);

select throws_ok(
  $$ select public.cmd_mark_maintenance_done(
       '8a8a0003-3333-4333-8333-8a8a8a8a8a8a',
       (select id from public.maintenance_schedules
        where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a' limit 1),
       '{"odometerKm":125300}'::jsonb, null, null
     ) $$,
  '42501',
  null,
  'a driver logs the work, only the owner closes the rule'
);

-- ---------------------------------------------------------------------------
-- 6. Deleting the source soft-deletes the money
-- ---------------------------------------------------------------------------

update public.fuel_logs
set deleted_at = now(), deleted_by = '8a8a0001-1111-4111-8111-8a8a8a8a8a8a'
where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a' and litres = 40;

select is(
  (
    select o.deleted_at is not null
    from public.expenses o
    join public.fuel_logs f on f.id = o.source_id
    where o.source = 'fuel_log' and f.litres = 40
  ),
  true,
  'the expense of a deleted fill is soft-deleted with it'
);

select is(
  (
    select count(*)::int from audit.log
    where action = 'expense.reversePending'
      and after ->> 'source' = 'fuel_log'
  ),
  1,
  'and a reversal is marked as owed to the ledger'
);

-- ---------------------------------------------------------------------------
-- 7. Settings, the trip gate, and the reminder job
-- ---------------------------------------------------------------------------

select is(
  (select remind_km from app.fleet_thresholds('8a8a9001-0000-4000-8000-8a8a8a8a8a8a')),
  500,
  'with no settings row the defaults apply'
);

select is(
  (
    public.cmd_update_fleet_settings(
      '8a8a0001-1111-4111-8111-8a8a8a8a8a8a', null,
      '{"remindKm":800,"remindDays":21,"blockOverdueAssignment":true}'::jsonb, null, null
    ) -> 'settings' ->> 'block_overdue_assignment'
  ),
  'true',
  'the owner can switch on the assignment block'
);

select is(
  (select block_overdue from app.fleet_thresholds('8a8a9001-0000-4000-8000-8a8a8a8a8a8a')),
  true,
  'and the vehicle sees it'
);

-- Make it overdue again, then prove the gate.
update public.maintenance_schedules
set last_done_km = 120000
where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a';

select throws_ok(
  $$ select app.assert_trip_vehicle(
       '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
       '8a8a0001-1111-4111-8111-8a8a8a8a8a8a', null
     ) $$,
  '23505',
  null,
  'an overdue vehicle cannot be put on a trip when the owner blocks it'
);

select public.cmd_update_fleet_settings(
  '8a8a0001-1111-4111-8111-8a8a8a8a8a8a', null,
  '{"remindKm":500,"remindDays":14,"blockOverdueAssignment":false}'::jsonb, null, null
);

select lives_ok(
  $$ select app.assert_trip_vehicle(
       '8a8a9001-0000-4000-8000-8a8a8a8a8a8a',
       '8a8a0001-1111-4111-8111-8a8a8a8a8a8a', null
     ) $$,
  'with the block off, the same van is schedulable — a workshop visit is not a passenger''s problem'
);

select is(
  app.job_maintenance_scan(10),
  1,
  'the reminder job notifies the owner once about the overdue vehicle'
);

select is(
  app.job_maintenance_scan(10),
  0,
  'and not again while the state has not changed'
);

select is(
  (
    select last_notified_state::text from public.vehicle_maintenance_status
    where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a'
  ),
  'overdue',
  'the state it told them about is remembered'
);

-- ---------------------------------------------------------------------------
-- 8. Reads reconcile, and clients cannot write
-- ---------------------------------------------------------------------------

select is(
  (
    public.get_vehicle_health(
      '8a8a0001-1111-4111-8111-8a8a8a8a8a8a', '8a8a9001-0000-4000-8000-8a8a8a8a8a8a'
    ) -> 'maintenance' ->> 'state'
  ),
  'overdue',
  'the health card agrees with the derived status'
);

select is(
  (
    public.get_vehicle_health(
      '8a8a0001-1111-4111-8111-8a8a8a8a8a8a', '8a8a9001-0000-4000-8000-8a8a8a8a8a8a'
    ) -> 'expenses' ->> 'monthTotalYer'
  )::bigint,
  (
    select coalesce(sum(amount_yer), 0)::bigint from public.expenses
    where vehicle_id = '8a8a9001-0000-4000-8000-8a8a8a8a8a8a' and deleted_at is null
      and incurred_on >= date_trunc('month', (now() at time zone 'Asia/Aden')::date)::date
  ),
  'the month total is the sum of the live expenses, not a cached guess'
);

select is(
  (
    public.get_fleet_summary('8a8a0001-1111-4111-8111-8a8a8a8a8a8a', null) -> 'totals' ->> 'monthFuelYer'
  )::bigint,
  (
    select coalesce(sum(amount_yer), 0)::bigint from public.expenses
    where owner_user_id = '8a8a0001-1111-4111-8111-8a8a8a8a8a8a' and category = 'fuel'
      and deleted_at is null
      and incurred_on >= date_trunc('month', (now() at time zone 'Asia/Aden')::date)::date
  ),
  'the fleet rollup reconciles with the same rows'
);

select throws_ok(
  $$ select public.get_vehicle_health(
       '8a8a0004-4444-4444-8444-8a8a8a8a8a8a', '8a8a9001-0000-4000-8000-8a8a8a8a8a8a'
     ) $$,
  '42501',
  null,
  'a stranger cannot read the health card'
);

select is(
  has_function_privilege('authenticated', 'public.cmd_log_fuel(uuid, uuid, jsonb, text, inet)', 'execute'),
  false,
  'a client cannot call cmd_log_fuel'
);

select is(
  has_function_privilege('authenticated', 'public.get_vehicle_health(uuid, uuid)', 'execute'),
  false,
  'nor the actor-taking health read'
);

select is(
  has_function_privilege('authenticated', 'public.vehicle_health(uuid)', 'execute'),
  true,
  'but the session-bound wrapper is theirs to call'
);

select is(
  (select count(*)::int from public.expenses where owner_user_id is null and owner_org_id is null),
  0,
  'every expense has an owner'
);

select * from finish();

rollback;
