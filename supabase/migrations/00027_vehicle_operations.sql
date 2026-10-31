-- ---------------------------------------------------------------------------
-- 00027 — Phase 8: the vehicle earns its keep, and the books know what it cost
--
-- Phase 3 registered a vehicle; Phase 6 made it drive and advanced its odometer. What was missing is the
-- part that decides whether it is *roadworthy tomorrow*: fuel, consumption, scheduled maintenance, and
-- the money those cost. This migration is that, plus the seam Phase 10 will use to put the same money
-- through a double-entry ledger.
--
-- Three rules shape everything below:
--
--   1. **The odometer only goes forward** (BR-16). Every write path — fuel, maintenance, a manual
--      reading — passes through `app.assert_odometer_advance`, and the one legitimate way to record a
--      *lower* reading is an explicit owner override with a reason, which leaves an audit row.
--   2. **A schedule is a rule, not a row of text.** `due_km` and `due_on` are generated columns, so a
--      schedule cannot disagree with its own interval, and the state (ok / due soon / overdue) is derived
--      in exactly one function that the dashboard, the badge and the trip gate all call.
--   3. **Expenses are written by the database, not by the client.** A fuel log and a maintenance record
--      each produce one `expenses` row through a trigger, so "we logged 38 litres and paid 19 000" and
--      "the month cost 19 000" cannot drift apart — and deleting the log soft-deletes the expense with a
--      reversal marker for the ledger.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Types
-- ---------------------------------------------------------------------------

create type public.maintenance_kind as enum (
  'oil_change',
  'oil_filter',
  'air_filter',
  'fuel_filter',
  'cabin_filter',
  'tyres',
  'brakes',
  'battery',
  'timing_belt',
  'coolant',
  'transmission',
  'suspension',
  'electrical',
  'bodywork',
  'inspection',
  'other'
);

/** The three states a schedule can be in. `due_soon` exists so a warning can happen *before* a failure. */
create type public.maintenance_state as enum ('ok', 'due_soon', 'overdue');

create type public.expense_category as enum (
  'fuel',
  'maintenance',
  'insurance',
  'registration',
  'permit',
  'salary',
  'toll',
  'parking',
  'fine',
  'other'
);

/** Where an expense came from. `manual` is the Phase 10 form; the other two are written by triggers. */
create type public.expense_source as enum ('fuel_log', 'maintenance_record', 'manual');

-- ---------------------------------------------------------------------------
-- 2. Settings, per owner — not per vehicle
-- ---------------------------------------------------------------------------
-- Two vans in one fleet that disagree about "warn me 500 km out" is not a feature. The owner is either a
-- person or an organization, like every other owner in the schema, so the row is keyed the same way.

