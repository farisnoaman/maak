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

| at 49,998 trips | before 00036 | after 00036 | after 00038 | after 00040 |
| --- | --- | --- | --- | --- |
| search, cache miss (mixed filters, `perf:smoke`) | 15,690 ms p95 | 112 ms p95 | 5.6 ms p95 | **6.0 ms p95** |
| search, cache hit (30 s TTL) | — | 3 ms p95 | 2.7 ms p95 | 2.8 ms p95 |
| write (`search.save`) | 4 ms p95 | 5 ms p95 | 4.2 ms p95 | 10.2 ms p95 |
| finance dashboard | — | 79 ms p95 | 83.5 ms p95 | 88.3 ms p95 |

The last two rows moved and nothing in `00040` touches them: the write and the dashboard are the same code on a
busier sandbox, and this file records what the harness printed rather than what the change intended.

`00038_search_counts.sql` then removed the two costs that were *proportional* rather than making them cheaper.
The facets are one grouping pass over `(origin, destination, gender, booking, direct)` buckets — ~30 rows at
this volume — with the six cascading summaries taken over the buckets instead of the trips; the unfiltered
answer is stored in `search_counts` and refreshed by whichever request notices it is more than thirty seconds
old. The page stopped being sorted at all: `trips_search` carries three generated rank columns, one per sort,
each with a partial index ending in `trip_id`, so `ORDER BY … LIMIT 12` is an index scan that stops after
twelve rows and the keyset cursor is an index condition.

`00040_search_bucket_counts.sql` finished the job the buckets started. The observation is that the *dimension*
filters are the axes of the bucket tuple, so a count filtered on some of them is a sum over the buckets the rest
admit: the buckets became a table (`search_buckets`), the stored homepage counts became their projections
instead of a second scan, and a search filtered only on origin/destination/gender/booking/direct is now
arithmetic over ~30 rows. The exact total is counted from a covering partial index
(`trips_search_facets_idx`), and the enum dimensions are compared as enums — `gender_policy::text = any(…)`
casts 50,000 times and costs 12 ms where `gender_policy = any(enum[])` costs 6.

Measured one request at a time on the same 49,998-trip database, cache cleared between calls:

| cold search (`search_public_trips`, 12 rows) | 00038 | 00040 |
| --- | --- | --- |
| unfiltered — the homepage, most of the traffic | 12.9 ms | **6.1 ms** |
| `direct: true` | 41.6 ms | **7.7 ms** |
| a selective origin | ~35 ms + page | **2.7 ms** |
| `destination` + `booking` | ~35 ms + page | **3.1 ms** |
| `gender: ["any"]` — matches all but one trip, the pathological case | ~42 ms | **8.6 ms** |
| `priceMax: 9000000` — a filter no aggregate can answer | 42.0 ms | **37 ms** |

The `~35 ms` rows are the counts pass those shapes used to pay (`app.search_facet_counts()`, measured 33–35 ms
on this database); the last row is that pass unchanged, and it is the honest remainder. Selective filters,
which are the ones users actually combine, are answered by an index on `price_from_yer` and cost 3 ms.

## What is still true

**The remaining linear cost is a price, date or text filter — and the exact total.** A dimension-filtered search
is 3–9 ms (a selective subset 2.7 ms, `direct` 7.7 ms, the pathological "matches everything" 8.6 ms) and the
homepage is 6.1 ms, so the working number is **~115 cold searches per second per core in the worst dimension
case** and 160+ for the homepage; before 00040 the same shapes cost 42 ms and ~23/s. A price cap that matches
everything still costs 37 ms because no aggregate computed for every filter can answer "under 5,000 riyals", and
that pass is cached for thirty seconds per filter set. `perf:db` now measures both series: at 8 callers the cold
price-cap search is p95 256 ms and the dimension series p95 37 ms.

**The facet counts for a dimension-filtered search are up to thirty seconds old, on purpose.** The chips read
`search_buckets` (or `search_counts` for the homepage); the number of results does not — the total is an exact
`count(*)` on an index-only scan (4–9 ms at 50,000), because a user paginates against it. A trip published in
the last half-minute is therefore in the list and in the count but not yet in the chips. That is the deliberate
trade for not scanning 17 MB to draw a dropdown, it is decided in one place (`app.ensure_search_counts()`), and
0007 pins it: bucket arithmetic must equal row arithmetic for a matrix of dimension filters, the buckets must
sum to the public trips, and a dimension-filtered search's facet must equal `app.trip_matches()`'s grouping.

**`count(*)` is the last thing that is linear in public trips**, and it is the cheapest linear thing available:
an index-only scan of a partial index, 4 ms unfiltered and 6–12 ms with a dimension filter. At a million trips
it would be ~80 ms, which is the next ceiling and the next migration's problem; nothing else in the read path
grows with the catalogue.

Anything further, in order of value:

1. a bucket table keyed on the *price bands* as well, which would let "under 5,000 riyals" be arithmetic too —
   the bands have to be chosen against the real price distribution, and each band is another axis of the tuple;
2. a longer counts cache or warming for the top filter combinations, which trades freshness for the 37 ms
   row-path case — a maintained cube cannot answer arbitrary filters, so this is a cache question, not an
   aggregate one;
3. the same treatment for `total` if a million trips ever arrives.

**The dev gateway serialises.** `scripts/dev-backend` runs every query through one PostgreSQL connection behind
a mutex, so N concurrent HTTP requests queue: 8 × 42 ms becomes 336 ms of wall clock however fast the query is.
That is why `perf:smoke`'s gated series is serial and `perf:smoke --queue 8` reports gateway throughput rather
than latency, and why `perf:db` talks to PostgreSQL directly.

**The seed does not reproduce contention.** It creates trips, not bookings, payments or pings. Booking races,
payment confirmation volume and ping ingest are the k6 suites' job, and they have not been run against a
production-sized environment — there is no such environment yet.
