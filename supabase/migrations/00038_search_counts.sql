-- 00038_search_counts.sql — the marketplace stops recounting 50,000 rows to answer a homepage.
--
-- `00036` collapsed seven passes into one materialised projection, and the measurement afterwards was still
-- **155 ms** of CPU per cold search at 50,000 published trips. Broken down with `explain (analyze)`:
--
--   · 79.5 ms  the five cascading facet aggregations, each a pass over the materialised matched set;
--   · 54.8 ms  the total;
--   · 50.5 ms  ranking every public trip so the first twelve could be sorted out of it;
--   · 66.8 ms  the page sort and its joins.
--
-- Every one of those is proportional to the number of public trips, so the ceiling was never a latency bug
-- that a faster box hides: it is ~7 cold searches per second per core, and `docs/perf/README.md` said so.
--
-- Two of the four can be *removed* rather than made cheaper, and this migration removes them.
--
-- **1. The counts are not recomputed per request.** `app.search_facet_counts()` answers "how many per
-- origin / destination / gender / booking / direct" in one pass, grouping 50,000 rows into ~30 buckets
-- (~35 ms, down from 79 ms, because the six summaries then run over the buckets instead of the trips). The
-- unfiltered answer — the homepage, which is most of the traffic — is additionally stored in
-- `public.search_counts` and recomputed in the background by whoever notices it is stale, so a homepage
-- request reads thirty rows instead of scanning fifty thousand. The result is deliberately allowed to be up
-- to a minute old: a chip that says «عدن ٤٩٬٩٩٧» when the truth is ٤٩٬٩٩٨ is not a bug, it is the price of
-- not scanning. The *total* is not taken from that row — it is an exact `count(*)` on an index-only scan
-- (5–7 ms), because the count of results is a number the user reads as a promise and paginates against.
--
-- **2. The page is read from an index.** The sort key was computed per row, so `ORDER BY rank LIMIT 12`
-- ranked every public trip before it could answer. `trips_search` now carries three *generated* rank
-- columns — one per sort, each with a partial index ending in `trip_id` — so a page is an index scan that
-- stops after `limit` rows and the keyset cursor is an index condition instead of a filter. Page 1 costs
-- 0.0 ms; page 40, which has to skip 480 rows, costs 0.1 ms.
--
-- Measured back to back against the 00036 implementation on the same 49,998-trip database, one request at a
-- time with the cache cleared: the unfiltered homepage 161.6 → 12.9 ms, a selective price cap 112.6 → 3.0 ms,
-- a cap that matches everything 159.7 → 42.0 ms, `direct: true` 155.1 → 41.6 ms — with the facets identical
-- on every shape. What is left of the old cost: 5–7 ms for the exact total, 0.03 ms for the page, and — for a
-- *filtered* search, where no aggregate can answer "what is left if I also pick Aden" — the 35 ms grouping
-- pass, cached for thirty seconds and shared by every sort and every page of the same filter set.
-- `0007_trips.test.sql` keeps the new paths honest against `app.trip_matches()` and against each other: the
-- fast answer is allowed to differ from the slow one in speed and in nothing else.

-- Deploying: `alter table … add column … generated` rewrites `trips_search` and `create index` takes a lock,
-- so on a production-sized table this belongs in a maintenance window (50,000 rows rewrote in 0.5 s here).
-- Nothing else in the migration touches existing rows, and the old function stays callable until the new one
-- replaces it in the same transaction.

begin;

-- ---------------------------------------------------------------------------
-- 1. The sort key becomes a column
-- ---------------------------------------------------------------------------

/**
 * Three rank columns, generated, one per sort.
 *
 * The arithmetic is `app.trip_rank`'s, character for character — `0007` asserts every row of both agree for
 * all three sorts, so the index and the function cannot drift apart. Inlining it here rather than calling the
 * function keeps the expression immutable in the sense the planner cares about and lets the ORDER BY in
 * `search_public_trips` match an index exactly.
 *
 * `extract(epoch from (p_departure - epoch))` and not `extract(epoch from p_departure)` for the reason
 * `00036` gives: the first is immutable, the second is only stable, and a generated column cannot be built
 * on a stable expression.
 */
