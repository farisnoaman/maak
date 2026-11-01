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

| at 49,998 trips | before 00036 | after 00036 |
| --- | --- | --- |
| search, cache miss | 15,690 ms p95 | **112 ms p95** |
| search, cache hit (30 s TTL) | — | 3 ms p95 |
| write (`search.save`) | 4 ms p95 | 5 ms p95 |
| finance dashboard | — | 79 ms p95 |

The write and the dashboard did not change; they are there because they are the other two targets, and because
the dashboard's 79 ms at 50,000 trips is a different number from the 10 ms it shows on the three-trip demo
database — the same query over sixteen thousand times the data.

## What is still true

**Cold search is CPU-bound at ~100–145 ms per request.** The scan and the cascading facets are O(public trips);
the 30 s `search_cache` is what keeps a real marketplace fast, and a hit costs 3 ms. The consequence is a
capacity number rather than a latency one: about **7 cold searches/second/core** on this data set. On two cores,
4 concurrent cold searches already sit at p95 ≈ 316 ms (`docs/perf/db-50k.txt`), so the 300 ms target under the
plan's stated load is met on paper only by a box with more cores — and the honest statement is "100 ms per cold
search, 3 ms cached", not "under 300 ms at 500 users".

The follow-up that would change it, in order of value:

1. a maintained facet aggregate (counts by origin/destination/gender/booking for live public trips, refreshed by
   the maintenance scan) so the unfiltered homepage — the majority of traffic — never scans 50,000 rows;
2. a longer TTL, or cache warming for the top filter combinations, which trades freshness for hit rate;
3. partial indexes per dimension, so a filtered search reads thousands of rows instead of all of them.

**The dev gateway serialises.** `scripts/dev-backend` runs every query through one PostgreSQL connection behind
a mutex, so N concurrent HTTP requests queue: 8 × 105 ms becomes 844 ms of wall clock however fast the query is.
That is why `perf:smoke`'s gated series is serial and `perf:smoke --queue 8` reports gateway throughput rather
than latency, and why `perf:db` talks to PostgreSQL directly.

**The seed does not reproduce contention.** It creates trips, not bookings, payments or pings. Booking races,
payment confirmation volume and ping ingest are the k6 suites' job, and they have not been run against a
production-sized environment — there is no such environment yet.
