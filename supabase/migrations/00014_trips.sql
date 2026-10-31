-- 00014 — Phase 4: trips, pricing and the public marketplace
--
-- A trip is a *published promise*: a route, a time, a vehicle, a driver and a price. Everything in this
-- migration exists to make that promise honest and to make it findable.
--
-- Three rules shape the whole file:
--   1. **Drafts are private, published trips are public** — and nothing else is. Visibility is derived
--      (`app.set_trip_visibility`), never typed in by a client.
--   2. **A trip freezes two hours before departure** (BR-06). The rule lives in
--      `app.assert_trip_editable`, so the RPC refuses with `EDIT_WINDOW_CLOSED` even if a screen forgets
--      to disable its button.
--   3. **The marketplace reads a projection, not the trip table** — `trips_search` is refreshed by
--      triggers, so a cancelled trip leaves the public list in the same transaction that cancels it.
--
-- Quotas (§6.14) are extended here, not re-implemented: `trips` becomes a per-calendar-month metric
-- (Basic: 5 trips/month), `active_trips` counts published future departures, `featured_listings` counts
-- live boosts. Soft plans get a warning at 80% and are still blocked at 100% — a limit that never
-- blocks is not a limit.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

create type public.trip_status as enum ('draft', 'pending', 'published', 'cancelled', 'completed');

create type public.trip_event_kind as enum (
  'created', 'updated', 'stops_changed', 'submitted', 'approved', 'rejected',
  'published', 'unpublished', 'cancelled', 'completed'
);

-- These four mirror `packages/core/src/domain/pricing.ts` exactly. The names are the ones the pricing
-- engine already used in Phase 0 — the database follows the code, not the other way round.
create type public.trip_booking_mode as enum ('per_seat', 'whole_trip', 'both');
create type public.trip_pricing_mode as enum ('flat', 'per_stop');
create type public.trip_discount_kind as enum ('none', 'fixed', 'percent');
create type public.trip_discount_scope as enum ('per_seat', 'whole_trip', 'all');

create type public.trip_gender_policy as enum ('any', 'women_only', 'men_only');
create type public.trip_payment_policy as enum ('cash', 'transfer', 'deposit');

-- ---------------------------------------------------------------------------
-- 2. Trips
-- ---------------------------------------------------------------------------