alter table public.trips_search
  add column rank_soonest numeric
    generated always as (
      extract(epoch from (departure_at - '1970-01-01 00:00:00+00'::timestamptz))
    ) stored,
  add column rank_cheapest numeric
    generated always as (
      price_from_yer::numeric * 1e10
      + extract(epoch from (departure_at - '1970-01-01 00:00:00+00'::timestamptz))
    ) stored,
  add column rank_featured numeric
    generated always as (
      (case when is_featured then 0 else 1 end)::numeric * 1e15
      + extract(epoch from (departure_at - '1970-01-01 00:00:00+00'::timestamptz))
    ) stored;

-- Partial, like `trips_search_public_idx`: only public rows are ever paged through, and the trailing
-- `trip_id` is what makes the (rank, trip_id) keyset comparison a single index condition.
create index trips_search_rank_soonest_idx
  on public.trips_search (rank_soonest, trip_id) where is_public;
create index trips_search_rank_cheapest_idx
  on public.trips_search (rank_cheapest, trip_id) where is_public;
create index trips_search_rank_featured_idx
  on public.trips_search (rank_featured, trip_id) where is_public;

comment on column public.trips_search.rank_soonest is
  'The soonest keyset sort key as a generated column, so the page can be read from an index. Equal to app.trip_rank(price_from_yer, departure_at, is_featured, soonest) — asserted in 0007.';

-- ---------------------------------------------------------------------------
-- 2. The maintained counts
-- ---------------------------------------------------------------------------

/**
 * The unfiltered facet counts, kept in a table so a homepage request reads thirty rows instead of fifty
 * thousand.
 *
 * `app.refresh_search_counts()` rewrites this table from `app.search_facet_counts()` — the same function a
 * filtered search calls, with no filters — so the stored answer and the computed one are the same query.
 * `refreshed_at` is what makes "stale" a decidable question.
 */
create table public.search_counts (
  dimension   text not null check (dimension in ('origin', 'destination', 'gender', 'booking', 'direct')),
  value       text not null,
  count       integer not null,
  refreshed_at timestamptz not null default now(),
  primary key (dimension, value)
);

comment on table public.search_counts is
  'Facet counts for the unfiltered marketplace search, recomputed lazily: at most a minute old, and never used for the result total.';

-- No policy and no grant: only `search_public_trips` (SECURITY DEFINER, owned by the migration role) reads
-- it. A browser role that could read it would get a table of numbers it can already get from the API.
alter table public.search_counts enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Counting, once per filter set
-- ---------------------------------------------------------------------------

/**
 * Every facet count, in one pass, from one definition.
 *
 * The trick that makes this a single scan is the granularity: instead of six passes over 50,000 trips, group
 * them by the tuple the counts are made of — (origin, destination, gender, booking, direct) — and the result
 * is a few dozen buckets (Yemen has 22 governorates; the ceiling is 22 × 22 × 3 × 3 × 2 ≈ 8,700). Every
 * filter in this product constrains one of those tuple positions to a set of allowed values, so the
 * cascading rule «count what would be left if I also chose Aden» is a sum over buckets whose *value* passes
 * the other dimensions' filters. That is arithmetic on ~30 rows, not four more scans.
 *
 * `p_skip`-free on purpose: `app.trip_matches()` is still the readable statement of what a filter means and
 * `0007` asserts these counts equal the ones it produces, dimension by dimension, for a matrix of filters.
 * The price/date/text filters cannot be skipped by a facet, so they restrict the scan instead.
 */
