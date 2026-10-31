-- 00013 — Phase 3: fleet (vehicles, drivers, assignments, odometer baseline)
--
-- One owner per vehicle, either an individual (`owner_user_id`) or an organization
-- (`owner_org_id`) — never both, never neither. That single rule is what makes every scope question in
-- this phase answerable: RLS, the commands, and Phase 4's trip ownership all read it.
--
-- Two rules carried over from the Phase 2 review, deliberately:
--   · a decision is made once — nothing here can be re-decided (see `cmd_decide_vehicle_verification`);
--   · a duplicate is a field error, not a 500 — plate numbers surface as a *warning* on create and a
--     `DUPLICATE_REFERENCE` on the assignment that would actually collide.
--
-- Quotas come from `public.plans` / `public.plan_limits` (specs.md §6.14). They are data, not code:
-- an admin edits a row, not a migration. A missing plan row falls back to Basic, which is the *lowest*
-- tier — a bug here under-grants rather than handing out unlimited.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

create type public.vehicle_body_type as enum (
  'sedan', 'hatchback', 'suv', 'pickup', 'van', 'minibus', 'bus', 'coach', 'truck', 'other'
);

create type public.drive_type as enum ('front_wheel_drive', 'rear_wheel_drive', 'four_wheel_drive', 'all_wheel_drive');

create type public.transmission as enum ('manual', 'automatic', 'cvt', 'dual_clutch');

create type public.fuel_type as enum ('petrol', 'diesel', 'hybrid', 'electric', 'lpg');

create type public.vehicle_condition as enum ('new', 'used', 'refurbished');

create type public.vehicle_condition_rating as enum ('excellent', 'good', 'fair', 'poor');

create type public.vehicle_ownership_kind as enum ('owned', 'leased', 'financed');

create type public.vehicle_status as enum ('draft', 'active', 'suspended', 'retired');

create type public.driver_status as enum ('invited', 'active', 'suspended', 'revoked');

create type public.odometer_kind as enum ('baseline', 'trip_start', 'trip_end', 'service');

-- ---------------------------------------------------------------------------
-- 2. Plans and quotas (§6.14 — values are data)
-- ---------------------------------------------------------------------------

