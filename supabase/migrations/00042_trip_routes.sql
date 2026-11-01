-- 00042 — the route a real road takes, and the straight line when nobody answered
--
-- `00023` built the seam and said plainly that no provider was called: `trip_route_geometry` existed, the read
-- path fell back to the straight line between stops, and the ETA arithmetic (haversine) was honest about being
-- a chain of straight lines. On a 300 km stretch of the Aden–Sana'a road that is not a rounding error; it is
-- where the "next stop in 40 minutes" comes from.
--
-- This adds the provider half without letting it become a dependency:
--
--   · **A corridor cache.** A route is a function of two points, and an operator publishing tomorrow's Sana'a
--     trip needs exactly the geometry yesterday's did. `route_cache` is keyed on the two endpoints rounded to
--     four decimals (~11 m), so 500 departures on one corridor cost one provider call. The trip row stores its
--     own copy as well, because a trip's route should not change under a passenger when the cache is pruned.
--   · **A fetch, outside the transaction.** Postgres cannot make an HTTPS call here, and it should not learn
--     how. `public.get_trips_needing_routes()` is the queue for a worker (`npm run routes:fill`), and
--     `public.cmd_store_trip_route()` is the one write it makes — one command per request, exactly like every
--     other write in this schema, so the audit row and the geometry land together.
--   · **The fallback stays the default.** With no provider URL, no network, a timeout, or a malformed answer,
--     nothing is written and `app.trip_route_for()` keeps returning the straight line it always did. A missing
--     route is a worse estimate, not a broken trip — that is the whole point of the seam `00023` left.
--
-- The straight line is still what `app.trip_progress` measures against until a route exists. This migration
-- does not change the ETA maths for a trip with no geometry, and it does not silently substitute street distance
-- for straight-line distance in stored pings: the progress function recomputes from whatever `trip_route_for`
-- returns, which is now a road when one is known and the same chain it used before when one is not.

-- ---------------------------------------------------------------------------
-- 1. The corridor cache
-- ---------------------------------------------------------------------------

create table public.route_cache (
  -- `app.route_key()`: the two endpoints to four decimals. Text so the key is readable in an EXPLAIN and in a
  -- support query; a hash would save nothing at this row count and cost an investigation every time.
  route_key   text primary key,
  provider    text not null check (length(btrim(provider)) between 2 and 40),
  polyline    jsonb not null
    check (jsonb_typeof(polyline) = 'array' and jsonb_array_length(polyline) >= 2),
  distance_km numeric(10, 2) not null check (distance_km >= 0),
  computed_at timestamptz not null default now()
);

comment on table public.route_cache is
  'Road geometry per corridor, keyed by app.route_key(). One provider call per corridor, not per departure.';

alter table public.route_cache enable row level security;
-- No policy on purpose: the worker reads and writes it through security-definer functions with the service
-- role, and no client has a reason to see another operator's corridors. Same shape as `search_buckets`.

/**
 * The cache key for a corridor.
 *
 * Four decimals is ~11 m: finer than GPS, coarser than the difference between two operators' pins on the same
 * bus station. Rounding is what makes the cache hit at all — the alternative (exact coordinates) misses on every
 * trip because a place's coordinates are entered by hand.
 */
create or replace function app.route_key(
  p_from_lat double precision,
  p_from_lng double precision,
  p_to_lat double precision,
  p_to_lng double precision
)
returns text
language sql
immutable
set search_path = ''
as $$
  select round(p_from_lat::numeric, 4)::text || ',' || round(p_from_lng::numeric, 4)::text
      || ';' || round(p_to_lat::numeric, 4)::text || ',' || round(p_to_lng::numeric, 4)::text;
$$;

comment on function app.route_key(double precision, double precision, double precision, double precision) is
  'Corridor identity: endpoints rounded to four decimals (~11 m), in travel order. `a,b;c,d`.';

/** The first and last stop that actually have coordinates, or nulls. */
create or replace function app.trip_route_endpoints(p_trip_id uuid)
returns table (
  from_lat double precision,
  from_lng double precision,
  to_lat double precision,
  to_lng double precision
)
language sql
stable
security definer
set search_path = ''
as $$
  with points as (
    select q.lat, q.lng, q.seq
      from app.trip_stop_points(p_trip_id) q
     where q.lat is not null and q.lng is not null
  )
  select
    (select lat from points order by seq limit 1),
    (select lng from points order by seq limit 1),
    (select lat from points order by seq desc limit 1),
    (select lng from points order by seq desc limit 1);
$$;

-- ---------------------------------------------------------------------------
-- 2. Reading a route: trip copy → corridor cache → straight line
-- ---------------------------------------------------------------------------

