# Performance

Three tools, three questions. They are separate because they fail for different reasons, and because one of
them can run in a sandbox with no Docker and no k6 — which is the one that finds regressions.

| Tool | Question | Runs in CI | Needs |
| --- | --- | --- | --- |
| `npm run perf:smoke` | Is a single request slow? | yes | the dev stack (`npm run dev:api`) |
| `npm run perf:db` | How much of a core does one request cost, and what happens with N callers? | no | the dev stack + a seed |
| `k6 run docs/perf/*.js` | Does it hold at 500 concurrent users through a real PostgREST? | no | k6, a seeded staging environment |

The acceptance numbers, from `IMPLEMENTATION_PLAN.md` (Phase 9 and Phase 12): **search p95 < 300 ms**, **write
RPC p95 < 250 ms**, **finance dashboard p95 < 500 ms**, at 50,000+ trips with 200 live.

## Running it

```bash
npm run dev:api                       # a dev database and API on :54321
npm run perf:seed -- --trips 50000    # clone a published trip 50,000 times (8 seconds)
npm run perf:smoke                    # cold and cached search, a write, the finance dashboard
npm run perf:db -- --concurrency 1,4,8
npm run perf:seed -- --reset          # put the database back
```

`perf:seed` refuses to run against anything but `127.0.0.1`. Fifty thousand fabricated trips in production is
not a benchmark.

k6 suites (they need a deployed environment, and they exit non-zero on a missed threshold):

```bash
k6 run docs/perf/k6-search.js           -e BASE_URL=... -e ANON_KEY=...
k6 run docs/perf/k6-booking-race.js     -e BASE_URL=... -e TRIP_ID=... -e TOKENS=...
k6 run docs/perf/k6-ping-ingest.js      -e BASE_URL=... -e TRIP_ID=... -e TOKEN=...
k6 run docs/perf/k6-finance-dashboard.js -e BASE_URL=... -e ORG_ID=... -e TOKEN=...
```

## What was found

Search was the problem, and it had never been measured: **p95 15.7 s at 50,000 trips**, against a 300 ms
target. `search_public_trips` called `app.trip_matches()` once per row *per facet* — five passes over
`trips_search`, each rebuilding four text arrays out of the filter JSON for every row. At three trips it was
4 ms; the plan's Phase 9 line saying "k6 benchmark not written or run" was the whole reason nobody knew.

`00036_search_performance.sql` evaluates each filter dimension once per row in a materialised projection and
answers the page, the total and all five facet groupings from it, and the sort key gained a scalar overload
that PostgreSQL can inline (the row-shaped one could not be, and cost 226 ms on its own). 0007 asserts the
fast path and `app.trip_matches()` return the same totals and facets, so the rewrite is allowed to be faster
and nothing else.

Measured on this sandbox (2 cores, dev PostgreSQL, 49,998 published trips, `docs/perf/*.json`):

| at 49,998 trips | before 00036 | after 00036 | after 00038 |
| --- | --- | --- | --- |
| search, cache miss (mixed filters, `perf:smoke`) | 15,690 ms p95 | 112 ms p95 | **5.6 ms p95** |
| search, cache hit (30 s TTL) | — | 3 ms p95 | 2.7 ms p95 |
| write (`search.save`) | 4 ms p95 | 5 ms p95 | 4.2 ms p95 |
| finance dashboard | — | 79 ms p95 | 83.5 ms p95 |

`00038_search_counts.sql` then removed the two costs that were *proportional* rather than making them cheaper.
The facets are one grouping pass over `(origin, destination, gender, booking, direct)` buckets — ~30 rows at
this volume — with the six cascading summaries taken over the buckets instead of the trips; the unfiltered
answer is stored in `search_counts` and refreshed by whichever request notices it is more than thirty seconds
old. The page stopped being sorted at all: `trips_search` carries three generated rank columns, one per sort,
each with a partial index ending in `trip_id`, so `ORDER BY … LIMIT 12` is an index scan that stops after
twelve rows and the keyset cursor is an index condition. Both implementations are still in the repository's
hands: 0007 asserts the generated keys equal `app.trip_rank()` to the digit, the bucketed counts equal
`app.trip_matches()`, and the stored counts equal the counting function.