create or replace function app.search_facet_counts(
  p_origin uuid[] default null,
  p_destination uuid[] default null,
  p_gender text[] default null,
  p_booking text[] default null,
  p_direct boolean default null,
  p_price_max integer default null,
  p_date_from date default null,
  p_date_to date default null,
  p_q text default null
)
returns table (dimension text, value text, n integer)
language plpgsql
stable
set search_path = ''
as $$
declare
  -- The four filters that *narrow the scan* are written into the statement instead of being guarded per row:
  -- `(p_price_max is null or …)` cannot be folded when p_price_max is a parameter, and five unfolded guards
  -- measured 54 ms of the 89 ms this function cost. The four dimension filters stay as guards, because they
  -- are applied to the ~30 buckets rather than to the 50,000 trips.
  v_where text := '';
begin
  if p_price_max is not null then
    v_where := v_where || format(' and s.price_from_yer <= %s', p_price_max);
  end if;
  if p_date_from is not null then
    v_where := v_where || format(' and s.departure_date >= %L', p_date_from);
  end if;
  if p_date_to is not null then
    v_where := v_where || format(' and s.departure_date <= %L', p_date_to);
  end if;
  if p_q is not null then
    v_where := v_where || format(' and s.search_text like %L', '%' || lower(p_q) || '%');
  end if;

  return query execute format($counts$
    with groups as materialized (
      select
        s.origin_governorate_id as o,
        s.destination_governorate_id as d,
        s.gender_policy::text as g,
        s.booking_mode::text as b,
        (s.stop_count = 0) as direct,
        count(*)::int as n
      from public.trips_search s
      where s.is_public
        and s.departure_at > now()%s
      group by 1, 2, 3, 4, 5
    ),
    buckets as (
      select
        g.*,
        ($1::uuid[] is null or g.o = any ($1::uuid[])) as ok_o,
        ($2::uuid[] is null or g.d = any ($2::uuid[])) as ok_d,
        ($3::text[] is null or g.g = any ($3::text[])) as ok_g,
        ($4::text[] is null or g.b = any ($4::text[])) as ok_b,
        ($5::boolean is null or g.direct = $5::boolean) as ok_direct
      from groups g
    )
    select 'total', '', coalesce(sum(b.n), 0)::int
    from buckets b
    where b.ok_o and b.ok_d and b.ok_g and b.ok_b and b.ok_direct
    union all
    select 'origin', b.o::text, sum(b.n)::int
    from buckets b
    where b.ok_d and b.ok_g and b.ok_b and b.ok_direct
    group by b.o
    union all
    select 'destination', b.d::text, sum(b.n)::int
    from buckets b
    where b.ok_o and b.ok_g and b.ok_b and b.ok_direct
    group by b.d
    union all
    select 'gender', b.g, sum(b.n)::int
    from buckets b
    where b.ok_o and b.ok_d and b.ok_b and b.ok_direct
    group by b.g
    union all
    select 'booking', b.b, sum(b.n)::int
    from buckets b
    where b.ok_o and b.ok_d and b.ok_g and b.ok_direct
    group by b.b
    union all
    select 'direct', b.direct::text, sum(b.n)::int
    from buckets b
    where b.ok_o and b.ok_d and b.ok_g and b.ok_b
    group by b.direct
  $counts$, v_where)
  using p_origin, p_destination, p_gender, p_booking, p_direct;
end;
$$;

comment on function app.search_facet_counts(uuid[], uuid[], text[], text[], boolean, integer, date, date, text) is
  'Every marketplace facet count in one pass: group the public trips into ~30 (origin, destination, gender, '
  'booking, direct) buckets, then sum the buckets each cascading filter admits.';

/**
 * Rebuilds `public.search_counts` from the same function, with no filters applied.
 *
 * Delete-then-insert rather than upsert: a governorate that no longer offers a trip must disappear from the
 * counts, and a stale row that nothing updates would be invisible forever. Both statements are one
 * transaction, so a concurrent reader sees the old table until the new one commits.
 */
create or replace function app.refresh_search_counts()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  delete from public.search_counts;

  insert into public.search_counts (dimension, value, count, refreshed_at)
  select c.dimension, c.value, c.n, now()
  from app.search_facet_counts() c
  where c.dimension <> 'total';

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function app.refresh_search_counts() is
  'Rewrites public.search_counts from app.search_facet_counts() — the unfiltered facet counts, one scan.';

