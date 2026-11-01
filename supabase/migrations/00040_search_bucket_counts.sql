-- 00040_search_bucket_counts.sql — a filtered marketplace search stops scanning 50,000 rows for its chips.
--
-- `00038` removed two of the four proportional costs of a cold search and wrote down the remainder honestly: a
-- *filtered* search still paid **35 ms** for `app.search_facet_counts()`, because "how many are left if I also
-- choose Aden" was answered by grouping every public trip into buckets. The homepage escaped that (its answer
-- is stored), but `direct: true` and every dimension-filtered page did not: 41.6 ms measured, ~23 cold searches
-- per second per core.
--
-- The observation this migration acts on is that the *dimension* filters — origin, destination, gender, booking
-- mode, direct — are not arbitrary predicates: they are the axes of the bucket tuple. A count filtered on some
-- of them is a sum over the buckets that the rest admit. So:
--
--   1. the buckets become a table (`public.search_buckets`, ~30 rows at this volume, 8,700 at the ceiling),
--      rebuilt by the same refresher as the stored homepage counts, from the same single pass — the refresh now
--      costs one scan where it used to cost one, and the stored counts are derived from the buckets instead of
--      counted a second time;
--   2. a search filtered **only** on those dimensions answers from the buckets: ~0.3 ms of arithmetic instead of
--      a 35 ms pass, with the total still taken from the partial index so the number the user paginates against
--      is exact;
--   3. a search filtered on price, dates or text still takes the one grouping pass, because no aggregate can
--      answer "under 5,000 riyals" — that 35 ms is now the documented remainder rather than the common case.
--
-- Staleness is bounded and named: the chips of a dimension-filtered search are at most `ensure_search_counts`'s
-- thirty seconds old, exactly like the homepage's, and never older than that on a request that noticed. The
-- total is never taken from them. Both facts are asserted in `0007_trips.test.sql`, which compares the bucket
-- arithmetic with the row arithmetic for a matrix of filters and with `app.trip_matches()`, the readable
-- definition of what a filter means.
--
-- Deploying: one table, one index-free refresh, and two functions replaced. The buckets are built on first use,
-- so there is nothing to backfill.

begin;

-- ---------------------------------------------------------------------------
-- 1. The buckets become the one place counts are made
-- ---------------------------------------------------------------------------

/**
 * The public marketplace, grouped by the tuple every facet is a projection of.
 *
 * ~30 rows at launch volume and hard-capped by geography at 22 × 22 × 3 × 3 × 2 ≈ 8,700, which is why summing
 * this is arithmetic and summing `trips_search` is a scan. `refreshed_at` matches `search_counts`'s: one
 * refresher rebuilds both, so the chips of any search in one request family share an age.
 */
create table public.search_buckets (
  origin_governorate_id       uuid not null,
  destination_governorate_id  uuid not null,
  gender_policy               text not null,
  booking_mode                text not null,
  direct                      boolean not null,
  trips                       integer not null check (trips > 0),
  refreshed_at                timestamptz not null default now(),
  primary key (origin_governorate_id, destination_governorate_id, gender_policy, booking_mode, direct)
);

comment on table public.search_buckets is
  'Public future trips grouped by (origin, destination, gender, booking, direct) — the tuple the facet counts '
  'are projections of. Rebuilt by app.refresh_search_counts() with the stored homepage counts; at most thirty '
  'seconds old, and never used for a result total.';

-- No policy and no grant, for the reason `search_counts` has none: only SECURITY DEFINER functions read it, and
-- a browser role that could would get a table of numbers the API already gives it.
alter table public.search_buckets enable row level security;

/**
 * Every cascading facet count, by summing the buckets instead of scanning the trips.
 *
 * The guards are the same as `app.search_facet_counts()`'s and the unions are in the same order: a facet counts
 * what would be left if you *also* picked a value, so each dimension's summary applies every filter except its
 * own. `0007` asserts the two functions agree bucket for bucket.
 */