create table public.plans (
  code        public.plan_code primary key,
  name_ar     text not null,
  name_en     text not null,
  price_yer   integer not null default 0 check (price_yer >= 0),
  trial_days  integer not null default 0 check (trial_days >= 0),
  -- Soft means "warn and allow" (Pro/Business grace); hard means "block with an upgrade prompt".
  soft_limit  boolean not null default false,
  features    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create table public.plan_limits (
  plan_code   public.plan_code not null references public.plans (code) on delete cascade,
  metric      text not null check (
                metric in ('vehicles', 'trips', 'staff', 'drivers', 'active_trips', 'featured_listings')
              ),
  -- NULL = unlimited. Deliberately not 0, because 0 is a real and different limit (featured listings
  -- on Basic), and conflating the two would let a paid tier look free.
  limit_value integer check (limit_value is null or limit_value >= 0),
  primary key (plan_code, metric)
);

insert into public.plans (code, name_ar, name_en, price_yer, trial_days, soft_limit) values
  ('basic',    'الأساسية', 'Basic',    0,     0,  false),
  ('pro',      'الاحترافية', 'Pro',    7500,  14, true),
  ('business', 'الأعمال', 'Business',  25000, 14, true)
on conflict (code) do nothing;

insert into public.plan_limits (plan_code, metric, limit_value) values
  ('basic', 'vehicles', 1), ('basic', 'trips', 5), ('basic', 'staff', 1),
  ('basic', 'drivers', 1), ('basic', 'active_trips', 1), ('basic', 'featured_listings', 0),
  ('pro', 'vehicles', 5), ('pro', 'trips', 50), ('pro', 'staff', 5),
  ('pro', 'drivers', 10), ('pro', 'active_trips', 5), ('pro', 'featured_listings', 2),
  ('business', 'vehicles', null), ('business', 'trips', null), ('business', 'staff', null),
  ('business', 'drivers', null), ('business', 'active_trips', null), ('business', 'featured_listings', 10)
on conflict (plan_code, metric) do nothing;

create trigger plans_set_updated_at
  before update on public.plans
  for each row execute function app.set_updated_at();

/**
 * The plan that governs an owner: an organization's own plan, or the individual's.
 *
 * `app.owner_effective_plan` is still the Phase 1 stub returning Basic for individuals; Phase 10 replaces
 * its body. Routing every caller through this one function means that replacement needs no other change.
 */
create or replace function app.owner_plan(p_owner_user uuid, p_owner_org uuid)
returns public.plan_code
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_owner_org is not null then app.org_effective_plan(p_owner_org)
    when p_owner_user is not null then app.owner_effective_plan(p_owner_user)
    else 'basic'::public.plan_code
  end;
$$;

/**
 * "May this owner add one more `<metric>`?" — raises `QUOTA_EXCEEDED` when not.
 *
 * Usage is counted live rather than from a counter table: a counter is a second source of truth that
 * drifts the first time something is deleted outside the command. Phase 10 adds period-scoped counters
 * for the *time-based* metrics (trips per month); the counting rule here does not change.
 *
 * The detail is a stable, machine-readable string (`metric=vehicles limit=1 used=1`) that
 * `@maak/core` parses into `error.context`, so the UI can offer the right upgrade without parsing prose.
 */
create or replace function app.assert_quota(
  p_owner_user uuid,
  p_owner_org uuid,
  p_metric text,
  p_delta integer default 1
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan public.plan_code;
  v_limit integer;
  v_used integer;
  v_soft boolean;
begin
  v_plan := app.owner_plan(p_owner_user, p_owner_org);

  select l.limit_value, coalesce(p.soft_limit, false)
  into v_limit, v_soft
  from public.plan_limits l
  join public.plans p on p.code = l.plan_code
  where l.plan_code = v_plan and l.metric = p_metric;

  -- A metric the plan table does not define is a programming error, not "unlimited": failing loudly
  -- here is what stops a new caller from silently bypassing the check.
  if not found then
    raise exception 'VALIDATION_FAILED: unknown quota metric %', p_metric using errcode = '22023';
  end if;

  if v_limit is null then
    return;
  end if;

  v_used := case p_metric
    when 'vehicles' then (
      select count(*)::int from public.vehicles v
      where v.is_active
        and (case when p_owner_org is not null then v.owner_org_id = p_owner_org
                  else v.owner_user_id = p_owner_user end)
    )
    when 'drivers' then (
      select count(*)::int from public.driver_profiles d
      where d.is_active and d.status <> 'revoked'
        and (case when p_owner_org is not null then d.org_id = p_owner_org
                  else d.invited_by = p_owner_user end)
    )
    when 'staff' then (
      select count(*)::int from public.organization_members m
      where m.status = 'active'
        and (p_owner_org is not null and m.org_id = p_owner_org
             or p_owner_org is null and m.user_id = p_owner_user)
    )
    else 0
  end;

  if v_used + p_delta > v_limit and not v_soft then
    raise exception 'QUOTA_EXCEEDED: metric=% limit=% used=%', p_metric, v_limit, v_used
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function app.assert_quota(uuid, uuid, text, integer) is
  'Plan limit gate for create_vehicle / invite_driver / invite_member / create_trip. Raises QUOTA_EXCEEDED with a parseable detail.';

-- ---------------------------------------------------------------------------
-- 3. Vehicles — the full specification (~60 attributes per specs.md §7)
-- ---------------------------------------------------------------------------

/**
 * `::uuid` on a path segment that a client controls must not turn a bad upload into a 500. This returns
 * NULL instead, and the policy then simply denies.
 */
create or replace function app.safe_uuid(p_text text)
returns uuid
language plpgsql
immutable
as $$
begin
  return p_text::uuid;
exception
  when others then return null;
end;
$$;

create or replace function app.normalize_phone(p_phone text)
returns text
language sql
immutable
as $$
  -- «+967 733 000 001», «00967-733-000001» and «733000001» are the same number.
  select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
$$;

create or replace function app.normalize_plate(p_plate text)
returns text
language sql
immutable
as $$
  -- Plates are written «12345-أ», «12345 أ» and «12345أ» by different people; comparison needs one form.
  select upper(regexp_replace(coalesce(p_plate, ''), '[[:space:]\-]', '', 'g'));
$$;

create table public.vehicles (
  id                        uuid primary key default gen_random_uuid(),

  -- Ownership (exactly one).
  owner_user_id             uuid references public.profiles (id) on delete restrict,
  owner_org_id              uuid references public.organizations (id) on delete restrict,

  -- Identity.
  make                      text not null check (length(btrim(make)) between 1 and 60),
  model                     text not null check (length(btrim(model)) between 1 and 60),
  model_year                smallint not null check (model_year between 1950 and 2100),
  trim                      text,
  plate_number              text not null check (length(app.normalize_plate(plate_number)) between 3 and 12),
  plate_norm                text generated always as (app.normalize_plate(plate_number)) stored,
  plate_governorate_id      uuid references public.governorates (id) on delete set null,
  vin                       text check (vin is null or length(vin) = 17),
  chassis_no                text,
  color                     text check (color is null or length(color) <= 40),

  -- Mechanical.
  body_type                 public.vehicle_body_type not null default 'van',
  drive_type                public.drive_type,
  transmission              public.transmission,
  fuel_type                 public.fuel_type not null default 'petrol',
  engine_cc                 integer check (engine_cc is null or engine_cc between 50 and 20000),
  cylinders                 smallint check (cylinders is null or cylinders between 1 and 16),
  fuel_tank_l               numeric(6, 2) check (fuel_tank_l is null or fuel_tank_l > 0),
  tyre_size                 text check (tyre_size is null or length(tyre_size) <= 40),
  tyre_count                smallint check (tyre_count is null or tyre_count between 3 and 18),
  spare_tyre                boolean not null default true,
  vehicle_condition         public.vehicle_condition not null default 'used',
  ownership_kind            public.vehicle_ownership_kind not null default 'owned',

  -- Capacity.
  seats_passenger           smallint not null check (seats_passenger between 1 and 60),
  seats_total               smallint not null check (seats_total between 1 and 62),
  luggage_capacity_l        integer check (luggage_capacity_l is null or luggage_capacity_l >= 0),
  roof_rack                 boolean not null default false,

  -- Comfort.
  air_conditioning          boolean not null default true,
  heating                   boolean not null default false,
  reclining_seats           boolean not null default false,
  usb_charging              boolean not null default false,
  wifi                      boolean not null default false,
  entertainment             boolean not null default false,
  curtains                  boolean not null default false,
  reading_lights            boolean not null default false,

  -- Safety and compliance.
  airbags                   smallint not null default 0 check (airbags between 0 and 12),
  abs                       boolean not null default true,
  esp                       boolean not null default false,
  seatbelts_all             boolean not null default true,
  fire_extinguisher         boolean not null default false,
  first_aid                 boolean not null default false,
  emergency_exit            boolean not null default false,
  gps_device                boolean not null default false,
  speed_limiter             boolean not null default false,

  -- Accessibility.
  child_seat                boolean not null default false,
  wheelchair_accessible     boolean not null default false,
  step_assist               boolean not null default false,

  -- Documents (dates only; the files live in the private bucket).
  insurance_company         text,
  insurance_policy_no       text,
  insurance_expiry          date,
  inspection_expiry         date,
  registration_expiry       date,
  transport_permit_expiry   date,

  -- Appearance.
  exterior_condition        public.vehicle_condition_rating not null default 'good',
  interior_condition        public.vehicle_condition_rating not null default 'good',

  -- Operational.
  odometer_km               integer not null default 0 check (odometer_km >= 0),
  status                    public.vehicle_status not null default 'draft',
  verification_status       public.verification_status not null default 'pending',
  verified_by               uuid references public.profiles (id) on delete set null,
  verified_at               timestamptz,
  verification_note         text,
  is_active                 boolean not null default true,
  notes                     text check (notes is null or length(notes) <= 2000),
  created_by                uuid references public.profiles (id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint vehicles_one_owner
    check ((owner_user_id is null) <> (owner_org_id is null)),
  constraint vehicles_seats_sane
    check (seats_passenger <= seats_total)
);

create index vehicles_owner_user_idx on public.vehicles (owner_user_id) where owner_user_id is not null;
create index vehicles_owner_org_idx on public.vehicles (owner_org_id) where owner_org_id is not null;
create index vehicles_plate_idx on public.vehicles (plate_norm);
create index vehicles_pending_idx on public.vehicles (verification_status) where verification_status = 'pending';

create trigger vehicles_set_updated_at
  before update on public.vehicles
  for each row execute function app.set_updated_at();

comment on table public.vehicles is
  'One row per vehicle, ~60 attributes. Exactly one owner (individual or organization). Verification is
   a staff decision; a substantive edit re-opens it, because what was approved is no longer what exists.';

create table public.vehicle_photos (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references public.vehicles (id) on delete cascade,
  storage_path text not null,
  caption     text,
  is_primary  boolean not null default false,
  sort_order  smallint not null default 0,
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index vehicle_photos_vehicle_idx on public.vehicle_photos (vehicle_id, sort_order);
-- One primary photo per vehicle: the card has to pick one without guessing.
create unique index vehicle_photos_one_primary
  on public.vehicle_photos (vehicle_id) where is_primary;

create table public.driver_profiles (
  id                  uuid primary key default gen_random_uuid(),
  -- Null until the invited person accepts: an operator can invite by phone before the person signs up.
  user_id             uuid references public.profiles (id) on delete cascade,
  invited_phone       text not null check (length(app.normalize_phone(invited_phone)) between 6 and 20),
  full_name           text not null check (length(btrim(full_name)) between 2 and 120),
  org_id              uuid references public.organizations (id) on delete cascade,
  invited_by          uuid references public.profiles (id) on delete set null,
  licence_no          text,
  licence_class       text,
  licence_expiry      date,
  licence_photo_path  text,
  status              public.driver_status not null default 'invited',
  verification_status public.verification_status not null default 'unverified',
  verified_by         uuid references public.profiles (id) on delete set null,
  verified_at         timestamptz,
  verification_note   text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint driver_profiles_org_or_inviter
    check (org_id is not null or invited_by is not null)
);

create unique index driver_profiles_user_unique on public.driver_profiles (user_id) where user_id is not null;
create index driver_profiles_org_idx on public.driver_profiles (org_id) where org_id is not null;
create index driver_profiles_phone_idx on public.driver_profiles (app.normalize_phone(invited_phone));
create index driver_profiles_inviter_idx on public.driver_profiles (invited_by) where invited_by is not null;

create trigger driver_profiles_set_updated_at
  before update on public.driver_profiles
  for each row execute function app.set_updated_at();

create table public.vehicle_documents (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references public.vehicles (id) on delete cascade,
  kind         text not null check (kind in ('insurance', 'registration', 'inspection', 'permit', 'other')),
  storage_path text not null,
  mime         text,
  size_bytes   integer check (size_bytes is null or size_bytes >= 0),
  uploaded_by  uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index vehicle_documents_vehicle_idx on public.vehicle_documents (vehicle_id, kind);

create table public.vehicle_driver_assignments (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references public.vehicles (id) on delete cascade,
  driver_id    uuid not null references public.driver_profiles (id) on delete cascade,
  assigned_by  uuid references public.profiles (id) on delete set null,
  assigned_at  timestamptz not null default now(),
  unassigned_at timestamptz,
  unassigned_by uuid references public.profiles (id) on delete set null,
  note         text
);

-- A vehicle has at most one active driver: two drivers on one van is a data-entry mistake, and the
-- QR/manifest path in Phase 7 assumes an unambiguous "who is driving".
create unique index vehicle_driver_active_unique
  on public.vehicle_driver_assignments (vehicle_id) where unassigned_at is null;
create index vehicle_driver_assignments_driver_idx
  on public.vehicle_driver_assignments (driver_id) where unassigned_at is null;

create table public.odometer_readings (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references public.vehicles (id) on delete cascade,
  reading_km  integer not null check (reading_km >= 0),
  kind        public.odometer_kind not null,
  driver_id   uuid references public.driver_profiles (id) on delete set null,
  recorded_by uuid references public.profiles (id) on delete set null,
  recorded_at timestamptz not null default now(),
  note        text
);

create index odometer_readings_vehicle_idx on public.odometer_readings (vehicle_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- 4. RLS — owner, organization member and staff only. Vehicles are not public data.
-- ---------------------------------------------------------------------------

alter table public.vehicles enable row level security;
alter table public.vehicle_photos enable row level security;
alter table public.driver_profiles enable row level security;
alter table public.vehicle_documents enable row level security;
alter table public.vehicle_driver_assignments enable row level security;
alter table public.odometer_readings enable row level security;
alter table public.plans enable row level security;
alter table public.plan_limits enable row level security;

create or replace function app.owns_vehicle(p_vehicle uuid, p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.vehicles v
    where v.id = p_vehicle
      and (
        v.owner_user_id = p_uid
        or (v.owner_org_id is not null and app.is_org_member(v.owner_org_id, p_uid))
      )
  );
$$;

create or replace function app.is_assigned_driver(p_vehicle uuid, p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.vehicle_driver_assignments a
    join public.driver_profiles d on d.id = a.driver_id
    where a.vehicle_id = p_vehicle and a.unassigned_at is null and d.user_id = p_uid
  );
$$;

create policy vehicles_read_own_or_staff on public.vehicles
  for select to authenticated
  using (
    owner_user_id = app.uid()
    or (owner_org_id is not null and app.is_org_member(owner_org_id))
    or app.is_platform_staff()
    or app.is_assigned_driver(id)
  );

create policy vehicle_photos_read_with_vehicle on public.vehicle_photos
  for select to authenticated
  using (
    app.owns_vehicle(vehicle_id)
    or app.is_platform_staff()
    or app.is_assigned_driver(vehicle_id)
  );

create policy vehicle_documents_read_own_or_staff on public.vehicle_documents
  for select to authenticated
  using (app.owns_vehicle(vehicle_id) or app.is_platform_staff());

create policy driver_profiles_read_own_or_org_or_staff on public.driver_profiles
  for select to authenticated
  using (
    user_id = app.uid()
    or (org_id is not null and app.is_org_member(org_id))
    or invited_by = app.uid()
    or app.is_platform_staff()
  );

create policy assignments_read_involved on public.vehicle_driver_assignments
  for select to authenticated
  using (
    app.owns_vehicle(vehicle_id)
    or app.is_platform_staff()
    or exists (
      select 1 from public.driver_profiles d
      where d.id = driver_id and d.user_id = app.uid()
    )
  );

create policy odometer_read_involved on public.odometer_readings
  for select to authenticated
  using (app.owns_vehicle(vehicle_id) or app.is_platform_staff() or app.is_assigned_driver(vehicle_id));

-- Plans are reference data: readable by everyone (the pricing page needs them, including logged-out).
create policy plans_read_all on public.plans for select to anon, authenticated using (true);
create policy plan_limits_read_all on public.plan_limits for select to anon, authenticated using (true);

grant select on public.vehicles to authenticated;
grant select on public.vehicle_photos to authenticated;
grant select on public.driver_profiles to authenticated;
grant select on public.vehicle_documents to authenticated;
grant select on public.vehicle_driver_assignments to authenticated;
grant select on public.odometer_readings to authenticated;
grant select on public.plans, public.plan_limits to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Payload validation, shared by create and update
-- ---------------------------------------------------------------------------

/**
 * Cross-field rules that a column constraint cannot express, in one place.
 *
 * Kept as a function rather than inline in each command so `create` and `update` cannot diverge — the
 * Phase 2 review found exactly that class of drift between two gateways.
 */
create or replace function app.assert_vehicle_payload(p jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_year int;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'VALIDATION_FAILED: vehicle payload' using errcode = '22023';
  end if;

  if coalesce(length(btrim(p ->> 'make')), 0) < 1 or coalesce(length(btrim(p ->> 'model')), 0) < 1 then
    raise exception 'VALIDATION_FAILED: make and model are required' using errcode = '22023';
  end if;

  v_year := nullif(p ->> 'modelYear', '')::int;
  if v_year is null or v_year < 1980 or v_year > extract(year from now())::int + 1 then
    raise exception 'VALIDATION_FAILED: model year out of range' using errcode = '22023';
  end if;

  if coalesce(length(app.normalize_plate(p ->> 'plateNumber')), 0) < 3 then
    raise exception 'VALIDATION_FAILED: plate number' using errcode = '22023';
  end if;

  if nullif(p ->> 'vin', '') is not null and length(p ->> 'vin') <> 17 then
    raise exception 'VALIDATION_FAILED: VIN must be 17 characters' using errcode = '22023';
  end if;

  if coalesce((p ->> 'seatsPassenger')::int, 0) < 1 then
    raise exception 'VALIDATION_FAILED: at least one passenger seat' using errcode = '22023';
  end if;

  if coalesce((p ->> 'seatsPassenger')::int, 0) > coalesce((p ->> 'seatsTotal')::int, 0) then
    raise exception 'VALIDATION_FAILED: passenger seats exceed total seats' using errcode = '22023';
  end if;

  -- Insurance that has already expired is not a vehicle anyone may run: refusing here keeps the
  -- dispatch and trip paths from having to defend against it later.
  if nullif(p ->> 'insuranceExpiry', '') is not null
     and (p ->> 'insuranceExpiry')::date < current_date then
    raise exception 'VALIDATION_FAILED: insurance has already expired' using errcode = '22023';
  end if;

  if nullif(p ->> 'inspectionExpiry', '') is not null
     and (p ->> 'inspectionExpiry')::date < current_date - interval '1 year' then
    raise exception 'VALIDATION_FAILED: inspection is more than a year out of date' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Commands
-- ---------------------------------------------------------------------------

create or replace function public.cmd_create_vehicle(
  p_actor uuid,
  p_owner_org uuid,
  p_vehicle jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vehicle public.vehicles%rowtype;
  v_owner_user uuid;
  v_warnings jsonb := '[]'::jsonb;
  v_dup record;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  -- Who owns it. An organization owner must be an active member of a *verified* organization: being
  -- verified through one company says nothing about another (see app.org_can_own).
  if p_owner_org is not null then
    if not app.is_org_member(p_owner_org, p_actor) then
      raise exception 'FORBIDDEN: not a member of this organization' using errcode = '42501';
    end if;
    if not app.org_is_verified(p_owner_org) then
      raise exception 'NOT_VERIFIED: this organization is not verified' using errcode = '42501';
    end if;
  else
    if not app.is_verified_actor(p_actor) then
      raise exception 'NOT_VERIFIED: only verified accounts can add vehicles' using errcode = '42501';
    end if;
    v_owner_user := p_actor;
  end if;

  perform app.assert_vehicle_payload(p_vehicle);
  perform app.assert_quota(v_owner_user, p_owner_org, 'vehicles', 1);

  -- A plate that already exists is worth saying out loud (transposed digits are the classic case) but
  -- not worth blocking: a genuinely re-registered vehicle exists. The operator decides.
  select v.id, v.make, v.model, v.owner_user_id, v.owner_org_id into v_dup
  from public.vehicles v
  where v.is_active
    and v.plate_norm = app.normalize_plate(p_vehicle ->> 'plateNumber')
    and (v.owner_user_id is not distinct from v_owner_user and v.owner_org_id is not distinct from p_owner_org)
  limit 1;

  if found then
    v_warnings := v_warnings || jsonb_build_array(
      jsonb_build_object('code', 'PLATE_DUPLICATE', 'vehicleId', v_dup.id,
                         'make', v_dup.make, 'model', v_dup.model)
    );
  end if;

  insert into public.vehicles (
    owner_user_id, owner_org_id, make, model, model_year, trim, plate_number, plate_governorate_id,
    vin, chassis_no, color, body_type, drive_type, transmission, fuel_type, engine_cc, cylinders,
    fuel_tank_l, tyre_size, tyre_count, spare_tyre, vehicle_condition, ownership_kind,
    seats_passenger, seats_total, luggage_capacity_l, roof_rack, air_conditioning, heating,
    reclining_seats, usb_charging, wifi, entertainment, curtains, reading_lights, airbags, abs, esp,
    seatbelts_all, fire_extinguisher, first_aid, emergency_exit, gps_device, speed_limiter,
    child_seat, wheelchair_accessible, step_assist, insurance_company, insurance_policy_no,
    insurance_expiry, inspection_expiry, registration_expiry, transport_permit_expiry,
    exterior_condition, interior_condition, odometer_km, status, verification_status, notes, created_by
  )
  values (
    v_owner_user, p_owner_org,
    btrim(p_vehicle ->> 'make'), btrim(p_vehicle ->> 'model'), (p_vehicle ->> 'modelYear')::smallint,
    nullif(btrim(coalesce(p_vehicle ->> 'trim', '')), ''),
    btrim(p_vehicle ->> 'plateNumber'), nullif(p_vehicle ->> 'plateGovernorateId', '')::uuid,
    nullif(btrim(coalesce(p_vehicle ->> 'vin', '')), ''),
    nullif(btrim(coalesce(p_vehicle ->> 'chassisNo', '')), ''),
    nullif(btrim(coalesce(p_vehicle ->> 'color', '')), ''),
    coalesce((p_vehicle ->> 'bodyType')::public.vehicle_body_type, 'van'),
    nullif(p_vehicle ->> 'driveType', '')::public.drive_type,
    nullif(p_vehicle ->> 'transmission', '')::public.transmission,
    coalesce((p_vehicle ->> 'fuelType')::public.fuel_type, 'petrol'),
    nullif(p_vehicle ->> 'engineCc', '')::int,
    nullif(p_vehicle ->> 'cylinders', '')::smallint,
    nullif(p_vehicle ->> 'fuelTankL', '')::numeric,
    nullif(btrim(coalesce(p_vehicle ->> 'tyreSize', '')), ''),
    nullif(p_vehicle ->> 'tyreCount', '')::smallint,
    coalesce((p_vehicle ->> 'spareTyre')::boolean, true),
    coalesce((p_vehicle ->> 'vehicleCondition')::public.vehicle_condition, 'used'),
    coalesce((p_vehicle ->> 'ownershipKind')::public.vehicle_ownership_kind, 'owned'),
    (p_vehicle ->> 'seatsPassenger')::smallint, (p_vehicle ->> 'seatsTotal')::smallint,
    nullif(p_vehicle ->> 'luggageCapacityL', '')::int,
    coalesce((p_vehicle ->> 'roofRack')::boolean, false),
    coalesce((p_vehicle ->> 'airConditioning')::boolean, true),
    coalesce((p_vehicle ->> 'heating')::boolean, false),
    coalesce((p_vehicle ->> 'recliningSeats')::boolean, false),
    coalesce((p_vehicle ->> 'usbCharging')::boolean, false),
    coalesce((p_vehicle ->> 'wifi')::boolean, false),
    coalesce((p_vehicle ->> 'entertainment')::boolean, false),
    coalesce((p_vehicle ->> 'curtains')::boolean, false),
    coalesce((p_vehicle ->> 'readingLights')::boolean, false),
    coalesce((p_vehicle ->> 'airbags')::smallint, 0),
    coalesce((p_vehicle ->> 'abs')::boolean, true),
    coalesce((p_vehicle ->> 'esp')::boolean, false),
    coalesce((p_vehicle ->> 'seatbeltsAll')::boolean, true),
    coalesce((p_vehicle ->> 'fireExtinguisher')::boolean, false),
    coalesce((p_vehicle ->> 'firstAid')::boolean, false),
    coalesce((p_vehicle ->> 'emergencyExit')::boolean, false),
    coalesce((p_vehicle ->> 'gpsDevice')::boolean, false),
    coalesce((p_vehicle ->> 'speedLimiter')::boolean, false),
    coalesce((p_vehicle ->> 'childSeat')::boolean, false),
    coalesce((p_vehicle ->> 'wheelchairAccessible')::boolean, false),
    coalesce((p_vehicle ->> 'stepAssist')::boolean, false),
    nullif(btrim(coalesce(p_vehicle ->> 'insuranceCompany', '')), ''),
    nullif(btrim(coalesce(p_vehicle ->> 'insurancePolicyNo', '')), ''),
    nullif(p_vehicle ->> 'insuranceExpiry', '')::date,
    nullif(p_vehicle ->> 'inspectionExpiry', '')::date,
    nullif(p_vehicle ->> 'registrationExpiry', '')::date,
    nullif(p_vehicle ->> 'transportPermitExpiry', '')::date,
    coalesce((p_vehicle ->> 'exteriorCondition')::public.vehicle_condition_rating, 'good'),
    coalesce((p_vehicle ->> 'interiorCondition')::public.vehicle_condition_rating, 'good'),
    coalesce((p_vehicle ->> 'odometerKm')::int, 0),
    'draft', 'unverified',
    nullif(btrim(coalesce(p_vehicle ->> 'notes', '')), ''),
    p_actor
  )
  returning * into v_vehicle;

  -- The baseline reading: every later odometer comparison needs a starting point, and Phase 6's
  -- trip readings are meaningless without it.
  insert into public.odometer_readings (vehicle_id, reading_km, kind, recorded_by, note)
  values (v_vehicle.id, v_vehicle.odometer_km, 'baseline', p_actor, 'initial reading at registration');

  perform app.write_audit(
    p_actor, 'vehicle.create', 'vehicle', v_vehicle.id::text, null,
    jsonb_build_object('make', v_vehicle.make, 'model', v_vehicle.model,
                       'plate', v_vehicle.plate_number, 'owner_org', p_owner_org),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('vehicle', to_jsonb(v_vehicle) - 'plate_norm', 'warnings', v_warnings);
end;
$$;

create or replace function public.cmd_update_vehicle(
  p_actor uuid,
  p_vehicle_id uuid,
  p_vehicle jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.vehicles%rowtype;
  v_after public.vehicles%rowtype;
  v_reverify boolean := false;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.owns_vehicle(p_vehicle_id, p_actor) then
    raise exception 'FORBIDDEN: not your vehicle' using errcode = '42501';
  end if;

  select * into v_before from public.vehicles where id = p_vehicle_id for update;
  if not found then
    raise exception 'NOT_FOUND: vehicle' using errcode = 'P0002';
  end if;
  if v_before.status = 'retired' then
    raise exception 'CONFLICT: a retired vehicle cannot be edited' using errcode = '23505';
  end if;

  perform app.assert_vehicle_payload(p_vehicle);

  update public.vehicles set
    make = btrim(p_vehicle ->> 'make'),
    model = btrim(p_vehicle ->> 'model'),
    model_year = (p_vehicle ->> 'modelYear')::smallint,
    trim = nullif(btrim(coalesce(p_vehicle ->> 'trim', '')), ''),
    plate_number = btrim(p_vehicle ->> 'plateNumber'),
    plate_governorate_id = nullif(p_vehicle ->> 'plateGovernorateId', '')::uuid,
    vin = nullif(btrim(coalesce(p_vehicle ->> 'vin', '')), ''),
    chassis_no = nullif(btrim(coalesce(p_vehicle ->> 'chassisNo', '')), ''),
    color = nullif(btrim(coalesce(p_vehicle ->> 'color', '')), ''),
    body_type = coalesce((p_vehicle ->> 'bodyType')::public.vehicle_body_type, body_type),
    drive_type = nullif(p_vehicle ->> 'driveType', '')::public.drive_type,
    transmission = nullif(p_vehicle ->> 'transmission', '')::public.transmission,
    fuel_type = coalesce((p_vehicle ->> 'fuelType')::public.fuel_type, fuel_type),
    engine_cc = nullif(p_vehicle ->> 'engineCc', '')::int,
    cylinders = nullif(p_vehicle ->> 'cylinders', '')::smallint,
    fuel_tank_l = nullif(p_vehicle ->> 'fuelTankL', '')::numeric,
    tyre_size = nullif(btrim(coalesce(p_vehicle ->> 'tyreSize', '')), ''),
    tyre_count = nullif(p_vehicle ->> 'tyreCount', '')::smallint,
    spare_tyre = coalesce((p_vehicle ->> 'spareTyre')::boolean, spare_tyre),
    vehicle_condition = coalesce((p_vehicle ->> 'vehicleCondition')::public.vehicle_condition, vehicle_condition),
    ownership_kind = coalesce((p_vehicle ->> 'ownershipKind')::public.vehicle_ownership_kind, ownership_kind),
    seats_passenger = (p_vehicle ->> 'seatsPassenger')::smallint,
    seats_total = (p_vehicle ->> 'seatsTotal')::smallint,
    luggage_capacity_l = nullif(p_vehicle ->> 'luggageCapacityL', '')::int,
    roof_rack = coalesce((p_vehicle ->> 'roofRack')::boolean, roof_rack),
    air_conditioning = coalesce((p_vehicle ->> 'airConditioning')::boolean, air_conditioning),
    heating = coalesce((p_vehicle ->> 'heating')::boolean, heating),
    reclining_seats = coalesce((p_vehicle ->> 'recliningSeats')::boolean, reclining_seats),
    usb_charging = coalesce((p_vehicle ->> 'usbCharging')::boolean, usb_charging),
    wifi = coalesce((p_vehicle ->> 'wifi')::boolean, wifi),
    entertainment = coalesce((p_vehicle ->> 'entertainment')::boolean, entertainment),
    curtains = coalesce((p_vehicle ->> 'curtains')::boolean, curtains),
    reading_lights = coalesce((p_vehicle ->> 'readingLights')::boolean, reading_lights),
    airbags = coalesce((p_vehicle ->> 'airbags')::smallint, airbags),
    abs = coalesce((p_vehicle ->> 'abs')::boolean, abs),
    esp = coalesce((p_vehicle ->> 'esp')::boolean, esp),
    seatbelts_all = coalesce((p_vehicle ->> 'seatbeltsAll')::boolean, seatbelts_all),
    fire_extinguisher = coalesce((p_vehicle ->> 'fireExtinguisher')::boolean, fire_extinguisher),
    first_aid = coalesce((p_vehicle ->> 'firstAid')::boolean, first_aid),
    emergency_exit = coalesce((p_vehicle ->> 'emergencyExit')::boolean, emergency_exit),
    gps_device = coalesce((p_vehicle ->> 'gpsDevice')::boolean, gps_device),
    speed_limiter = coalesce((p_vehicle ->> 'speedLimiter')::boolean, speed_limiter),
    child_seat = coalesce((p_vehicle ->> 'childSeat')::boolean, child_seat),
    wheelchair_accessible = coalesce((p_vehicle ->> 'wheelchairAccessible')::boolean, wheelchair_accessible),
    step_assist = coalesce((p_vehicle ->> 'stepAssist')::boolean, step_assist),
    insurance_company = nullif(btrim(coalesce(p_vehicle ->> 'insuranceCompany', '')), ''),
    insurance_policy_no = nullif(btrim(coalesce(p_vehicle ->> 'insurancePolicyNo', '')), ''),
    insurance_expiry = nullif(p_vehicle ->> 'insuranceExpiry', '')::date,
    inspection_expiry = nullif(p_vehicle ->> 'inspectionExpiry', '')::date,
    registration_expiry = nullif(p_vehicle ->> 'registrationExpiry', '')::date,
    transport_permit_expiry = nullif(p_vehicle ->> 'transportPermitExpiry', '')::date,
    exterior_condition = coalesce((p_vehicle ->> 'exteriorCondition')::public.vehicle_condition_rating, exterior_condition),
    interior_condition = coalesce((p_vehicle ->> 'interiorCondition')::public.vehicle_condition_rating, interior_condition),
    odometer_km = coalesce((p_vehicle ->> 'odometerKm')::int, odometer_km),
    notes = nullif(btrim(coalesce(p_vehicle ->> 'notes', '')), '')
  where id = p_vehicle_id
  returning * into v_after;

  -- What was approved is no longer what exists: plate, VIN, seats and the document dates are exactly
  -- the facts a verification decision was based on. Changing them re-opens the decision instead of
  -- silently inheriting a badge.
  if v_before.verification_status = 'verified' and (
       v_before.plate_norm <> v_after.plate_norm
    or v_before.vin is distinct from v_after.vin
    or v_before.seats_passenger <> v_after.seats_passenger
    or v_before.model_year <> v_after.model_year
    or v_before.insurance_expiry is distinct from v_after.insurance_expiry
    or v_before.inspection_expiry is distinct from v_after.inspection_expiry
  ) then
    update public.vehicles
    set verification_status = 'pending', verified_by = null, verified_at = null,
        verification_note = 're-submitted after a substantive edit'
    where id = p_vehicle_id;
    v_reverify := true;
  end if;

  perform app.write_audit(
    p_actor, 'vehicle.update', 'vehicle', p_vehicle_id::text,
    jsonb_build_object('plate', v_before.plate_number, 'seats', v_before.seats_passenger,
                       'verification', v_before.verification_status),
    jsonb_build_object('plate', v_after.plate_number, 'seats', v_after.seats_passenger,
                       'verification', case when v_reverify then 'pending' else v_after.verification_status end),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'vehicle', to_jsonb((select v from public.vehicles v where v.id = p_vehicle_id)) - 'plate_norm',
    'reverificationRequired', v_reverify
  );
end;
$$;

create or replace function public.cmd_submit_vehicle_verification(
  p_actor uuid,
  p_vehicle_id uuid,
  p_documents jsonb default '[]'::jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vehicle public.vehicles%rowtype;
  v_staff uuid;
  v_required text[] := array['insurance', 'registration'];
  v_provided text[] := '{}';
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.owns_vehicle(p_vehicle_id, p_actor) then
    raise exception 'FORBIDDEN: not your vehicle' using errcode = '42501';
  end if;

  select * into v_vehicle from public.vehicles where id = p_vehicle_id for update;
  if not found then
    raise exception 'NOT_FOUND: vehicle' using errcode = 'P0002';
  end if;
  if v_vehicle.status = 'retired' then
    raise exception 'CONFLICT: a retired vehicle cannot be submitted' using errcode = '23505';
  end if;
  if v_vehicle.verification_status = 'verified' then
    raise exception 'CONFLICT: already verified' using errcode = '23505';
  end if;

  -- Documents are paths in the private `vehicle-documents` bucket, one JSON object each.
  if p_documents is null or jsonb_typeof(p_documents) <> 'array' then
    raise exception 'MISSING_DOCUMENT: documents' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct d ->> 'kind'), '{}')
  into v_provided
  from jsonb_array_elements(p_documents) d
  where coalesce(d ->> 'path', '') <> '';
  if not (v_required <@ v_provided) then
    raise exception 'MISSING_DOCUMENT: %', array_to_string(v_required, ',') using errcode = '22023';
  end if;

  -- Replace the document set in this transaction: a resubmission is the documents as they are now, not
  -- an accumulating pile of old scans the reviewer has to choose between.
  delete from public.vehicle_documents where vehicle_id = p_vehicle_id;
  insert into public.vehicle_documents (vehicle_id, kind, storage_path, mime, size_bytes, uploaded_by)
  select p_vehicle_id, d ->> 'kind', d ->> 'path',
         nullif(d ->> 'mime', ''), nullif(d ->> 'sizeBytes', '')::int, p_actor
  from jsonb_array_elements(p_documents) d
  where coalesce(d ->> 'path', '') <> '';

  update public.vehicles
  set verification_status = 'pending',
      status = case when status = 'draft' then 'active' else status end,
      verification_note = null
  where id = p_vehicle_id;

  -- Only a submission puts work in the staff queue, so this is where the queue owner is told.
  for v_staff in
    select ur.user_id from public.user_roles ur
    where ur.role in ('platform_staff', 'platform_admin') and ur.revoked_at is null
  loop
    perform app.notify(
      v_staff, 'verification_submitted', 'notifications.vehiclePending',
      jsonb_build_object('name', v_vehicle.make || ' ' || v_vehicle.model), '/staff/vehicles'
    );
  end loop;

  perform app.write_audit(
    p_actor, 'vehicle.submitVerification', 'vehicle', p_vehicle_id::text,
    jsonb_build_object('verification_status', v_vehicle.verification_status),
    jsonb_build_object('verification_status', 'pending', 'documents', jsonb_array_length(p_documents)),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('vehicleId', p_vehicle_id, 'verificationStatus', 'pending');
end;
$$;

create or replace function public.cmd_decide_vehicle_verification(
  p_actor uuid,
  p_vehicle_id uuid,
  p_outcome public.verification_outcome,
  p_reason text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vehicle public.vehicles%rowtype;
  v_new public.verification_status;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_staff(p_actor) then
    raise exception 'FORBIDDEN: staff only' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('approve', 'reject') then
    raise exception 'VALIDATION_FAILED: outcome' using errcode = '22023';
  end if;
  if p_outcome = 'reject' and (p_reason is null or length(btrim(p_reason)) < 10) then
    raise exception 'VALIDATION_FAILED: reason too short' using errcode = '22023';
  end if;

  select * into v_vehicle from public.vehicles where id = p_vehicle_id for update;
  if not found then
    raise exception 'NOT_FOUND: vehicle' using errcode = 'P0002';
  end if;

  -- A decision is made once (the Phase 2 lesson, applied here from the start).
  if v_vehicle.verification_status <> 'pending' then
    raise exception 'CONFLICT: vehicle is already %, not awaiting review', v_vehicle.verification_status
      using errcode = '23505';
  end if;
  -- Separation of duties: nobody approves their own vehicle, however senior.
  if v_vehicle.owner_user_id = p_actor then
    raise exception 'FORBIDDEN: own vehicle' using errcode = '42501';
  end if;

  v_new := case when p_outcome = 'approve' then 'verified' else 'rejected' end;

  update public.vehicles
  set verification_status = v_new,
      verified_by = p_actor,
      verified_at = now(),
      verification_note = nullif(btrim(coalesce(p_reason, '')), ''),
      status = case when p_outcome = 'approve' then 'active' else status end
  where id = p_vehicle_id;

  perform app.notify(
    coalesce(v_vehicle.owner_user_id, (select o.owner_id from public.organizations o where o.id = v_vehicle.owner_org_id)),
    case when p_outcome = 'approve' then 'verification_approved' else 'verification_rejected' end::public.notification_kind,
    case when p_outcome = 'approve' then 'notifications.vehicleApproved' else 'notifications.vehicleRejected' end,
    jsonb_build_object('name', v_vehicle.make || ' ' || v_vehicle.model, 'reason', p_reason),
    '/operator/vehicles'
  );

  perform app.write_audit(
    p_actor, 'vehicle.decide', 'vehicle', p_vehicle_id::text,
    jsonb_build_object('verification_status', v_vehicle.verification_status),
    jsonb_build_object('verification_status', v_new), p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('vehicleId', p_vehicle_id, 'verificationStatus', v_new);
end;
$$;

create or replace function public.cmd_set_vehicle_status(
  p_actor uuid,
  p_vehicle_id uuid,
  p_status public.vehicle_status,
  p_reason text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.vehicles%rowtype;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_status is null then
    raise exception 'VALIDATION_FAILED: status' using errcode = '22023';
  end if;

  select * into v_before from public.vehicles where id = p_vehicle_id for update;
  if not found then
    raise exception 'NOT_FOUND: vehicle' using errcode = 'P0002';
  end if;

  -- Owners may park or retire their own vehicle; only staff may suspend one (that is a compliance
  -- action, not a preference).
  if p_status = 'suspended' then
    if not app.is_platform_staff(p_actor) then
      raise exception 'FORBIDDEN: only staff can suspend a vehicle' using errcode = '42501';
    end if;
    if p_reason is null or length(btrim(p_reason)) < 10 then
      raise exception 'VALIDATION_FAILED: suspension reason required' using errcode = '22023';
    end if;
  elsif not app.owns_vehicle(p_vehicle_id, p_actor) then
    raise exception 'FORBIDDEN: not your vehicle' using errcode = '42501';
  end if;

  if v_before.status = p_status then
    return jsonb_build_object('vehicleId', p_vehicle_id, 'status', p_status, 'changed', false);
  end if;

  update public.vehicles
  set status = p_status,
      is_active = p_status <> 'retired',
      verification_note = case when p_status = 'suspended' then p_reason else verification_note end
  where id = p_vehicle_id;

  perform app.write_audit(
    p_actor, 'vehicle.status', 'vehicle', p_vehicle_id::text,
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('status', p_status), p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('vehicleId', p_vehicle_id, 'status', p_status, 'changed', true);
end;
$$;

create or replace function public.cmd_invite_driver(
  p_actor uuid,
  p_org_id uuid,
  p_phone text,
  p_full_name text,
  p_licence_no text default null,
  p_licence_expiry date default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver public.driver_profiles%rowtype;
  v_existing_user uuid;
  v_owner_user uuid;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  if p_org_id is not null then
    if not app.is_org_member(p_org_id, p_actor) then
      raise exception 'FORBIDDEN: not a member of this organization' using errcode = '42501';
    end if;
    if not app.org_is_verified(p_org_id) then
      raise exception 'NOT_VERIFIED: this organization is not verified' using errcode = '42501';
    end if;
    v_owner_user := null;
  else
    if not app.is_verified_actor(p_actor) then
      raise exception 'NOT_VERIFIED: only verified accounts can invite drivers' using errcode = '42501';
    end if;
    v_owner_user := p_actor;
  end if;

  if coalesce(length(app.normalize_phone(p_phone)), 0) < 6 then
    raise exception 'VALIDATION_FAILED: phone' using errcode = '22023';
  end if;
  if coalesce(length(btrim(p_full_name)), 0) < 2 then
    raise exception 'VALIDATION_FAILED: name' using errcode = '22023';
  end if;

  -- The same driver twice is the same person: refuse rather than creating a second profile that the
  -- assignment path would then have to choose between.
  if exists (
    select 1 from public.driver_profiles d
    where d.is_active
      and d.status <> 'revoked'
      and app.normalize_phone(d.invited_phone) = app.normalize_phone(p_phone)
      and (case when p_org_id is not null then d.org_id = p_org_id else d.invited_by = p_actor end)
  ) then
    raise exception 'DUPLICATE_REFERENCE: this driver is already on your list' using errcode = '23505';
  end if;

  perform app.assert_quota(v_owner_user, p_org_id, 'drivers', 1);

  -- If a profile already uses that phone, the invite is linked immediately and the person is told.
  select p.id into v_existing_user
  from public.profiles p
  where app.normalize_phone(p.phone) = app.normalize_phone(p_phone)
  limit 1;

  insert into public.driver_profiles (
    user_id, invited_phone, full_name, org_id, invited_by,
    licence_no, licence_expiry, status
  )
  values (
    v_existing_user, btrim(p_phone), btrim(p_full_name), p_org_id, p_actor,
    nullif(btrim(coalesce(p_licence_no, '')), ''), p_licence_expiry, 'invited'
  )
  returning * into v_driver;

  perform app.notify(
    v_existing_user, 'member_invited', 'notifications.driverInvited',
    jsonb_build_object('name', v_driver.full_name), '/account/invitations'
  );

  perform app.write_audit(
    p_actor, 'driver.invite', 'driver', v_driver.id::text, null,
    jsonb_build_object('phone', v_driver.invited_phone, 'linked', v_existing_user is not null),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'driver', jsonb_build_object(
      'id', v_driver.id, 'fullName', v_driver.full_name, 'status', v_driver.status,
      'verificationStatus', v_driver.verification_status, 'phone', v_driver.invited_phone
    ),
    'linkedImmediately', v_existing_user is not null
  );
end;
$$;

create or replace function public.cmd_accept_driver_invite(
  p_actor uuid,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver public.driver_profiles%rowtype;
  v_phone text;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  if exists (select 1 from public.driver_profiles d where d.user_id = p_actor and d.status = 'active') then
    raise exception 'CONFLICT: already an active driver' using errcode = '23505';
  end if;

  select * into v_driver
  from public.driver_profiles d
  where d.status = 'invited' and d.is_active
    and (d.user_id = p_actor
      or (d.user_id is null and app.normalize_phone(d.invited_phone)
            = app.normalize_phone((select p.phone from public.profiles p where p.id = p_actor))))
  order by d.created_at
  limit 1
  for update;

  if not found then
    raise exception 'NOT_FOUND: no invitation for this account' using errcode = 'P0002';
  end if;

  update public.driver_profiles
  set user_id = p_actor, status = 'active'
  where id = v_driver.id
  returning * into v_driver;

  select p.phone into v_phone from public.profiles p where p.id = p_actor;
  if v_phone is null then
    update public.profiles set phone = v_driver.invited_phone where id = p_actor;
  end if;

  -- The inviter needs to know the seat is taken, whichever account they used.
  perform app.notify(
    v_driver.invited_by, 'member_joined', 'notifications.driverAccepted',
    jsonb_build_object('name', v_driver.full_name), '/operator/drivers'
  );

  perform app.write_audit(
    p_actor, 'driver.accept', 'driver', v_driver.id::text,
    jsonb_build_object('status', 'invited'), jsonb_build_object('status', 'active'),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'driver', jsonb_build_object('id', v_driver.id, 'status', v_driver.status),
    'orgId', v_driver.org_id
  );
end;
$$;

create or replace function public.cmd_verify_driver(
  p_actor uuid,
  p_driver_id uuid,
  p_outcome public.verification_outcome,
  p_reason text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver public.driver_profiles%rowtype;
  v_new public.verification_status;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_staff(p_actor) then
    raise exception 'FORBIDDEN: staff only' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('approve', 'reject') then
    raise exception 'VALIDATION_FAILED: outcome' using errcode = '22023';
  end if;
  if p_outcome = 'reject' and (p_reason is null or length(btrim(p_reason)) < 10) then
    raise exception 'VALIDATION_FAILED: reason too short' using errcode = '22023';
  end if;

  select * into v_driver from public.driver_profiles where id = p_driver_id for update;
  if not found then
    raise exception 'NOT_FOUND: driver' using errcode = 'P0002';
  end if;
  if v_driver.status = 'invited' then
    raise exception 'CONFLICT: the driver has not accepted the invitation yet' using errcode = '23505';
  end if;
  if v_driver.verification_status in ('verified', 'rejected') then
    raise exception 'CONFLICT: driver is already %', v_driver.verification_status using errcode = '23505';
  end if;
  if v_driver.user_id = p_actor then
    raise exception 'FORBIDDEN: own driver profile' using errcode = '42501';
  end if;

  -- A licence that expired yesterday cannot be approved today.
  if p_outcome = 'approve' and v_driver.licence_expiry is not null and v_driver.licence_expiry < current_date then
    raise exception 'VALIDATION_FAILED: licence has expired' using errcode = '22023';
  end if;

  v_new := case when p_outcome = 'approve' then 'verified' else 'rejected' end;

  update public.driver_profiles
  set verification_status = v_new,
      verified_by = p_actor,
      verified_at = now(),
      verification_note = nullif(btrim(coalesce(p_reason, '')), '')
  where id = p_driver_id;

  perform app.notify(
    v_driver.user_id,
    case when p_outcome = 'approve' then 'verification_approved' else 'verification_rejected' end::public.notification_kind,
    case when p_outcome = 'approve' then 'notifications.driverApproved' else 'notifications.driverRejected' end,
    jsonb_build_object('name', v_driver.full_name, 'reason', p_reason),
    '/driver/profile'
  );

  perform app.write_audit(
    p_actor, 'driver.verify', 'driver', p_driver_id::text,
    jsonb_build_object('verification_status', v_driver.verification_status),
    jsonb_build_object('verification_status', v_new), p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('driverId', p_driver_id, 'verificationStatus', v_new);
end;
$$;

create or replace function public.cmd_assign_driver(
  p_actor uuid,
  p_vehicle_id uuid,
  p_driver_id uuid,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vehicle public.vehicles%rowtype;
  v_driver public.driver_profiles%rowtype;
  v_warnings jsonb := '[]'::jsonb;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.owns_vehicle(p_vehicle_id, p_actor) then
    raise exception 'FORBIDDEN: not your vehicle' using errcode = '42501';
  end if;

  select * into v_vehicle from public.vehicles where id = p_vehicle_id for update;
  if v_vehicle.status = 'retired' then
    raise exception 'CONFLICT: a retired vehicle cannot be assigned' using errcode = '23505';
  end if;

  select * into v_driver from public.driver_profiles where id = p_driver_id;
  if not found then
    raise exception 'NOT_FOUND: driver' using errcode = 'P0002';
  end if;
  if v_driver.status <> 'active' then
    raise exception 'CONFLICT: the driver has not accepted the invitation yet' using errcode = '23505';
  end if;

  -- The driver must belong to the same owner: an individual's driver cannot be put on a company van.
  if (v_driver.org_id is distinct from v_vehicle.owner_org_id)
     or (v_vehicle.owner_org_id is null and v_driver.invited_by is distinct from v_vehicle.owner_user_id) then
    raise exception 'FORBIDDEN: this driver belongs to a different owner' using errcode = '42501';
  end if;

  -- One active driver per vehicle: close the previous assignment first, in this transaction.
  update public.vehicle_driver_assignments
  set unassigned_at = now(), unassigned_by = p_actor
  where vehicle_id = p_vehicle_id and unassigned_at is null and driver_id <> p_driver_id;

  insert into public.vehicle_driver_assignments (vehicle_id, driver_id, assigned_by)
  values (p_vehicle_id, p_driver_id, p_actor)
  on conflict (vehicle_id) where unassigned_at is null
  do update set driver_id = excluded.driver_id, assigned_by = excluded.assigned_by,
                assigned_at = now(), unassigned_at = null, unassigned_by = null;

  -- Warnings, not blocks: assignment is reversible and Phase 4 gates the trip, not the roster.
  if v_driver.verification_status <> 'verified' then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'DRIVER_NOT_VERIFIED'));
  end if;
  if v_vehicle.verification_status <> 'verified' then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'VEHICLE_NOT_VERIFIED'));
  end if;
  if v_vehicle.inspection_expiry is not null and v_vehicle.inspection_expiry < current_date then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'INSPECTION_EXPIRED'));
  end if;
  if v_vehicle.insurance_expiry is not null and v_vehicle.insurance_expiry < current_date then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'INSURANCE_EXPIRED'));
  end if;

  perform app.notify(
    v_driver.user_id, 'member_joined', 'notifications.driverAssigned',
    jsonb_build_object('name', v_vehicle.make || ' ' || v_vehicle.model), '/driver/vehicle/' || p_vehicle_id
  );

  perform app.write_audit(
    p_actor, 'vehicle.assignDriver', 'vehicle', p_vehicle_id::text, null,
    jsonb_build_object('driver_id', p_driver_id), null, p_request_id, p_ip
  );

  return jsonb_build_object('vehicleId', p_vehicle_id, 'driverId', p_driver_id, 'warnings', v_warnings);
end;
$$;

create or replace function public.cmd_unassign_driver(
  p_actor uuid,
  p_vehicle_id uuid,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.owns_vehicle(p_vehicle_id, p_actor) then
    raise exception 'FORBIDDEN: not your vehicle' using errcode = '42501';
  end if;

  update public.vehicle_driver_assignments
  set unassigned_at = now(), unassigned_by = p_actor
  where vehicle_id = p_vehicle_id and unassigned_at is null;

  get diagnostics v_count = row_count;

  perform app.write_audit(
    p_actor, 'vehicle.unassignDriver', 'vehicle', p_vehicle_id::text,
    jsonb_build_object('active', v_count), jsonb_build_object('active', 0),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('vehicleId', p_vehicle_id, 'unassigned', v_count);
end;
$$;

create or replace function public.cmd_set_vehicle_photos(
  p_actor uuid,
  p_vehicle_id uuid,
  p_photos jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photo jsonb;
  v_count int := 0;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.owns_vehicle(p_vehicle_id, p_actor) then
    raise exception 'FORBIDDEN: not your vehicle' using errcode = '42501';
  end if;
  if p_photos is null or jsonb_typeof(p_photos) <> 'array' then
    raise exception 'VALIDATION_FAILED: photos' using errcode = '22023';
  end if;
  if jsonb_array_length(p_photos) > 12 then
    raise exception 'VALIDATION_FAILED: at most 12 photos' using errcode = '22023';
  end if;

  -- Every path must be inside this vehicle's folder. The bucket policy says the same thing, but a row
  -- pointing at someone else's file would be readable forever, so it is checked where it matters.
  for v_photo in select * from jsonb_array_elements(p_photos) loop
    if coalesce(v_photo ->> 'path', '') = ''
       or split_part(v_photo ->> 'path', '/', 1) <> p_vehicle_id::text then
      raise exception 'VALIDATION_FAILED: photo path must be under %/', p_vehicle_id using errcode = '22023';
    end if;
    v_count := v_count + 1;
  end loop;

  delete from public.vehicle_photos where vehicle_id = p_vehicle_id;
  insert into public.vehicle_photos (vehicle_id, storage_path, caption, is_primary, sort_order, uploaded_by)
  select p_vehicle_id, photo ->> 'path', nullif(photo ->> 'caption', ''),
         coalesce((photo ->> 'isPrimary')::boolean, ordinality = 1),
         (ordinality - 1)::smallint, p_actor
  from jsonb_array_elements(p_photos) with ordinality as t(photo, ordinality);

  -- The newest upload becomes the card image when nothing claimed that role.
  if not exists (select 1 from public.vehicle_photos where vehicle_id = p_vehicle_id and is_primary) then
    update public.vehicle_photos set is_primary = true
    where id = (select id from public.vehicle_photos where vehicle_id = p_vehicle_id order by sort_order limit 1);
  end if;

  perform app.write_audit(
    p_actor, 'vehicle.photos', 'vehicle', p_vehicle_id::text, null,
    jsonb_build_object('photos', v_count), null, p_request_id, p_ip
  );

  return jsonb_build_object('vehicleId', p_vehicle_id, 'photos', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Lock the commands down: service_role only, exactly like every other cmd_*
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.cmd_create_vehicle(uuid, uuid, jsonb, text, inet)',
    'public.cmd_update_vehicle(uuid, uuid, jsonb, text, inet)',
    'public.cmd_submit_vehicle_verification(uuid, uuid, jsonb, text, inet)',
    'public.cmd_decide_vehicle_verification(uuid, uuid, public.verification_outcome, text, text, inet)',
    'public.cmd_set_vehicle_status(uuid, uuid, public.vehicle_status, text, text, inet)',
    'public.cmd_invite_driver(uuid, uuid, text, text, text, date, text, inet)',
    'public.cmd_accept_driver_invite(uuid, text, inet)',
    'public.cmd_verify_driver(uuid, uuid, public.verification_outcome, text, text, inet)',
    'public.cmd_assign_driver(uuid, uuid, uuid, text, inet)',
    'public.cmd_unassign_driver(uuid, uuid, text, inet)',
    'public.cmd_set_vehicle_photos(uuid, uuid, jsonb, text, inet)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;

  -- Command internals: nobody but the gateway may call these. `assert_vehicle_payload` in particular
  -- must not be reachable from a browser, or a client could "validate" a payload the command then
  -- inserts unchanged.
  foreach v_signature in array array[
    'app.assert_quota(uuid, uuid, text, integer)',
    'app.owner_plan(uuid, uuid)',
    'app.assert_vehicle_payload(jsonb)',
    'app.normalize_phone(text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;

  -- Predicates that RLS policies *execute as the querying role*. Revoking these does not harden the
  -- schema; it makes every select on `vehicles` fail with 42501 from inside its own policy.
  foreach v_signature in array array[
    'app.owns_vehicle(uuid, uuid)',
    'app.is_assigned_driver(uuid, uuid)',
    'app.safe_uuid(text)',
    'app.normalize_plate(text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', v_signature);
    execute format('grant execute on function %s to authenticated, service_role', v_signature);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Storage: fleet photos (public) and documents (private)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('vehicle-photos', 'vehicle-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('vehicle-documents', 'vehicle-documents', false, 10485760,
   array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

-- Path convention: <vehicle-uuid>/<file>. The first folder must be a vehicle the caller owns, which is
-- the same rule as everywhere else in this phase.
create policy vehicle_photos_read_all on storage.objects
  for select using (bucket_id = 'vehicle-photos');

create policy vehicle_photos_write_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vehicle-photos'
    and app.owns_vehicle(app.safe_uuid((storage.foldername(name))[1]))
  );

create policy vehicle_documents_read_own_or_staff on storage.objects
  for select to authenticated
  using (
    bucket_id = 'vehicle-documents'
    and (app.owns_vehicle(app.safe_uuid((storage.foldername(name))[1])) or app.is_platform_staff())
  );

create policy vehicle_documents_write_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vehicle-documents'
    and app.owns_vehicle(app.safe_uuid((storage.foldername(name))[1]))
  );
