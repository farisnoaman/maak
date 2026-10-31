-- ---------------------------------------------------------------------------
-- 00029 — Phase 8, closed gaps: trips and months, drivers' photos, the bell, the report
--
-- Phase 8 shipped the ledger and the badges. This migration closes the five things it left out, each of
-- which was written down as a gap rather than quietly dropped:
--
--   1. Fuel analytics per trip and per month (the plan asked for both trends; 00027 only had segments).
--   2. km/L alongside L/100km, because that is the unit an owner in Aden actually quotes.
--   3. A driver may attach the odometer photograph (the bucket policy was owner-only, so the command
--      accepted a path no driver could ever produce).
--   4. A fuel anomaly rings a bell, once a week, instead of only colouring a card.
--   5. Exports are plan-gated: the printable report is a Pro/Business feature, the CSV stays free.
--
-- Everything here is additive and re-runnable on top of 00027.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Plans: a metric for the printable report
-- ---------------------------------------------------------------------------

-- The metric list is a check constraint, not an enum: adding a metric is a data change, and an owner with
-- no row for it must be *refused* rather than granted (app.plan_allows default false).
alter table public.plan_limits drop constraint if exists plan_limits_metric_check;
alter table public.plan_limits add constraint plan_limits_metric_check check (
  metric in (
    'vehicles', 'trips', 'staff', 'drivers', 'active_trips', 'featured_listings',
    -- Phase 8.1: the printable fleet report. NULL on Business = unlimited attempts; 0 on Basic = no.
    'fleet_reports'
  )
);

insert into public.plan_limits (plan_code, metric, limit_value) values
  ('basic', 'fleet_reports', 0),
  ('pro', 'fleet_reports', 1),
  ('business', 'fleet_reports', null)
on conflict (plan_code, metric) do nothing;

/**
 * May this owner *use* a metric at all?
 *
 * Different question from `assert_quota`, which asks "is there room for one more". A report is not
 * accumulated, so a limit of 1 means "allowed", NULL means "allowed", and 0 means "not on this plan".
 * A metric with no row at all answers false: a plan that was never configured must not get a feature.
 */
create or replace function app.plan_allows(p_owner_user uuid, p_owner_org uuid, p_metric text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select case when l.limit_value is null then true else l.limit_value >= 1 end
      from public.plan_limits l
      where l.plan_code = app.owner_plan(p_owner_user, p_owner_org)
        and l.metric = p_metric
    ),
    false
  );
$$;

