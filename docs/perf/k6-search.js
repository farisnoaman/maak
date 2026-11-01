// k6 — the marketplace under load, at the volume the launch plan assumes.
//
//   k6 run docs/perf/k6-search.js \
//     -e BASE_URL=https://staging.maak.example \
//     -e ANON_KEY=... \
//     --summary-export docs/perf/k6-search.json
//
// The thresholds are the acceptance criteria (IMPLEMENTATION_PLAN.md Phase 9 and Phase 12), not suggestions:
// k6 exits non-zero when they are missed, so this is a gate on hardware that can actually hold the load.
//
// What this measures that `npm run perf:smoke` cannot: concurrency, a warm HTTP path, a real PostgREST and a
// real connection pooler. What it needs to be meaningful: at least 50,000 seeded trips and 200 departing in the
// next two days, or you are timing an empty table.
//
// Every iteration uses a different filter combination on purpose. Repeating one filter would warm the 30 s
// `search_cache` and turn the benchmark into a measure of the cache — the same trap `scripts/perf-db.mjs`
// documents, hit and fixed.

import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = __ENV.ANON_KEY || 'maak-dev-anon-key';

const coldSearch = new Trend('search_cold_ms', true);

export const options = {
  scenarios: {
    // 500 virtual users is the stated load. The ramp gives the p95 a chance to settle instead of measuring
    // the first thirty seconds of a cold JIT and a cold cache.
    browsing: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 100 },
        { duration: '2m', target: 500 },
        { duration: '3m', target: 500 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    // Both, because they fail differently: `search_cold_ms` says the query is slow, `http_req_failed` says
    // something upstream of the query is.
    search_cold_ms: ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
    http_reqs: ['rate>20'],
  },
};

/** A filter nobody has searched for yet: a fresh price band, sometimes a route or a text query. */
function filters() {
  const priceMax = 500 + Math.floor(Math.random() * 90_000);
  const shapes = [
    { priceMax },
    { priceMax, direct: true },
    { priceMax, gender: ['any'] },
    { q: ['صنعاء', 'عدن', 'تعز', 'المكلا'][Math.floor(Math.random() * 4)] },
    {},
  ];
  return shapes[Math.floor(Math.random() * shapes.length)];
}

export default function () {
  const response = http.post(
    `${BASE_URL}/rest/v1/rpc/search_public_trips`,
    JSON.stringify({
      p_locale: Math.random() > 0.5 ? 'ar' : 'en',
      p_filters: JSON.stringify(filters()),
      p_sort: ['soonest', 'cheapest', 'featured'][Math.floor(Math.random() * 3)],
      p_cursor: null,
      p_limit: 12,
    }),
    {
      headers: { 'content-type': 'application/json', apikey: ANON_KEY },
      tags: { name: 'search_public_trips' },
    },
  );

  coldSearch.add(response.timings.duration);

  check(response, {
    'search returns 200': (r) => r.status === 200,
    'search returns items': (r) => {
      if (r.status !== 200) return false;
      const body = r.json();
      return Array.isArray(body?.items) && Array.isArray(body?.facets?.origins);
    },
  });
}
