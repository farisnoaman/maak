-- 00036_search_performance.sql — search at launch volume.
--
-- `search_public_trips` evaluated `app.trip_matches()` once per row, per dimension: the page, the total and
-- the four facet groupings were independent passes over `trips_search`, and each pass rebuilt four text arrays
-- out of the filter JSON for every row it looked at. On the demo database (three trips) that is invisible. On
-- 50,000 published trips it measured **15.7 s at p95** — fifty times the Phase 9 target of 300 ms, and a
-- number that had never been taken, because there was no seed to take it against.
--
-- The rewrite computes every dimension's predicate **once per row**, in a materialised CTE, and answers the
-- page, the total and all five facet groupings from that one projection with plain boolean tests:
--
--   · the filter scalars (arrays, booleans, dates) are extracted from the JSON once, in plpgsql, not per row;
--   · `matched` is `materialized`, so PostgreSQL evaluates the eight predicates exactly once — without that
--     keyword the planner is free to inline the CTE and re-evaluate them in each aggregation, which is the
--     same problem in a new place;
--   · the facets read the projection, so a facet pass costs a group-by over booleans instead of one plpgsql
--     call per public trip.
--
-- `app.trip_matches()` stays. It is the readable statement of what a filter means, `00032`'s saved-search job
-- still uses it, and 0007's equivalence assertions keep the fast path honest: the rewrite is allowed to differ
-- from the function in speed and in nothing else.

/**
 * The sort key, as scalars rather than as a row.
 *
 * The composite overload `app.trip_rank(public.trips_search, text)` cannot be inlined by PostgreSQL — passing a
 * whole row blocks it — so 50,000 rows meant 50,000 function calls and 226 ms of the 480 ms the rewrite still
 * spent. This overload inlines, and the composite one now delegates to it so the two cannot disagree.
 *
 * Why the arithmetic instead of `extract(epoch from p_departure)`: that form is **stable**, not immutable
 * (`timestamptz` → epoch depends on the session TimeZone in principle), and a body containing a stable call
 * blocks inlining just as surely. Subtracting the epoch and extracting from the resulting interval is
 * immutable, and produces the identical numeric — asserted against 50,000 rows, and by 0007's equivalence test.
 */
create or replace function app.trip_rank(
  p_price integer,
  p_departure timestamptz,
  p_featured boolean,
  p_sort text
)
returns numeric
language sql
immutable
as $$
  select case p_sort
    when 'cheapest' then p_price::numeric * 1e10
                         + extract(epoch from (p_departure - '1970-01-01 00:00:00+00'::timestamptz))
    when 'featured' then (case when p_featured then 0 else 1 end)::numeric * 1e15
                         + extract(epoch from (p_departure - '1970-01-01 00:00:00+00'::timestamptz))
    else extract(epoch from (p_departure - '1970-01-01 00:00:00+00'::timestamptz))
  end;
$$;

/** The original signature, unchanged for every caller, now a thin delegation. */
create or replace function app.trip_rank(p_row public.trips_search, p_sort text)
returns numeric
language sql
immutable
as $$
  select app.trip_rank(p_row.price_from_yer, p_row.departure_at, p_row.is_featured, p_sort);
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
-- Volatile, not stable: a cache miss writes a row into `search_cache`. A STABLE function may not INSERT,
-- and marking this one STABLE to satisfy a reader made every cache miss fail at runtime.
volatile
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
  v_facets jsonb;
  v_payload jsonb;

  -- Every filter, extracted once. NULL means "this dimension is not filtered", which lets the predicates
  -- below read as `v_origin is null or …` instead of branching per row.
  v_q text;
  v_origin uuid[];
  v_destination uuid[];
  v_gender text[];
  v_booking text[];
  v_direct boolean;
  v_price_max integer;
  v_date_from date;
  v_date_to date;