create or replace function app.search_facet_counts_from_buckets(
  p_origin uuid[] default null,
  p_destination uuid[] default null,
  p_gender text[] default null,
  p_booking text[] default null,
  p_direct boolean default null
)
returns table (dimension text, value text, n integer)
language sql
stable
set search_path = ''
as $$
  with buckets as (
    select
      b.origin_governorate_id as o,
      b.destination_governorate_id as d,
      b.gender_policy as g,
      b.booking_mode as bm,
      b.direct as dir,
      b.trips,
      (p_origin is null or b.origin_governorate_id = any (p_origin)) as ok_o,
      (p_destination is null or b.destination_governorate_id = any (p_destination)) as ok_d,
      (p_gender is null or b.gender_policy = any (p_gender)) as ok_g,
      (p_booking is null or b.booking_mode = any (p_booking)) as ok_bm,
      (p_direct is null or b.direct = p_direct) as ok_direct
    from public.search_buckets b
  )
  select 'total'::text, ''::text, coalesce(sum(b.trips), 0)::int
  from buckets b
  where b.ok_o and b.ok_d and b.ok_g and b.ok_bm and b.ok_direct
  union all
  select 'origin', b.o::text, sum(b.trips)::int
  from buckets b
  where b.ok_d and b.ok_g and b.ok_bm and b.ok_direct
  group by b.o
  union all
  select 'destination', b.d::text, sum(b.trips)::int
  from buckets b
  where b.ok_o and b.ok_g and b.ok_bm and b.ok_direct
  group by b.d
  union all
  select 'gender', b.g, sum(b.trips)::int
  from buckets b
  where b.ok_o and b.ok_d and b.ok_bm and b.ok_direct
  group by b.g
  union all
  select 'booking', b.bm, sum(b.trips)::int
  from buckets b
  where b.ok_o and b.ok_d and b.ok_g and b.ok_direct
  group by b.bm
  union all
  select 'direct', b.dir::text, sum(b.trips)::int
  from buckets b
  where b.ok_o and b.ok_d and b.ok_g and b.ok_bm
  group by b.dir;
$$;

comment on function app.search_facet_counts_from_buckets(uuid[], uuid[], text[], text[], boolean) is
  'The facet counts of a dimension-only filter, by arithmetic over search_buckets: the cascading rule is a sum '
  'over the buckets whose tuple passes every other dimension. Equal to app.search_facet_counts() for the '
  'dimension-only case, asserted in 0007.';

/**
 * The covering index the dimension-filtered *total* is counted from.
 *
 * The chips are arithmetic over the buckets now, but the total stays exact — it is the number the user reads as
 * a promise and paginates against — so a `count(*)` over the dimension filters is on the request path. Without
 * this index that count is a seq scan of 50,000 wide rows (15–21 ms, and the widest cost left); with it, an
 * index-only scan of the same 50,000 tuples: 4 ms unfiltered, 6 ms for `direct`, 12 ms for the pathological
 * case (a gender value that matches all but one trip, where the filter is evaluated 50,000 times and the cast
 * dominates). `departure_at` is last so the «not yet departed» condition is evaluated on the index tuple too.
 */
create index trips_search_facets_idx
  on public.trips_search (
    origin_governorate_id,
    destination_governorate_id,
    gender_policy,
    booking_mode,
    stop_count,
    departure_at
  )
  where is_public;

/**
 * Rebuilds `public.search_buckets` in one pass over the public trips.
 *
 * Delete-then-insert, both in the caller's transaction, so a concurrent reader keeps the old buckets until the
 * new ones commit and never sees a half-summed marketplace.
 */
create or replace function app.refresh_search_buckets()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  delete from public.search_buckets;

  insert into public.search_buckets (
    origin_governorate_id, destination_governorate_id, gender_policy, booking_mode, direct, trips, refreshed_at
  )
  select
    s.origin_governorate_id,
    s.destination_governorate_id,
    s.gender_policy::text,
    s.booking_mode::text,
    (s.stop_count = 0),
    count(*)::int,
    now()
  from public.trips_search s
  where s.is_public
    and s.departure_at > now()
  group by 1, 2, 3, 4, 5;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function app.refresh_search_buckets() is
  'Rebuilds public.search_buckets from the public future trips in one grouping pass.';