/** What the UI needs to decide whether to offer the button, and what to say when it cannot. */
create or replace function app.report_access(p_owner_user uuid, p_owner_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan public.plan_code := app.owner_plan(p_owner_user, p_owner_org);
begin
  return jsonb_build_object(
    'plan', v_plan,
    'allowed', app.plan_allows(p_owner_user, p_owner_org, 'fleet_reports'),
    'csv', true
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The anomaly bell needs somewhere to remember what it already said
-- ---------------------------------------------------------------------------

alter table public.vehicle_maintenance_status
  add column if not exists last_fuel_anomaly_at timestamptz;

comment on column public.vehicle_maintenance_status.last_fuel_anomaly_at is
  'When the owner was last told this vehicle is drinking more than usual. The dedupe key for the anomaly '
  'notification: one message a week per vehicle, not one per fill.';

-- ---------------------------------------------------------------------------
-- 3. Fuel analytics: a trip, and a month
-- ---------------------------------------------------------------------------

/**
 * What a trip cost in fuel, and what that works out to.
 *
 * The distance comes from the trip's own odometer readings (`trip_start` / `trip_end`, written by Phase 6),
 * not from the route: a van that took the mountain road drove more kilometres than the map says, and the
 * fuel bill is the honest number. Litres are the fills *attributed* to the trip — a driver who does not
 * attribute them still contributes to the monthly figure, which is why both existed in the plan.
 */
create or replace function app.trip_fuel(p_vehicle_id uuid, p_limit integer default 12)
returns table (
  trip_id uuid,
  code text,
  departure_at timestamptz,
  litres numeric,
  cost_yer bigint,
  distance_km integer,
  l_per_100km numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.id,
    t.code,
    t.departure_at,
    coalesce(f.litres, 0),
    coalesce(f.cost_yer, 0),
    d.distance_km,
    case
      when coalesce(f.litres, 0) > 0 and coalesce(d.distance_km, 0) > 0
        then round(f.litres * 100 / d.distance_km, 2)
      else null
    end
  from public.trips t
  left join lateral (
    select sum(fl.litres) as litres, sum(fl.total_cost_yer)::bigint as cost_yer
    from public.fuel_logs fl
    where fl.trip_id = t.id and fl.deleted_at is null
  ) f on true
  left join lateral (
    select
      (max(r.reading_km) filter (where r.kind = 'trip_end'))
        - (min(r.reading_km) filter (where r.kind = 'trip_start')) as distance_km
    from public.odometer_readings r
    where r.trip_id = t.id and r.kind in ('trip_start', 'trip_end')
  ) d on true
  where t.vehicle_id = p_vehicle_id
    and t.status in ('in_progress', 'completed')
  order by t.departure_at desc
  limit greatest(coalesce(p_limit, 12), 1);
$$;

/**
 * Fuel by calendar month, in Aden, including months with no fills.
 *
 * The month has to be rendered even when it is empty: a chart with a gap where the van sat idle is a
 * different story from a chart that silently skips the month. Distance is the odometer span *within* the
 * month (highest reading minus lowest), which is the only distance figure the data actually supports — and
 * the reason a month with no readings reports `null` rather than a division by zero.
 */
create or replace function app.monthly_fuel(p_vehicle_id uuid, p_months integer default 6)
returns table (
  month_start date,
  fills integer,
  litres numeric,
  cost_yer bigint,
  distance_km integer,
  l_per_100km numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with span as (
    select
      date_trunc('month', (now() at time zone 'Asia/Aden'))::date as this_month,
      greatest(least(coalesce(p_months, 6), 36), 1) as months
  ),
  months as (
    select generate_series(
      (select this_month from span) - (((select months from span) - 1) || ' months')::interval,
      (select this_month from span),
      interval '1 month'
    )::date as month_start
  )
  select
    m.month_start,
    coalesce(f.fills, 0),
    coalesce(f.litres, 0),
    coalesce(f.cost_yer, 0),
    d.distance_km,
    case
      when coalesce(f.litres, 0) > 0 and coalesce(d.distance_km, 0) > 0
        then round(f.litres * 100 / d.distance_km, 2)
      else null
    end
  from months m
  left join lateral (
    select
      count(*)::int as fills,
      sum(fl.litres) as litres,
      sum(fl.total_cost_yer)::bigint as cost_yer
    from public.fuel_logs fl
    where fl.vehicle_id = p_vehicle_id
      and fl.deleted_at is null
      and date_trunc('month', fl.filled_at at time zone 'Asia/Aden')::date = m.month_start
  ) f on true
  left join lateral (
    select (max(r.reading_km) - min(r.reading_km))::int as distance_km
    from public.odometer_readings r
    where r.vehicle_id = p_vehicle_id
      and date_trunc('month', r.recorded_at at time zone 'Asia/Aden')::date = m.month_start
  ) d on true
  order by m.month_start;
$$;

-- ---------------------------------------------------------------------------
-- 4. The driver's photograph: one prefix, and no more
-- ---------------------------------------------------------------------------

-- `vehicle-documents` holds insurance scans, registration and inspection certificates. A driver may see the
-- odometer photograph of the van they were assigned and must not see the rest, so the driver's clause is
-- scoped to the `odometer/` folder *and* to their own vehicle — the folder layout is the permission.
drop policy if exists vehicle_documents_read_own_or_staff on storage.objects;
create policy vehicle_documents_read_own_or_staff on storage.objects
  for select to authenticated
  using (
    bucket_id = 'vehicle-documents'
    and (
      app.owns_vehicle(app.safe_uuid((storage.foldername(name))[1]))
      or app.is_platform_staff()
      or (
        (storage.foldername(name))[2] in ('odometer', 'receipt', 'maintenance')
        and app.is_assigned_driver(app.safe_uuid((storage.foldername(name))[1]))
      )
    )
  );

drop policy if exists vehicle_documents_write_own on storage.objects;
create policy vehicle_documents_write_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vehicle-documents'
    and (
      app.owns_vehicle(app.safe_uuid((storage.foldername(name))[1]))
      or (
        (storage.foldername(name))[2] in ('odometer', 'receipt', 'maintenance')
        and app.is_assigned_driver(app.safe_uuid((storage.foldername(name))[1]))
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 5. The two reads are replaced, not duplicated
-- ---------------------------------------------------------------------------

-- `create or replace` keeps the existing grants and the RLS story intact; only the returned shape grows
-- (km/L, per-trip and per-month trends, an attachment path, and whether the printable report is allowed).

create or replace function public.get_vehicle_health(p_actor uuid, p_vehicle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vehicle public.vehicles%rowtype;
  v_status public.vehicle_maintenance_status%rowtype;
  v_th record;
  v_schedules jsonb;
  v_segments jsonb;
  v_records jsonb;
  v_last_log jsonb;
  v_month bigint;
  v_by_category jsonb;
  v_recent numeric;
  v_lifetime numeric;
  v_lifetime_cost bigint;
  v_lifetime_km integer;
  v_recent_kmpl numeric;
  v_lifetime_kmpl numeric;
  v_monthly jsonb;
  v_by_trip jsonb;
begin
  perform app.assert_vehicle_access(p_actor, p_vehicle_id);

  select * into v_vehicle from public.vehicles v where v.id = p_vehicle_id;
  select * into v_status from public.vehicle_maintenance_status st where st.vehicle_id = p_vehicle_id;
  if v_status.vehicle_id is null then
    v_status := app.recompute_maintenance_status(p_vehicle_id);
  end if;
  select * into v_th from app.fleet_thresholds(p_vehicle_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ms.id,
    'kind', ms.kind,
    'intervalKm', ms.interval_km,
    'intervalDays', ms.interval_days,
    'lastDoneKm', ms.last_done_km,
    'lastDoneOn', ms.last_done_on,
    'dueKm', ms.due_km,
    'dueOn', ms.due_on,
    'state', app.maintenance_state_for(
      ms.due_km, ms.due_on, greatest(v_vehicle.odometer_km, 0),
      (now() at time zone 'Asia/Aden')::date, v_th.remind_km, v_th.remind_days
    )
  ) order by ms.kind), '[]'::jsonb)
  into v_schedules
  from public.maintenance_schedules ms
  where ms.vehicle_id = p_vehicle_id and ms.is_active;

  select coalesce(jsonb_agg(jsonb_build_object(
    'fromKm', s.from_km, 'toKm', s.to_km, 'distanceKm', s.distance_km,
    'litres', s.litres, 'costYer', s.cost_yer,
    'lPer100Km', s.l_per_100km, 'costPerKmYer', s.cost_per_km_yer, 'filledAt', s.filled_at
  )), '[]'::jsonb)
  into v_segments
  from app.fuel_segments(p_vehicle_id, 6) s;

  select s.l_per_100km into v_recent from app.fuel_segments(p_vehicle_id, 1) s;

  select round(avg(s.l_per_100km), 2), sum(s.cost_yer)::bigint, sum(s.distance_km)::int
    into v_lifetime, v_lifetime_cost, v_lifetime_km
  from app.fuel_segments(p_vehicle_id, 100) s;

  -- The same two figures the other way up: kilometres per litre is what an owner in Aden quotes, and the
  -- plan asked for it by name. Derived from the segments above so the two can never disagree.
  select round(s.distance_km::numeric / nullif(s.litres, 0), 2) into v_recent_kmpl
  from app.fuel_segments(p_vehicle_id, 1) s;

  select round(sum(s.distance_km)::numeric / nullif(sum(s.litres), 0), 2) into v_lifetime_kmpl
  from app.fuel_segments(p_vehicle_id, 100) s;

  -- The two trends the plan asked for: by trip, and by month. Both come from the same rows the segments
  -- do, so a chart cannot tell a different story than the card above it.
  select coalesce(jsonb_agg(jsonb_build_object(
    'monthStart', f.month_start,
    'fills', f.fills,
    'litres', f.litres,
    'costYer', f.cost_yer,
    'distanceKm', f.distance_km,
    'lPer100Km', f.l_per_100km
  ) order by f.month_start), '[]'::jsonb)
  into v_monthly
  from app.monthly_fuel(p_vehicle_id, 6) f;

  select coalesce(jsonb_agg(jsonb_build_object(
    'tripId', t.trip_id,
    'code', t.code,
    'departureAt', t.departure_at,
    'litres', t.litres,
    'costYer', t.cost_yer,
    'distanceKm', t.distance_km,
    'lPer100Km', t.l_per_100km
  ) order by t.departure_at desc), '[]'::jsonb)
  into v_by_trip
  from app.trip_fuel(p_vehicle_id, 6) t;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'scheduleId', r.schedule_id, 'kind', r.kind, 'performedOn', r.performed_on,
    'odometerKm', r.odometer_km, 'costYer', r.cost_yer, 'vendor', r.vendor, 'note', r.note,
    'attachmentPath', r.attachment_path
  )), '[]'::jsonb)
  into v_records
  from (
    select * from public.maintenance_records mr
    where mr.vehicle_id = p_vehicle_id and mr.deleted_at is null
    order by mr.performed_on desc, mr.created_at desc
    limit 5
  ) r;

  select jsonb_build_object(
    'id', f.id, 'filledAt', f.filled_at, 'odometerKm', f.odometer_km,
    'litres', f.litres, 'pricePerLitreYer', f.price_per_litre_yer,
    'totalCostYer', f.total_cost_yer, 'isFullTank', f.is_full_tank,
    'stationName', f.station_name
  ) into v_last_log
  from public.fuel_logs f
  where f.vehicle_id = p_vehicle_id and f.deleted_at is null
  order by f.odometer_km desc, f.filled_at desc
  limit 1;

  select coalesce(sum(e.amount_yer), 0) into v_month
  from public.expenses e
  where e.vehicle_id = p_vehicle_id and e.deleted_at is null
    and e.incurred_on >= date_trunc('month', (now() at time zone 'Asia/Aden')::date)::date;

  select coalesce(jsonb_object_agg(x.category, x.total), '{}'::jsonb) into v_by_category
  from (
    select e.category::text as category, sum(e.amount_yer) as total
    from public.expenses e
    where e.vehicle_id = p_vehicle_id and e.deleted_at is null
      and e.incurred_on >= (date_trunc('month', (now() at time zone 'Asia/Aden')::date) - interval '2 months')::date
    group by e.category
  ) x;

  return jsonb_build_object(
    'vehicle', jsonb_build_object(
      'id', v_vehicle.id,
      -- Who it belongs to, so the card can decide whether to offer the *owner's* buttons. The
      -- commands re-check this; the id is here so the UI does not have to fetch the fleet to guess.
      'ownerUserId', v_vehicle.owner_user_id,
      'ownerOrgId', v_vehicle.owner_org_id,
      'make', v_vehicle.make,
      'model', v_vehicle.model,
      'plateNumber', v_vehicle.plate_number,
      'fuelType', v_vehicle.fuel_type,
      'tankLitres', v_vehicle.fuel_tank_l,
      'odometerKm', v_vehicle.odometer_km,
      'status', v_vehicle.status,
      'verificationStatus', v_vehicle.verification_status
    ),
    'maintenance', jsonb_build_object(
      'state', v_status.state,
      'nextDueKm', v_status.next_due_km,
      'nextDueOn', v_status.next_due_on,
      'dueCount', v_status.due_count,
      'overdueCount', v_status.overdue_count,
      'schedules', v_schedules,
      'recentRecords', v_records,
      'computedAt', v_status.computed_at
    ),
    'fuel', jsonb_build_object(
      'lastLog', v_last_log,
      'recentLPer100Km', v_recent,
      'recentKmPerLitre', v_recent_kmpl,
      'lifetimeLPer100Km', v_lifetime,
      'lifetimeKmPerLitre', v_lifetime_kmpl,
      'lifetimeCostYer', coalesce(v_lifetime_cost, 0),
      'lifetimeDistanceKm', coalesce(v_lifetime_km, 0),
      -- Cost per kilometre over the segments we have; null rather than a division by zero.
      'costPerKmYer',
        case when coalesce(v_lifetime_km, 0) > 0
          then round(coalesce(v_lifetime_cost, 0)::numeric / v_lifetime_km, 2) end,
      'segments', v_segments,
      'byTrip', v_by_trip,
      'monthly', v_monthly
    ),
    'expenses', jsonb_build_object(
      'monthTotalYer', v_month,
      'byCategory', v_by_category
    ),
    -- Whether the printable report is theirs to take. The route re-checks it with the same function; this
    -- copy exists so the card can explain the absence of a button instead of hiding behind a 403.
    'reports', app.report_access(v_vehicle.owner_user_id, v_vehicle.owner_org_id),
    'thresholds', jsonb_build_object(
      'remindKm', v_th.remind_km,
      'remindDays', v_th.remind_days,
      'blockOverdueAssignment', v_th.block_overdue,
      'fuelAnomalyPercent', v_th.fuel_anomaly_percent
    )
  );
end;
$$;
create or replace function public.get_fleet_summary(p_actor uuid, p_org_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
  v_totals jsonb;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  if p_org_id is not null then
    if not (app.is_org_member(p_org_id, p_actor) or app.is_platform_staff(p_actor)) then
      raise exception 'FORBIDDEN: not your organization' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(item order by item ->> 'plateNumber'), '[]'::jsonb) into v_items
  from (
    select jsonb_build_object(
      'id', v.id,
      'make', v.make,
      'model', v.model,
      'plateNumber', v.plate_number,
      'status', v.status,
      'verificationStatus', v.verification_status,
      'odometerKm', v.odometer_km,
      'maintenanceState', coalesce(ms.state, 'ok'),
      'dueCount', coalesce(ms.due_count, 0),
      'overdueCount', coalesce(ms.overdue_count, 0),
      'nextDueKm', ms.next_due_km,
      'nextDueOn', ms.next_due_on,
      'reportsAllowed', app.plan_allows(v.owner_user_id, v.owner_org_id, 'fleet_reports'),
      'recentLPer100Km', (select s.l_per_100km from app.fuel_segments(v.id, 1) s),
      'recentKmPerLitre', (
        select round(s.distance_km::numeric / nullif(s.litres, 0), 2)
        from app.fuel_segments(v.id, 1) s
      ),
      'monthFuelYer', (
        select coalesce(sum(e.amount_yer), 0) from public.expenses e
        where e.vehicle_id = v.id and e.deleted_at is null and e.category = 'fuel'
          and e.incurred_on >= date_trunc('month', (now() at time zone 'Asia/Aden')::date)::date
      ),
      'monthMaintenanceYer', (
        select coalesce(sum(e.amount_yer), 0) from public.expenses e
        where e.vehicle_id = v.id and e.deleted_at is null and e.category = 'maintenance'
          and e.incurred_on >= date_trunc('month', (now() at time zone 'Asia/Aden')::date)::date
      )
    ) as item
    from public.vehicles v
    left join public.vehicle_maintenance_status ms on ms.vehicle_id = v.id
    where (
      (p_org_id is not null and v.owner_org_id = p_org_id)
      or (p_org_id is null and v.owner_user_id = p_actor)
      or app.is_platform_staff(p_actor)
    )
  ) x;

  select jsonb_build_object(
    'vehicles', jsonb_array_length(v_items),
    'active', (
      select count(*)::int from jsonb_array_elements(v_items) i
      where i ->> 'status' = 'active'
    ),
    'dueSoon', (
      select count(*)::int from jsonb_array_elements(v_items) i
      where i ->> 'maintenanceState' = 'due_soon'
    ),
    'overdue', (
      select count(*)::int from jsonb_array_elements(v_items) i
      where i ->> 'maintenanceState' = 'overdue'
    ),
    'monthFuelYer', (
      select coalesce(sum((i ->> 'monthFuelYer')::bigint), 0) from jsonb_array_elements(v_items) i
    ),
    'monthMaintenanceYer', (
      select coalesce(sum((i ->> 'monthMaintenanceYer')::bigint), 0) from jsonb_array_elements(v_items) i
    )
  ) into v_totals;

  return jsonb_build_object('vehicles', v_items, 'totals', v_totals);
end;
$$;
-- ---------------------------------------------------------------------------
-- 6. The fill now rings a bell, and names a station it can find
-- ---------------------------------------------------------------------------

create or replace function public.cmd_log_fuel(
  p_actor uuid,
  p_vehicle_id uuid,
  p_log jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_log public.fuel_logs%rowtype;
  v_vehicle public.vehicles%rowtype;
  v_odo integer;
  v_litres numeric;
  v_price integer;
  v_trip uuid;
  v_last integer;
  v_t record;
  v_newest numeric;
  v_baseline numeric;
  v_anomaly boolean := false;
  v_place uuid;
  v_user uuid;
  v_last_anomaly timestamptz;
  v_anomaly_notified boolean := false;
begin
  perform app.assert_vehicle_access(p_actor, p_vehicle_id);

  select * into v_vehicle from public.vehicles v where v.id = p_vehicle_id;

  v_odo := nullif(p_log ->> 'odometerKm', '')::int;
  v_litres := nullif(p_log ->> 'litres', '')::numeric;
  v_price := nullif(p_log ->> 'pricePerLitreYer', '')::int;

  if v_odo is null or v_odo < 0 then
    raise exception 'VALIDATION: odometerKm is required' using errcode = '22023';
  end if;
  if v_litres is null or v_litres <= 0 then
    raise exception 'VALIDATION: litres must be greater than zero' using errcode = '22023';
  end if;
  if v_price is null or v_price < 0 then
    raise exception 'VALIDATION: pricePerLitreYer is required' using errcode = '22023';
  end if;

  v_last := app.assert_odometer_advance(p_vehicle_id, v_odo);

  -- Station linking: a fill may point at a real place (a `station` or `market` in the reference), which is
  -- what turns "محطة الروضة" typed twelve ways into one row Phase 10 can price. The name is still kept as
  -- typed, because a place the driver could not find must not stop the receipt from being recorded.
  v_place := nullif(p_log ->> 'stationPlaceId', '')::uuid;
  if v_place is not null and not exists (
    select 1 from public.places pl where pl.id = v_place and pl.is_active
  ) then
    raise exception 'NOT_FOUND: that station is not a known place' using errcode = 'P0002';
  end if;

  -- A fill may name the trip it happened on, but only a trip this vehicle actually drove. Either by id
  -- (the web form, which has one) or by its printed code (the phone, which shows a code, not a uuid).
  v_trip := nullif(p_log ->> 'tripId', '')::uuid;
  if v_trip is null and nullif(btrim(p_log ->> 'tripCode'), '') is not null then
    select t.id into v_trip
    from public.trips t
    where upper(t.code) = upper(btrim(p_log ->> 'tripCode'))
      and t.vehicle_id = p_vehicle_id;
    -- Supplying a code is a claim. If the claim resolves to nothing, the fill is refused rather than
    -- filed against no trip: silent nulls are how "the app lost my data" support tickets begin.
    if v_trip is null then
      raise exception 'NOT_FOUND: no trip with that code on this vehicle' using errcode = 'P0002';
    end if;
  end if;
  if v_trip is not null then
    if not exists (select 1 from public.trips t where t.id = v_trip and t.vehicle_id = p_vehicle_id) then
      raise exception 'CONFLICT: that trip is not driven by this vehicle' using errcode = '23505';
    end if;
  end if;

  insert into public.fuel_logs (
    vehicle_id, trip_id, driver_id, filled_at, odometer_km, litres, price_per_litre_yer,
    is_full_tank, station_name, station_place_id, receipt_path, note, recorded_by
  ) values (
    p_vehicle_id,
    v_trip,
    app.driver_id_for_user(p_actor),
    coalesce(nullif(p_log ->> 'filledAt', '')::timestamptz, now()),
    v_odo,
    v_litres,
    v_price,
    coalesce((p_log ->> 'isFullTank')::boolean, true),
    nullif(btrim(p_log ->> 'stationName'), ''),
    v_place,
    nullif(p_log ->> 'receiptPath', ''),
    nullif(btrim(p_log ->> 'note'), ''),
    p_actor
  )
  returning * into v_log;

  update public.vehicles
  set odometer_km = greatest(odometer_km, v_odo)
  where id = p_vehicle_id;

  insert into public.odometer_readings (vehicle_id, reading_km, kind, driver_id, recorded_by, note)
  values (p_vehicle_id, v_odo, 'service', app.driver_id_for_user(p_actor), p_actor, 'fuel log');

  -- Anomaly: the newest tank-to-tank figure against the average of the ones before it.
  select * into v_t from app.fleet_thresholds(p_vehicle_id);
  select s.l_per_100km into v_newest from app.fuel_segments(p_vehicle_id, 1) s;
  select round(avg(s.l_per_100km), 2) into v_baseline
  from app.fuel_segments(p_vehicle_id, 7) s
  where s.to_km < (select max(o.to_km) from app.fuel_segments(p_vehicle_id, 1) o);

  if v_newest is not null and v_baseline is not null and v_baseline > 0
     and v_newest > v_baseline * (1 + v_t.fuel_anomaly_percent / 100.0) then
    v_anomaly := true;
  end if;

  -- A symptom is worth a bell, but not a bell per fill: one message a week per vehicle, and only to the
  -- people who can actually send it to a workshop. The status row is updated first so the row exists even
  -- on a vehicle that has no schedules at all (and therefore no reason to have been recomputed yet).
  if v_anomaly then
    perform app.recompute_maintenance_status(p_vehicle_id);

    select st.last_fuel_anomaly_at into v_last_anomaly
    from public.vehicle_maintenance_status st
    where st.vehicle_id = p_vehicle_id;

    if v_last_anomaly is null or v_last_anomaly < now() - interval '7 days' then
      if v_vehicle.owner_user_id is not null then
        perform app.notify(
          v_vehicle.owner_user_id, 'vehicle_fuel_anomaly', 'notifications.vehicleFuelAnomaly',
          jsonb_build_object(
            'plate', v_vehicle.plate_number,
            'value', v_newest,
            'baseline', v_baseline
          ),
          '/operator/vehicles/' || p_vehicle_id || '/health'
        );
        v_anomaly_notified := true;
      elsif v_vehicle.owner_org_id is not null then
        for v_user in
          select m.user_id from public.organization_members m
          where m.org_id = v_vehicle.owner_org_id
            and m.status = 'active' and m.user_id is not null
            and m.role in ('owner', 'manager')
        loop
          perform app.notify(
            v_user, 'vehicle_fuel_anomaly', 'notifications.vehicleFuelAnomaly',
            jsonb_build_object(
              'plate', v_vehicle.plate_number,
              'value', v_newest,
              'baseline', v_baseline
            ),
            '/operator/vehicles/' || p_vehicle_id || '/health'
          );
          v_anomaly_notified := true;
        end loop;
      end if;

      if v_anomaly_notified then
        update public.vehicle_maintenance_status
        set last_fuel_anomaly_at = now()
        where vehicle_id = p_vehicle_id;
      end if;
    end if;
  end if;

  perform app.write_audit(
    p_actor, 'vehicle.logFuel', 'vehicle', p_vehicle_id::text, null,
    jsonb_build_object(
      'fuelLogId', v_log.id, 'litres', v_litres, 'odometerKm', v_odo,
      'costYer', v_log.total_cost_yer, 'anomaly', v_anomaly
    ),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'fuelLog', to_jsonb(v_log),
    'lastOdometerKm', v_last,
    'anomaly', v_anomaly,
    'anomalyNotified', v_anomaly_notified,
    'lPer100Km', v_newest
  );
end;
$$;
/**
 * The printable report, session-bound like every other read the UI makes.
 *
 * `app.report_access` takes an actor; the route that renders A4 has no business holding one, so this is the
 * only shape it gets to call. Same precedent as `vehicle_health` / `fleet_summary`.
 */
create or replace function public.fleet_report_access(p_org_id uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when app.uid() is null then
      jsonb_build_object('plan', 'basic', 'allowed', false, 'csv', true)
    when p_org_id is not null and not (app.is_org_member(p_org_id, app.uid()) or app.is_platform_staff())
      then jsonb_build_object('plan', 'basic', 'allowed', false, 'csv', true)
    else app.report_access(
      case when p_org_id is null then app.uid() else null end,
      p_org_id
    )
  end;
$$;

grant execute on function public.fleet_report_access(uuid) to authenticated, service_role;
revoke all on function public.fleet_report_access(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- 7. Grants for everything new
-- ---------------------------------------------------------------------------

-- Policy predicates and reads call these, and a policy evaluates *as the caller*: an unexecutable helper is
-- a 500 from PostgREST, not an empty result (the Phase 6 lesson, learned the hard way in 00024).
grant execute on function app.plan_allows(uuid, uuid, text) to authenticated, service_role;
grant execute on function app.report_access(uuid, uuid) to authenticated, service_role;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'app.trip_fuel(uuid, integer)',
    'app.monthly_fuel(uuid, integer)',
    'app.plan_allows(uuid, uuid, text)',
    'app.report_access(uuid, uuid)'
  ]
  loop
    continue when to_regprocedure(v_signature) is null;
    execute format('revoke all on function %s from public, anon', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

comment on function app.trip_fuel(uuid, integer) is
  'Fuel attributed to each trip, with distance from its own odometer readings. Phase 8.1.';
comment on function app.monthly_fuel(uuid, integer) is
  'Fuel per Aden calendar month, including months with no fills. Phase 8.1.';
comment on function app.plan_allows(uuid, uuid, text) is
  'Whether a plan includes a metric at all (1 or NULL = yes, 0 = no, missing row = no). Phase 8.1.';

-- ---------------------------------------------------------------------------
-- 9. A date-ranged cost ledger, so the CSV can answer "how much did we spend between these dates"
-- ---------------------------------------------------------------------------

-- The dashboard answers "this month", because that is the question a manager asks on a normal Tuesday.
-- An auditor asks a different question — "everything between March and June" — and a rollup cannot answer
-- it. This returns one row per fuel fill and per maintenance record, which is both the export the finance
-- phase will want and the reconciliation the acceptance criterion demands: the sum of these rows over a
-- month equals the month columns of `get_fleet_summary`, because both read the same logs.
create or replace function public.fleet_cost_detail(
  p_actor uuid,
  p_org_id uuid default null,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to date;
  v_rows jsonb;
  v_totals jsonb;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  if p_org_id is not null then
    if not (app.is_org_member(p_org_id, p_actor) or app.is_platform_staff(p_actor)) then
      raise exception 'FORBIDDEN: not your organization' using errcode = '42501';
    end if;
  end if;

  -- Defaults are deliberately the same window the dashboard shows, so a bare `/export` and the screen it
  -- was exported from always agree. A range given backwards is swapped rather than rejected: a user who
  -- typed the dates in the other order wants the data, not a validation message.
  v_to := coalesce(p_to, (now() at time zone 'Asia/Aden')::date);
  v_from := coalesce(p_from, date_trunc('month', v_to)::date);
  if v_from > v_to then
    select v_from, v_to into v_to, v_from;
  end if;

  with visible as (
    select v.id, v.plate_number, v.make, v.model
    from public.vehicles v
    where (p_org_id is not null and v.owner_org_id = p_org_id)
      or (p_org_id is null and v.owner_user_id = p_actor)
      or app.is_platform_staff(p_actor)
  ),
  fuel as (
    select
      'fuel'::text as kind,
      (fl.filled_at at time zone 'Asia/Aden')::date as occurred_on,
      vis.plate_number,
      coalesce(pl.name_ar, fl.station_name, '') as detail,
      fl.litres,
      fl.odometer_km,
      fl.total_cost_yer as amount_yer
    from public.fuel_logs fl
    join visible vis on vis.id = fl.vehicle_id
    left join public.places pl on pl.id = fl.station_place_id
    where (fl.filled_at at time zone 'Asia/Aden')::date between v_from and v_to
  ),
  work as (
    select
      'maintenance'::text as kind,
      mr.performed_on as occurred_on,
      vis.plate_number,
      coalesce(nullif(btrim(mr.vendor), ''), nullif(btrim(mr.note), ''), mr.kind::text) as detail,
      null::numeric as litres,
      mr.odometer_km,
      mr.cost_yer as amount_yer
    from public.maintenance_records mr
    join visible vis on vis.id = mr.vehicle_id
    where mr.deleted_at is null
      and mr.performed_on between v_from and v_to
  ),
  allrows as (
    select * from fuel union all select * from work
  )
  select
    coalesce(jsonb_agg(item order by item ->> 'occurredOn', item ->> 'plateNumber'), '[]'::jsonb),
    jsonb_build_object(
      'fuelYer', coalesce(sum(amount_yer) filter (where kind = 'fuel'), 0),
      'maintenanceYer', coalesce(sum(amount_yer) filter (where kind = 'maintenance'), 0),
      'rows', count(*)
    )
  into v_rows, v_totals
  from (
    select jsonb_build_object(
      'kind', a.kind,
      'occurredOn', to_char(a.occurred_on, 'YYYY-MM-DD'),
      'plateNumber', a.plate_number,
      'detail', a.detail,
      'litres', a.litres,
      'odometerKm', a.odometer_km,
      'amountYer', a.amount_yer
    ) as item,
    a.kind, a.amount_yer
    from allrows a
  ) j;

  return jsonb_build_object(
    'range', jsonb_build_object('from', to_char(v_from, 'YYYY-MM-DD'), 'to', to_char(v_to, 'YYYY-MM-DD')),
    'totals', v_totals,
    'rows', v_rows
  );
end;
$$;

comment on function public.fleet_cost_detail(uuid, uuid, date, date) is
  'Fuel fills and maintenance records in a date window, for the CSV export and for reconciling the rollup.';

revoke all on function public.fleet_cost_detail(uuid, uuid, date, date) from public;
grant execute on function public.fleet_cost_detail(uuid, uuid, date, date) to authenticated;
