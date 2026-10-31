-- ---------------------------------------------------------------------------
-- 00022 — Phase 6, part one: the trip actually starts, moves and ends
--
-- Phase 4 could sell a seat on a trip and Phase 5 could fill the vehicle, but nothing in the product
-- could say "this vehicle has left". This migration is the skeleton of trip execution — the state
-- machine, the odometer discipline and the stop log — with the parts that need a live position
-- (pings, progress, the map) deliberately left to a later migration so each piece can be tested on
-- its own.
--
-- Three rules are being made structural rather than documented:
--
--   1. **Only a verified trip starts** (BR-05), and not more than two hours before its departure: a
--      driver who taps "start" at breakfast is telling the system something untrue about the vehicle.
--   2. **The odometer only goes forward.** Every reading is appended to `odometer_readings`, and a trip
--      cannot end below where it started. A typo is refused at the door, with a code the app can
--      explain, rather than discovered in a maintenance report a month later.
--   3. **The trip's state is its history.** `started_at`, `last_stop_seq` and `completed_at` are set by
--      commands, never by a client, and each one appends a `trip_events` row in the same transaction.
-- ---------------------------------------------------------------------------

alter table public.trips
  add column if not exists started_at timestamptz,
  -- The highest stop the driver has announced reaching. A sequence number, not a timestamp: the driver
  -- may arrive early or late, and "where is the vehicle now" must not depend on the timetable.
  add column if not exists last_stop_seq smallint check (last_stop_seq is null or last_stop_seq between 1 and 20);

-- A trip that claims to have started has to say when, and a completed one too.
alter table public.trips
  drop constraint if exists trips_started_when_in_progress;
alter table public.trips
  add constraint trips_started_when_in_progress
  check (status not in ('in_progress', 'completed') or started_at is not null) not valid;

-- Odometer readings become attributable to a trip, so "how far did this trip drive" is a subtraction
-- rather than a guess, and a trip cannot be started or ended twice.
alter table public.odometer_readings
  add column if not exists trip_id uuid references public.trips (id) on delete set null;

create unique index if not exists odometer_readings_trip_kind_uq
  on public.odometer_readings (trip_id, kind)
  where trip_id is not null;

/**
 * Is `p_actor` the driver this trip is assigned to?
 *
 * One question, one place: the driver's row is bound to an account (`driver_profiles.user_id`), and
 * being *a* driver is not the same as being *this trip's* driver.
 */
create or replace function app.is_trip_driver(p_actor uuid, p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from public.trips t
      join public.driver_profiles d on d.id = t.driver_id
      where t.id = p_trip_id
        and d.user_id = p_actor
        and d.is_active
    ),
    false
  );
$$;

/** The vehicle's last known odometer: the registration reading or the newest logged one, whichever is higher. */
create or replace function app.last_odometer_km(p_vehicle_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    coalesce((select v.odometer_km from public.vehicles v where v.id = p_vehicle_id), 0),
    coalesce(
      (select max(r.reading_km) from public.odometer_readings r where r.vehicle_id = p_vehicle_id),
      0
    )
  );
$$;

/**
 * May this actor move this trip along?
 *
 * The assigned driver, the trip's owner (a one-vehicle operator drives their own Hiace), or platform
 * staff acting as an audited override. Anyone else is `FORBIDDEN` — and the answer is computed from the
 * rows, never from a claim in the request.
 */
create or replace function app.assert_can_execute_trip(p_actor uuid, p_trip public.trips)
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

  if app.is_trip_driver(p_actor, p_trip.id)
     or app.actor_can_manage_trip(p_actor, p_trip.id)
     or app.is_platform_staff(p_actor) then
    return;
  end if;

  raise exception 'FORBIDDEN: this trip is not assigned to you' using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Start
-- ---------------------------------------------------------------------------

/**
 * BR-05 — a trip starts only when it is verified, close enough to its departure, and driven by the
 * person it is assigned to. Starting it writes the odometer reading and the event in the same
 * transaction, so there is no state in which a trip is running and its distance is unknown.
 */
