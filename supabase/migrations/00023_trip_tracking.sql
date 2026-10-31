-- ---------------------------------------------------------------------------
-- 00023 — Phase 6, part two: where the vehicle actually is
--
-- 00022 made a trip start, announce stops and end. This migration answers the
-- question a passenger asks while waiting: *where is it now, and when does it
-- get to me?*
--
-- Three decisions are structural here:
--
--   1. **Pings are append-only and time-partitioned.** A phone that reconnects
--      after an hour uploads its queue in one burst, out of order, and every
--      point is kept: the newest one drives the map, the rest are evidence.
--      Monthly partitions keep the table from becoming a single 40-million-row
--      object that every index rebuild has to touch.
--   2. **Progress is derived, then stored.** `app.recompute_trip_progress()`
--      is the only place that turns pings and stop coordinates into "24 km to
--      the next stop, 137 km to the destination". Readers never do geometry, so
--      the driver's phone and the passenger's browser cannot disagree.
--   3. **Staleness is a read-time fact.** Nothing writes "the location is old":
--      21 minutes without a ping is computed when somebody looks, so it is
--      correct even if the server was down.
--
-- Distances are haversine, not PostGIS. The dev cluster has no PostGIS
-- guarantee (00008 says so), and a straight-line chain between stops is honest
-- about being an estimate — a routing provider refines it later through
-- `trip_route_geometry`.
-- ---------------------------------------------------------------------------

alter table public.trips
  add column if not exists last_ping_at timestamptz;

/**
 * `app.uid()`, made safe when the session carries no claims at all.
 *
 * 00001 casts `current_setting('request.jwt.claims')` straight to `jsonb`. On a connection whose
 * claims were never set that setting is the empty string, and the cast raises `22P02` — so *every*
 * function that asks who the caller is answers with a syntax error instead of "nobody". PostgREST
 * always sets it, a pooled connection reset between requests does not, and the difference should not be
 * an outage.
 */
create or replace function app.uid()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select nullif(
    coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub',
    ''
  )::uuid;
$$;

-- ---------------------------------------------------------------------------
-- 1. Pings
-- ---------------------------------------------------------------------------

create table if not exists public.trip_location_pings (
  id            uuid not null default gen_random_uuid(),
  trip_id       uuid not null references public.trips (id) on delete cascade,
  -- The driver profile, like `trips.driver_id` — not the account, so a report stays attributable to
  -- the person the trip was assigned to even if they later change accounts.
  driver_id     uuid references public.driver_profiles (id) on delete set null,
  -- When the phone *took* the reading, not when it arrived: an offline queue
  -- flushes in order, and the progress must reflect the road, not the upload.
  recorded_at   timestamptz not null,
  latitude      double precision not null check (latitude between -90 and 90),
  longitude     double precision not null check (longitude between -180 and 180),
  accuracy_m    double precision check (accuracy_m is null or accuracy_m between 0 and 100000),
  speed_kmh     double precision check (speed_kmh is null or speed_kmh between 0 and 250),
  source        text not null default 'app' check (source in ('app', 'background', 'web', 'manual')),
  created_at    timestamptz not null default now(),
  -- A partitioned table's primary key has to contain the partition key.
  primary key (id, recorded_at)
) partition by range (recorded_at);

/**
 * The catch-all partition.
 *
 * `app.ensure_trip_ping_partition()` creates the current month on demand, so the
 * default stays empty in practice — but a clock skew or a future timestamp must
 * never make a ping fail. A default partition turns "insert failed" into "insert
 * landed in the overflow bin", and the row is still queryable.
 */
create table if not exists public.trip_location_pings_default
  partition of public.trip_location_pings default;

create index if not exists trip_pings_trip_time_idx
  on public.trip_location_pings (trip_id, recorded_at desc);
create index if not exists trip_pings_recent_idx
  on public.trip_location_pings (recorded_at desc);

/**
 * Creates `trip_location_pings_YYYYMM` for the month `p_at` falls in, if absent.
 *
 * Idempotent and cheap (`to_regclass` is a catalogue lookup). Called by
 * `cmd_record_ping()` before the insert, so no cron is required for the table to
 * keep working — a monthly job can still pre-create the next one.
 */