create table public.fleet_settings (
  id                        uuid primary key default gen_random_uuid(),
  owner_user_id             uuid references public.profiles (id) on delete cascade,
  owner_org_id              uuid references public.organizations (id) on delete cascade,

  /** Warn this many kilometres before a distance-based schedule is due. */
  remind_km                 integer not null default 500 check (remind_km between 0 and 20000),
  /** Warn this many days before a date-based schedule is due. */
  remind_days               integer not null default 14 check (remind_days between 0 and 365),
  /** BR: a vehicle overdue on maintenance cannot be scheduled onto a new trip when this is on. */
  block_overdue_assignment  boolean not null default false,
  /** A tank-to-tank consumption this far above the lifetime average is flagged, not refused. */
  fuel_anomaly_percent      integer not null default 25 check (fuel_anomaly_percent between 5 and 200),

  updated_by                uuid references public.profiles (id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint fleet_settings_one_owner
    check ((owner_user_id is null) <> (owner_org_id is null))
);

-- Plain unique indexes, not partial ones: a personal row has a null org and vice versa, and NULLs are
-- distinct — so these two allow exactly one of each. (A partial index would also break `on conflict
-- (owner_user_id)` inference in the settings command, which is the kind of thing migrations find late.)
create unique index fleet_settings_user_uq on public.fleet_settings (owner_user_id);
create unique index fleet_settings_org_uq on public.fleet_settings (owner_org_id);

create trigger fleet_settings_set_updated_at
  before update on public.fleet_settings
  for each row execute function app.set_updated_at();

comment on table public.fleet_settings is
  'Reminder thresholds and the maintenance-assignment block, one row per owner. Absent row = defaults: '
  '500 km, 14 days, warnings only, 25% fuel anomaly.';

-- ---------------------------------------------------------------------------
-- 3. Fuel
-- ---------------------------------------------------------------------------

create table public.fuel_logs (
  id                    uuid primary key default gen_random_uuid(),
  vehicle_id            uuid not null references public.vehicles (id) on delete cascade,
  trip_id               uuid references public.trips (id) on delete set null,
  driver_id             uuid references public.driver_profiles (id) on delete set null,

  filled_at             timestamptz not null default now(),
  odometer_km           integer not null check (odometer_km >= 0),
  litres                numeric(8, 2) not null check (litres > 0 and litres <= 2000),
  /** Money is integer minor units everywhere in this schema (fils). */
  price_per_litre_yer   integer not null check (price_per_litre_yer >= 0 and price_per_litre_yer <= 1000000),
  total_cost_yer        bigint generated always as ((round(litres * price_per_litre_yer))::bigint) stored,

  /**
   * Only a full tank can close a consumption segment. A partial fill is a real expense and a real
   * reading, it just cannot be the denominator of an economy figure.
   */
  is_full_tank          boolean not null default true,

  station_name          text check (station_name is null or length(btrim(station_name)) between 1 and 120),
  /** Optional link to a `places` row (kind `station`), so the same station is spelled the same way twice. */
  station_place_id      uuid references public.places (id) on delete set null,
  /** Object path in the private `vehicle-documents` bucket, `<vehicle_id>/fuel/<file>`. */
  receipt_path          text,
  note                  text check (note is null or length(note) <= 1000),

  recorded_by           uuid references public.profiles (id) on delete set null,
  created_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  deleted_by            uuid references public.profiles (id) on delete set null
);

create index fuel_logs_vehicle_idx on public.fuel_logs (vehicle_id, filled_at desc);
create index fuel_logs_trip_idx on public.fuel_logs (trip_id) where trip_id is not null;
create index fuel_logs_live_idx on public.fuel_logs (vehicle_id, odometer_km)
  where deleted_at is null;

comment on table public.fuel_logs is
  'One row per fill. `total_cost_yer` is generated from litres × price so the receipt and the total '
  'cannot disagree; `is_full_tank` decides whether the row can close a consumption segment.';

-- ---------------------------------------------------------------------------
-- 4. Maintenance: the rule, the record, and the state
-- ---------------------------------------------------------------------------

create table public.maintenance_schedules (
  id              uuid primary key default gen_random_uuid(),
  vehicle_id      uuid not null references public.vehicles (id) on delete cascade,
  kind            public.maintenance_kind not null,

  interval_km     integer check (interval_km is null or interval_km between 100 and 500000),
  interval_days   integer check (interval_days is null or interval_days between 1 and 3650),

  last_done_km    integer check (last_done_km is null or last_done_km >= 0),
  last_done_on    date,

  -- Generated, because a due point that can drift from its interval is a due point nobody can trust.
  due_km          integer generated always as (last_done_km + interval_km) stored,
  due_on          date generated always as (last_done_on + interval_days) stored,

  is_active       boolean not null default true,
  note            text check (note is null or length(note) <= 500),

  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint maintenance_schedules_has_interval
    check (interval_km is not null or interval_days is not null),
  -- A schedule with neither a starting point nor an interval has nothing to compute from.
  constraint maintenance_schedules_km_needs_start
    check (interval_km is null or last_done_km is not null)
);

create index maintenance_schedules_vehicle_idx
  on public.maintenance_schedules (vehicle_id) where is_active;

create trigger maintenance_schedules_set_updated_at
  before update on public.maintenance_schedules
  for each row execute function app.set_updated_at();

create table public.maintenance_records (
  id              uuid primary key default gen_random_uuid(),
  vehicle_id      uuid not null references public.vehicles (id) on delete cascade,
  schedule_id     uuid references public.maintenance_schedules (id) on delete set null,
  kind            public.maintenance_kind not null,

  performed_on    date not null default (now() at time zone 'Asia/Aden')::date,
  odometer_km     integer check (odometer_km is null or odometer_km >= 0),
  cost_yer        bigint not null default 0 check (cost_yer >= 0),
  vendor          text check (vendor is null or length(btrim(vendor)) between 1 and 160),
  note            text check (note is null or length(note) <= 2000),
  /** Object path in the private `vehicle-documents` bucket. */
  attachment_path text,

  recorded_by     uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  deleted_by      uuid references public.profiles (id) on delete set null
);

create index maintenance_records_vehicle_idx
  on public.maintenance_records (vehicle_id, performed_on desc);
create index maintenance_records_schedule_idx
  on public.maintenance_records (schedule_id) where schedule_id is not null;

/**
 * One row per vehicle: the cheapest question the fleet screen asks ("what needs attention?").
 *
 * Recomputed by `app.recompute_maintenance_status()` — never written by hand, never by a client. It is a
 * table rather than a view because the reminder job needs to remember what it already told somebody
 * (`last_notified_state`), and because the fleet page reads it for every vehicle at once.
 */
create table public.vehicle_maintenance_status (
  vehicle_id          uuid primary key references public.vehicles (id) on delete cascade,
  state               public.maintenance_state not null default 'ok',
  worst_schedule_id   uuid references public.maintenance_schedules (id) on delete set null,
  next_due_km         integer,
  next_due_on         date,
  due_count           integer not null default 0,
  overdue_count       integer not null default 0,

  last_notified_state public.maintenance_state,
  last_notified_at    timestamptz,

  computed_at         timestamptz not null default now()
);

create index vehicle_maintenance_status_state_idx
  on public.vehicle_maintenance_status (state) where state <> 'ok';

comment on table public.vehicle_maintenance_status is
  'Derived maintenance state per vehicle. `last_notified_state` is the dedupe key for the daily reminder '
  'job: a vehicle that stays overdue is not a daily notification.';

-- ---------------------------------------------------------------------------
-- 5. Expenses — the seam Phase 10 will run the ledger through
-- ---------------------------------------------------------------------------
-- Phase 8 only needs "what did this vehicle cost", and Phase 10 needs to be able to turn every row into a
-- journal entry without re-reading fuel and maintenance. So this table is deliberately *not* a ledger:
-- one row per cost, one source, one owner, soft delete with a reversal marker. No double entry yet, and
-- no pretending there is.

create table public.expenses (
  id                uuid primary key default gen_random_uuid(),

  owner_user_id     uuid references public.profiles (id) on delete restrict,
  owner_org_id      uuid references public.organizations (id) on delete restrict,
  vehicle_id        uuid references public.vehicles (id) on delete set null,
  trip_id           uuid references public.trips (id) on delete set null,

  category          public.expense_category not null,
  /** Integer minor units (fils), like every other amount in this schema. */
  amount_yer        bigint not null check (amount_yer >= 0),
  incurred_on       date not null,
  description       text check (description is null or length(description) <= 500),

  source            public.expense_source not null default 'manual',
  source_id         uuid,

  /**
   * Phase 10 writes the reversing double-entry here when the source is deleted. It stays null in Phase 8
   * on purpose: an expense marked deleted with no ledger behind it is honest, an expense with a fake
   * offsetting entry is not.
   */
  reversal_entry_id uuid,

  recorded_by       uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid references public.profiles (id) on delete set null,
  delete_reason     text,

  constraint expenses_one_owner
    check ((owner_user_id is null) <> (owner_org_id is null)),
  -- A generated expense must name its source; a manual one must not claim one.
  constraint expenses_source_shape
    check ((source = 'manual') = (source_id is null))
);

-- Not partial: `on conflict (source, source_id)` cannot infer a partial index, and NULL `source_id`s are
-- distinct anyway, so manual expenses do not collide with each other.
create unique index expenses_source_uq on public.expenses (source, source_id);
create index expenses_owner_month_idx on public.expenses (owner_org_id, incurred_on desc)
  where owner_org_id is not null and deleted_at is null;
create index expenses_owner_user_month_idx on public.expenses (owner_user_id, incurred_on desc)
  where owner_user_id is not null and deleted_at is null;
create index expenses_vehicle_idx on public.expenses (vehicle_id, incurred_on desc)
  where vehicle_id is not null and deleted_at is null;

comment on table public.expenses is
  'What a vehicle cost, one row per cost. Written by triggers from fuel_logs and maintenance_records and '
  '(Phase 10) by hand. Soft delete carries a reversal marker for the double-entry ledger.';

-- ---------------------------------------------------------------------------
-- 6. Helpers: thresholds, access, the odometer rule, and the state machine
-- ---------------------------------------------------------------------------

/** The thresholds that apply to a vehicle: its owner's row, or the defaults when nobody set one. */
create or replace function app.fleet_thresholds(p_vehicle_id uuid)
returns table (
  remind_km integer,
  remind_days integer,
  block_overdue boolean,
  fuel_anomaly_percent integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(fs.remind_km, 500),
    coalesce(fs.remind_days, 14),
    coalesce(fs.block_overdue_assignment, false),
    coalesce(fs.fuel_anomaly_percent, 25)
  from public.vehicles v
  left join public.fleet_settings fs
    on (fs.owner_user_id is not null and fs.owner_user_id = v.owner_user_id)
    or (fs.owner_org_id is not null and fs.owner_org_id = v.owner_org_id)
  where v.id = p_vehicle_id;
$$;

/**
 * May this actor record anything against this vehicle?
 *
 * Three answers, and the difference matters: the owner manages it, the assigned driver *logs against* it
 * (fuel, odometer) and nothing else, and platform staff may do both. `p_owner_only` is the switch the
 * schedule and settings commands use — a driver can fill the tank, not rewrite the maintenance rule.
 */
create or replace function app.assert_vehicle_access(
  p_actor uuid,
  p_vehicle_id uuid,
  p_owner_only boolean default false
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  if not exists (select 1 from public.vehicles v where v.id = p_vehicle_id) then
    raise exception 'NOT_FOUND: vehicle' using errcode = 'P0002';
  end if;

  if app.is_platform_staff(p_actor) then
    return;
  end if;

  if app.owns_vehicle(p_vehicle_id, p_actor) then
    return;
  end if;

  if not p_owner_only and app.is_assigned_driver(p_vehicle_id, p_actor) then
    return;
  end if;

  raise exception 'FORBIDDEN: this vehicle is not yours to log against' using errcode = '42501';
end;
$$;

/**
 * BR-16, in one place: the odometer only goes forward.
 *
 * Returns the reading it compared against, so a caller can report "you typed 120 400, the van read
 * 121 900" without a second query. `p_allow_backward` exists for exactly one caller — the owner's manual
 * correction with a reason — and that caller writes an audit row saying so.
 */
create or replace function app.assert_odometer_advance(
  p_vehicle_id uuid,
  p_reading integer,
  p_allow_backward boolean default false
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_last integer;
begin
  v_last := app.last_odometer_km(p_vehicle_id);

  if p_reading < v_last and not p_allow_backward then
    raise exception 'ODO_REGRESSION: the odometer reads % km but the vehicle was last logged at % km',
      p_reading, v_last using errcode = '22023';
  end if;

  return v_last;
end;
$$;

/**
 * The state machine, as a pure function: given a due point and today, is it ok, soon, or late?
 *
 * A schedule is overdue when either arm is exceeded — kilometres *or* the calendar — because an oil
 * change is due at 5 000 km or six months, whichever comes first. `due_soon` is the earlier of the two
 * reminders, for the same reason.
 */
create or replace function app.maintenance_state_for(
  p_due_km integer,
  p_due_on date,
  p_odometer integer,
  p_as_of date,
  p_remind_km integer default 500,
  p_remind_days integer default 14
)
returns public.maintenance_state
language sql
immutable
as $$
  select case
    when p_due_km is null and p_due_on is null then 'ok'::public.maintenance_state
    when (p_due_km is not null and p_odometer >= p_due_km)
      or (p_due_on is not null and p_as_of > p_due_on) then 'overdue'::public.maintenance_state
    when (p_due_km is not null and p_odometer >= p_due_km - greatest(p_remind_km, 0))
      or (p_due_on is not null and p_as_of >= p_due_on - greatest(p_remind_days, 0))
      then 'due_soon'::public.maintenance_state
    else 'ok'::public.maintenance_state
  end;
$$;

/**
 * Recompute one vehicle's derived maintenance state.
 *
 * The single implementation: the fleet list, the vehicle health card, the reminder job and the trip gate
 * all read the row this writes. `worst_schedule_id` is what the UI links to ("oil change, 400 km ago"),
 * and `due_count` / `overdue_count` are what the rollup sums — recomputing them here means the rollup
 * cannot disagree with the cards it summarises.
 */
create or replace function app.recompute_maintenance_status(p_vehicle_id uuid)
returns public.vehicle_maintenance_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_odo integer;
  v_t record;
  v_state public.maintenance_state := 'ok';
  v_worst uuid;
  v_next_km integer;
  v_next_on date;
  v_due integer := 0;
  v_overdue integer := 0;
  v_row public.vehicle_maintenance_status%rowtype;
  s record;
  v_s public.maintenance_state;
begin
  select greatest(coalesce(v.odometer_km, 0), coalesce(app.last_odometer_km(p_vehicle_id), 0))
    into v_odo
  from public.vehicles v where v.id = p_vehicle_id;

  if v_odo is null then
    raise exception 'NOT_FOUND: vehicle' using errcode = 'P0002';
  end if;

  select * into v_t from app.fleet_thresholds(p_vehicle_id);

  for s in
    select * from public.maintenance_schedules ms
    where ms.vehicle_id = p_vehicle_id and ms.is_active
  loop
    v_s := app.maintenance_state_for(
      s.due_km, s.due_on, v_odo, (now() at time zone 'Asia/Aden')::date,
      v_t.remind_km, v_t.remind_days
    );

    if v_s = 'overdue' then
      v_overdue := v_overdue + 1;
    end if;
    if v_s <> 'ok' then
      v_due := v_due + 1;
    end if;

    if v_s = 'overdue' then
      v_state := 'overdue';
      v_worst := s.id;
    elsif v_s = 'due_soon' and v_state <> 'overdue' then
      v_state := 'due_soon';
      v_worst := coalesce(v_worst, s.id);
    end if;

    if s.due_km is not null and (v_next_km is null or s.due_km < v_next_km) then
      v_next_km := s.due_km;
    end if;
    if s.due_on is not null and (v_next_on is null or s.due_on < v_next_on) then
      v_next_on := s.due_on;
    end if;
  end loop;

  insert into public.vehicle_maintenance_status as st (
    vehicle_id, state, worst_schedule_id, next_due_km, next_due_on,
    due_count, overdue_count, computed_at
  ) values (
    p_vehicle_id, v_state, v_worst, v_next_km, v_next_on, v_due, v_overdue, now()
  )
  on conflict (vehicle_id) do update set
    state = excluded.state,
    worst_schedule_id = excluded.worst_schedule_id,
    next_due_km = excluded.next_due_km,
    next_due_on = excluded.next_due_on,
    due_count = excluded.due_count,
    overdue_count = excluded.overdue_count,
    computed_at = excluded.computed_at
  returning * into v_row;

  return v_row;
end;
$$;

/**
 * Tank-to-tank consumption, newest first.
 *
 * A segment runs from one full tank to the next, and its litres are everything put in *since* the
 * previous full tank — including partial fills, which is the only way a driver who tops up mid-week is
 * not invisible. Segments with no previous full tank (the first one ever) carry no distance and are
 * dropped: a consumption figure needs two readings.
 */
create or replace function app.fuel_segments(p_vehicle_id uuid, p_limit integer default 12)
returns table (
  from_km integer,
  to_km integer,
  distance_km integer,
  litres numeric,
  cost_yer bigint,
  l_per_100km numeric,
  cost_per_km_yer numeric,
  filled_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with logs as (
    select f.odometer_km, f.litres, f.total_cost_yer, f.filled_at, f.is_full_tank
    from public.fuel_logs f
    where f.vehicle_id = p_vehicle_id and f.deleted_at is null
  ),
  marks as (
    select l.*,
      -- How many full tanks ended *before* this row. Every row between two full tanks shares a number,
      -- and the full tank that closes a segment carries the number of the segment it closes.
      count(*) filter (where l.is_full_tank) over (
        order by l.odometer_km, l.filled_at
        rows between unbounded preceding and 1 preceding
      ) as seg
    from logs l
  ),
  segments as (
    select m.seg,
           sum(m.litres) as litres,
           sum(m.total_cost_yer) as cost_yer,
           max(m.odometer_km) as to_km,
           max(m.filled_at) as filled_at,
           bool_or(m.is_full_tank) as closed
    from marks m
    group by m.seg
  ),
  ordered as (
    select s.*, lag(s.to_km) over (order by s.seg) as from_km
    from segments s
  )
  select
    o.from_km,
    o.to_km,
    o.to_km - o.from_km,
    o.litres,
    o.cost_yer,
    case when o.to_km > o.from_km then round(o.litres * 100 / (o.to_km - o.from_km), 2) end,
    case when o.to_km > o.from_km then round(o.cost_yer::numeric / (o.to_km - o.from_km), 2) end,
    o.filled_at
  from ordered o
  where o.closed
    and o.from_km is not null
    and o.to_km > o.from_km
  order by o.to_km desc
  limit greatest(coalesce(p_limit, 12), 1);
$$;

-- ---------------------------------------------------------------------------
-- 7. Expenses are written by the database
-- ---------------------------------------------------------------------------

/** Fuel → one expense row, keyed to the log so a double insert is impossible. */
create or replace function app.expense_from_fuel_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vehicle public.vehicles%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into v_vehicle from public.vehicles v where v.id = new.vehicle_id;

    insert into public.expenses (
      owner_user_id, owner_org_id, vehicle_id, trip_id, category, amount_yer,
      incurred_on, description, source, source_id, recorded_by
    ) values (
      v_vehicle.owner_user_id, v_vehicle.owner_org_id, new.vehicle_id, new.trip_id, 'fuel',
      new.total_cost_yer,
      (new.filled_at at time zone 'Asia/Aden')::date,
      coalesce(new.station_name, 'fuel'), 'fuel_log', new.id, new.recorded_by
    )
    on conflict (source, source_id) do nothing;

    return new;
  end if;

  if new.deleted_at is not null and old.deleted_at is null then
    update public.expenses
    set deleted_at = new.deleted_at, deleted_by = new.deleted_by, delete_reason = 'source_deleted'
    where source = 'fuel_log' and source_id = new.id and deleted_at is null;

    -- The reversal is owed to the ledger, not invented here. Phase 10 fills `reversal_entry_id`; until
    -- then the audit row is the record that a reversing entry is outstanding.
    perform app.write_audit(
      new.deleted_by, 'expense.reversePending', 'expense', new.id::text, null,
      jsonb_build_object('source', 'fuel_log', 'reason', 'source_deleted'),
      'source_deleted', null, null
    );
  end if;

  return new;
end;
$$;

/** Maintenance → one expense row, same contract as fuel. */
create or replace function app.expense_from_maintenance_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vehicle public.vehicles%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into v_vehicle from public.vehicles v where v.id = new.vehicle_id;

    -- A free service is still a service: the row records the work with a zero amount rather than
    -- vanishing, so the maintenance history does not lie about what was done.
    insert into public.expenses (
      owner_user_id, owner_org_id, vehicle_id, category, amount_yer,
      incurred_on, description, source, source_id, recorded_by
    ) values (
      v_vehicle.owner_user_id, v_vehicle.owner_org_id, new.vehicle_id, 'maintenance',
      new.cost_yer, new.performed_on,
      coalesce(new.vendor, new.kind::text), 'maintenance_record', new.id, new.recorded_by
    )
    on conflict (source, source_id) do nothing;

    return new;
  end if;

  if new.deleted_at is not null and old.deleted_at is null then
    update public.expenses
    set deleted_at = new.deleted_at, deleted_by = new.deleted_by, delete_reason = 'source_deleted'
    where source = 'maintenance_record' and source_id = new.id and deleted_at is null;

    perform app.write_audit(
      new.deleted_by, 'expense.reversePending', 'expense', new.id::text, null,
      jsonb_build_object('source', 'maintenance_record', 'reason', 'source_deleted'),
      'source_deleted', null, null
    );
  end if;

  return new;
end;
$$;

create trigger fuel_logs_expense
  after insert or update of deleted_at on public.fuel_logs
  for each row execute function app.expense_from_fuel_log();

create trigger maintenance_records_expense
  after insert or update of deleted_at on public.maintenance_records
  for each row execute function app.expense_from_maintenance_record();

/**
 * Keep the derived state honest on every write this table can see.
 *
 * A trigger rather than a line in each command: a schedule edited by `upsert`, a record added by
 * `mark_done`, or a row fixed by a migration all change the answer, and a dashboard that is stale until
 * some unrelated command runs is worse than no dashboard.
 */
create or replace function app.touch_maintenance_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform app.recompute_maintenance_status(old.vehicle_id);
    return old;
  end if;

  perform app.recompute_maintenance_status(new.vehicle_id);
  if tg_op = 'UPDATE' and old.vehicle_id <> new.vehicle_id then
    perform app.recompute_maintenance_status(old.vehicle_id);
  end if;
  return new;
end;
$$;

create trigger maintenance_schedules_touch_status
  after insert or update or delete on public.maintenance_schedules
  for each row execute function app.touch_maintenance_status();

create trigger maintenance_records_touch_status
  after insert or delete on public.maintenance_records
  for each row execute function app.touch_maintenance_status();

/**
 * The two writes the schedule triggers cannot see: a reading, and the vehicle's own total.
 *
 * A trip ending at 130 000 km on a van whose oil was due at 125 000 changes the answer, and until this
 * existed the answer stayed wrong until the next morning's sweep — which meant the trip gate could let the
 * same van out again on the strength of a stale `ok`. The odometer is the input the state machine reads, so
 * every write to it recomputes.
 */
create or replace function app.touch_status_from_odometer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.recompute_maintenance_status(new.vehicle_id);
  return new;
end;
$$;

create trigger odometer_readings_touch_status
  after insert on public.odometer_readings
  for each row execute function app.touch_status_from_odometer();

create or replace function app.touch_status_from_vehicle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.recompute_maintenance_status(new.id);
  return new;
end;
$$;

create trigger vehicles_odometer_touch_status
  after update of odometer_km on public.vehicles
  for each row
  when (old.odometer_km is distinct from new.odometer_km)
  execute function app.touch_status_from_vehicle();

-- ---------------------------------------------------------------------------
-- 8. Commands
-- ---------------------------------------------------------------------------

/** The driver row for an actor, if they are one. Used to attribute a fill to the person who made it. */
create or replace function app.driver_id_for_user(p_uid uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id from public.driver_profiles d
  where d.user_id = p_uid and d.status = 'active'
  limit 1;
$$;

/**
 * "I filled 38 litres at 19 000 and the clock said 121 900."
 *
 * One transaction writes four things that must agree: the log, the vehicle's odometer, an odometer
 * reading (so the history in `odometer_readings` stays the single answer to "how far has this van
 * been?"), and — through a trigger — the expense. The consumption anomaly is *reported*, never a
 * refusal: a van that suddenly drinks 40% more is a symptom, and refusing the fill would hide it.
 */
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

  -- A fill may name the trip it happened on, but only a trip this vehicle actually drove.
  v_trip := nullif(p_log ->> 'tripId', '')::uuid;
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
    nullif(p_log ->> 'stationPlaceId', '')::uuid,
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
    'lPer100Km', v_newest
  );
end;
$$;

/**
 * A manual odometer reading, with the one legitimate way to go backwards.
 *
 * A lower reading is refused (`ODO_REGRESSION`) unless the *owner* supplies `overrideReason`. The
 * override stores the reading, keeps the vehicle's total at its high-water mark (the van's real mileage
 * did not decrease), and writes the reason into the audit row and the reading's note. That is the whole
 * difference between a correction and a cover-up: who asked, why, and on the record.
 */
create or replace function public.cmd_record_manual_odometer(
  p_actor uuid,
  p_vehicle_id uuid,
  p_reading jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_km integer;
  v_last integer;
  v_reason text;
  v_override boolean := false;
  v_reading public.odometer_readings%rowtype;
  v_photo text;
begin
  perform app.assert_vehicle_access(p_actor, p_vehicle_id);

  v_km := nullif(p_reading ->> 'odometerKm', '')::int;
  if v_km is null or v_km < 0 then
    raise exception 'VALIDATION: odometerKm is required' using errcode = '22023';
  end if;

  v_reason := nullif(btrim(p_reading ->> 'overrideReason'), '');
  v_photo := nullif(p_reading ->> 'photoPath', '');
  v_last := app.last_odometer_km(p_vehicle_id);

  if v_km < v_last then
    if v_reason is null then
      perform app.assert_odometer_advance(p_vehicle_id, v_km);
    end if;
    if not (app.owns_vehicle(p_vehicle_id, p_actor) or app.is_platform_staff(p_actor)) then
      raise exception 'FORBIDDEN: only the owner may correct a lower reading' using errcode = '42501';
    end if;
    v_override := true;
  end if;

  if v_photo is not null and not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'vehicle-documents' and o.name = v_photo
  ) then
    raise exception 'NOT_FOUND: the odometer photo is not uploaded' using errcode = 'P0002';
  end if;

  insert into public.odometer_readings (vehicle_id, reading_km, kind, recorded_by, note)
  values (
    p_vehicle_id, v_km, 'service', p_actor,
    case when v_override then 'manual correction: ' || v_reason else coalesce(nullif(btrim(p_reading ->> 'note'), ''), 'manual reading') end
  )
  returning * into v_reading;

  -- The high-water mark only ever rises: a correction preserves the record of the real distance.
  update public.vehicles
  set odometer_km = greatest(odometer_km, v_km)
  where id = p_vehicle_id;

  perform app.write_audit(
    p_actor, 'vehicle.recordOdometer', 'vehicle', p_vehicle_id::text,
    jsonb_build_object('odometerKm', v_last),
    jsonb_build_object('odometerKm', v_km, 'photoPath', v_photo, 'override', v_override),
    case when v_override then v_reason else null end,
    p_request_id, p_ip
  );

  return jsonb_build_object(
    'reading', to_jsonb(v_reading),
    'lastOdometerKm', v_last,
    'override', v_override
  );
end;
$$;

/**
 * Create or edit a maintenance rule.
 *
 * `due_km` / `due_on` are generated from the interval and the last completion, so this command only
 * records those two facts. A kilometres-based rule with no known starting point takes the vehicle's
 * current odometer — "oil every 5 000 km, starting from where the van is now" — which is what an owner
 * means when they set one up for the first time; making them invent a past date would be worse.
 */
create or replace function public.cmd_upsert_maintenance_schedule(
  p_actor uuid,
  p_vehicle_id uuid,
  p_schedule jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p_schedule ->> 'id', '')::uuid;
  v_kind public.maintenance_kind;
  v_interval_km integer := nullif(p_schedule ->> 'intervalKm', '')::int;
  v_interval_days integer := nullif(p_schedule ->> 'intervalDays', '')::int;
  v_last_km integer := nullif(p_schedule ->> 'lastDoneKm', '')::int;
  v_last_on date := nullif(p_schedule ->> 'lastDoneOn', '')::date;
  v_schedule public.maintenance_schedules%rowtype;
  v_status public.vehicle_maintenance_status%rowtype;
begin
  perform app.assert_vehicle_access(p_actor, p_vehicle_id, true);

  v_kind := (p_schedule ->> 'kind')::public.maintenance_kind;
  if v_kind is null then
    raise exception 'VALIDATION: kind is required' using errcode = '22023';
  end if;
  if v_interval_km is null and v_interval_days is null then
    raise exception 'VALIDATION: give an interval in kilometres or days' using errcode = '22023';
  end if;
  if v_interval_km is not null and (v_interval_km < 100 or v_interval_km > 500000) then
    raise exception 'VALIDATION: intervalKm is out of range' using errcode = '22023';
  end if;
  if v_interval_days is not null and (v_interval_days < 1 or v_interval_days > 3650) then
    raise exception 'VALIDATION: intervalDays is out of range' using errcode = '22023';
  end if;

  if v_interval_km is not null and v_last_km is null then
    v_last_km := app.last_odometer_km(p_vehicle_id);
  end if;
  if v_interval_days is not null and v_last_on is null then
    v_last_on := (now() at time zone 'Asia/Aden')::date;
  end if;

  if v_id is null then
    insert into public.maintenance_schedules (
      vehicle_id, kind, interval_km, interval_days, last_done_km, last_done_on, note, created_by
    ) values (
      p_vehicle_id, v_kind, v_interval_km, v_interval_days, v_last_km, v_last_on,
      nullif(btrim(p_schedule ->> 'note'), ''), p_actor
    )
    returning * into v_schedule;
  else
    update public.maintenance_schedules ms
    set kind = v_kind,
        interval_km = v_interval_km,
        interval_days = v_interval_days,
        last_done_km = v_last_km,
        last_done_on = v_last_on,
        note = nullif(btrim(p_schedule ->> 'note'), ''),
        is_active = coalesce((p_schedule ->> 'isActive')::boolean, ms.is_active)
    where ms.id = v_id and ms.vehicle_id = p_vehicle_id
    returning * into v_schedule;

    if not found then
      raise exception 'NOT_FOUND: schedule' using errcode = 'P0002';
    end if;
  end if;

  v_status := app.recompute_maintenance_status(p_vehicle_id);

  perform app.write_audit(
    p_actor, 'vehicle.upsertSchedule', 'vehicle', p_vehicle_id::text, null,
    jsonb_build_object(
      'scheduleId', v_schedule.id, 'kind', v_kind, 'dueKm', v_schedule.due_km,
      'dueOn', v_schedule.due_on
    ),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('schedule', to_jsonb(v_schedule), 'status', to_jsonb(v_status));
end;
$$;

/**
 * "The oil was changed at 121 400 km, 4 500 riyals, at the workshop on the ring road."
 *
 * Written as one function whether or not it closes a schedule: an ad-hoc repair (a tyre, a battery) is
 * the same row with `scheduleId` null, and both produce an expense through the same trigger.
 */
create or replace function public.cmd_log_maintenance(
  p_actor uuid,
  p_vehicle_id uuid,
  p_record jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule uuid := nullif(p_record ->> 'scheduleId', '')::uuid;
  v_kind public.maintenance_kind := nullif(p_record ->> 'kind', '')::public.maintenance_kind;
  v_performed date := coalesce(
    nullif(p_record ->> 'performedOn', '')::date, (now() at time zone 'Asia/Aden')::date
  );
  v_odo integer := nullif(p_record ->> 'odometerKm', '')::int;
  v_cost bigint := coalesce(nullif(p_record ->> 'costYer', '')::bigint, 0);
  v_record public.maintenance_records%rowtype;
  v_status public.vehicle_maintenance_status%rowtype;
begin
  perform app.assert_vehicle_access(p_actor, p_vehicle_id);

  if v_schedule is not null then
    select ms.kind into v_kind
    from public.maintenance_schedules ms
    where ms.id = v_schedule and ms.vehicle_id = p_vehicle_id;

    if not found then
      raise exception 'NOT_FOUND: schedule' using errcode = 'P0002';
    end if;
  end if;

  if v_kind is null then
    raise exception 'VALIDATION: kind is required' using errcode = '22023';
  end if;
  if v_odo is not null then
    perform app.assert_odometer_advance(p_vehicle_id, v_odo);
  end if;
  if v_cost < 0 then
    raise exception 'VALIDATION: costYer cannot be negative' using errcode = '22023';
  end if;

  insert into public.maintenance_records (
    vehicle_id, schedule_id, kind, performed_on, odometer_km, cost_yer,
    vendor, note, attachment_path, recorded_by
  ) values (
    p_vehicle_id, v_schedule, v_kind, v_performed, v_odo, v_cost,
    nullif(btrim(p_record ->> 'vendor'), ''),
    nullif(btrim(p_record ->> 'note'), ''),
    nullif(p_record ->> 'attachmentPath', ''),
    p_actor
  )
  returning * into v_record;

  if v_odo is not null then
    update public.vehicles set odometer_km = greatest(odometer_km, v_odo) where id = p_vehicle_id;
    insert into public.odometer_readings (vehicle_id, reading_km, kind, recorded_by, note)
    values (p_vehicle_id, v_odo, 'service', p_actor, 'maintenance');
  end if;

  v_status := app.recompute_maintenance_status(p_vehicle_id);

  perform app.write_audit(
    p_actor, 'vehicle.logMaintenance', 'vehicle', p_vehicle_id::text, null,
    jsonb_build_object(
      'recordId', v_record.id, 'kind', v_kind, 'costYer', v_cost,
      'odometerKm', v_odo, 'scheduleId', v_schedule
    ),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('record', to_jsonb(v_record), 'status', to_jsonb(v_status));
end;
$$;

/**
 * "The service is done" — the schedule's clock restarts.
 *
 * Distinct from logging a record because it *closes a rule*: `last_done_km` / `last_done_on` move, and
 * therefore `due_km` / `due_on` move with them. Doing this implicitly when any record happened to name
 * the schedule would mean a tyre rotation reset the oil interval.
 */
create or replace function public.cmd_mark_maintenance_done(
  p_actor uuid,
  p_schedule_id uuid,
  p_record jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule public.maintenance_schedules%rowtype;
  v_odo integer := nullif(coalesce(p_record ->> 'odometerKm', p_record ->> 'lastDoneKm'), '')::int;
  v_done_on date := coalesce(
    nullif(p_record ->> 'performedOn', '')::date, (now() at time zone 'Asia/Aden')::date
  );
  v_result jsonb;
begin
  select * into v_schedule from public.maintenance_schedules ms where ms.id = p_schedule_id;
  if not found then
    raise exception 'NOT_FOUND: schedule' using errcode = 'P0002';
  end if;

  perform app.assert_vehicle_access(p_actor, v_schedule.vehicle_id, true);

  if v_schedule.interval_km is not null and v_odo is null then
    v_odo := greatest(app.last_odometer_km(v_schedule.vehicle_id), v_schedule.last_done_km);
  end if;

  if v_odo is not null and v_schedule.last_done_km is not null and v_odo < v_schedule.last_done_km then
    raise exception 'ODO_REGRESSION: this schedule was completed at % km, not % km',
      v_schedule.last_done_km, v_odo using errcode = '22023';
  end if;

  -- The record first: it is the evidence, and its trigger writes the expense.
  v_result := public.cmd_log_maintenance(
    p_actor, v_schedule.vehicle_id,
    coalesce(p_record, '{}'::jsonb) || jsonb_build_object(
      'scheduleId', v_schedule.id,
      'kind', v_schedule.kind,
      'odometerKm', v_odo,
      'performedOn', v_done_on
    ),
    p_request_id, p_ip
  );

  update public.maintenance_schedules ms
  set last_done_km = coalesce(v_odo, ms.last_done_km),
      last_done_on = v_done_on
  where ms.id = p_schedule_id
  returning * into v_schedule;

  perform app.write_audit(
    p_actor, 'vehicle.maintenanceDone', 'vehicle', v_schedule.vehicle_id::text, null,
    jsonb_build_object(
      'scheduleId', p_schedule_id, 'odometerKm', v_odo, 'doneOn', v_done_on,
      'dueKm', v_schedule.due_km, 'dueOn', v_schedule.due_on
    ),
    null, p_request_id, p_ip
  );

  -- The record's own trigger recomputed the status *before* the schedule moved, so the answer it left in
  -- `v_result` is one interval stale. Return the recomputed row: a client that trusts this response must
  -- not be told "overdue" about work it has just recorded.
  return v_result || jsonb_build_object(
    'schedule', to_jsonb(v_schedule),
    'status', to_jsonb(app.recompute_maintenance_status(v_schedule.vehicle_id))
  );
end;
$$;

/** Thresholds, one row per owner. Absent means defaults; this is how an owner changes them. */
create or replace function public.cmd_update_fleet_settings(
  p_actor uuid,
  p_org_id uuid,
  p_settings jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.fleet_settings%rowtype;
  v_role public.member_role;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  if p_org_id is not null then
    v_role := app.org_role(p_org_id, p_actor);
    if not (v_role in ('owner', 'manager') or app.is_platform_staff(p_actor)) then
      raise exception 'FORBIDDEN: only an owner or manager sets fleet thresholds' using errcode = '42501';
    end if;
  end if;

  -- Two branches rather than one upsert: the unique index that makes `on conflict` work is on a single
  -- column, and a personal row has no org id to conflict on (and the reverse).
  if p_org_id is null then
    insert into public.fleet_settings (
      owner_user_id, remind_km, remind_days, block_overdue_assignment, fuel_anomaly_percent, updated_by
    ) values (
      p_actor,
      coalesce(nullif(p_settings ->> 'remindKm', '')::int, 500),
      coalesce(nullif(p_settings ->> 'remindDays', '')::int, 14),
      coalesce((p_settings ->> 'blockOverdueAssignment')::boolean, false),
      coalesce(nullif(p_settings ->> 'fuelAnomalyPercent', '')::int, 25),
      p_actor
    )
    on conflict (owner_user_id) do update set
      remind_km = excluded.remind_km,
      remind_days = excluded.remind_days,
      block_overdue_assignment = excluded.block_overdue_assignment,
      fuel_anomaly_percent = excluded.fuel_anomaly_percent,
      updated_by = excluded.updated_by
    returning * into v_settings;
  else
    insert into public.fleet_settings (
      owner_org_id, remind_km, remind_days, block_overdue_assignment, fuel_anomaly_percent, updated_by
    ) values (
      p_org_id,
      coalesce(nullif(p_settings ->> 'remindKm', '')::int, 500),
      coalesce(nullif(p_settings ->> 'remindDays', '')::int, 14),
      coalesce((p_settings ->> 'blockOverdueAssignment')::boolean, false),
      coalesce(nullif(p_settings ->> 'fuelAnomalyPercent', '')::int, 25),
      p_actor
    )
    on conflict (owner_org_id) do update set
      remind_km = excluded.remind_km,
      remind_days = excluded.remind_days,
      block_overdue_assignment = excluded.block_overdue_assignment,
      fuel_anomaly_percent = excluded.fuel_anomaly_percent,
      updated_by = excluded.updated_by
    returning * into v_settings;
  end if;

  perform app.write_audit(
    p_actor, 'vehicle.updateFleetSettings',
    case when p_org_id is null then 'profile' else 'organization' end,
    coalesce(p_org_id, p_actor)::text, null, to_jsonb(v_settings),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('settings', to_jsonb(v_settings));
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Reads: the health card and the rollup
-- ---------------------------------------------------------------------------

/**
 * One vehicle, everything the card shows: distance, consumption, what is due, and what it cost.
 *
 * The read is scoped to people who are allowed to touch the vehicle — the owner, the assigned driver,
 * staff — because it contains a driver's habits and the owner's spending. A driver sees their van's
 * health (they are the one who reports a noise); they do not see the invoices of the whole fleet.
 *
 * Not `stable`: when the derived status row is missing (a vehicle whose schedules predate the trigger)
 * this read fills it in rather than showing every schedule as `ok`, and a stable function may not write.
 */
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'scheduleId', r.schedule_id, 'kind', r.kind, 'performedOn', r.performed_on,
    'odometerKm', r.odometer_km, 'costYer', r.cost_yer, 'vendor', r.vendor, 'note', r.note
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
      'lifetimeLPer100Km', v_lifetime,
      'lifetimeCostYer', coalesce(v_lifetime_cost, 0),
      'lifetimeDistanceKm', coalesce(v_lifetime_km, 0),
      -- Cost per kilometre over the segments we have; null rather than a division by zero.
      'costPerKmYer',
        case when coalesce(v_lifetime_km, 0) > 0
          then round(coalesce(v_lifetime_cost, 0)::numeric / v_lifetime_km, 2) end,
      'segments', v_segments
    ),
    'expenses', jsonb_build_object(
      'monthTotalYer', v_month,
      'byCategory', v_by_category
    ),
    'thresholds', jsonb_build_object(
      'remindKm', v_th.remind_km,
      'remindDays', v_th.remind_days,
      'blockOverdueAssignment', v_th.block_overdue,
      'fuelAnomalyPercent', v_th.fuel_anomaly_percent
    )
  );
end;
$$;

/**
 * The fleet rollup: one row per vehicle plus the totals the dashboard shows.
 *
 * Deliberately derived from the same `fuel_segments` and `vehicle_maintenance_status` the individual
 * cards use — a rollup that sums its own query is a second implementation of the same number, and the
 * acceptance criterion for this phase is that the totals *reconcile* with the underlying logs.
 */
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
      'recentLPer100Km', (select s.l_per_100km from app.fuel_segments(v.id, 1) s),
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
-- 10. The daily sweep: recompute, then tell somebody — once
-- ---------------------------------------------------------------------------

/**
 * Maintenance reminders.
 *
 * The dedupe rule is the whole design: notify when the state *changes* to due/overdue, and again only
 * after it has been dealt with and comes back. A van that has been overdue for three weeks produces one
 * notification, not twenty-one — a bell nobody can clear is a bell nobody reads.
 */
create or replace function app.job_maintenance_scan(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_vehicle record;
  v_status public.vehicle_maintenance_status%rowtype;
  v_kind public.notification_kind;
  v_key text;
  v_params jsonb;
  v_user uuid;
begin
  for v_vehicle in
    select v.id, v.plate_number, v.owner_user_id, v.owner_org_id
    from public.vehicles v
    where v.is_active
      and exists (
        select 1 from public.maintenance_schedules ms
        where ms.vehicle_id = v.id and ms.is_active
      )
    order by v.created_at
    limit greatest(coalesce(p_limit, 500), 1)
  loop
    v_status := app.recompute_maintenance_status(v_vehicle.id);

    if v_status.state = 'ok' then
      -- Back to healthy: forget what we told them, so the next lapse is news again.
      update public.vehicle_maintenance_status
      set last_notified_state = null
      where vehicle_id = v_vehicle.id and last_notified_state is not null;
      continue;
    end if;

    if v_status.last_notified_state is not distinct from v_status.state then
      continue;
    end if;

    v_kind := case when v_status.state = 'overdue'
      then 'vehicle_maintenance_overdue'::public.notification_kind
      else 'vehicle_maintenance_due'::public.notification_kind
    end;
    v_key := case when v_status.state = 'overdue'
      then 'notifications.vehicleMaintenanceOverdue'
      else 'notifications.vehicleMaintenanceDue'
    end;
    -- One readable "due" string rather than two nullable numbers: a date-based rule has no kilometre
    -- figure, and "due at null km" is not a sentence in either language.
    v_params := jsonb_build_object(
      'plate', v_vehicle.plate_number,
      'dueKm', v_status.next_due_km,
      'dueOn', v_status.next_due_on,
      'due', case
        when v_status.next_due_km is not null
          then v_status.next_due_km::text || ' km'
        else to_char(v_status.next_due_on, 'YYYY-MM-DD')
      end
    );

    if v_vehicle.owner_user_id is not null then
      perform app.notify(v_vehicle.owner_user_id, v_kind, v_key, v_params,
                         '/operator/vehicles/' || v_vehicle.id || '/health');
      v_count := v_count + 1;
    elsif v_vehicle.owner_org_id is not null then
      for v_user in
        select m.user_id from public.organization_members m
        where m.org_id = v_vehicle.owner_org_id
          and m.status = 'active' and m.user_id is not null
          and m.role in ('owner', 'manager')
      loop
        perform app.notify(v_user, v_kind, v_key, v_params,
                           '/operator/vehicles/' || v_vehicle.id || '/health');
        v_count := v_count + 1;
      end loop;
    end if;

    update public.vehicle_maintenance_status
    set last_notified_state = v_status.state, last_notified_at = now()
    where vehicle_id = v_vehicle.id;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. The trip gate grows a maintenance condition
-- ---------------------------------------------------------------------------

/**
 * Re-created from 00017 with one addition: when the owner has switched on
 * `block_overdue_assignment`, a vehicle whose maintenance is overdue cannot be put on a trip.
 *
 * It lives here — in the predicate that create, update *and* publish already call — rather than in a new
 * `if` in each command, for the same reason 00017 did it: one gate cannot be half-applied. The setting is
 * off by default because a workshop appointment is not a reason to strand passengers; an owner who wants
 * the stricter rule asks for it.
 */
create or replace function app.assert_trip_vehicle(p_vehicle_id uuid, p_owner_user uuid, p_owner_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vehicle public.vehicles%rowtype;
  v_th record;
  v_state public.maintenance_state;
begin
  select * into v_vehicle from public.vehicles v where v.id = p_vehicle_id;
  if not found then
    raise exception 'NOT_FOUND: vehicle' using errcode = 'P0002';
  end if;

  if not (
    (p_owner_org is not null and v_vehicle.owner_org_id = p_owner_org)
    or (p_owner_user is not null and v_vehicle.owner_user_id = p_owner_user)
  ) then
    raise exception 'FORBIDDEN: the vehicle belongs to another owner' using errcode = '42501';
  end if;

  if v_vehicle.verification_status <> 'verified' then
    raise exception 'NOT_VERIFIED: the vehicle is not verified' using errcode = '42501';
  end if;

  if v_vehicle.status <> 'active' or not v_vehicle.is_active then
    raise exception 'CONFLICT: the vehicle is % and cannot be scheduled', v_vehicle.status
      using errcode = '23505';
  end if;

  -- The trip's own gate, so a stale tab and a fresh one are refused by the same rule.
  if v_vehicle.inspection_expiry is not null and v_vehicle.inspection_expiry < current_date then
    raise exception 'CONFLICT: the vehicle inspection expired on %', v_vehicle.inspection_expiry
      using errcode = '23505';
  end if;

  if v_vehicle.insurance_expiry is not null and v_vehicle.insurance_expiry < current_date then
    raise exception 'CONFLICT: the vehicle insurance expired on %', v_vehicle.insurance_expiry
      using errcode = '23505';
  end if;

  if v_vehicle.registration_expiry is not null and v_vehicle.registration_expiry < current_date then
    raise exception 'CONFLICT: the vehicle registration expired on %', v_vehicle.registration_expiry
      using errcode = '23505';
  end if;

  select * into v_th from app.fleet_thresholds(p_vehicle_id);

  if v_th.block_overdue then
    v_state := app.maintenance_state_for(
      (select min(ms.due_km) from public.maintenance_schedules ms
        where ms.vehicle_id = p_vehicle_id and ms.is_active),
      (select min(ms.due_on) from public.maintenance_schedules ms
        where ms.vehicle_id = p_vehicle_id and ms.is_active),
      v_vehicle.odometer_km,
      (now() at time zone 'Asia/Aden')::date,
      v_th.remind_km, v_th.remind_days
    );

    if v_state = 'overdue' then
      raise exception 'MAINTENANCE_OVERDUE: this vehicle has overdue maintenance and the owner blocks assignments while it is overdue'
        using errcode = '23505';
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Access
-- ---------------------------------------------------------------------------

alter table public.fleet_settings enable row level security;
alter table public.fuel_logs enable row level security;
alter table public.maintenance_schedules enable row level security;
alter table public.maintenance_records enable row level security;
alter table public.vehicle_maintenance_status enable row level security;
alter table public.expenses enable row level security;

-- Fuel and maintenance are operational data: whoever may drive the van may read what it drank. The
-- money is narrower — expenses are the owner's ledger, not the driver's business.
create policy fuel_logs_read_involved on public.fuel_logs
  for select to authenticated
  using (app.owns_vehicle(vehicle_id) or app.is_assigned_driver(vehicle_id) or app.is_platform_staff());

create policy maintenance_schedules_read_involved on public.maintenance_schedules
  for select to authenticated
  using (app.owns_vehicle(vehicle_id) or app.is_assigned_driver(vehicle_id) or app.is_platform_staff());

create policy maintenance_records_read_involved on public.maintenance_records
  for select to authenticated
  using (app.owns_vehicle(vehicle_id) or app.is_assigned_driver(vehicle_id) or app.is_platform_staff());

create policy vehicle_maintenance_status_read_involved on public.vehicle_maintenance_status
  for select to authenticated
  using (app.owns_vehicle(vehicle_id) or app.is_assigned_driver(vehicle_id) or app.is_platform_staff());

create policy expenses_read_owner_or_staff on public.expenses
  for select to authenticated
  using (
    (owner_user_id is not null and owner_user_id = app.uid())
    or (owner_org_id is not null and app.is_org_member(owner_org_id))
    or app.is_platform_staff()
  );

create policy fleet_settings_read_owner_or_staff on public.fleet_settings
  for select to authenticated
  using (
    (owner_user_id is not null and owner_user_id = app.uid())
    or (owner_org_id is not null and app.is_org_member(owner_org_id))
    or app.is_platform_staff()
  );

grant select on public.fuel_logs to authenticated;
grant select on public.maintenance_schedules to authenticated;
grant select on public.maintenance_records to authenticated;
grant select on public.vehicle_maintenance_status to authenticated;
grant select on public.expenses to authenticated;
grant select on public.fleet_settings to authenticated;

-- A policy evaluates its predicate as the caller, so the helpers it calls must be executable by them.
grant execute on function app.owns_vehicle(uuid, uuid) to authenticated;
grant execute on function app.is_assigned_driver(uuid, uuid) to authenticated;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.cmd_log_fuel(uuid, uuid, jsonb, text, inet)',
    'public.cmd_record_manual_odometer(uuid, uuid, jsonb, text, inet)',
    'public.cmd_upsert_maintenance_schedule(uuid, uuid, jsonb, text, inet)',
    'public.cmd_log_maintenance(uuid, uuid, jsonb, text, inet)',
    'public.cmd_mark_maintenance_done(uuid, uuid, jsonb, text, inet)',
    'public.cmd_update_fleet_settings(uuid, uuid, jsonb, text, inet)',
    'public.get_vehicle_health(uuid, uuid)',
    'public.get_fleet_summary(uuid, uuid)',
    'app.job_maintenance_scan(integer)',
    'app.recompute_maintenance_status(uuid)',
    'app.fuel_segments(uuid, integer)',
    'app.expense_from_fuel_log()',
    'app.expense_from_maintenance_record()',
    'app.touch_maintenance_status()',
    'app.touch_status_from_odometer()',
    'app.touch_status_from_vehicle()'
  ]
  loop
    continue when to_regprocedure(v_signature) is null;
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

/**
 * The two session-bound wrappers, in the Phase 7 shape: no actor parameter, so the only identity these
 * can use is the one on the request's JWT. The web server components call these; the gateways call the
 * `p_actor` versions with the id they resolved from the bearer token.
 */
create or replace function public.vehicle_health(p_vehicle_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.get_vehicle_health(app.uid(), p_vehicle_id);
$$;

create or replace function public.fleet_summary(p_org_id uuid default null)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.get_fleet_summary(app.uid(), p_org_id);
$$;

grant execute on function public.vehicle_health(uuid) to authenticated, service_role;
grant execute on function public.fleet_summary(uuid) to authenticated, service_role;
revoke all on function public.vehicle_health(uuid) from anon;
revoke all on function public.fleet_summary(uuid) from anon;

-- ---------------------------------------------------------------------------
-- 13. Backfill: every scheduled vehicle gets its derived row
-- ---------------------------------------------------------------------------

do $$
declare
  v_vehicle uuid;
begin
  for v_vehicle in
    select distinct ms.vehicle_id from public.maintenance_schedules ms where ms.is_active
  loop
    perform app.recompute_maintenance_status(v_vehicle);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. The schedule, where a scheduler exists
-- ---------------------------------------------------------------------------
-- 06:00 UTC is 09:00 in Aden: the reminder lands when a workshop can still be telephoned, not at 2 a.m.

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available here; app.job_maintenance_scan is still callable by name';
    return;
  end if;

  begin
    execute 'create extension if not exists pg_cron';
  exception
    when others then
      raise notice 'pg_cron could not be created (%); leaving the schedule to the platform', sqlerrm;
      return;
  end;

  execute $q$select cron.schedule('maak_maintenance_scan', '0 6 * * *',
                                   'select app.job_maintenance_scan(500)')$q$;
end;
$$;

-- ---------------------------------------------------------------------------
-- 15. Comments — the schema is the documentation the next migration reads
-- ---------------------------------------------------------------------------

comment on table public.fuel_logs is
  'One row per fill. `total_cost_yer` is generated from litres × price; a full tank closes a consumption '
  'segment in `app.fuel_segments`, a partial one still counts as an expense and a reading.';

comment on table public.maintenance_schedules is
  'The rule: an interval in kilometres, in days, or both, anchored at the last completion. `due_km` and '
  '`due_on` are generated, so the due point cannot drift from the interval.';

comment on table public.maintenance_records is
  'The evidence: what was actually done, when, at what distance and for how much. One of these is what '
  'resets a schedule, through `cmd_mark_maintenance_done`.';

comment on function public.cmd_log_fuel(uuid, uuid, jsonb, text, inet) is
  'Fuel in, odometer forward, expense written. An implausible tank-to-tank consumption is flagged in the '
  'response (`anomaly`), never refused: a van that drinks 40% more is a symptom, not a data error.';

comment on function public.cmd_record_manual_odometer(uuid, uuid, jsonb, text, inet) is
  'BR-16. A lower reading is refused unless the owner supplies an override reason, which is then stored '
  'on the reading and in the audit row. The vehicle total keeps its high-water mark either way.';

comment on function app.maintenance_state_for(integer, date, integer, date, integer, integer) is
  'ok / due_soon / overdue, from a due point and today. The same function the card, the badge, the '
  'rollup and the trip gate use — there is no second opinion about what "due" means.';