/**
 * Staleness, decided in one place, with one refresher.
 *
 * The alternative to a scheduled refresh is not "no staleness", it is "every request pays 39 ms": a cache
 * miss is exactly the moment to notice, and nothing else knows the traffic. The advisory lock is what stops a
 * thundering herd of simultaneous misses from all writing the same thirty rows; the losers serve the old
 * counts, which is what they would have done anyway.
 */
create or replace function app.ensure_search_counts(p_max_age interval default interval '30 seconds')
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  select max(c.refreshed_at) into v_at from public.search_counts c;

  if v_at is not null and v_at > now() - p_max_age then
    return false;
  end if;

  if not pg_try_advisory_xact_lock(hashtext('maak.search_counts')) then
    return false;
  end if;

  perform app.refresh_search_counts();
  return true;
end;
$$;

comment on function app.ensure_search_counts(interval) is
  'Refreshes public.search_counts when it is older than p_max_age, at most one refresher at a time.';

/**
 * Turns (dimension, value, n) rows into the JSON a screen renders.
 *
 * One shaper for both sources — the stored counts and the filtered pass — because two shapers would be two
 * orderings, two name fallbacks and eventually two answers. Ordered the way `00036` ordered them: biggest
 * first, then Arabic name, so the chips do not jump around between refreshes.
 */
create or replace function app.search_facets_json(p_counts jsonb, p_locale text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with c as (
    select
      x ->> 'dimension' as dimension,
      x ->> 'value' as value,
      (x ->> 'n')::int as n
    from jsonb_array_elements(coalesce(p_counts, '[]'::jsonb)) x
  )
  select jsonb_build_object(
    'origins', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', g.id, 'code', g.code,
        'name', case when p_locale = 'ar' then g.name_ar else coalesce(g.name_en, g.name_ar) end,
        'count', c.n
      ) order by c.n desc, g.name_ar), '[]'::jsonb)
      from c join public.governorates g on g.id::text = c.value
      where c.dimension = 'origin'
    ),
    'destinations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', g.id, 'code', g.code,
        'name', case when p_locale = 'ar' then g.name_ar else coalesce(g.name_en, g.name_ar) end,
        'count', c.n
      ) order by c.n desc, g.name_ar), '[]'::jsonb)
      from c join public.governorates g on g.id::text = c.value
      where c.dimension = 'destination'
    ),
    'genders', (
      select coalesce(jsonb_agg(jsonb_build_object('value', c.value, 'count', c.n) order by c.n desc), '[]'::jsonb)
      from c where c.dimension = 'gender'
    ),
    'bookingModes', (
      select coalesce(jsonb_agg(jsonb_build_object('value', c.value, 'count', c.n) order by c.n desc), '[]'::jsonb)
      from c where c.dimension = 'booking'
    ),
    'direct', jsonb_build_object(
      'direct', coalesce((select c.n from c where c.dimension = 'direct' and c.value = 'true'), 0),
      'withStops', coalesce((select c.n from c where c.dimension = 'direct' and c.value = 'false'), 0)
    )
  );
$$;

comment on function app.search_facets_json(jsonb, text) is
  'The facet JSON both count sources are rendered through — stored counts and the filtered pass.';

-- ---------------------------------------------------------------------------
-- 4. The search itself
-- ---------------------------------------------------------------------------

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
  v_page_key text;
  v_counts_key text;
  v_page jsonb;
  v_counts jsonb;
  v_page_hit boolean := false;
  v_counts_hit boolean := false;
  v_items jsonb;
  v_next text;
  v_total integer;
  v_facets jsonb;
  v_payload jsonb;

  -- Every filter, extracted once, so the predicates below read as `v_x is null or …` rather than branching
  -- per row. NULL means "this dimension is not filtered".
  v_q text;
  v_origin uuid[];
  v_destination uuid[];
  v_gender text[];
  v_booking text[];
  v_direct boolean;
  v_price_max integer;
  v_date_from date;
  v_date_to date;

  -- The two halves of the page query that depend on the sort, chosen together so they cannot disagree: the
  -- ORDER BY column and the «not departed yet» condition, which for `soonest` is written in the units of the
  -- index (the rank column *is* the departure epoch) so the scan starts at now instead of at the oldest
  -- public trip that ever departed.
  v_rank_col text;
  v_window text;