create or replace function app.ensure_trip_ping_partition(p_at timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := date_trunc('month', p_at at time zone 'utc') at time zone 'utc';
  v_to   timestamptz := (date_trunc('month', p_at at time zone 'utc') + interval '1 month') at time zone 'utc';
  v_name text := 'trip_location_pings_' || to_char(p_at at time zone 'utc', 'YYYYMM');
begin
  if to_regclass('public.' || v_name) is null then
    execute format(
      'create table if not exists public.%I partition of public.trip_location_pings for values from (%L) to (%L)',
      v_name, v_from, v_to
    );
  end if;
  return v_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Geometry
-- ---------------------------------------------------------------------------

/**
 * Great-circle distance in kilometres.
 *
 * Haversine, not PostGIS: `lat`/`lng` are plain doubles on every install, and the
 * error against a real road is dwarfed by the error in a straight-line estimate —
 * which is why the result is labelled an estimate everywhere it is shown.
 */
create or replace function app.haversine_km(
  p_lat1 double precision,
  p_lng1 double precision,
  p_lat2 double precision,
  p_lng2 double precision
)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select 6371.0088 * 2 * asin(
    sqrt(
      power(sin(radians(p_lat2 - p_lat1) / 2), 2)
      + cos(radians(p_lat1)) * cos(radians(p_lat2))
        * power(sin(radians(p_lng2 - p_lng1) / 2), 2)
    )
  );
$$;

/**
 * The trip's stops that have coordinates, in order.
 *
 * A stop is either a gazetteer place (which has `lat`/`lng`) or free text (which
 * does not). The latter still counts as a stop the driver can reach — it just
 * cannot take part in distance arithmetic, so it is skipped here and the geometry
 * runs between the stops that can.
 */
create or replace function app.trip_stop_points(p_trip_id uuid)
returns table (
  seq smallint,
  name_ar text,
  name_en text,
  arrive_offset_minutes integer,
  lat double precision,
  lng double precision
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.seq,
    coalesce(p.name_ar, s.name_ar) as name_ar,
    coalesce(p.name_en, s.name_en) as name_en,
    s.arrive_offset_minutes,
    p.lat,
    p.lng
  from public.trip_stops s
  left join public.places p on p.id = s.place_id
  where s.trip_id = p_trip_id
  order by s.seq;
$$;

-- ---------------------------------------------------------------------------
-- 3. Progress
-- ---------------------------------------------------------------------------

create table if not exists public.trip_progress (
  trip_id                 uuid primary key references public.trips (id) on delete cascade,
  last_ping_at            timestamptz,
  latitude                double precision,
  longitude               double precision,
  accuracy_m              double precision,
  nearest_stop_seq        smallint,
  distance_to_next_km     numeric(10, 2),
  distance_remaining_km   numeric(10, 2),
  total_distance_km       numeric(10, 2),
  progress_pct            numeric(5, 2) check (progress_pct is null or progress_pct between 0 and 100),
  speed_kmh              numeric(6, 2),
  eta_next_seconds        integer check (eta_next_seconds is null or eta_next_seconds >= 0),
  eta_destination_seconds integer check (eta_destination_seconds is null or eta_destination_seconds >= 0),
  updated_at              timestamptz not null default now()
);

-- Route geometry, when a routing provider has produced one. Until then the read
-- path falls back to the straight line between stops (`app.trip_route_for`).
create table if not exists public.trip_route_geometry (
  trip_id     uuid primary key references public.trips (id) on delete cascade,
  provider    text not null,
  -- [{ "lat": 12.78, "lng": 45.03 }, …] in travel order.
  polyline    jsonb not null check (jsonb_typeof(polyline) = 'array'),
  distance_km numeric(10, 2) not null check (distance_km >= 0),
  computed_at timestamptz not null default now()
);

/**
 * Recomputes and stores one trip's progress from its newest ping.
 *
 * Deliberately volatile — it writes `trip_progress` — and deliberately the *only*
 * implementation: the driver screen, the passenger screen and the operator inbox
 * all read the row this produces, so they cannot drift apart the way three
 * copies of a distance formula do.
 *
 * Speed is a rolling average over the last 15 minutes of pings. With no usable
 * speed (a parked bus, a gap in coverage) the ETA falls back to the published
 * timetable — `arrive_offset_minutes` from departure — and is `null` once that
 * moment has passed: a late bus is better represented by "no estimate" than by a
 * negative countdown.
 */
create or replace function app.recompute_trip_progress(p_trip_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ping        public.trip_location_pings%rowtype;
  v_trip        public.trips%rowtype;
  v_seqs        smallint[];
  v_lats        double precision[];
  v_lngs        double precision[];
  v_offsets     integer[];
  v_count       integer;
  v_total       double precision := 0;
  v_last_stop   smallint;
  v_next_index  integer;
  v_best        double precision;
  v_to_next     double precision;
  v_remaining   double precision := 0;
  v_speed       double precision;
  v_pct         numeric(5, 2);
  v_eta_next    integer;
  v_eta_dest    integer;
  i             integer;
begin
  select * into v_trip from public.trips t where t.id = p_trip_id;
  if not found then
    return;
  end if;

  select * into v_ping
  from public.trip_location_pings p
  where p.trip_id = p_trip_id
  order by p.recorded_at desc
  limit 1;

  select
    array_agg(seq order by seq),
    array_agg(lat order by seq),
    array_agg(lng order by seq),
    array_agg(arrive_offset_minutes order by seq)
  into v_seqs, v_lats, v_lngs, v_offsets
  from app.trip_stop_points(p_trip_id)
  where lat is not null and lng is not null;

  v_count := coalesce(array_length(v_seqs, 1), 0);

  if v_count >= 2 then
    for i in 1 .. v_count - 1 loop
      v_total := v_total + app.haversine_km(v_lats[i], v_lngs[i], v_lats[i + 1], v_lngs[i + 1]);
    end loop;
  end if;

  if v_ping.id is null then
    -- Started but no position yet: keep the row (the screen says "no location") rather than
    -- deleting it, so `updated_at` still tells an operator when we last knew anything.
    insert into public.trip_progress (trip_id, updated_at)
    values (p_trip_id, now())
    on conflict (trip_id) do update set updated_at = now();
    return;
  end if;

  v_last_stop := coalesce(v_trip.last_stop_seq, 0);
  v_next_index := null;

  if v_count > 0 then
    -- The nearest stop the trip has not already announced. Falls back to the
    -- destination once every stop is behind it, so the ETA never disappears
    -- a kilometre before the terminal.
    for i in 1 .. v_count loop
      if v_seqs[i] <= v_last_stop then
        continue;
      end if;
      declare
        v_d double precision := app.haversine_km(v_ping.latitude, v_ping.longitude, v_lats[i], v_lngs[i]);
      begin
        if v_next_index is null or v_d < v_best then
          v_next_index := i;
          v_best := v_d;
        end if;
      end;
    end loop;

    if v_next_index is null then
      v_next_index := v_count;
      v_best := app.haversine_km(v_ping.latitude, v_ping.longitude, v_lats[v_count], v_lngs[v_count]);
    end if;

    v_to_next := v_best;
    v_remaining := v_to_next;
    for i in v_next_index .. v_count - 1 loop
      v_remaining := v_remaining + app.haversine_km(v_lats[i], v_lngs[i], v_lats[i + 1], v_lngs[i + 1]);
    end loop;

    if v_total > 0 then
      v_pct := greatest(0, least(100, (100 * (1 - v_remaining / v_total))))::numeric(5, 2);
    end if;
  end if;

  select avg(p.speed_kmh) into v_speed
  from public.trip_location_pings p
  where p.trip_id = p_trip_id
    and p.recorded_at > now() - interval '15 minutes'
    and p.speed_kmh is not null
    and p.speed_kmh > 1;

  -- No reported speed? Derive one from the two ends of the window before
  -- falling back to the timetable: a phone that reports positions but not speed
  -- is common, and its own track is the best evidence available.
  if v_speed is null then
    declare
      v_first public.trip_location_pings%rowtype;
      v_hours double precision;
    begin
      select * into v_first
      from public.trip_location_pings p
      where p.trip_id = p_trip_id
        and p.recorded_at > now() - interval '15 minutes'
      order by p.recorded_at
      limit 1;

      v_hours := extract(epoch from (v_ping.recorded_at - v_first.recorded_at)) / 3600.0;
      if v_hours > 0.01 then
        v_speed := app.haversine_km(
          v_first.latitude, v_first.longitude, v_ping.latitude, v_ping.longitude
        ) / v_hours;
      end if;
    end;
  end if;

  if v_next_index is not null and v_speed is not null and v_speed > 3 then
    v_eta_next := round(v_to_next / v_speed * 3600)::integer;
    v_eta_dest := round(v_remaining / v_speed * 3600)::integer;
  elsif v_next_index is not null then
    -- Timetable fallback. A negative remainder means the plan is already behind
    -- us, and an estimate of "soon" made up by arithmetic is worse than none.
    v_eta_next := greatest(
      0,
      extract(epoch from (
        v_trip.departure_at + make_interval(mins => coalesce(v_offsets[v_next_index], 0)) - now()
      ))::integer
    );
    if v_trip.departure_at + make_interval(mins => coalesce(v_offsets[v_count], 0)) > now() then
      v_eta_dest := extract(epoch from (
        v_trip.departure_at + make_interval(mins => coalesce(v_offsets[v_count], 0)) - now()
      ))::integer;
    end if;
  end if;

  insert into public.trip_progress (
    trip_id, last_ping_at, latitude, longitude, accuracy_m, nearest_stop_seq,
    distance_to_next_km, distance_remaining_km, total_distance_km, progress_pct,
    speed_kmh, eta_next_seconds, eta_destination_seconds, updated_at
  ) values (
    p_trip_id, v_ping.recorded_at, v_ping.latitude, v_ping.longitude, v_ping.accuracy_m,
    case when v_next_index is null then null else v_seqs[v_next_index] end,
    round(coalesce(v_to_next, 0)::numeric, 2), round(coalesce(v_remaining, 0)::numeric, 2),
    round(v_total::numeric, 2), v_pct,
    round(coalesce(v_speed, 0)::numeric, 2), v_eta_next, v_eta_dest, now()
  )
  on conflict (trip_id) do update set
    last_ping_at = excluded.last_ping_at,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    accuracy_m = excluded.accuracy_m,
    nearest_stop_seq = excluded.nearest_stop_seq,
    distance_to_next_km = excluded.distance_to_next_km,
    distance_remaining_km = excluded.distance_remaining_km,
    total_distance_km = excluded.total_distance_km,
    progress_pct = excluded.progress_pct,
    speed_kmh = excluded.speed_kmh,
    eta_next_seconds = excluded.eta_next_seconds,
    eta_destination_seconds = excluded.eta_destination_seconds,
    updated_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The ping command
-- ---------------------------------------------------------------------------

/**
 * One position report from the road.
 *
 * Three things make this safe to call from a phone on a bad connection:
 *
 *   · `p_recorded_at` is the phone's clock, clamped to `[started_at, now()]` — a
 *     queued ping from an hour ago keeps its own time, and a phone whose clock is
 *     a day fast cannot leapfrog the present.
 *   · A ping is accepted out of order. It is *stored* (it is evidence) but only
 *     the newest one drives progress, because `last_ping_at` only moves forward.
 *   · The whole thing is one transaction: a ping that cannot be stored is a ping
 *     the driver's queue will retry; there is no half-recorded position.
 */
create or replace function public.cmd_record_ping(
  p_actor uuid,
  p_trip_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_recorded_at timestamptz default null,
  p_accuracy_m double precision default null,
  p_speed_kmh double precision default null,
  p_source text default 'app',
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
  v_at timestamptz := coalesce(p_recorded_at, now());
  v_progress public.trip_progress%rowtype;
begin
  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  perform app.assert_can_execute_trip(p_actor, v_trip);

  if v_trip.status <> 'in_progress' then
    raise exception 'TRIP_NOT_STARTABLE: this trip is %', v_trip.status using errcode = '23505';
  end if;

  if p_lat is null or p_lng is null then
    raise exception 'VALIDATION_FAILED: a ping needs a latitude and a longitude' using errcode = '22023';
  end if;

  -- A queue that flushed late keeps its own timestamps; a phone whose clock is
  -- wrong cannot report from tomorrow.
  if v_at > now() then
    v_at := now();
  end if;
  if v_trip.started_at is not null and v_at < v_trip.started_at then
    v_at := v_trip.started_at;
  end if;

  perform app.ensure_trip_ping_partition(v_at);

  insert into public.trip_location_pings (
    trip_id, driver_id, recorded_at, latitude, longitude, accuracy_m, speed_kmh, source
  ) values (
    p_trip_id, v_trip.driver_id, v_at, p_lat, p_lng, p_accuracy_m, p_speed_kmh, coalesce(p_source, 'app')
  );

  update public.trips
  set last_ping_at = greatest(coalesce(last_ping_at, v_at), v_at)
  where id = p_trip_id;

  perform app.recompute_trip_progress(p_trip_id);

  select * into v_progress from public.trip_progress where trip_id = p_trip_id;

  perform app.write_audit(
    p_actor, 'trip.ping', 'trip', p_trip_id::text, null,
    jsonb_build_object('recorded_at', v_at, 'lat', p_lat, 'lng', p_lng), null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'recordedAt', v_at,
    'progress', to_jsonb(v_progress)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Reading it back
-- ---------------------------------------------------------------------------

/**
 * The polyline to draw: a provider's geometry when one has been stored, otherwise
 * the straight line between the stops that have coordinates.
 *
 * Read-only on purpose. A miss does not trigger a provider call inside a screen
 * render — that is how a page becomes slow and a provider bill becomes surprising.
 */
create or replace function app.trip_route_for(p_trip_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select g.polyline from public.trip_route_geometry g where g.trip_id = p_trip_id),
    (
      select coalesce(
        jsonb_agg(jsonb_build_object('lat', q.lat, 'lng', q.lng) order by q.seq),
        '[]'::jsonb
      )
      from app.trip_stop_points(p_trip_id) q
      where q.lat is not null and q.lng is not null
    ),
    '[]'::jsonb
  );
$$;

/** 21 minutes: two missed 10-minute reports plus a minute of grace. */
create or replace function app.ping_stale_after_seconds()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 1260;
$$;

/**
 * Everything the live screen needs, for people allowed to see it.
 *
 * Visibility is checked here rather than in RLS because the answer spans several
 * tables (a booking, an organisation membership, a driver assignment) and because
 * a caller who is not allowed must be told `FORBIDDEN` — not handed an empty
 * object that looks exactly like "the vehicle has not moved yet".
 */
create or replace function public.get_trip_progress(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_trip     public.trips%rowtype;
  v_progress public.trip_progress%rowtype;
  v_actor    uuid := app.uid();
  v_allowed  boolean;
  v_next     record;
  v_dest     record;
  v_stale    boolean;
begin
  select * into v_trip from public.trips t where t.code = upper(btrim(p_code));
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  select
    app.is_trip_driver(v_actor, v_trip.id)
    or app.actor_can_manage_trip(v_actor, v_trip.id)
    or app.is_platform_staff(v_actor)
    or exists (
      select 1 from public.bookings b
      where b.trip_id = v_trip.id
        and b.passenger_id = v_actor
        and b.status in ('pending', 'accepted', 'completed')
    )
    or exists (
      select 1 from public.trips t
      join public.driver_profiles d on d.id = t.driver_id
      where t.id = v_trip.id and d.user_id = v_actor
    )
  into v_allowed;

  if not coalesce(v_allowed, false) then
    raise exception 'FORBIDDEN: this trip is not yours to track' using errcode = '42501';
  end if;

  select * into v_progress from public.trip_progress where trip_id = v_trip.id;

  select q.seq, q.name_ar, q.name_en
  into v_next
  from app.trip_stop_points(v_trip.id) q
  where q.seq = v_progress.nearest_stop_seq;

  select q.seq, q.name_ar, q.name_en
  into v_dest
  from app.trip_stop_points(v_trip.id) q
  order by q.seq desc
  limit 1;

  v_stale := v_progress.last_ping_at is null
    or v_progress.last_ping_at < now() - make_interval(secs => app.ping_stale_after_seconds());

  return jsonb_build_object(
    'trip', jsonb_build_object(
      'id', v_trip.id,
      'code', v_trip.code,
      'status', v_trip.status,
      'departureAt', v_trip.departure_at,
      'arriveEstimateMinutes', v_trip.arrive_estimate_minutes,
      'startedAt', v_trip.started_at,
      'lastStopSeq', v_trip.last_stop_seq
    ),
    'position', case
      when v_progress.latitude is null then null
      else jsonb_build_object(
        'lat', v_progress.latitude,
        'lng', v_progress.longitude,
        'accuracyM', v_progress.accuracy_m,
        'at', v_progress.last_ping_at
      )
    end,
    'nextStop', case
      when v_next.seq is null then null
      else jsonb_build_object(
        'seq', v_next.seq,
        'nameAr', v_next.name_ar,
        'nameEn', v_next.name_en,
        'distanceKm', v_progress.distance_to_next_km,
        'etaSeconds', v_progress.eta_next_seconds
      )
    end,
    'destination', case
      when v_dest.seq is null then null
      else jsonb_build_object(
        'seq', v_dest.seq,
        'nameAr', v_dest.name_ar,
        'nameEn', v_dest.name_en,
        'distanceKm', v_progress.distance_remaining_km,
        'etaSeconds', v_progress.eta_destination_seconds
      )
    end,
    'progressPct', v_progress.progress_pct,
    'distanceRemainingKm', v_progress.distance_remaining_km,
    'speedKmh', v_progress.speed_kmh,
    'stale', v_stale,
    'staleAfterSeconds', app.ping_stale_after_seconds(),
    'lastPingAt', v_progress.last_ping_at,
    'updatedAt', v_progress.updated_at,
    'stops', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'seq', q.seq,
        'nameAr', q.name_ar,
        'nameEn', q.name_en,
        'lat', q.lat,
        'lng', q.lng,
        'reached', coalesce(v_trip.last_stop_seq, 0) >= q.seq
      ) order by q.seq), '[]'::jsonb)
      from app.trip_stop_points(v_trip.id) q
    ),
    'route', app.trip_route_for(v_trip.id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Access
-- ---------------------------------------------------------------------------

alter table public.trip_location_pings enable row level security;
alter table public.trip_progress enable row level security;
alter table public.trip_route_geometry enable row level security;

drop policy if exists trip_pings_read_own on public.trip_location_pings;
create policy trip_pings_read_own on public.trip_location_pings
  for select to authenticated
  using (app.is_trip_driver(app.uid(), trip_id) or app.actor_can_manage_trip(app.uid(), trip_id));

drop policy if exists trip_progress_read_own on public.trip_progress;
create policy trip_progress_read_own on public.trip_progress
  for select to authenticated
  using (app.is_trip_driver(app.uid(), trip_id) or app.actor_can_manage_trip(app.uid(), trip_id));

drop policy if exists trip_route_geometry_read_own on public.trip_route_geometry;
create policy trip_route_geometry_read_own on public.trip_route_geometry
  for select to authenticated
  using (app.actor_can_manage_trip(app.uid(), trip_id) or app.is_trip_driver(app.uid(), trip_id));

-- Nothing writes through PostgREST: the commands are the only writers.
do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.cmd_record_ping(uuid, uuid, double precision, double precision, timestamptz, double precision, double precision, text, text, inet)',
    'app.recompute_trip_progress(uuid)',
    'app.ensure_trip_ping_partition(timestamptz)',
    'app.trip_stop_points(uuid)',
    'app.trip_route_for(uuid)',
    'app.haversine_km(double precision, double precision, double precision, double precision)',
    'app.ping_stale_after_seconds()'
  ]
  loop
    continue when to_regprocedure(v_signature) is null;
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

revoke all on function public.get_trip_progress(text) from public, anon;
grant execute on function public.get_trip_progress(text) to authenticated, service_role;

revoke all on table public.trip_location_pings, public.trip_progress, public.trip_route_geometry
  from anon, authenticated;
grant select on table public.trip_location_pings, public.trip_progress, public.trip_route_geometry
  to authenticated;
grant all on table public.trip_location_pings, public.trip_progress, public.trip_route_geometry
  to service_role;

-- Realtime, where the deployment has the publication. The dev backend has no
-- websocket endpoint, so the app polls; production gets the channel without a
-- second migration.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.trip_progress';
    exception
      when duplicate_object then null;
    end;
  end if;
end;
$$;

comment on table public.trip_location_pings is
  'Every position report a driver''s device produced, partitioned monthly by recorded_at. Append-only.';
comment on table public.trip_progress is
  'Derived once per ping by app.recompute_trip_progress(); every screen reads this row instead of doing geometry.';
comment on column public.trips.last_ping_at is
  'Newest ping time (monotonic). `get_trip_progress()` compares it with app.ping_stale_after_seconds() to show «الموقع غير محدّث».';