create or replace function app.trip_route_for(p_trip_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    -- The trip's own copy first: a published trip's route must not change under a passenger because an
    -- operator republished the same corridor with a different provider.
    (select g.polyline from public.trip_route_geometry g where g.trip_id = p_trip_id),
    -- Then the corridor, which is what makes a *new* trip answer immediately when the road is already known.
    (
      select c.polyline
        from public.route_cache c
       where c.route_key = (
         select app.route_key(e.from_lat, e.from_lng, e.to_lat, e.to_lng)
           from app.trip_route_endpoints(p_trip_id) e
          where e.from_lat is not null and e.to_lat is not null
       )
    ),
    -- Then the honest fallback `00023` shipped.
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

-- ---------------------------------------------------------------------------
-- 3. The queue and the one write
-- ---------------------------------------------------------------------------

/**
 * Trips a router could fill in right now.
 *
 * Public, upcoming, not cancelled, with at least two located stops and no geometry of their own. The worker is
 * responsible for the cache check — it fetches the corridor key once per distinct corridor and skips the ones
 * already cached — because a worker that asks for one trip at a time would call the provider once per departure,
 * which is the cost this table exists to avoid.
 */
create or replace function public.get_trips_needing_routes(p_limit integer default 200)
returns table (
  trip_id uuid,
  route_key text,
  from_lat double precision,
  from_lng double precision,
  to_lat double precision,
  to_lng double precision,
  cached boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.id,
    app.route_key(e.from_lat, e.from_lng, e.to_lat, e.to_lng),
    e.from_lat,
    e.from_lng,
    e.to_lat,
    e.to_lng,
    exists (select 1 from public.route_cache c where c.route_key = app.route_key(e.from_lat, e.from_lng, e.to_lat, e.to_lng))
  from public.trips t
  cross join lateral app.trip_route_endpoints(t.id) e
  -- `is_public` lives on `trips_search` (00014 derives it: published, verified, future), not on `trips`.
  -- Reading it there keeps one definition of "a trip a passenger can see" instead of a second copy that drifts.
  where exists (
      select 1 from public.trips_search s
       where s.trip_id = t.id and s.is_public
    )
    and t.departure_at > now() - interval '6 hours'
    and t.status in ('published', 'in_progress')
    and e.from_lat is not null
    and e.to_lat is not null
    and (e.from_lat, e.from_lng) is distinct from (e.to_lat, e.to_lng)
    and not exists (select 1 from public.trip_route_geometry g where g.trip_id = t.id)
  order by t.departure_at
  limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$$;

comment on function public.get_trips_needing_routes(integer) is
  'Router queue: public upcoming trips with two located stops and no stored geometry. Service role only.';

/**
 * Store one trip's road geometry, and the corridor it belongs to.
 *
 * Validation is deliberately strict, because the caller is a network response and network responses are the
 * least trustworthy input in this system. A polyline must be an array of at least two `{lat, lng}` objects in
 * range; a distance must be a non-negative number. Anything else is refused with `VALIDATION_FAILED`, which the
 * worker logs and moves past — a provider that starts answering in a different shape should stop filling routes,
 * not fill them with garbage.
 *
 * Idempotent: re-storing the same route is an upsert, so a retried worker request is harmless.
 */
create or replace function public.cmd_store_trip_route(
  p_actor uuid,
  p_trip_id uuid,
  p_provider text,
  p_polyline jsonb,
  p_distance_km numeric,
  p_request_id uuid default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip record;
  v_endpoints record;
  v_key text;
  v_point jsonb;
  v_polyline jsonb := '[]'::jsonb;
begin
  if p_provider is null or length(btrim(p_provider)) < 2 then
    raise exception 'VALIDATION_FAILED: provider is required' using errcode = '22023';
  end if;

  if p_distance_km is null or p_distance_km < 0 then
    raise exception 'VALIDATION_FAILED: distance must be non-negative' using errcode = '22023';
  end if;

  if p_polyline is null or jsonb_typeof(p_polyline) <> 'array' or jsonb_array_length(p_polyline) < 2 then
    raise exception 'VALIDATION_FAILED: polyline must be an array of at least two points'
      using errcode = '22023';
  end if;

  -- Normalise and validate in one pass: only `lat`/`lng` survive, rounded to six decimals (~0.1 m), which is
  -- more precision than any road geometry needs and keeps the stored JSON small.
  for v_point in select * from jsonb_array_elements(p_polyline) loop
    if jsonb_typeof(v_point) <> 'object'
       or jsonb_typeof(v_point -> 'lat') <> 'number'
       or jsonb_typeof(v_point -> 'lng') <> 'number' then
      raise exception 'VALIDATION_FAILED: every point needs numeric lat and lng' using errcode = '22023';
    end if;
    if (v_point ->> 'lat')::double precision not between -90 and 90
       or (v_point ->> 'lng')::double precision not between -180 and 180 then
      raise exception 'VALIDATION_FAILED: point out of range' using errcode = '22023';
    end if;
    v_polyline := v_polyline || jsonb_build_array(jsonb_build_object(
      'lat', round((v_point ->> 'lat')::numeric, 6),
      'lng', round((v_point ->> 'lng')::numeric, 6)
    ));
  end loop;

  select t.id, t.code into v_trip from public.trips t where t.id = p_trip_id;
  if v_trip.id is null then
    raise exception 'NOT_FOUND: trip %', p_trip_id using errcode = 'P0002';
  end if;

  select * into v_endpoints from app.trip_route_endpoints(p_trip_id);
  if v_endpoints.from_lat is null or v_endpoints.to_lat is null then
    raise exception 'VALIDATION_FAILED: trip % has fewer than two located stops', v_trip.code
      using errcode = '22023';
  end if;

  v_key := app.route_key(v_endpoints.from_lat, v_endpoints.from_lng, v_endpoints.to_lat, v_endpoints.to_lng);

  insert into public.route_cache (route_key, provider, polyline, distance_km, computed_at)
  values (v_key, btrim(p_provider), v_polyline, p_distance_km, now())
  on conflict (route_key) do update
    set provider = excluded.provider,
        polyline = excluded.polyline,
        distance_km = excluded.distance_km,
        computed_at = excluded.computed_at;

  insert into public.trip_route_geometry (trip_id, provider, polyline, distance_km, computed_at)
  values (p_trip_id, btrim(p_provider), v_polyline, p_distance_km, now())
  on conflict (trip_id) do update
    set provider = excluded.provider,
        polyline = excluded.polyline,
        distance_km = excluded.distance_km,
        computed_at = excluded.computed_at;

  perform app.write_audit(
    p_actor, 'trip.route.stored', 'trip', p_trip_id::text, null,
    jsonb_build_object(
      'provider', btrim(p_provider),
      'points', jsonb_array_length(v_polyline),
      'distance_km', p_distance_km,
      'route_key', v_key
    ),
    null, p_request_id::text, p_ip
  );

  return jsonb_build_object(
    'tripId', p_trip_id,
    'routeKey', v_key,
    'points', jsonb_array_length(v_polyline),
    'distanceKm', p_distance_km,
    'provider', btrim(p_provider)
  );
end;
$$;

comment on function public.cmd_store_trip_route(uuid, uuid, text, jsonb, numeric, uuid, inet) is
  'Stores validated road geometry for one trip and its corridor. Service role only; idempotent upsert.';

/**
 * Give one trip a copy of a corridor that is already cached.
 *
 * A warm corridor is the common case after the first day — every new departure on the Aden–Sana'a road — and it
 * has no reason to touch the network at all: the geometry is in `route_cache`, keyed by the trip's own endpoints.
 * Kept as its own command rather than a flag on `cmd_store_trip_route`, because the write guard counts commands
 * per request and a boolean that changes what a command stores is how a validate-everything path quietly becomes
 * a trust-anything one.
 *
 * Refuses when the corridor is not cached: the caller should have called the provider, and silently falling back
 * to the straight line inside a "store the route" function would hide that.
 */
create or replace function public.cmd_attach_cached_route(p_trip_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_endpoints record;
  v_key text;
  v_cache public.route_cache%rowtype;
begin
  select * into v_endpoints from app.trip_route_endpoints(p_trip_id);
  if v_endpoints.from_lat is null or v_endpoints.to_lat is null then
    raise exception 'VALIDATION_FAILED: trip % has fewer than two located stops', p_trip_id
      using errcode = '22023';
  end if;

  v_key := app.route_key(v_endpoints.from_lat, v_endpoints.from_lng, v_endpoints.to_lat, v_endpoints.to_lng);

  select * into v_cache from public.route_cache c where c.route_key = v_key;
  if v_cache.route_key is null then
    raise exception 'NOT_FOUND: corridor % is not cached', v_key using errcode = 'P0002';
  end if;

  insert into public.trip_route_geometry (trip_id, provider, polyline, distance_km, computed_at)
  values (p_trip_id, v_cache.provider, v_cache.polyline, v_cache.distance_km, now())
  on conflict (trip_id) do update
    set provider = excluded.provider,
        polyline = excluded.polyline,
        distance_km = excluded.distance_km,
        computed_at = excluded.computed_at;

  return jsonb_build_object(
    'tripId', p_trip_id,
    'routeKey', v_key,
    'points', jsonb_array_length(v_cache.polyline),
    'distanceKm', v_cache.distance_km,
    'provider', v_cache.provider,
    'fromCache', true
  );
end;
$$;

comment on function public.cmd_attach_cached_route(uuid) is
  'Copies a cached corridor onto one trip. Service role only; refuses when the corridor is not cached.';

revoke all on table public.route_cache from public, anon, authenticated;
grant all on table public.route_cache to service_role;

revoke all on function public.get_trips_needing_routes(integer) from public, anon, authenticated;
grant execute on function public.get_trips_needing_routes(integer) to service_role;

revoke all on function public.cmd_store_trip_route(uuid, uuid, text, jsonb, numeric, uuid, inet)
  from public, anon, authenticated;
grant execute on function public.cmd_store_trip_route(uuid, uuid, text, jsonb, numeric, uuid, inet)
  to service_role;

revoke all on function public.cmd_attach_cached_route(uuid) from public, anon, authenticated;
grant execute on function public.cmd_attach_cached_route(uuid) to service_role;