begin
  case v_sort
    when 'cheapest' then
      v_rank_col := 'rank_cheapest';
      v_window := 's.departure_at > now()';
    when 'featured' then
      v_rank_col := 'rank_featured';
      v_window := 's.departure_at > now()';
    else
      v_rank_col := 'rank_soonest';
      v_window := 's.rank_soonest >= extract(epoch from (now() - ''1970-01-01 00:00:00+00''::timestamptz))';
  end case;

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

  -- Two cache rows, not one. The counts do not depend on the sort, the cursor or the page size, so keying
  -- them separately turns "one full scan per sort × page" into "one per filter set": paging to page 4 of a
  -- filtered search costs a page read, not another 39 ms.
  v_page_key := md5(jsonb_build_object(
    'public-page', v_locale, 'filters', p_filters, 'sort', v_sort, 'cursor', p_cursor, 'limit', v_limit
  )::text);
  v_counts_key := md5(jsonb_build_object('public-counts', v_locale, 'filters', p_filters)::text);

  select c.payload into v_page
  from public.search_cache c where c.key = v_page_key and c.expires_at > now();
  v_page_hit := v_page is not null;

  select c.payload into v_counts
  from public.search_cache c where c.key = v_counts_key and c.expires_at > now();
  v_counts_hit := v_counts is not null;

  if not v_counts_hit then
    if v_origin is null and v_destination is null and v_gender is null and v_booking is null
       and v_direct is null and v_price_max is null and v_date_from is null and v_date_to is null
       and v_q is null then
      -- Nothing is filtered, which is the homepage and most of the traffic: the facet counts are the
      -- maintained ones, and the total is the one number worth an index-only scan.
      perform app.ensure_search_counts();

      select
        (select count(*)::int from public.trips_search s where s.is_public and s.departure_at > now()),
        app.search_facets_json((
          select jsonb_agg(jsonb_build_object('dimension', c.dimension, 'value', c.value, 'n', c.count))
          from public.search_counts c
        ), v_locale)
      into v_total, v_facets;
    else
      -- Something is filtered, so "how many are left if I also choose Aden" is about *this* filter set: one
      -- grouping pass, exact, and cached for the next thirty seconds of the same filter set.
      with counts as (
        select *
        from app.search_facet_counts(
          v_origin, v_destination, v_gender, v_booking, v_direct, v_price_max, v_date_from, v_date_to, v_q
        )
      )
      select
        coalesce((select c.n from counts c where c.dimension = 'total'), 0),
        app.search_facets_json((
          select jsonb_agg(jsonb_build_object('dimension', c.dimension, 'value', c.value, 'n', c.n))
          from counts c
        ), v_locale)
      into v_total, v_facets;
    end if;

    v_counts := jsonb_build_object('total', v_total, 'facets', v_facets);
    insert into public.search_cache (key, payload, expires_at)
    values (v_counts_key, v_counts, now() + interval '30 seconds')
    on conflict (key) do update set payload = excluded.payload, expires_at = excluded.expires_at;
  end if;

  if not v_page_hit then
    -- One statement, two placeholders. `%1$I` is the sort's rank column and `%2$s` its «not yet departed»
    -- condition; both come from the same CASE above, and `%I` quotes what it is given, so neither can carry
    -- anything the CASE did not put there.
    execute format($page$
      with page as (
        select s.trip_id, s.%1$I as rank
        from public.trips_search s
        where s.is_public
          and %2$s
          and ($1::text is null
               or (s.%1$I, s.trip_id) > (split_part($1, '|', 1)::numeric, split_part($1, '|', 2)::uuid))
          and ($3::uuid[] is null or s.origin_governorate_id = any ($3::uuid[]))
          and ($4::uuid[] is null or s.destination_governorate_id = any ($4::uuid[]))
          and ($5::text[] is null or s.gender_policy::text = any ($5::text[]))
          and ($6::text[] is null or s.booking_mode::text = any ($6::text[]))
          and ($7::boolean is null or (s.stop_count = 0) = $7::boolean)
          and ($8::int is null or s.price_from_yer <= $8::int)
          and ($9::date is null or s.departure_date >= $9::date)
          and ($10::date is null or s.departure_date <= $10::date)
          and ($11::text is null or s.search_text like '%%' || lower($11::text) || '%%')
        order by s.%1$I, s.trip_id
        limit $2
      )
      select
        (
          select coalesce(jsonb_agg(x.item order by x.rank, x.trip_id), '[]'::jsonb)
          from (
            select p.rank, p.trip_id, jsonb_build_object(
              'id', p.trip_id,
              'code', t.code,
              'departureAt', d.departure_at,
              'departureDate', d.departure_date,
              'seatsAvailable', d.seats_available,
              'seatsTotal', d.seats_total,
              'priceFromYer', d.price_from_yer,
              'currency', 'YER',
              'stopCount', d.stop_count,
              'bookingMode', d.booking_mode,
              'pricingMode', d.pricing_mode,
              'discountKind', d.discount_kind,
              'discountValue', d.discount_value,
              'genderPolicy', d.gender_policy,
              'isFeatured', d.is_featured,
              'operatorName', case when $12 = 'ar' then d.operator_name_ar else d.operator_name_en end,
              'vehicleLabel', d.vehicle_label,
              'origin', jsonb_build_object(
                'id', d.origin_governorate_id,
                'code', og.code,
                'name', case when $12 = 'ar' then og.name_ar else coalesce(og.name_en, og.name_ar) end
              ),
              'destination', jsonb_build_object(
                'id', d.destination_governorate_id,
                'code', dg.code,
                'name', case when $12 = 'ar' then dg.name_ar else coalesce(dg.name_en, dg.name_ar) end
              )
            ) as item
            from page p
            join public.trips_search d on d.trip_id = p.trip_id
            join public.trips t on t.id = p.trip_id
            join public.governorates og on og.id = d.origin_governorate_id
            join public.governorates dg on dg.id = d.destination_governorate_id
          ) x
        ),
        (
          select p.rank::text || '|' || p.trip_id::text
          from page p order by p.rank desc, p.trip_id desc limit 1
        )
    $page$, v_rank_col, v_window)
    into v_items, v_next
    using p_cursor, v_limit, v_origin, v_destination, v_gender, v_booking, v_direct,
          v_price_max, v_date_from, v_date_to, v_q, v_locale;

    v_page := jsonb_build_object('items', coalesce(v_items, '[]'::jsonb), 'next', v_next);
    insert into public.search_cache (key, payload, expires_at)
    values (v_page_key, v_page, now() + interval '30 seconds')
    on conflict (key) do update set payload = excluded.payload, expires_at = excluded.expires_at;
  end if;

  v_payload := jsonb_build_object(
    'items', coalesce(v_page -> 'items', '[]'::jsonb),
    'total', (v_counts ->> 'total')::int,
    'facets', v_counts -> 'facets',
    'nextCursor', case
      when (v_counts ->> 'total')::int > v_limit then v_page ->> 'next'
      else null
    end,
    'sort', v_sort,
    'cached', v_page_hit and v_counts_hit
  );

  return v_payload;
end;
$$;

comment on function public.search_public_trips(text, jsonb, text, text, integer) is
  'Public marketplace search. The page is an index scan over a generated rank column; the counts are one '
  'grouping pass per filter set (maintained in search_counts when nothing is filtered), cached separately '
  'from the page so sort and cursor changes do not recompute them.';

commit;