The whole function, one request at a time, cache cleared between calls — `00036` and `00038` measured back to
back on the same database, with the facets compared for equality on every shape:

| cold search (`search_public_trips`, 12 rows) | 00036 | 00038 | facets identical |
| --- | --- | --- | --- |
| unfiltered — the homepage, most of the traffic | 161.6 ms | **12.9 ms** | yes |
| a cap that matches almost nothing (`priceMax: 1234`) | 112.6 ms | **3.0 ms** | yes |
| a cap that matches everything (`priceMax: 9000000`) | 159.7 ms | 42.0 ms | yes |
| `direct: true` | 155.1 ms | 41.6 ms | yes |

The last two rows are the honest remainder, and they are the point of the design rather than a miss: a
*filtered* search cannot be answered by an aggregate that was computed for every filter, so its counts are
still one pass over the public trips (35 ms of that 42 ms). What changed is that the pass happens once per
filter set per thirty seconds — the counts are cached apart from the page, keyed on the filters alone — and
that the page costs nothing. Selective filters, which are the ones users actually combine, are answered by an
index on `price_from_yer` and cost 3 ms.

## What is still true

**Cold search is no longer uniformly expensive, and the difference matters for capacity.** The homepage and a
selective filter are now 3–13 ms; an unselective filter is 42 ms, so the worst case is **~23 cold searches per
second per core** instead of ~7, and `perf:db` measures 8 concurrent callers at p95 195 ms instead of 712 ms.
The 30 s cache still does the heavy lifting under real traffic, and a hit costs 2.7 ms. The honest sentence is
now "13 ms for the homepage, 42 ms for a filter the aggregate cannot answer, 2.7 ms cached".

**The facet counts for an unfiltered search are up to thirty seconds old, on purpose.** The chips next to the
filter panel read `search_counts`; the number of results does not — the total is an exact `count(*)` on an
index-only scan (7 ms at 50,000), because a user paginates against it. A trip published in the last half-minute
is therefore in the list and in the count but not yet in the chips. That is the deliberate trade for not
scanning 17 MB to draw a dropdown, it is decided in one place (`app.ensure_search_counts()`), and 0007 pins it.

**`count(*)` is the last thing that is linear in public trips**, and it is the cheapest linear thing available:
an index-only scan of a partial index. At a million trips it would be ~100 ms, which is the next ceiling and
the next migration's problem; nothing else in the read path grows with the catalogue.

Anything further, in order of value:

1. a longer counts cache or warming for the top filter combinations, which trades freshness for the 42 ms
   unselective-filter case — note that a maintained cube cannot answer arbitrary filters, so this is a cache
   question and not an aggregate one;
2. partial indexes per dimension (origin, destination, gender, booking), so a filtered search reads thousands
   of rows instead of all of them — `trips_search_price_idx` is what makes `priceMax` cost 3 ms already;
3. the same treatment for `total` if a million trips ever arrives.

**The dev gateway serialises.** `scripts/dev-backend` runs every query through one PostgreSQL connection behind
a mutex, so N concurrent HTTP requests queue: 8 × 42 ms becomes 336 ms of wall clock however fast the query is.
That is why `perf:smoke`'s gated series is serial and `perf:smoke --queue 8` reports gateway throughput rather
than latency, and why `perf:db` talks to PostgreSQL directly.

**The seed does not reproduce contention.** It creates trips, not bookings, payments or pings. Booking races,
payment confirmation volume and ping ingest are the k6 suites' job, and they have not been run against a
production-sized environment — there is no such environment yet.