begin
  v_key := md5(jsonb_build_object(
    'public', v_locale, 'filters', p_filters, 'sort', v_sort, 'cursor', p_cursor, 'limit', v_limit
  )::text);

  select payload into v_cached from public.search_cache c where c.key = v_key and c.expires_at > now();
  if v_cached is not null then
    return v_cached || jsonb_build_object('cached', true);
  end if;

  if p_filters is not null then
    v_q := nullif(btrim(coalesce(p_filters ->> 'q', '')), '');

    if jsonb_typeof(p_filters -> 'origin') = 'array' and jsonb_array_length(p_filters -> 'origin') > 0 then
      v_origin := array(select value::uuid from jsonb_array_elements_text(p_filters -> 'origin') as value);
    end if;
    if jsonb_typeof(p_filters -> 'destination') = 'array'
       and jsonb_array_length(p_filters -> 'destination') > 0 then
      v_destination := array(
        select value::uuid from jsonb_array_elements_text(p_filters -> 'destination') as value
      );
    end if;
    if jsonb_typeof(p_filters -> 'gender') = 'array' and jsonb_array_length(p_filters -> 'gender') > 0 then
      v_gender := array(select value from jsonb_array_elements_text(p_filters -> 'gender') as value);
    end if;
    if jsonb_typeof(p_filters -> 'booking') = 'array' and jsonb_array_length(p_filters -> 'booking') > 0 then
      v_booking := array(select value from jsonb_array_elements_text(p_filters -> 'booking') as value);
    end if;

    if p_filters ? 'direct' then
      v_direct := (p_filters ->> 'direct')::boolean;
    end if;
    if p_filters ? 'priceMax' then
      v_price_max := (p_filters ->> 'priceMax')::integer;
    end if;
    if p_filters ? 'dateFrom' then
      v_date_from := (p_filters ->> 'dateFrom')::date;
    end if;
    if p_filters ? 'dateTo' then
      v_date_to := (p_filters ->> 'dateTo')::date;
    end if;
  end if;

  -- Narrow on purpose. `s.*` is 339 bytes a row: materialising 50,000 of them is 17 MB of copying before a
  -- single row is returned, and the page needs five of those columns. The projection keeps the keys the facets
  -- group by and the eight booleans, and joins the rest back for the twelve rows that are actually rendered.
  with matched as materialized (
    select
      s.trip_id,
      s.departure_at,
      s.departure_date,
      s.origin_governorate_id,
      s.destination_governorate_id,
      s.gender_policy,
      s.booking_mode,
      s.stop_count,
      app.trip_rank(s.price_from_yer, s.departure_at, s.is_featured, v_sort) as rank,
      (v_origin is null or s.origin_governorate_id = any (v_origin)) as ok_origin,
      (v_destination is null or s.destination_governorate_id = any (v_destination)) as ok_destination,
      (v_gender is null or s.gender_policy::text = any (v_gender)) as ok_gender,
      (v_booking is null or s.booking_mode::text = any (v_booking)) as ok_booking,
      (
        v_direct is null
        or (v_direct and s.stop_count = 0)
        or (not v_direct and s.stop_count > 0)
      ) as ok_direct,
      (v_price_max is null or s.price_from_yer <= v_price_max) as ok_price,
      (
        (v_date_from is null or s.departure_date >= v_date_from)
        and (v_date_to is null or s.departure_date <= v_date_to)
      ) as ok_date,
      (v_q is null or s.search_text like '%' || lower(v_q) || '%') as ok_q
    from public.trips_search s
    where s.is_public
      and s.departure_at > now()
  ),
  hit as (
    select m.*
    from matched m
    where m.ok_origin and m.ok_destination and m.ok_gender and m.ok_booking
      and m.ok_direct and m.ok_price and m.ok_date and m.ok_q
  ),
  page as (
    select h.*
    from hit h
    where p_cursor is null
       or (h.rank, h.trip_id) > (split_part(p_cursor, '|', 1)::numeric, split_part(p_cursor, '|', 2)::uuid)
    order by h.rank, h.trip_id
    limit v_limit
  ),
  -- Cascading facets: each count is computed with every filter *except its own dimension*, so narrowing
  -- origins still tells you what the other origins would have offered.
  facets as (
    select jsonb_build_object(
      'origins', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', g.id, 'code', g.code,
          'name', case when v_locale = 'ar' then g.name_ar else coalesce(g.name_en, g.name_ar) end,
          'count', c.n
        ) order by c.n desc, g.name_ar), '[]'::jsonb)
        from (
          select m.origin_governorate_id as id, count(*)::int as n
          from matched m
          where m.ok_destination and m.ok_gender and m.ok_booking
            and m.ok_direct and m.ok_price and m.ok_date and m.ok_q
          group by m.origin_governorate_id
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
          select m.destination_governorate_id as id, count(*)::int as n
          from matched m
          where m.ok_origin and m.ok_gender and m.ok_booking
            and m.ok_direct and m.ok_price and m.ok_date and m.ok_q
          group by m.destination_governorate_id
        ) c
        join public.governorates g on g.id = c.id
      ),
      'genders', (
        select coalesce(jsonb_agg(jsonb_build_object('value', c.value, 'count', c.n) order by c.n desc), '[]'::jsonb)
        from (
          select m.gender_policy::text as value, count(*)::int as n
          from matched m
          where m.ok_origin and m.ok_destination and m.ok_booking
            and m.ok_direct and m.ok_price and m.ok_date and m.ok_q
          group by m.gender_policy
        ) c
      ),
      'bookingModes', (
        select coalesce(jsonb_agg(jsonb_build_object('value', c.value, 'count', c.n) order by c.n desc), '[]'::jsonb)
        from (
          select m.booking_mode::text as value, count(*)::int as n
          from matched m
          where m.ok_origin and m.ok_destination and m.ok_gender
            and m.ok_direct and m.ok_price and m.ok_date and m.ok_q
          group by m.booking_mode
        ) c
      ),
      'direct', jsonb_build_object(
        'direct', (
          select count(*)::int from matched m
          where m.stop_count = 0 and m.ok_origin and m.ok_destination and m.ok_gender and m.ok_booking
            and m.ok_price and m.ok_date and m.ok_q
        ),
        'withStops', (
          select count(*)::int from matched m
          where m.stop_count > 0 and m.ok_origin and m.ok_destination and m.ok_gender and m.ok_booking
            and m.ok_price and m.ok_date and m.ok_q
        )
      )
    ) as payload
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
          'seatsAvailable', s.seats_available,
          'seatsTotal', s.seats_total,
          'priceFromYer', s.price_from_yer,
          'currency', 'YER',
          'stopCount', p.stop_count,
          'bookingMode', p.booking_mode,
          'pricingMode', s.pricing_mode,
          'discountKind', s.discount_kind,
          'discountValue', s.discount_value,
          'genderPolicy', p.gender_policy,
          'isFeatured', s.is_featured,
          'operatorName', case when v_locale = 'ar' then s.operator_name_ar else s.operator_name_en end,
          'vehicleLabel', s.vehicle_label,
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
        join public.trips_search s on s.trip_id = p.trip_id
        join public.trips t on t.id = p.trip_id
        join public.governorates og on og.id = p.origin_governorate_id
        join public.governorates dg on dg.id = p.destination_governorate_id
      ) x
    ),
    (select count(*)::int from hit),
    (
      select p.rank::text || '|' || p.trip_id::text
      from page p order by p.rank desc, p.trip_id desc limit 1
    ),
    (select payload from facets)
  into v_items, v_total, v_next, v_facets;

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

comment on function public.search_public_trips(text, jsonb, text, text, integer) is
  'Public marketplace search. Evaluates each filter dimension once per row (materialized), so a cache miss '
  'costs one pass over trips_search plus group-bys — not one plpgsql call per row per facet.';
