// k6 — the booking race: many passengers, one seat.
//
//   k6 run docs/perf/k6-booking-race.js -e BASE_URL=... -e ANON_KEY=... -e TOKEN=...
//
// This is not a latency benchmark. It is a correctness benchmark that happens to be under load: twenty
// passengers press "book" on a trip with one seat left, and exactly one must succeed. A system that is fast
// and oversells is worse than one that is slow and correct, so the threshold here is on *outcomes*, and the
// p95 is a secondary report.
//
// What must hold, and why each failure mode is different:
//   · exactly one 200 — the seat is claimed once. Two successes mean the lock is in the application, not the
//     database.
//   · nineteen 409s (`BOOKING_SEAT_TAKEN` / `TRIP_FULL`) — the others were told the truth, quickly. A 500 is a
//     crash, and a 200 is an oversale.
//   · no 5xx at all — a deadlock that surfaces as 500 under contention is the bug this test exists to find.
//
// Setup: a trip with one seat free, every passenger holding their own access token in `TOKENS` (comma
// separated). `scripts/perf-seed.mjs` can create the trips; tokens come from your fixture of choice.

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = __ENV.ANON_KEY || 'maak-dev-anon-key';
const TOKENS = (__ENV.TOKENS || '').split(',').filter(Boolean);

const accepted = new Counter('booking_accepted');
const refused = new Counter('booking_refused');
const broken = new Counter('booking_broken');

export const options = {
  scenarios: {
    race: {
      executor: 'per-vu-iterations',
      vus: Math.max(1, TOKENS.length || 20),
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    // One seat, one booking. Expressed as a rate over the whole run so a flake cannot hide in an average.
    booking_accepted: ['count==1'],
    booking_broken: ['count==0'],
    'http_req_duration{name:booking_create}': ['p(95)<2000'],
  },
};

export default function () {
  const token = TOKENS[(__VU - 1) % Math.max(1, TOKENS.length)];
  const tripId = __ENV.TRIP_ID;
  if (!tripId) throw new Error('TRIP_ID is required: the one-seat trip this race is about');

  const response = http.post(
    `${BASE_URL}/functions/v1/bookings`,
    JSON.stringify({
      action: 'booking.create',
      tripId,
      seats: 1,
      contactName: `متبارٍ ${__VU}`,
      contactPhone: `77000${String(1000 + __VU).slice(-4)}`,
      gender: __VU % 2 === 0 ? 'female' : 'male',
      note: null,
    }),
    {
      headers: {
        'content-type': 'application/json',
        apikey: ANON_KEY,
        authorization: `Bearer ${token}`,
      },
      tags: { name: 'booking_create' },
    },
  );

  if (response.status === 200) accepted.add(1);
  else if (response.status >= 400 && response.status < 500) refused.add(1);
  else broken.add(1);

  check(response, {
    'the seat is claimed once or refused honestly': (r) => r.status === 200 || r.status === 409,
    'no server error under contention': (r) => r.status < 500,
  });
}