create or replace function public.cmd_start_trip(
  p_actor uuid,
  p_trip_id uuid,
  p_odo_km integer,
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
  v_last_odo integer;
  v_reading integer;
begin
  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  perform app.assert_can_execute_trip(p_actor, v_trip);

  if v_trip.status = 'in_progress' then
    raise exception 'CONFLICT: this trip has already started' using errcode = '23505';
  end if;
  if v_trip.status <> 'published' then
    raise exception 'TRIP_NOT_STARTABLE: % is not a published trip', v_trip.status
      using errcode = '23505';
  end if;
  if v_trip.verification_status <> 'verified' then
    raise exception 'TRIP_NOT_VERIFIED: this trip has not been verified' using errcode = '23505';
  end if;

  -- Two hours: long enough for a driver to open the app when the vehicle is being loaded, short enough
  -- that "started" still means something to a passenger looking at the live screen.
  if now() < v_trip.departure_at - interval '2 hours' then
    raise exception 'TOO_EARLY: this trip departs at %', to_char(v_trip.departure_at, 'YYYY-MM-DD HH24:MI')
      using errcode = '23505';
  end if;

  v_last_odo := app.last_odometer_km(v_trip.vehicle_id);
  v_reading := coalesce(p_odo_km, v_last_odo);
  if v_reading < v_last_odo then
    raise exception 'ODO_REGRESSION: the odometer reads % km but the vehicle was last logged at % km',
      v_reading, v_last_odo using errcode = '22023';
  end if;

  insert into public.odometer_readings (
    vehicle_id, reading_km, kind, driver_id, recorded_by, trip_id, note
  ) values (
    v_trip.vehicle_id, v_reading, 'trip_start', v_trip.driver_id, p_actor, p_trip_id,
    'trip ' || v_trip.code
  );

  update public.trips
  set status = 'in_progress', started_at = now()
  where id = p_trip_id
  returning * into v_trip;

  insert into public.trip_events (trip_id, kind, actor_id, detail)
  values (p_trip_id, 'started', p_actor,
          jsonb_build_object('odo_km', v_reading, 'departure_at', v_trip.departure_at));

  perform app.write_audit(
    p_actor, 'trip.start', 'trip', p_trip_id::text, null,
    jsonb_build_object('status', 'in_progress', 'odo_km', v_reading),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('trip', to_jsonb(v_trip), 'odoKm', v_reading);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Stops, as the driver announces them
-- ---------------------------------------------------------------------------

/**
 * "Reached stop 2."
 *
 * Monotonic by construction: the trip remembers the highest stop reached, so a double tap or a
 * reconnecting queue cannot walk the trip backwards. The stop must exist on this trip — the sequence is
 * a position on *this* route, not a global number.
 */
create or replace function public.cmd_mark_stop_reached(
  p_actor uuid,
  p_trip_id uuid,
  p_seq smallint,
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
  v_stop public.trip_stops%rowtype;
begin
  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  perform app.assert_can_execute_trip(p_actor, v_trip);

  if v_trip.status <> 'in_progress' then
    raise exception 'TRIP_NOT_STARTABLE: this trip is %', v_trip.status using errcode = '23505';
  end if;

  select * into v_stop from public.trip_stops s where s.trip_id = p_trip_id and s.seq = p_seq;
  if not found then
    raise exception 'NOT_FOUND: stop % on this trip', p_seq using errcode = 'P0002';
  end if;

  if v_trip.last_stop_seq is not null and p_seq <= v_trip.last_stop_seq then
    -- Not an error worth a dialog: the phone retried a request the server already applied.
    return jsonb_build_object('trip', to_jsonb(v_trip), 'alreadyReached', true);
  end if;

  update public.trips set last_stop_seq = p_seq where id = p_trip_id returning * into v_trip;

  insert into public.trip_events (trip_id, kind, actor_id, detail)
  values (p_trip_id, 'stop_reached', p_actor,
          jsonb_build_object('seq', p_seq, 'name', coalesce(v_stop.name_ar, v_stop.name_en)));

  perform app.write_audit(
    p_actor, 'trip.stopReached', 'trip', p_trip_id::text, null,
    jsonb_build_object('seq', p_seq), null, p_request_id, p_ip
  );

  return jsonb_build_object('trip', to_jsonb(v_trip), 'alreadyReached', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. End
-- ---------------------------------------------------------------------------

/**
 * The trip arrives: the odometer advances, the vehicle's total moves with it, and every accepted
 * booking on the trip becomes history in the same transaction.
 *
 * An ending odometer below the starting one is refused (`ODO_REGRESSION`). An ending reading that is
 * *absurdly* above the distance the trip could have covered is recorded and flagged rather than
 * refused: a driver who took a detour is not a data-entry error, and refusing would strand a vehicle
 * at the side of the road. The flag is what an auditor reads.
 */
create or replace function public.cmd_end_trip(
  p_actor uuid,
  p_trip_id uuid,
  p_odo_km integer,
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
  v_start integer;
  v_distance integer;
  v_unusual boolean := false;
begin
  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  perform app.assert_can_execute_trip(p_actor, v_trip);

  if v_trip.status <> 'in_progress' then
    raise exception 'TRIP_NOT_STARTABLE: this trip is %', v_trip.status using errcode = '23505';
  end if;

  select r.reading_km into v_start
  from public.odometer_readings r
  where r.trip_id = p_trip_id and r.kind = 'trip_start';

  if v_start is null then
    raise exception 'CONFLICT: this trip has no starting odometer' using errcode = '23505';
  end if;
  if p_odo_km is null or p_odo_km < v_start then
    raise exception 'ODO_REGRESSION: the odometer reads % km but this trip started at % km',
      coalesce(p_odo_km, 0), v_start using errcode = '22023';
  end if;

  v_distance := p_odo_km - v_start;

  -- 100 km/h for the whole elapsed time is the ceiling of the plausible; beyond it the number is worth a
  -- second look, but the trip still ends. (`arrive_estimate_minutes` is the operator's own figure, and a
  -- vehicle that sat in traffic for two hours is not suspicious.)
  if v_distance > ceil(
       greatest(extract(epoch from (now() - v_trip.started_at)) / 3600, 0.25) * 100
     )::int + 50 then
    v_unusual := true;
  end if;

  insert into public.odometer_readings (
    vehicle_id, reading_km, kind, driver_id, recorded_by, trip_id, note
  ) values (
    v_trip.vehicle_id, p_odo_km, 'trip_end', v_trip.driver_id, p_actor, p_trip_id,
    case when v_unusual then 'trip ' || v_trip.code || ' (distance flagged)' else 'trip ' || v_trip.code end
  );

  update public.vehicles
  set odometer_km = greatest(odometer_km, p_odo_km)
  where id = v_trip.vehicle_id;

  update public.trips
  set status = 'completed', completed_at = now()
  where id = p_trip_id
  returning * into v_trip;

  insert into public.trip_events (trip_id, kind, actor_id, detail)
  values (p_trip_id, 'ended', p_actor,
          jsonb_build_object('odo_km', p_odo_km, 'distance_km', v_distance, 'flagged', v_unusual));

  -- The passengers were on this vehicle; their bookings become `completed` here rather than waiting for
  -- the nightly sweep, because the operator is looking at the manifest right now.
  perform public.cmd_finalize_trip_bookings(p_trip_id, p_request_id);

  perform app.write_audit(
    p_actor, 'trip.end', 'trip', p_trip_id::text, null,
    jsonb_build_object(
      'status', 'completed', 'odo_km', p_odo_km, 'distance_km', v_distance, 'flagged', v_unusual
    ),
    case when v_unusual then 'distance above plausible range' end, p_request_id, p_ip
  );

  return jsonb_build_object(
    'trip', to_jsonb(v_trip), 'odoKm', p_odo_km, 'distanceKm', v_distance, 'flagged', v_unusual
  );
end;
$$;

-- Commands are not API: a client reaches them through the `trips` edge function, which checks the
-- policy matrix first and passes the actor explicitly.
do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.cmd_start_trip(uuid, uuid, integer, text, inet)',
    'public.cmd_mark_stop_reached(uuid, uuid, smallint, text, inet)',
    'public.cmd_end_trip(uuid, uuid, integer, text, inet)',
    'app.is_trip_driver(uuid, uuid)',
    'app.assert_can_execute_trip(uuid, public.trips)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

comment on column public.trips.last_stop_seq is
  'The highest stop sequence the driver has announced reaching. Monotonic; set only by cmd_mark_stop_reached().';
comment on column public.odometer_readings.trip_id is
  'Which trip this reading belongs to. `trip_start` and `trip_end` are unique per trip by index.';
