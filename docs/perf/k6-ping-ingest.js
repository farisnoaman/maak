// k6 — location ping ingest: 5,000 pings an hour, with the spikes that come with a fleet starting at dawn.
//
//   k6 run docs/perf/k6-ping-ingest.js -e BASE_URL=... -e ANON_KEY=... -e TOKEN=... -e TRIP_ID=...
//
// 5,000/hour is 1.4/s average — a rate any database absorbs without noticing. The interesting number is the
// spike: a hundred vehicles crossing a checkpoint region at once, each sending a ping every twenty seconds.
// The plan's load line is 5k pings/hour, so this runs an average of ~3/s for ten minutes and then a 30 s burst
// at ten times that, which is what the partition and the batch write were designed for.
//
// The table is partitioned by month (`00023_trip_tracking.sql`), and every partition carries its own RLS and
// grants (`00035_partition_rls.sql`) — a ping written to a partition created after the fact is the failure
// mode this exercises: it fails closed if the factory forgot to re-apply the policy.

import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = __ENV.ANON_KEY || 'maak-dev-anon-key';
const TRIP_ID = __ENV.TRIP_ID;

const pingLatency = new Trend('ping_ingest_ms', true);

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: 3,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 20,
      maxVUs: 80,
    },
    dawn_burst: {
      executor: 'ramping-arrival-rate',
      startTime: '10m',
      startRate: 3,
      timeUnit: '1s',
      stages: [
        { duration: '10s', target: 30 },
        { duration: '30s', target: 30 },
        { duration: '10s', target: 0 },
      ],
      preAllocatedVUs: 60,
      maxVUs: 200,
    },
  },
  thresholds: {
    // Pings are small writes with a partition-local insert; anything near the trip write budget means the
    // partition pruning or the index is wrong.
    ping_ingest_ms: ['p(95)<400'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  // A path near Aden's coastline, jittered: consecutive pings must remain plausible, because the ingest
  // rejects a jump it cannot explain and a rejected ping would silently lower the measured rate.
  const lat = 12.7855 + Math.random() * 0.02;
  const lng = 45.0187 + Math.random() * 0.02;

  const response = http.post(
    `${BASE_URL}/functions/v1/trips`,
    JSON.stringify({
      action: 'trip.recordPing',
      tripId: TRIP_ID,
      lat,
      lng,
      accuracyM: 8,
      speedKmh: 55,
      source: 'gps',
    }),
    {
      headers: {
        'content-type': 'application/json',
        apikey: ANON_KEY,
        authorization: `Bearer ${__ENV.TOKEN}`,
      },
      tags: { name: 'record_ping' },
    },
  );

  pingLatency.add(response.timings.duration);

  check(response, {
    'ping accepted': (r) => r.status === 200,
  });
}