create table public.trips (
  id                          uuid primary key default gen_random_uuid(),

  -- A short, stable, human-shareable code: `/trips/ADE-SAA-7K2Q`. Uppercase so a URL is case-safe.
  code                        text not null unique check (code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'),

  owner_user_id               uuid references public.profiles (id) on delete restrict,
  owner_org_id                uuid references public.organizations (id) on delete restrict,

  vehicle_id                  uuid not null references public.vehicles (id) on delete restrict,
  driver_id                   uuid references public.driver_profiles (id) on delete set null,

  origin_governorate_id       uuid not null references public.governorates (id) on delete restrict,
  destination_governorate_id  uuid not null references public.governorates (id) on delete restrict,

  departure_at                timestamptz not null,
  -- Local business date, computed once so a calendar query never has to know the timezone.
  departure_date              date generated always as (
                                (departure_at at time zone 'Asia/Aden')::date
                              ) stored,
  arrive_estimate_minutes     integer not null default 0 check (arrive_estimate_minutes between 0 and 4320),

  seats_total                 smallint not null check (seats_total between 1 and 60),
  -- Maintained by app.recompute_seats_available(); Phase 5 subtracts real bookings.
  seats_available             smallint not null check (seats_available >= 0),
  constraint trips_seats_available_within_total check (seats_available <= seats_total),

  booking_mode                public.trip_booking_mode not null default 'per_seat',
  pricing_mode                public.trip_pricing_mode not null default 'flat',
  price_per_seat_yer          integer check (price_per_seat_yer is null or price_per_seat_yer >= 0),
  whole_trip_price_yer        integer check (whole_trip_price_yer is null or whole_trip_price_yer >= 0),

  discount_kind               public.trip_discount_kind not null default 'none',
  -- percent: basis points (1000 = 10%). fixed: whole YER. Never a float.
  discount_value              integer not null default 0 check (discount_value >= 0),
  discount_scope              public.trip_discount_scope not null default 'all',

  gender_policy               public.trip_gender_policy not null default 'any',
  payment_policy              public.trip_payment_policy not null default 'cash',
  luggage_allowance_kg        smallint check (luggage_allowance_kg is null or luggage_allowance_kg between 0 and 500),
  policies                    jsonb not null default '{}'::jsonb,
  notes                       text check (notes is null or length(notes) <= 2000),

  status                      public.trip_status not null default 'draft',
  verification_status         public.verification_status not null default 'unverified',
  verified_by                 uuid references public.profiles (id) on delete set null,
  verified_at                 timestamptz,
  verification_note           text,

  published_at                timestamptz,
  featured_until              timestamptz,
  cancelled_at                timestamptz,
  cancelled_by                uuid references public.profiles (id) on delete set null,
  cancel_reason               text,
  completed_at                timestamptz,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint trips_one_owner check (num_nonnulls(owner_user_id, owner_org_id) = 1),
  constraint trips_distinct_route check (origin_governorate_id <> destination_governorate_id),
  constraint trips_flat_price_present check (
    pricing_mode = 'per_stop' or booking_mode = 'whole_trip' or price_per_seat_yer is not null
  ),
  constraint trips_whole_price_present check (
    booking_mode <> 'whole_trip' or whole_trip_price_yer is not null
  ),
  constraint trips_percent_range check (
    discount_kind <> 'percent' or discount_value between 0 and 10000
  ),
  constraint trips_discount_consistent check (
    (discount_kind = 'none' and discount_value = 0) or discount_kind <> 'none'
  ),
  constraint trips_cancel_reason_present check (
    status <> 'cancelled' or cancelled_at is not null
  )
);

create index trips_owner_user_idx on public.trips (owner_user_id, created_at desc);
create index trips_owner_org_idx on public.trips (owner_org_id, created_at desc);
create index trips_departure_idx on public.trips (departure_at);
create index trips_status_idx on public.trips (status, departure_at);
create index trips_vehicle_idx on public.trips (vehicle_id, departure_at desc);

create trigger trips_set_updated_at
  before update on public.trips
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Quotas: trips per month, active trips, featured slots
-- ---------------------------------------------------------------------------

/**
 * The quota state without the exception — used to *warn* before blocking.
 *
 * `assert_quota` raises at 100% for every plan; this returns the numbers so `create_trip` can attach a
 * soft warning at 80% for Pro/Business, which is what "soft limit" is supposed to mean.
 */
create or replace function app.quota_state(
  p_owner_user uuid,
  p_owner_org uuid,
  p_metric text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan public.plan_code;
  v_limit integer;
  v_soft boolean;
  v_used integer;
begin
  v_plan := app.owner_plan(p_owner_user, p_owner_org);

  select l.limit_value, coalesce(p.soft_limit, false)
  into v_limit, v_soft
  from public.plan_limits l
  join public.plans p on p.code = l.plan_code
  where l.plan_code = v_plan and l.metric = p_metric;

  if not found then
    raise exception 'VALIDATION_FAILED: unknown quota metric %', p_metric using errcode = '22023';
  end if;

  v_used := app.quota_usage(p_owner_user, p_owner_org, p_metric);

  return jsonb_build_object(
    'metric', p_metric,
    'plan', v_plan,
    'limit', v_limit,
    'used', v_used,
    'soft', v_soft,
    -- Only a soft plan warns, and only when it is close: a warning printed from day one is noise.
    'warning', (v_limit is not null and v_soft and v_limit > 0 and (v_used + 1) * 5 >= v_limit * 4)
  );
end;
$$;

/** Live usage per metric. One definition, because the counter and the check must agree. */
create or replace function app.quota_usage(p_owner_user uuid, p_owner_org uuid, p_metric text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case p_metric
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
    -- Trips are counted per calendar month: the limit is "5 trips a month", not "5 trips, ever".
    -- The month boundary is Yemeni, because that is where the operator lives (§6.15).
    when 'trips' then (
      select count(*)::int from public.trips t
      where date_trunc('month', t.created_at at time zone 'Asia/Aden')
          = date_trunc('month', now() at time zone 'Asia/Aden')
        and (case when p_owner_org is not null then t.owner_org_id = p_owner_org
                  else t.owner_user_id = p_owner_user end)
    )
    when 'active_trips' then (
      select count(*)::int from public.trips t
      where t.status = 'published' and t.departure_at > now()
        and (case when p_owner_org is not null then t.owner_org_id = p_owner_org
                  else t.owner_user_id = p_owner_user end)
    )
    when 'featured_listings' then (
      select count(*)::int from public.trips t
      where t.featured_until is not null and t.featured_until > now()
        and (case when p_owner_org is not null then t.owner_org_id = p_owner_org
                  else t.owner_user_id = p_owner_user end)
    )
    else 0
  end;
$$;

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
  v_state jsonb;
  v_limit integer;
  v_used integer;
begin
  v_state := app.quota_state(p_owner_user, p_owner_org, p_metric);
  v_limit := (v_state ->> 'limit')::integer;
  v_used := (v_state ->> 'used')::integer;

  -- NULL means unlimited; 0 is a real limit and must still block.
  if v_limit is null then
    return;
  end if;

  if v_used + p_delta > v_limit then
    raise exception 'QUOTA_EXCEEDED: metric=% limit=% used=%', p_metric, v_limit, v_used
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function app.assert_quota(uuid, uuid, text, integer) is
  'Plan limit gate. Blocks at 100% for every plan; app.quota_state() carries the 80% soft warning.';

-- ---------------------------------------------------------------------------
-- 4. Stops, events, verification trail
-- ---------------------------------------------------------------------------

create table public.trip_stops (
  id                      uuid primary key default gen_random_uuid(),
  trip_id                 uuid not null references public.trips (id) on delete cascade,
  -- 1-based and contiguous. The command refuses a gap, because "stop 2 of 1" is a bug, not a route.
  seq                     smallint not null check (seq between 1 and 20),
  place_id                uuid references public.places (id) on delete restrict,
  governorate_id          uuid references public.governorates (id) on delete restrict,
  -- Free-text fallback for a stop that is not in the gazetteer yet (a village, a specific station).
  name_ar                 text check (name_ar is null or length(btrim(name_ar)) between 1 and 160),
  name_en                 text check (name_en is null or length(btrim(name_en)) between 1 and 160),
  arrive_offset_minutes   integer not null check (arrive_offset_minutes >= 0),
  -- Per-stop pricing: the fare from the origin to this stop. NULL falls back to the trip's price.
  price_from_origin_yer   integer check (price_from_origin_yer is null or price_from_origin_yer >= 0),
  created_at              timestamptz not null default now(),

  unique (trip_id, seq),
  -- A route that visits the same place twice is a loop, and a loop needs a different model.
  unique (trip_id, place_id),
  constraint trip_stops_named check (place_id is not null or name_ar is not null or name_en is not null)
);

create index trip_stops_trip_idx on public.trip_stops (trip_id, seq);

/**
 * Consecutive duplicates are the classic data-entry error ("عدن، عدن") and are refused here rather than
 * discovered by a passenger looking at a timeline that repeats itself.
 */
create or replace function app.trip_stop_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous public.trip_stops%rowtype;
  v_key text;
  v_previous_key text;
begin
  select * into v_previous
  from public.trip_stops s
  where s.trip_id = new.trip_id and s.seq = new.seq - 1;

  if found then
    v_key := lower(coalesce(nullif(btrim(coalesce(new.name_ar, '')), ''), coalesce(new.place_id::text, '')));
    v_previous_key := lower(coalesce(nullif(btrim(coalesce(v_previous.name_ar, '')), ''), coalesce(v_previous.place_id::text, '')));
    if v_key <> '' and v_key = v_previous_key then
      raise exception 'VALIDATION_FAILED: two consecutive stops are the same place' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

create trigger trip_stops_no_consecutive_duplicates
  before insert or update on public.trip_stops
  for each row execute function app.trip_stop_guard();

create table public.trip_events (
  id          bigint generated always as identity primary key,
  trip_id     uuid not null references public.trips (id) on delete cascade,
  kind        public.trip_event_kind not null,
  actor_id    uuid references public.profiles (id) on delete set null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index trip_events_trip_idx on public.trip_events (trip_id, created_at desc);

/** Append-only: the trail is evidence, so nothing updates or deletes it. */
create or replace function app.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'FORBIDDEN: % is append-only', tg_table_name using errcode = '42501';
end;
$$;

create trigger trip_events_append_only
  before update or delete on public.trip_events
  for each row execute function app.reject_mutation();

create table public.trip_verifications (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips (id) on delete cascade,
  submitted_by  uuid references public.profiles (id) on delete set null,
  submitted_at  timestamptz not null default now(),
  -- What was reviewed: the prices and route at submission time, so a later edit cannot rewrite history.
  snapshot      jsonb not null default '{}'::jsonb,
  outcome       public.verification_outcome,
  decided_by    uuid references public.profiles (id) on delete set null,
  decided_at    timestamptz,
  note          text
);

create index trip_verifications_trip_idx on public.trip_verifications (trip_id, submitted_at desc);
create unique index trip_verifications_one_pending
  on public.trip_verifications (trip_id) where outcome is null;

-- ---------------------------------------------------------------------------
-- 5. trips_search — the projection the marketplace reads
-- ---------------------------------------------------------------------------

create table public.trips_search (
  trip_id                     uuid primary key references public.trips (id) on delete cascade,
  owner_user_id               uuid,
  owner_org_id                uuid,

  status                      public.trip_status not null,
  verification_status         public.verification_status not null,
  is_public                   boolean not null default false,

  departure_at                timestamptz not null,
  departure_date              date not null,
  seats_available             smallint not null,
  seats_total                 smallint not null,

  price_from_yer              integer not null,
  price_per_seat_yer          integer,
  discount_kind               public.trip_discount_kind not null,
  discount_value              integer not null,
  booking_mode                public.trip_booking_mode not null,
  pricing_mode                public.trip_pricing_mode not null,

  origin_governorate_id       uuid not null,
  destination_governorate_id  uuid not null,
  stop_governorate_ids        uuid[] not null default '{}',
  stop_place_ids              uuid[] not null default '{}',
  stop_count                  smallint not null default 0,

  gender_policy               public.trip_gender_policy not null,
  payment_policy              public.trip_payment_policy not null,

  operator_name_ar            text,
  operator_name_en            text,
  vehicle_label               text,

  featured_until              timestamptz,
  is_featured                 boolean not null default false,
  -- One scalar for the trigram index: names in both languages, so «صنعاء» and "Sanaa" both match.
  search_text                 text not null default '',

  updated_at                  timestamptz not null default now()
);

create index trips_search_public_idx
  on public.trips_search (departure_at) where is_public;
create index trips_search_price_idx on public.trips_search (price_from_yer);
create index trips_search_route_idx on public.trips_search (origin_governorate_id, destination_governorate_id);
create index trips_search_stop_places_idx on public.trips_search using gin (stop_place_ids);
create index trips_search_stop_govs_idx on public.trips_search using gin (stop_governorate_ids);
create index trips_search_text_trgm on public.trips_search using gin (search_text gin_trgm_ops);
create index trips_search_featured_idx on public.trips_search (is_featured, departure_at);

/**
 * Visibility, in one place.
 *
 * Published and not rejected is public. "Departure in the future" is deliberately *not* part of this
 * flag: it is a query condition, so a trip cannot stay public because a refresh ran at a lucky moment.
 */
create or replace function app.set_trip_visibility(p_trip public.trips)
returns boolean
language sql
immutable
as $$
  select p_trip.status = 'published'
     and p_trip.verification_status <> 'rejected'
     and p_trip.cancelled_at is null;
$$;

/** The fare from the origin to `p_stop_seq`, before discounts. Mirrors computePrice() in @maak/core. */
create or replace function app.trip_unit_fare(p_trip public.trips, p_stop_seq integer)
returns integer
language plpgsql
stable
as $$
declare
  v_price integer;
begin
  if p_trip.booking_mode = 'whole_trip' then
    return p_trip.whole_trip_price_yer;
  end if;

  if p_trip.pricing_mode = 'per_stop' and p_stop_seq is not null then
    select s.price_from_origin_yer into v_price
    from public.trip_stops s
    where s.trip_id = p_trip.id and s.seq = p_stop_seq;
    if v_price is not null then
      return v_price;
    end if;
  end if;

  return p_trip.price_per_seat_yer;
end;
$$;

/** Subtotal → discount → total, exactly as `computeDiscountMinor()` does it in TypeScript. */
create or replace function app.trip_total(
  p_trip public.trips,
  p_stop_seq integer,
  p_seats integer
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_unit integer;
  v_subtotal integer;
  v_discount integer := 0;
  v_scope_matches boolean;
begin
  if p_seats is null or p_seats < 1 then
    raise exception 'VALIDATION_FAILED: seats must be positive' using errcode = '22023';
  end if;

  v_unit := app.trip_unit_fare(p_trip, p_stop_seq);
  if v_unit is null then
    raise exception 'VALIDATION_FAILED: this trip has no price for that stop' using errcode = '22023';
  end if;

  v_subtotal := case when p_trip.booking_mode = 'whole_trip' then v_unit else v_unit * p_seats end;

  v_scope_matches := p_trip.discount_scope = 'all'
    or (p_trip.discount_scope = 'per_seat' and p_trip.booking_mode <> 'whole_trip')
    or (p_trip.discount_scope = 'whole_trip' and p_trip.booking_mode = 'whole_trip');

  if p_trip.discount_kind <> 'none' and v_scope_matches then
    v_discount := case p_trip.discount_kind
      when 'percent' then round(v_subtotal::numeric * p_trip.discount_value / 10000)
      else least(p_trip.discount_value, v_subtotal)
    end;
  end if;

  return jsonb_build_object(
    'currency', 'YER',
    'unitFareMinor', v_unit,
    'seats', p_seats,
    'subtotalMinor', v_subtotal,
    'discountMinor', v_discount,
    'totalMinor', v_subtotal - v_discount
  );
end;
$$;

/** The "from" price a card advertises: the cheapest stop, or the flat fare when there are no stops. */
create or replace function app.trip_price_from(p_trip_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_min integer;
begin
  select * into v_trip from public.trips t where t.id = p_trip_id;
  if not found then
    return null;
  end if;

  if v_trip.booking_mode = 'whole_trip' then
    return v_trip.whole_trip_price_yer;
  end if;

  if v_trip.pricing_mode = 'per_stop' then
    select min(coalesce(s.price_from_origin_yer, v_trip.price_per_seat_yer))
    into v_min
    from public.trip_stops s
    where s.trip_id = p_trip_id;
    if v_min is not null then
      return v_min;
    end if;
  end if;

  return v_trip.price_per_seat_yer;
end;
$$;

create or replace function app.trip_booked_seats(p_trip_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  -- Phase 5 replaces this body with a count of accepted bookings; the callers do not change.
  select 0;
$$;

/** Seats left = capacity − booked. One function, so the projection and the detail page agree. */
create or replace function app.recompute_seats_available(p_trip_id uuid)
returns smallint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total smallint;
  v_available smallint;
begin
  select t.seats_total into v_total from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  v_available := greatest(0, v_total - app.trip_booked_seats(p_trip_id));

  update public.trips set seats_available = v_available where id = p_trip_id;
  return v_available;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Keeping the projection honest
-- ---------------------------------------------------------------------------

create table public.search_cache (
  key         text primary key,
  payload     jsonb not null,
  expires_at  timestamptz not null
);

create index search_cache_expiry_idx on public.search_cache (expires_at);

/**
 * Rebuilds the search row for one trip.
 *
 * Called by triggers rather than by the commands: cancelling a trip must remove it from the public list
 * even if the cancel came from a staff tool, a migration or a future cron. The command is not a reliable
 * place for a rule that protects everyone else's data.
 */
create or replace function app.refresh_trip_search(p_trip_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_operator_ar text;
  v_operator_en text;
  v_vehicle text;
  v_origin_ar text;
  v_origin_en text;
  v_dest_ar text;
  v_dest_en text;
  v_stop_places uuid[];
  v_stop_govs uuid[];
  v_stop_names text;
  v_stop_count smallint;
begin
  select * into v_trip from public.trips t where t.id = p_trip_id;
  if not found then
    delete from public.trips_search where trip_id = p_trip_id;
    delete from public.search_cache;
    return;
  end if;

  if v_trip.owner_org_id is not null then
    select o.name, coalesce(o.name_en, o.name) into v_operator_ar, v_operator_en
    from public.organizations o where o.id = v_trip.owner_org_id;
  else
    select coalesce(p.full_name, '—') into v_operator_ar
    from public.profiles p where p.id = v_trip.owner_user_id;
    v_operator_en := v_operator_ar;
  end if;

  select v.make || ' ' || v.model || ' ' || v.model_year into v_vehicle
  from public.vehicles v where v.id = v_trip.vehicle_id;

  select g.name_ar, g.name_en into v_origin_ar, v_origin_en
  from public.governorates g where g.id = v_trip.origin_governorate_id;
  select g.name_ar, g.name_en into v_dest_ar, v_dest_en
  from public.governorates g where g.id = v_trip.destination_governorate_id;

  select
    coalesce(array_agg(distinct s.place_id) filter (where s.place_id is not null), '{}'),
    coalesce(array_agg(distinct coalesce(s.governorate_id, pl.governorate_id))
             filter (where coalesce(s.governorate_id, pl.governorate_id) is not null), '{}'),
    coalesce(string_agg(coalesce(s.name_ar, s.name_en, pl.name_ar, pl.name_en, ''), ' '), ''),
    count(*)::smallint
  into v_stop_places, v_stop_govs, v_stop_names, v_stop_count
  from public.trip_stops s
  left join public.places pl on pl.id = s.place_id
  where s.trip_id = p_trip_id;

  insert into public.trips_search as ts (
    trip_id, owner_user_id, owner_org_id, status, verification_status, is_public,
    departure_at, departure_date, seats_available, seats_total,
    price_from_yer, price_per_seat_yer, discount_kind, discount_value, booking_mode, pricing_mode,
    origin_governorate_id, destination_governorate_id,
    stop_governorate_ids, stop_place_ids, stop_count,
    gender_policy, payment_policy, operator_name_ar, operator_name_en, vehicle_label,
    featured_until, is_featured, search_text, updated_at
  ) values (
    v_trip.id, v_trip.owner_user_id, v_trip.owner_org_id, v_trip.status, v_trip.verification_status,
    app.set_trip_visibility(v_trip),
    v_trip.departure_at, v_trip.departure_date, v_trip.seats_available, v_trip.seats_total,
    coalesce(app.trip_price_from(v_trip.id), 0), v_trip.price_per_seat_yer,
    v_trip.discount_kind, v_trip.discount_value, v_trip.booking_mode, v_trip.pricing_mode,
    v_trip.origin_governorate_id, v_trip.destination_governorate_id,
    v_stop_govs, v_stop_places, v_stop_count,
    v_trip.gender_policy, v_trip.payment_policy, v_operator_ar, v_operator_en, v_vehicle,
    v_trip.featured_until, coalesce(v_trip.featured_until > now(), false),
    lower(concat_ws(' ', v_origin_ar, v_origin_en, v_dest_ar, v_dest_en, v_operator_ar, v_stop_names)),
    now()
  )
  on conflict (trip_id) do update set
    owner_user_id = excluded.owner_user_id,
    owner_org_id = excluded.owner_org_id,
    status = excluded.status,
    verification_status = excluded.verification_status,
    is_public = excluded.is_public,
    departure_at = excluded.departure_at,
    departure_date = excluded.departure_date,
    seats_available = excluded.seats_available,
    seats_total = excluded.seats_total,
    price_from_yer = excluded.price_from_yer,
    price_per_seat_yer = excluded.price_per_seat_yer,
    discount_kind = excluded.discount_kind,
    discount_value = excluded.discount_value,
    booking_mode = excluded.booking_mode,
    pricing_mode = excluded.pricing_mode,
    origin_governorate_id = excluded.origin_governorate_id,
    destination_governorate_id = excluded.destination_governorate_id,
    stop_governorate_ids = excluded.stop_governorate_ids,
    stop_place_ids = excluded.stop_place_ids,
    stop_count = excluded.stop_count,
    gender_policy = excluded.gender_policy,
    payment_policy = excluded.payment_policy,
    operator_name_ar = excluded.operator_name_ar,
    operator_name_en = excluded.operator_name_en,
    vehicle_label = excluded.vehicle_label,
    featured_until = excluded.featured_until,
    is_featured = excluded.is_featured,
    search_text = excluded.search_text,
    updated_at = excluded.updated_at;

  -- A cached search page is a 30-second lie after any change; the cheapest correct answer is to drop it.
  delete from public.search_cache;
end;
$$;

create or replace function app.trips_refresh_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.refresh_trip_search(coalesce(new.id, old.id));
  return null;
end;
$$;

create trigger trips_refresh_search
  after insert or update on public.trips
  for each row execute function app.trips_refresh_trigger();

create trigger trips_delete_search
  after delete on public.trips
  for each row execute function app.trips_refresh_trigger();

create or replace function app.trip_stops_refresh_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.refresh_trip_search(coalesce(new.trip_id, old.trip_id));
  return null;
end;
$$;

create trigger trip_stops_refresh_search
  after insert or update or delete on public.trip_stops
  for each row execute function app.trip_stops_refresh_trigger();

-- ---------------------------------------------------------------------------
-- 7. Rules: who may manage a trip, and when it freezes
-- ---------------------------------------------------------------------------

create or replace function app.actor_can_manage_trip(p_actor uuid, p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id
      and (
        (t.owner_user_id is not null and t.owner_user_id = p_actor)
        or (t.owner_org_id is not null and app.is_org_member(t.owner_org_id, p_actor))
        or app.is_platform_staff(p_actor)
      )
  );
$$;

/**
 * BR-06 — the two-hour edit lock.
 *
 * It is a *database* rule on purpose: the wizard disables its fields as a courtesy, but a stale tab, a
 * retried request or a curl call must hit the same wall, and the answer is a code the client can act on
 * (`EDIT_WINDOW_CLOSED`), not a generic 42501.
 */
create or replace function app.assert_trip_editable(p_trip public.trips, p_allow_published boolean default true)
returns void
language plpgsql
stable
as $$
begin
  if p_trip.status in ('cancelled', 'completed') then
    raise exception 'CONFLICT: a % trip cannot be edited', p_trip.status using errcode = '23505';
  end if;

  if not p_allow_published and p_trip.status = 'published' then
    raise exception 'CONFLICT: the trip is already published' using errcode = '23505';
  end if;

  if now() > p_trip.departure_at - interval '2 hours' then
    raise exception 'EDIT_WINDOW_CLOSED: departure % is less than two hours away', p_trip.departure_at
      using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Payload validation and the stop writer (shared by create and update)
-- ---------------------------------------------------------------------------

create or replace function app.assert_trip_payload(p_trip jsonb)
returns void
language plpgsql
immutable
as $$
declare
  v_departure timestamptz;
  v_kind text;
begin
  if p_trip is null or jsonb_typeof(p_trip) <> 'object' then
    raise exception 'VALIDATION_FAILED: trip must be an object' using errcode = '22023';
  end if;

  if app.safe_uuid(p_trip ->> 'originGovernorateId') is null
     or app.safe_uuid(p_trip ->> 'destinationGovernorateId') is null then
    raise exception 'VALIDATION_FAILED: origin and destination governorates are required'
      using errcode = '22023';
  end if;

  if p_trip ->> 'originGovernorateId' = p_trip ->> 'destinationGovernorateId' then
    raise exception 'VALIDATION_FAILED: origin and destination must differ' using errcode = '22023';
  end if;

  begin
    v_departure := (p_trip ->> 'departureAt')::timestamptz;
  exception when others then
    raise exception 'VALIDATION_FAILED: departureAt is not a timestamp' using errcode = '22023';
  end;

  if v_departure is null then
    raise exception 'VALIDATION_FAILED: departureAt is required' using errcode = '22023';
  end if;
  if v_departure <= now() then
    raise exception 'VALIDATION_FAILED: a trip cannot depart in the past' using errcode = '22023';
  end if;

  if coalesce((p_trip ->> 'seatsTotal')::int, 0) not between 1 and 60 then
    raise exception 'VALIDATION_FAILED: seatsTotal must be between 1 and 60' using errcode = '22023';
  end if;

  if coalesce(p_trip ->> 'bookingMode', 'per_seat') not in ('per_seat', 'whole_trip', 'both') then
    raise exception 'VALIDATION_FAILED: unknown bookingMode' using errcode = '22023';
  end if;
  if coalesce(p_trip ->> 'pricingMode', 'flat') not in ('flat', 'per_stop') then
    raise exception 'VALIDATION_FAILED: unknown pricingMode' using errcode = '22023';
  end if;
  if coalesce(p_trip ->> 'genderPolicy', 'any') not in ('any', 'women_only', 'men_only') then
    raise exception 'VALIDATION_FAILED: unknown genderPolicy' using errcode = '22023';
  end if;
  if coalesce(p_trip ->> 'paymentPolicy', 'cash') not in ('cash', 'transfer', 'deposit') then
    raise exception 'VALIDATION_FAILED: unknown paymentPolicy' using errcode = '22023';
  end if;

  v_kind := coalesce(p_trip ->> 'discountKind', 'none');
  if v_kind not in ('none', 'fixed', 'percent') then
    raise exception 'VALIDATION_FAILED: unknown discountKind' using errcode = '22023';
  end if;
  if coalesce(p_trip ->> 'discountScope', 'all') not in ('per_seat', 'whole_trip', 'all') then
    raise exception 'VALIDATION_FAILED: unknown discountScope' using errcode = '22023';
  end if;
  if v_kind = 'percent' and coalesce((p_trip ->> 'discountValue')::int, 0) not between 0 and 10000 then
    raise exception 'VALIDATION_FAILED: a percentage discount is expressed in basis points (0-10000)'
      using errcode = '22023';
  end if;
  if v_kind = 'none' and coalesce((p_trip ->> 'discountValue')::int, 0) <> 0 then
    raise exception 'VALIDATION_FAILED: discountValue must be 0 when discountKind is none'
      using errcode = '22023';
  end if;

  -- A price is mandatory unless every stop carries one (per-stop pricing fills them in later).
  if coalesce(p_trip ->> 'bookingMode', 'per_seat') = 'whole_trip' then
    if coalesce((p_trip ->> 'wholeTripPriceYer')::int, -1) < 0 then
      raise exception 'VALIDATION_FAILED: wholeTripPriceYer is required for whole-trip bookings'
        using errcode = '22023';
    end if;
  elsif coalesce(p_trip ->> 'pricingMode', 'flat') = 'flat' then
    if coalesce((p_trip ->> 'pricePerSeatYer')::int, -1) < 0 then
      raise exception 'VALIDATION_FAILED: pricePerSeatYer is required' using errcode = '22023';
    end if;
  end if;

  if (p_trip ->> 'pricePerSeatYer') is not null and (p_trip ->> 'pricePerSeatYer')::int < 0 then
    raise exception 'VALIDATION_FAILED: pricePerSeatYer cannot be negative' using errcode = '22023';
  end if;
  if (p_trip ->> 'wholeTripPriceYer') is not null and (p_trip ->> 'wholeTripPriceYer')::int < 0 then
    raise exception 'VALIDATION_FAILED: wholeTripPriceYer cannot be negative' using errcode = '22023';
  end if;

  if p_trip ? 'notes' and length(coalesce(p_trip ->> 'notes', '')) > 2000 then
    raise exception 'VALIDATION_FAILED: notes are limited to 2000 characters' using errcode = '22023';
  end if;
end;
$$;

/**
 * Replaces the whole stop list for a trip.
 *
 * Replace, never patch: stop ordering is a property of the list, and a partial update is how a route
 * ends up with two stop 3s. The unique index on (trip_id, seq) is the last line of defence, not the first.
 */
create or replace function app.replace_trip_stops(p_trip_id uuid, p_stops jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stop jsonb;
  v_index integer := 0;
  v_offset integer := -1;
  v_previous_name text;
  v_name text;
begin
  if p_stops is null or jsonb_typeof(p_stops) <> 'array' then
    raise exception 'VALIDATION_FAILED: stops must be an array' using errcode = '22023';
  end if;

  if jsonb_array_length(p_stops) > 10 then
    raise exception 'VALIDATION_FAILED: a trip cannot have more than 10 stops' using errcode = '22023';
  end if;

  delete from public.trip_stops where trip_id = p_trip_id;

  for v_stop in select * from jsonb_array_elements(p_stops)
  loop
    v_index := v_index + 1;

    if coalesce((v_stop ->> 'arriveOffsetMinutes')::int, -1) < 0 then
      raise exception 'VALIDATION_FAILED: arriveOffsetMinutes is required for every stop'
        using errcode = '22023';
    end if;
    if (v_stop ->> 'arriveOffsetMinutes')::int < v_offset then
      raise exception 'VALIDATION_FAILED: stops must be in the order they are reached'
        using errcode = '22023';
    end if;
    v_offset := (v_stop ->> 'arriveOffsetMinutes')::int;

    v_name := lower(btrim(coalesce(v_stop ->> 'nameAr', v_stop ->> 'nameEn', '')));
    if v_name <> '' and v_name = coalesce(v_previous_name, '') then
      raise exception 'VALIDATION_FAILED: two consecutive stops are the same place'
        using errcode = '22023';
    end if;
    v_previous_name := v_name;

    if (v_stop ->> 'priceFromOriginYer') is not null
       and (v_stop ->> 'priceFromOriginYer')::int < 0 then
      raise exception 'VALIDATION_FAILED: a stop price cannot be negative' using errcode = '22023';
    end if;

    insert into public.trip_stops (
      trip_id, seq, place_id, governorate_id, name_ar, name_en,
      arrive_offset_minutes, price_from_origin_yer
    ) values (
      p_trip_id,
      v_index,
      app.safe_uuid(v_stop ->> 'placeId'),
      coalesce(
        app.safe_uuid(v_stop ->> 'governorateId'),
        (select pl.governorate_id from public.places pl where pl.id = app.safe_uuid(v_stop ->> 'placeId'))
      ),
      nullif(btrim(coalesce(v_stop ->> 'nameAr', '')), ''),
      nullif(btrim(coalesce(v_stop ->> 'nameEn', '')), ''),
      (v_stop ->> 'arriveOffsetMinutes')::int,
      (v_stop ->> 'priceFromOriginYer')::int
    );
  end loop;

  if v_index > 0 then
    perform app.recompute_seats_available(p_trip_id);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Commands
-- ---------------------------------------------------------------------------

/** A short shareable code: `ADE-SAA-7K2Q`. Derived from the route, so it is readable in a URL. */
create or replace function app.new_trip_code(p_origin uuid, p_destination uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_origin text;
  v_destination text;
  v_suffix text;
  v_code text;
  v_attempt integer := 0;
begin
  v_origin := upper(substr(regexp_replace((select g.code from public.governorates g where g.id = p_origin), '^YE-', ''), 1, 3));
  v_destination := upper(substr(regexp_replace((select g.code from public.governorates g where g.id = p_destination), '^YE-', ''), 1, 3));

  loop
    v_attempt := v_attempt + 1;
    -- No vowels and no lookalikes: a code gets read over the phone and typed by hand.
    v_suffix := upper(substr(translate(encode(gen_random_bytes(6), 'base64'), 'aeiou+/=lIO01', 'BCDFGHJKLMNOPQRSTUVWXYZ'), 1, 4));
    v_code := concat_ws('-', coalesce(v_origin, 'TRI'), coalesce(v_destination, 'XXX'), rpad(v_suffix, 4, 'X'));
    exit when not exists (select 1 from public.trips t where t.code = v_code);
    if v_attempt > 20 then
      raise exception 'INTERNAL: could not allocate a trip code' using errcode = 'P0001';
    end if;
  end loop;

  return v_code;
end;
$$;

/** "This vehicle belongs to this owner, is verified, and may carry passengers." */
create or replace function app.assert_trip_vehicle(p_vehicle_id uuid, p_owner_user uuid, p_owner_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vehicle public.vehicles%rowtype;
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
end;
$$;

create or replace function app.assert_trip_driver(p_driver_id uuid, p_owner_user uuid, p_owner_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_driver public.driver_profiles%rowtype;
begin
  if p_driver_id is null then
    return;
  end if;

  select * into v_driver from public.driver_profiles d where d.id = p_driver_id;
  if not found then
    raise exception 'NOT_FOUND: driver' using errcode = 'P0002';
  end if;

  if not (
    (p_owner_org is not null and v_driver.org_id = p_owner_org)
    or (p_owner_user is not null and v_driver.invited_by = p_owner_user)
  ) then
    raise exception 'FORBIDDEN: the driver belongs to another owner' using errcode = '42501';
  end if;

  if v_driver.status <> 'active' then
    raise exception 'CONFLICT: the driver has not accepted the invitation yet' using errcode = '23505';
  end if;
  if v_driver.verification_status <> 'verified' then
    raise exception 'NOT_VERIFIED: the driver is not verified' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.cmd_create_trip(
  p_actor uuid,
  p_owner_org uuid,
  p_trip jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_user uuid;
  v_trip public.trips%rowtype;
  v_vehicle uuid;
  v_driver uuid;
  v_state jsonb;
  v_warnings jsonb := '[]'::jsonb;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  -- Same gate as `cmd_create_vehicle`: an organization must be verified in its own right.
  if p_owner_org is not null then
    if not app.is_org_member(p_owner_org, p_actor) then
      raise exception 'FORBIDDEN: not a member of this organization' using errcode = '42501';
    end if;
    if not app.org_is_verified(p_owner_org) then
      raise exception 'NOT_VERIFIED: this organization is not verified' using errcode = '42501';
    end if;
  else
    if not app.is_verified_actor(p_actor) then
      raise exception 'NOT_VERIFIED: only verified accounts can publish trips' using errcode = '42501';
    end if;
    v_owner_user := p_actor;
  end if;

  perform app.assert_trip_payload(p_trip);

  v_vehicle := app.safe_uuid(p_trip ->> 'vehicleId');
  if v_vehicle is null then
    raise exception 'VALIDATION_FAILED: vehicleId is required' using errcode = '22023';
  end if;
  perform app.assert_trip_vehicle(v_vehicle, v_owner_user, p_owner_org);

  v_driver := app.safe_uuid(p_trip ->> 'driverId');
  perform app.assert_trip_driver(v_driver, v_owner_user, p_owner_org);

  perform app.assert_quota(v_owner_user, p_owner_org, 'trips', 1);

  insert into public.trips (
    code, owner_user_id, owner_org_id, vehicle_id, driver_id,
    origin_governorate_id, destination_governorate_id, departure_at, arrive_estimate_minutes,
    seats_total, seats_available, booking_mode, pricing_mode, price_per_seat_yer, whole_trip_price_yer,
    discount_kind, discount_value, discount_scope, gender_policy, payment_policy,
    luggage_allowance_kg, policies, notes
  ) values (
    app.new_trip_code(
      app.safe_uuid(p_trip ->> 'originGovernorateId'),
      app.safe_uuid(p_trip ->> 'destinationGovernorateId')
    ),
    v_owner_user, p_owner_org, v_vehicle, v_driver,
    app.safe_uuid(p_trip ->> 'originGovernorateId'),
    app.safe_uuid(p_trip ->> 'destinationGovernorateId'),
    (p_trip ->> 'departureAt')::timestamptz,
    coalesce((p_trip ->> 'arriveEstimateMinutes')::int, 0),
    (p_trip ->> 'seatsTotal')::smallint,
    (p_trip ->> 'seatsTotal')::smallint,
    coalesce(p_trip ->> 'bookingMode', 'per_seat')::public.trip_booking_mode,
    coalesce(p_trip ->> 'pricingMode', 'flat')::public.trip_pricing_mode,
    (p_trip ->> 'pricePerSeatYer')::int,
    (p_trip ->> 'wholeTripPriceYer')::int,
    coalesce(p_trip ->> 'discountKind', 'none')::public.trip_discount_kind,
    coalesce((p_trip ->> 'discountValue')::int, 0),
    coalesce(p_trip ->> 'discountScope', 'all')::public.trip_discount_scope,
    coalesce(p_trip ->> 'genderPolicy', 'any')::public.trip_gender_policy,
    coalesce(p_trip ->> 'paymentPolicy', 'cash')::public.trip_payment_policy,
    (p_trip ->> 'luggageAllowanceKg')::smallint,
    coalesce(p_trip -> 'policies', '{}'::jsonb),
    nullif(btrim(coalesce(p_trip ->> 'notes', '')), '')
  )
  returning * into v_trip;

  if p_trip ? 'stops' then
    perform app.replace_trip_stops(v_trip.id, p_trip -> 'stops');
    select * into v_trip from public.trips t where t.id = v_trip.id;
  end if;

  perform app.recompute_seats_available(v_trip.id);

  insert into public.trip_events (trip_id, kind, actor_id, detail)
  values (v_trip.id, 'created', p_actor, jsonb_build_object('code', v_trip.code));

  -- 80% of a soft limit is a warning the operator can act on; 100% is a refusal from assert_quota.
  v_state := app.quota_state(v_owner_user, p_owner_org, 'trips');
  if (v_state ->> 'warning')::boolean then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'QUOTA_SOFT_WARNING', 'metric', 'trips',
      'limit', (v_state ->> 'limit')::int, 'used', (v_state ->> 'used')::int
    ));
  end if;

  perform app.write_audit(
    p_actor, 'trip.create', 'trip', v_trip.id::text, null,
    jsonb_build_object('code', v_trip.code, 'departure_at', v_trip.departure_at, 'status', v_trip.status),
    null, p_request_id, p_ip
  );

  select * into v_trip from public.trips t where t.id = v_trip.id;
  return jsonb_build_object('trip', to_jsonb(v_trip), 'warnings', v_warnings);
end;
$$;

create or replace function public.cmd_update_trip(
  p_actor uuid,
  p_trip_id uuid,
  p_trip jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_substantive boolean;
  v_reverification boolean := false;
  v_vehicle uuid;
  v_driver uuid;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  if not (app.actor_can_manage_trip(p_actor, p_trip_id) and not app.is_platform_staff(p_actor)) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;

  perform app.assert_trip_editable(v_trip);
  perform app.assert_trip_payload(p_trip);

  v_vehicle := coalesce(app.safe_uuid(p_trip ->> 'vehicleId'), v_trip.vehicle_id);
  perform app.assert_trip_vehicle(v_vehicle, v_trip.owner_user_id, v_trip.owner_org_id);

  v_driver := app.safe_uuid(p_trip ->> 'driverId');
  if (p_trip ? 'driverId') and v_driver is null then
    v_driver := null;
  elsif not (p_trip ? 'driverId') then
    v_driver := v_trip.driver_id;
  end if;
  perform app.assert_trip_driver(v_driver, v_trip.owner_user_id, v_trip.owner_org_id);

  v_before := jsonb_build_object(
    'departure_at', v_trip.departure_at, 'origin', v_trip.origin_governorate_id,
    'destination', v_trip.destination_governorate_id, 'vehicle', v_trip.vehicle_id,
    'seats_total', v_trip.seats_total, 'pricing_mode', v_trip.pricing_mode,
    'price_per_seat_yer', v_trip.price_per_seat_yer,
    'whole_trip_price_yer', v_trip.whole_trip_price_yer,
    'discount_kind', v_trip.discount_kind, 'discount_value', v_trip.discount_value,
    'verification_status', v_trip.verification_status
  );

  update public.trips set
    vehicle_id = v_vehicle,
    driver_id = v_driver,
    origin_governorate_id = app.safe_uuid(p_trip ->> 'originGovernorateId'),
    destination_governorate_id = app.safe_uuid(p_trip ->> 'destinationGovernorateId'),
    departure_at = (p_trip ->> 'departureAt')::timestamptz,
    arrive_estimate_minutes = coalesce((p_trip ->> 'arriveEstimateMinutes')::int, 0),
    seats_total = (p_trip ->> 'seatsTotal')::smallint,
    booking_mode = coalesce(p_trip ->> 'bookingMode', 'per_seat')::public.trip_booking_mode,
    pricing_mode = coalesce(p_trip ->> 'pricingMode', 'flat')::public.trip_pricing_mode,
    price_per_seat_yer = (p_trip ->> 'pricePerSeatYer')::int,
    whole_trip_price_yer = (p_trip ->> 'wholeTripPriceYer')::int,
    discount_kind = coalesce(p_trip ->> 'discountKind', 'none')::public.trip_discount_kind,
    discount_value = coalesce((p_trip ->> 'discountValue')::int, 0),
    discount_scope = coalesce(p_trip ->> 'discountScope', 'all')::public.trip_discount_scope,
    gender_policy = coalesce(p_trip ->> 'genderPolicy', 'any')::public.trip_gender_policy,
    payment_policy = coalesce(p_trip ->> 'paymentPolicy', 'cash')::public.trip_payment_policy,
    luggage_allowance_kg = (p_trip ->> 'luggageAllowanceKg')::smallint,
    policies = coalesce(p_trip -> 'policies', '{}'::jsonb),
    notes = nullif(btrim(coalesce(p_trip ->> 'notes', '')), '')
  where id = p_trip_id
  returning * into v_trip;

  v_after := jsonb_build_object(
    'departure_at', v_trip.departure_at, 'origin', v_trip.origin_governorate_id,
    'destination', v_trip.destination_governorate_id, 'vehicle', v_trip.vehicle_id,
    'seats_total', v_trip.seats_total, 'pricing_mode', v_trip.pricing_mode,
    'price_per_seat_yer', v_trip.price_per_seat_yer,
    'whole_trip_price_yer', v_trip.whole_trip_price_yer,
    'discount_kind', v_trip.discount_kind, 'discount_value', v_trip.discount_value
  );

  -- A colour change is cosmetic; a new departure time, route, vehicle or price is not. Only the second
  -- kind re-opens verification, exactly like `cmd_update_vehicle`.
  v_substantive := (v_before - 'verification_status') <> v_after;

  if v_substantive and v_before ->> 'verification_status' = 'verified' then
    update public.trips
    set verification_status = 'pending', verified_by = null, verified_at = null, verification_note = null
    where id = p_trip_id
    returning * into v_trip;
    v_reverification := true;
  end if;

  perform app.recompute_seats_available(p_trip_id);

  insert into public.trip_events (trip_id, kind, actor_id, detail)
  values (p_trip_id,
          case when v_substantive then 'updated' else 'updated' end::public.trip_event_kind,
          p_actor,
          jsonb_build_object('substantive', v_substantive, 'before', v_before, 'after', v_after));

  perform app.write_audit(
    p_actor, 'trip.update', 'trip', p_trip_id::text, v_before, v_after,
    case when v_substantive then 'substantive change' else 'cosmetic change' end, p_request_id, p_ip
  );

  select * into v_trip from public.trips t where t.id = p_trip_id;
  return jsonb_build_object('trip', to_jsonb(v_trip), 'reverificationRequired', v_reverification);
end;
$$;

create or replace function public.cmd_set_trip_stops(
  p_actor uuid,
  p_trip_id uuid,
  p_stops jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_reverification boolean := false;
  v_stops jsonb;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  if not (app.actor_can_manage_trip(p_actor, p_trip_id) and not app.is_platform_staff(p_actor)) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;

  perform app.assert_trip_editable(v_trip);
  perform app.replace_trip_stops(p_trip_id, p_stops);

  -- Per-stop prices are the fare passengers see: changing them re-opens review on a verified trip.
  if v_trip.verification_status = 'verified' and v_trip.pricing_mode = 'per_stop' then
    update public.trips
    set verification_status = 'pending', verified_by = null, verified_at = null
    where id = p_trip_id;
    v_reverification := true;
  end if;

  insert into public.trip_events (trip_id, kind, actor_id, detail)
  values (p_trip_id, 'stops_changed', p_actor,
          jsonb_build_object('stops', jsonb_array_length(p_stops)));

  perform app.write_audit(
    p_actor, 'trip.setStops', 'trip', p_trip_id::text, null,
    jsonb_build_object('stops', jsonb_array_length(p_stops)), null, p_request_id, p_ip
  );

  select coalesce(jsonb_agg(to_jsonb(s) order by s.seq), '[]'::jsonb) into v_stops
  from public.trip_stops s where s.trip_id = p_trip_id;

  return jsonb_build_object('tripId', p_trip_id, 'stops', v_stops,
                            'reverificationRequired', v_reverification);
end;
$$;

create or replace function public.cmd_publish_trip(
  p_actor uuid,
  p_trip_id uuid,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_featured jsonb;
  v_featured_until timestamptz;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  if not (app.actor_can_manage_trip(p_actor, p_trip_id) and not app.is_platform_staff(p_actor)) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;

  if v_trip.status <> 'draft' then
    raise exception 'CONFLICT: only a draft can be published (this one is %)', v_trip.status
      using errcode = '23505';
  end if;

  if v_trip.verification_status = 'rejected' then
    raise exception 'VALIDATION_FAILED: this trip was rejected and cannot be published'
      using errcode = '22023';
  end if;

  -- Nothing is announced two hours before it leaves: the same window that locks editing also gates
  -- publishing, so a trip cannot appear on the marketplace while passengers are already at the station.
  perform app.assert_trip_editable(v_trip, false);

  perform app.assert_trip_vehicle(v_trip.vehicle_id, v_trip.owner_user_id, v_trip.owner_org_id);
  perform app.assert_trip_driver(v_trip.driver_id, v_trip.owner_user_id, v_trip.owner_org_id);
  perform app.assert_quota(v_trip.owner_user_id, v_trip.owner_org_id, 'active_trips', 1);

  -- Featured slots are a plan feature (§6.14): a plan with none simply publishes without the boost.
  v_featured := app.quota_state(v_trip.owner_user_id, v_trip.owner_org_id, 'featured_listings');
  if v_featured ->> 'limit' is not null
     and (v_featured ->> 'used')::int < (v_featured ->> 'limit')::int
     and (v_featured ->> 'limit')::int > 0 then
    v_featured_until := now() + interval '7 days';
  end if;

  update public.trips
  set status = 'published',
      published_at = now(),
      featured_until = coalesce(v_featured_until, featured_until)
  where id = p_trip_id
  returning * into v_trip;

  insert into public.trip_events (trip_id, kind, actor_id, detail)
  values (p_trip_id, 'published', p_actor, jsonb_build_object('featured', v_featured_until is not null));

  perform app.write_audit(
    p_actor, 'trip.publish', 'trip', p_trip_id::text, null,
    jsonb_build_object('status', 'published', 'featured_until', v_featured_until),
    null, p_request_id, p_ip
  );

  select * into v_trip from public.trips t where t.id = p_trip_id;
  return jsonb_build_object('trip', to_jsonb(v_trip));
end;
$$;

create or replace function public.cmd_submit_trip_verification(
  p_actor uuid,
  p_trip_id uuid,
  p_note text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_staff uuid;
  v_snapshot jsonb;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  if not (app.actor_can_manage_trip(p_actor, p_trip_id) and not app.is_platform_staff(p_actor)) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;

  if v_trip.verification_status = 'pending' then
    raise exception 'CONFLICT: already awaiting review' using errcode = '23505';
  end if;

  v_snapshot := jsonb_build_object(
    'departure_at', v_trip.departure_at,
    'price_per_seat_yer', v_trip.price_per_seat_yer,
    'pricing_mode', v_trip.pricing_mode,
    'discount_kind', v_trip.discount_kind,
    'discount_value', v_trip.discount_value,
    'stops', (select count(*) from public.trip_stops s where s.trip_id = p_trip_id)
  );

  update public.trips
  set verification_status = 'pending', verified_by = null, verified_at = null, verification_note = null
  where id = p_trip_id
  returning * into v_trip;

  insert into public.trip_verifications (trip_id, submitted_by, snapshot, note)
  values (p_trip_id, p_actor, v_snapshot, nullif(btrim(coalesce(p_note, '')), ''));

  for v_staff in
    select ur.user_id from public.user_roles ur
    where ur.role in ('platform_staff', 'platform_admin') and ur.revoked_at is null
  loop
    perform app.notify(
      v_staff, 'verification_submitted', 'notifications.tripPending',
      jsonb_build_object('code', v_trip.code), '/staff/trips'
    );
  end loop;

  insert into public.trip_events (trip_id, kind, actor_id, detail)
  values (p_trip_id, 'submitted', p_actor, v_snapshot);

  perform app.write_audit(
    p_actor, 'trip.submitVerification', 'trip', p_trip_id::text,
    jsonb_build_object('verification_status', v_trip.verification_status), v_snapshot,
    null, p_request_id, p_ip
  );

  return jsonb_build_object('tripId', p_trip_id, 'verificationStatus', 'pending');
end;
$$;

create or replace function public.cmd_decide_trip_verification(
  p_actor uuid,
  p_trip_id uuid,
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
  v_trip public.trips%rowtype;
  v_new public.verification_status;
  v_owner uuid;
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

  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  if v_trip.verification_status <> 'pending' then
    raise exception 'CONFLICT: trip is already %, not awaiting review', v_trip.verification_status
      using errcode = '23505';
  end if;
  if v_trip.owner_user_id = p_actor then
    raise exception 'FORBIDDEN: own trip' using errcode = '42501';
  end if;

  v_new := case when p_outcome = 'approve' then 'verified' else 'rejected' end;

  update public.trips
  set verification_status = v_new,
      verified_by = p_actor,
      verified_at = now(),
      verification_note = nullif(btrim(coalesce(p_reason, '')), ''),
      -- A rejected trip leaves the marketplace in the same statement that rejects it.
      status = case when p_outcome = 'reject' and status = 'published' then 'draft' else status end,
      published_at = case when p_outcome = 'reject' then null else published_at end
  where id = p_trip_id
  returning * into v_trip;

  update public.trip_verifications
  set outcome = p_outcome, decided_by = p_actor, decided_at = now(),
      note = nullif(btrim(coalesce(p_reason, '')), '')
  where trip_id = p_trip_id and outcome is null;

  v_owner := coalesce(
    v_trip.owner_user_id,
    (select o.owner_id from public.organizations o where o.id = v_trip.owner_org_id)
  );

  perform app.notify(
    v_owner,
    case when p_outcome = 'approve' then 'verification_approved' else 'verification_rejected' end::public.notification_kind,
    case when p_outcome = 'approve' then 'notifications.tripApproved' else 'notifications.tripRejected' end,
    jsonb_build_object('code', v_trip.code, 'reason', p_reason),
    '/operator/trips'
  );

  insert into public.trip_events (trip_id, kind, actor_id, detail)
  values (p_trip_id,
          case when p_outcome = 'approve' then 'approved' else 'rejected' end::public.trip_event_kind,
          p_actor, jsonb_build_object('reason', p_reason));

  perform app.write_audit(
    p_actor, 'trip.decideVerification', 'trip', p_trip_id::text,
    jsonb_build_object('verification_status', 'pending'),
    jsonb_build_object('verification_status', v_new),
    p_reason, p_request_id, p_ip
  );

  select * into v_trip from public.trips t where t.id = p_trip_id;
  return jsonb_build_object('trip', to_jsonb(v_trip));
end;
$$;

create or replace function public.cmd_cancel_trip(
  p_actor uuid,
  p_trip_id uuid,
  p_reason text,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_is_staff boolean := app.is_platform_staff(p_actor);
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  if not (app.actor_can_manage_trip(p_actor, p_trip_id)) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;

  if v_trip.status in ('cancelled', 'completed') then
    raise exception 'CONFLICT: the trip is already %', v_trip.status using errcode = '23505';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'VALIDATION_FAILED: a cancellation needs a reason' using errcode = '22023';
  end if;

  -- An operator may cancel at any hour (§6.9); Phase 5 refunds the passengers inside this command.
  update public.trips
  set status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor,
      cancel_reason = btrim(p_reason)
  where id = p_trip_id
  returning * into v_trip;

  insert into public.trip_events (trip_id, kind, actor_id, detail)
  values (p_trip_id, 'cancelled', p_actor, jsonb_build_object('reason', p_reason, 'by_staff', v_is_staff));

  perform app.write_audit(
    p_actor, 'trip.cancel', 'trip', p_trip_id::text,
    jsonb_build_object('status', 'published'), jsonb_build_object('status', 'cancelled'),
    p_reason, p_request_id, p_ip
  );

  select * into v_trip from public.trips t where t.id = p_trip_id;
  return jsonb_build_object('trip', to_jsonb(v_trip));
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Reading the marketplace
-- ---------------------------------------------------------------------------

/**
 * One predicate for every filter, with the ability to ignore a single dimension.
 *
 * That `p_skip` is the whole trick behind cascading facets: the count next to «عدن» must answer "how
 * many trips would be left if I also chose Aden?", which is this predicate with every filter applied
 * *except* the origin one. Writing it once means the counts and the results can never disagree.
 */
create or replace function app.trip_matches(p_row public.trips_search, p_filters jsonb, p_skip text default null)
returns boolean
language plpgsql
stable
as $$
declare
  v_origin text[];
  v_destination text[];
  v_gender text[];
  v_booking text[];
  v_query text := nullif(btrim(coalesce(p_filters ->> 'q', '')), '');
begin
  if p_filters is null then
    return true;
  end if;

  v_origin := coalesce(array(select jsonb_array_elements_text(p_filters -> 'origin')), '{}');
  v_destination := coalesce(array(select jsonb_array_elements_text(p_filters -> 'destination')), '{}');
  v_gender := coalesce(array(select jsonb_array_elements_text(p_filters -> 'gender')), '{}');
  v_booking := coalesce(array(select jsonb_array_elements_text(p_filters -> 'booking')), '{}');

  if p_skip is distinct from 'origin' and cardinality(v_origin) > 0
     and not (p_row.origin_governorate_id::text = any (v_origin)) then
    return false;
  end if;

  if p_skip is distinct from 'destination' and cardinality(v_destination) > 0
     and not (p_row.destination_governorate_id::text = any (v_destination)) then
    return false;
  end if;

  if p_skip is distinct from 'gender' and cardinality(v_gender) > 0
     and not (p_row.gender_policy::text = any (v_gender)) then
    return false;
  end if;

  if p_skip is distinct from 'booking' and cardinality(v_booking) > 0
     and not (p_row.booking_mode::text = any (v_booking)) then
    return false;
  end if;

  -- «بدون توقف» — direct only. A trip with stops is a different product, not a worse one.
  if p_skip is distinct from 'direct' and (p_filters ? 'direct') then
    if (p_filters ->> 'direct')::boolean and p_row.stop_count > 0 then
      return false;
    end if;
    if not (p_filters ->> 'direct')::boolean and p_row.stop_count = 0 then
      return false;
    end if;
  end if;

  if p_skip is distinct from 'price' and (p_filters ? 'priceMax')
     and p_row.price_from_yer > (p_filters ->> 'priceMax')::int then
    return false;
  end if;

  if p_skip is distinct from 'date' and (p_filters ? 'dateFrom')
     and p_row.departure_date < (p_filters ->> 'dateFrom')::date then
    return false;
  end if;

  if p_skip is distinct from 'date' and (p_filters ? 'dateTo')
     and p_row.departure_date > (p_filters ->> 'dateTo')::date then
    return false;
  end if;

  if v_query is not null and p_row.search_text not like '%' || lower(v_query) || '%' then
    return false;
  end if;

  return true;
end;
$$;

/** The keyset sort key. One numeric per row, so pagination cannot skip or repeat a trip. */
create or replace function app.trip_rank(p_row public.trips_search, p_sort text)
returns numeric
language sql
immutable
as $$
  select case p_sort
    when 'cheapest' then p_row.price_from_yer::numeric * 1e10
                         + extract(epoch from p_row.departure_at)
    when 'featured' then (case when p_row.is_featured then 0 else 1 end)::numeric * 1e15
                         + extract(epoch from p_row.departure_at)
    else extract(epoch from p_row.departure_at)
  end;
$$;

create or replace function public.search_public_trips(
  p_locale text default 'ar',
  p_filters jsonb default '{}'::jsonb,
  p_sort text default 'soonest',
  p_cursor text default null,
  p_limit integer default 12
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 12), 1), 50);
  v_sort text := case when p_sort in ('soonest', 'cheapest', 'featured') then p_sort else 'soonest' end;
  v_locale text := case when p_locale = 'en' then 'en' else 'ar' end;
  v_key text;
  v_cached jsonb;
  v_items jsonb;
  v_total integer;
  v_next text;
  v_payload jsonb;
  v_facets jsonb;
begin
  v_key := md5(jsonb_build_object(
    'public', v_locale, 'filters', p_filters, 'sort', v_sort, 'cursor', p_cursor, 'limit', v_limit
  )::text);

  select payload into v_cached from public.search_cache c where c.key = v_key and c.expires_at > now();
  if v_cached is not null then
    return v_cached || jsonb_build_object('cached', true);
  end if;

  with base as (
    select s.*, app.trip_rank(s, v_sort) as rank
    from public.trips_search s
    where s.is_public
      and s.departure_at > now()
      and app.trip_matches(s, p_filters, null)
  ),
  page as (
    select b.*
    from base b
    where p_cursor is null
       or (b.rank, b.trip_id) > (split_part(p_cursor, '|', 1)::numeric, split_part(p_cursor, '|', 2)::uuid)
    order by b.rank, b.trip_id
    limit v_limit
  )
  select
    (
      select coalesce(jsonb_agg(x.item order by x.rank, x.trip_id), '[]'::jsonb)
      from (
        select p.rank, p.trip_id, jsonb_build_object(
          'id', p.trip_id,
          'code', t.code,
          'departureAt', p.departure_at,
          'departureDate', p.departure_date,
          'seatsAvailable', p.seats_available,
          'seatsTotal', p.seats_total,
          'priceFromYer', p.price_from_yer,
          'currency', 'YER',
          'stopCount', p.stop_count,
          'bookingMode', p.booking_mode,
          'pricingMode', p.pricing_mode,
          'discountKind', p.discount_kind,
          'discountValue', p.discount_value,
          'genderPolicy', p.gender_policy,
          'isFeatured', p.is_featured,
          'operatorName', case when v_locale = 'ar' then p.operator_name_ar else p.operator_name_en end,
          'vehicleLabel', p.vehicle_label,
          'origin', jsonb_build_object(
            'id', p.origin_governorate_id,
            'code', og.code,
            'name', case when v_locale = 'ar' then og.name_ar else coalesce(og.name_en, og.name_ar) end
          ),
          'destination', jsonb_build_object(
            'id', p.destination_governorate_id,
            'code', dg.code,
            'name', case when v_locale = 'ar' then dg.name_ar else coalesce(dg.name_en, dg.name_ar) end
          )
        ) as item
        from page p
        join public.trips t on t.id = p.trip_id
        join public.governorates og on og.id = p.origin_governorate_id
        join public.governorates dg on dg.id = p.destination_governorate_id
      ) x
    ),
    (select count(*)::int from base),
    (
      select p.rank::text || '|' || p.trip_id::text
      from page p order by p.rank desc, p.trip_id desc limit 1
    )
  into v_items, v_total, v_next;

  -- Cascading facets: each count is computed with every filter *except its own dimension*.
  select jsonb_build_object(
    'origins', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', g.id, 'code', g.code,
        'name', case when v_locale = 'ar' then g.name_ar else coalesce(g.name_en, g.name_ar) end,
        'count', c.n
      ) order by c.n desc, g.name_ar), '[]'::jsonb)
      from (
        select s.origin_governorate_id as id, count(*)::int as n
        from public.trips_search s
        where s.is_public and s.departure_at > now()
          and app.trip_matches(s, p_filters, 'origin')
        group by s.origin_governorate_id
      ) c
      join public.governorates g on g.id = c.id
    ),
    'destinations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', g.id, 'code', g.code,
        'name', case when v_locale = 'ar' then g.name_ar else coalesce(g.name_en, g.name_ar) end,
        'count', c.n
      ) order by c.n desc, g.name_ar), '[]'::jsonb)
      from (
        select s.destination_governorate_id as id, count(*)::int as n
        from public.trips_search s
        where s.is_public and s.departure_at > now()
          and app.trip_matches(s, p_filters, 'destination')
        group by s.destination_governorate_id
      ) c
      join public.governorates g on g.id = c.id
    ),
    'genders', (
      select coalesce(jsonb_agg(jsonb_build_object('value', c.value, 'count', c.n) order by c.n desc), '[]'::jsonb)
      from (
        select s.gender_policy::text as value, count(*)::int as n
        from public.trips_search s
        where s.is_public and s.departure_at > now()
          and app.trip_matches(s, p_filters, 'gender')
        group by s.gender_policy
      ) c
    ),
    'bookingModes', (
      select coalesce(jsonb_agg(jsonb_build_object('value', c.value, 'count', c.n) order by c.n desc), '[]'::jsonb)
      from (
        select s.booking_mode::text as value, count(*)::int as n
        from public.trips_search s
        where s.is_public and s.departure_at > now()
          and app.trip_matches(s, p_filters, 'booking')
        group by s.booking_mode
      ) c
    ),
    'direct', jsonb_build_object(
      'direct', (
        select count(*)::int from public.trips_search s
        where s.is_public and s.departure_at > now() and s.stop_count = 0
          and app.trip_matches(s, p_filters, 'direct')
      ),
      'withStops', (
        select count(*)::int from public.trips_search s
        where s.is_public and s.departure_at > now() and s.stop_count > 0
          and app.trip_matches(s, p_filters, 'direct')
      )
    )
  ) into v_facets;

  v_payload := jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'facets', v_facets,
    'nextCursor', case when v_total > v_limit then v_next else null end,
    'sort', v_sort,
    'cached', false
  );

  insert into public.search_cache (key, payload, expires_at)
  values (v_key, v_payload, now() + interval '30 seconds')
  on conflict (key) do update set payload = excluded.payload, expires_at = excluded.expires_at;

  return v_payload;
end;
$$;

/**
 * Everything a trip page needs, in one round trip — the page renders from this or shows a 404.
 * Deliberately not keyed on the caller: the marketplace is public.
 */
create or replace function public.get_trip_public(p_code text, p_locale text default 'ar')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_locale text := case when p_locale = 'en' then 'en' else 'ar' end;
  v_payload jsonb;
begin
  select * into v_trip
  from public.trips t
  where t.code = upper(btrim(coalesce(p_code, '')))
    and t.status = 'published'
    and t.verification_status <> 'rejected';

  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'id', v_trip.id,
    'code', v_trip.code,
    'status', v_trip.status,
    'verificationStatus', v_trip.verification_status,
    'departureAt', v_trip.departure_at,
    'departureDate', v_trip.departure_date,
    'arriveEstimateMinutes', v_trip.arrive_estimate_minutes,
    'seatsTotal', v_trip.seats_total,
    'seatsAvailable', v_trip.seats_available,
    'bookingMode', v_trip.booking_mode,
    'pricingMode', v_trip.pricing_mode,
    'pricePerSeatYer', v_trip.price_per_seat_yer,
    'wholeTripPriceYer', v_trip.whole_trip_price_yer,
    'discount', jsonb_build_object(
      'kind', v_trip.discount_kind, 'value', v_trip.discount_value, 'scope', v_trip.discount_scope
    ),
    'genderPolicy', v_trip.gender_policy,
    'paymentPolicy', v_trip.payment_policy,
    'luggageAllowanceKg', v_trip.luggage_allowance_kg,
    'policies', v_trip.policies,
    'notes', v_trip.notes,
    'isFeatured', coalesce(v_trip.featured_until > now(), false),
    'hasDeparted', v_trip.departure_at <= now(),
    'operator', jsonb_build_object(
      'userId', v_trip.owner_user_id,
      'orgId', v_trip.owner_org_id,
      'name', case
        when v_trip.owner_org_id is not null then (
          select case when v_locale = 'ar' then o.name else coalesce(o.name_en, o.name) end
          from public.organizations o where o.id = v_trip.owner_org_id
        )
        else (select p.full_name from public.profiles p where p.id = v_trip.owner_user_id)
      end,
      'verified', case
        when v_trip.owner_org_id is not null then app.org_is_verified(v_trip.owner_org_id)
        else (select p.verification_status = 'verified' from public.profiles p where p.id = v_trip.owner_user_id)
      end
    ),
    'vehicle', (
      select jsonb_build_object(
        'label', v.make || ' ' || v.model || ' ' || v.model_year,
        'bodyType', v.body_type,
        'seatsTotal', v.seats_total,
        'airConditioning', v.air_conditioning,
        'wifi', v.wifi,
        'usbCharging', v.usb_charging
      )
      from public.vehicles v where v.id = v_trip.vehicle_id
    ),
    'origin', jsonb_build_object(
      'id', og.id, 'code', og.code,
      'name', case when v_locale = 'ar' then og.name_ar else coalesce(og.name_en, og.name_ar) end
    ),
    'destination', jsonb_build_object(
      'id', dg.id, 'code', dg.code,
      'name', case when v_locale = 'ar' then dg.name_ar else coalesce(dg.name_en, dg.name_ar) end
    ),
    'stops', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'seq', s.seq,
        'placeId', s.place_id,
        'governorateId', coalesce(s.governorate_id, pl.governorate_id),
        'name', case
          when v_locale = 'ar' then coalesce(s.name_ar, pl.name_ar, s.name_en, pl.name_en)
          else coalesce(s.name_en, pl.name_en, s.name_ar, pl.name_ar)
        end,
        'arriveOffsetMinutes', s.arrive_offset_minutes,
        'priceFromOriginYer', coalesce(s.price_from_origin_yer, v_trip.price_per_seat_yer),
        'fare', app.trip_total(v_trip, s.seq, 1)
      ) order by s.seq), '[]'::jsonb)
      from public.trip_stops s
      left join public.places pl on pl.id = s.place_id
      where s.trip_id = v_trip.id
    ),
    'fare', app.trip_total(v_trip, null, 1)
  )
  into v_payload
  from public.governorates og, public.governorates dg
  where og.id = v_trip.origin_governorate_id and dg.id = v_trip.destination_governorate_id;

  return v_payload;
end;
$$;

/** Staff search: the same shape, but it deliberately includes drafts, cancellations and the past. */
create or replace function public.staff_search_trips(
  p_actor uuid,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_items jsonb;
begin
  if p_actor is null or not app.is_platform_staff(p_actor) then
    raise exception 'FORBIDDEN: staff only' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(item order by departure_at desc), '[]'::jsonb) into v_items
  from (
    select t.departure_at, jsonb_build_object(
      'id', t.id,
      'code', t.code,
      'status', t.status,
      'verificationStatus', t.verification_status,
      'departureAt', t.departure_at,
      'seatsAvailable', t.seats_available,
      'seatsTotal', t.seats_total,
      'priceFromYer', coalesce(app.trip_price_from(t.id), 0),
      'operatorName', case
        when t.owner_org_id is not null then (select o.name from public.organizations o where o.id = t.owner_org_id)
        else (select p.full_name from public.profiles p where p.id = t.owner_user_id)
      end,
      'cancelReason', t.cancel_reason,
      'origin', (select g.name_ar from public.governorates g where g.id = t.origin_governorate_id),
      'destination', (select g.name_ar from public.governorates g where g.id = t.destination_governorate_id)
    ) as item
    from public.trips t
    where (
        not (p_filters ? 'status')
        or t.status::text in (select jsonb_array_elements_text(p_filters -> 'status'))
      )
      and (
        not (p_filters ? 'q')
        or t.code ilike '%' || (p_filters ->> 'q') || '%'
        or exists (
          select 1 from public.governorates g
          where g.id in (t.origin_governorate_id, t.destination_governorate_id)
            and g.name_ar ilike '%' || (p_filters ->> 'q') || '%'
        )
      )
    order by t.departure_at desc
    limit v_limit
  ) x;

  return jsonb_build_object('items', v_items);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. RLS: the marketplace is public, the workshop is not
-- ---------------------------------------------------------------------------

/** Visible to the public: published, not rejected, not cancelled. Everything else is owner + staff. */
create or replace function app.can_read_trip(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id
      and (
        (t.status = 'published' and t.verification_status <> 'rejected' and t.cancelled_at is null)
        or (t.owner_user_id is not null and t.owner_user_id = app.uid())
        or (t.owner_org_id is not null and app.is_org_member(t.owner_org_id))
        or app.is_platform_staff()
      )
  );
$$;

alter table public.trips enable row level security;
alter table public.trip_stops enable row level security;
alter table public.trip_events enable row level security;
alter table public.trip_verifications enable row level security;
alter table public.trips_search enable row level security;
alter table public.search_cache enable row level security;

create policy trips_read_visible on public.trips
  for select to anon, authenticated
  using (
    (status = 'published' and verification_status <> 'rejected' and cancelled_at is null)
    or (owner_user_id is not null and owner_user_id = app.uid())
    or (owner_org_id is not null and app.is_org_member(owner_org_id))
    or app.is_platform_staff()
  );

create policy trip_stops_read_visible on public.trip_stops
  for select to anon, authenticated
  using (app.can_read_trip(trip_id));

create policy trip_events_read_owner_or_staff on public.trip_events
  for select to authenticated
  using (app.actor_can_manage_trip(app.uid(), trip_id));

create policy trip_verifications_read_owner_or_staff on public.trip_verifications
  for select to authenticated
  using (app.actor_can_manage_trip(app.uid(), trip_id));

create policy trips_search_read_visible on public.trips_search
  for select to anon, authenticated
  using (
    is_public
    or (owner_user_id is not null and owner_user_id = app.uid())
    or (owner_org_id is not null and app.is_org_member(owner_org_id))
    or app.is_platform_staff()
  );

grant select on public.trips to anon, authenticated;
grant select on public.trip_stops to anon, authenticated;
grant select on public.trips_search to anon, authenticated;
grant select on public.trip_events to authenticated;
grant select on public.trip_verifications to authenticated;

-- ---------------------------------------------------------------------------
-- 12. Execute grants: commands are service-only, the two public readers are public
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.cmd_create_trip(uuid, uuid, jsonb, text, inet)',
    'public.cmd_update_trip(uuid, uuid, jsonb, text, inet)',
    'public.cmd_set_trip_stops(uuid, uuid, jsonb, text, inet)',
    'public.cmd_publish_trip(uuid, uuid, text, inet)',
    'public.cmd_submit_trip_verification(uuid, uuid, text, text, inet)',
    'public.cmd_decide_trip_verification(uuid, uuid, public.verification_outcome, text, text, inet)',
    'public.cmd_cancel_trip(uuid, uuid, text, text, inet)',
    'public.staff_search_trips(uuid, jsonb, integer)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;

  -- The marketplace is anonymous by design, and these two functions are the only door.
  foreach v_signature in array array[
    'public.search_public_trips(text, jsonb, text, text, integer)',
    'public.get_trip_public(text, text)'
  ]
  loop
    execute format('revoke all on function %s from public', v_signature);
    execute format('grant execute on function %s to anon, authenticated, service_role', v_signature);
  end loop;

  -- Internals: unreachable from a client.
  foreach v_signature in array array[
    'app.quota_state(uuid, uuid, text)',
    'app.quota_usage(uuid, uuid, text)',
    'app.trip_total(public.trips, integer, integer)',
    'app.trip_unit_fare(public.trips, integer)',
    'app.trip_price_from(uuid)',
    'app.trip_booked_seats(uuid)',
    'app.recompute_seats_available(uuid)',
    'app.trip_matches(public.trips_search, jsonb, text)',
    'app.trip_rank(public.trips_search, text)',
    'app.new_trip_code(uuid, uuid)',
    'app.assert_trip_payload(jsonb)',
    'app.assert_trip_vehicle(uuid, uuid, uuid)',
    'app.assert_trip_driver(uuid, uuid, uuid)',
    'app.replace_trip_stops(uuid, jsonb)',
    'app.refresh_trip_search(uuid)',
    'app.set_trip_visibility(public.trips)',
    'app.assert_trip_editable(public.trips, boolean)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;

  -- Predicates the RLS policies execute as the querying role.
  foreach v_signature in array array[
    'app.can_read_trip(uuid)',
    'app.actor_can_manage_trip(uuid, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', v_signature);
    execute format('grant execute on function %s to authenticated, service_role', v_signature);
  end loop;
end;
$$;