/**
 * Rebuilds the stored homepage counts — from the buckets, not from a second scan.
 *
 * `00038` counted the trips once for the buckets inside `search_facet_counts()` and then counted them again to
 * fill this table. The two answers were the same query asked twice; now the buckets are materialised, the
 * stored counts are their projections, and a refresh costs one pass instead of two.
 */
create or replace function app.refresh_search_counts()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  perform app.refresh_search_buckets();

  delete from public.search_counts;

  insert into public.search_counts (dimension, value, count, refreshed_at)
  select c.dimension, c.value, c.n, now()
  from app.search_facet_counts_from_buckets() c
  where c.dimension <> 'total';

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function app.refresh_search_counts() is
  'Rebuilds public.search_buckets and then public.search_counts from them: the homepage chips are the '
  'projections of the same buckets a filtered search sums.';

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

  -- The same two dimensions as *enums*, built once from the text filters. `trips_search.gender_policy` is an
  -- enum, so `gender_policy::text = any(...)` casts 50,000 times per count (12.3 ms) where `gender_policy =
  -- any(enum[])` compares enum to enum (5.5 ms). The cast is done on the *parameter* instead, and a value the
  -- enum does not have simply does not survive it — an empty array, which matches nothing, rather than an
  -- error a crafted filter could use to turn a search into a 500.
  v_gender_enum public.trip_gender_policy[];
  v_booking_enum public.trip_booking_mode[];
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
      v_gender_enum := array(
        select g::public.trip_gender_policy
        from unnest(v_gender) g
        where g = any (enum_range(null::public.trip_gender_policy)::text[])
      );
    end if;
    if jsonb_typeof(p_filters -> 'booking') = 'array' and jsonb_array_length(p_filters -> 'booking') > 0 then
      v_booking := array(select value from jsonb_array_elements_text(p_filters -> 'booking') as value);
      v_booking_enum := array(
        select b::public.trip_booking_mode
        from unnest(v_booking) b
        where b = any (enum_range(null::public.trip_booking_mode)::text[])
      );
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
    elsif v_price_max is null and v_date_from is null and v_date_to is null and v_q is null then
      -- Only the dimensions are filtered, and those are exactly the buckets the homepage is built from:
      -- "how many are left if I also choose Aden" is arithmetic over ~30 rows rather than a 35 ms pass over
      -- 50,000 trips. The chips may be up to thirty seconds old, like the homepage's — the *total* is not: it
      -- is this filter set's own count from the partial index, because it is the number the user paginates
      -- against.
      perform app.ensure_search_counts();

      with counts as (
        select *
        from app.search_facet_counts_from_buckets(
          v_origin, v_destination, v_gender, v_booking, v_direct
        )
      )
      select
        (
          select count(*)::int
          from public.trips_search s
          where s.is_public
            and s.departure_at > now()
            and (v_origin is null or s.origin_governorate_id = any (v_origin))
            and (v_destination is null or s.destination_governorate_id = any (v_destination))
            and (v_gender_enum is null or s.gender_policy = any (v_gender_enum))
            and (v_booking_enum is null or s.booking_mode = any (v_booking_enum))
            and (v_direct is null or (s.stop_count = 0) = v_direct)
        ),
        app.search_facets_json((
          select jsonb_agg(jsonb_build_object('dimension', c.dimension, 'value', c.value, 'n', c.n))
          from counts c
          where c.dimension <> 'total'
        ), v_locale)
      into v_total, v_facets;
    else
      -- A price, a date or a text query is filtered, and no aggregate can answer those: one grouping pass,
      -- exact, cached for the next thirty seconds of the same filter set.
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
  'Public marketplace search. The page is an index scan over a generated rank column; the chips are arithmetic '
  'over search_buckets when only dimensions are filtered, one grouping pass when a price, date or text filter '
  'needs it, and the stored counts when nothing is; the total is always this filter set''s own count. Cached '
  'separately from the page so sort and cursor changes do not recompute it.';

commit;
