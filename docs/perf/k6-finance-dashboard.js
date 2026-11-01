// k6 — the finance dashboard, which is the most expensive read in the product.
//
//   k6 run docs/perf/k6-finance-dashboard.js -e BASE_URL=... -e ANON_KEY=... -e TOKEN=... -e ORG_ID=...
//
// The dashboard aggregates the ledger: revenue by day, outstanding payouts, renewals due, quota usage. It is the
// screen an operator opens every morning and the one that grows with the business, so its p95 target (500 ms)
// is the loosest of the three and the one most worth checking against a year of journals rather than a week.
//
// Fixture note: a dashboard with an empty ledger is fast and proves nothing. Point ORG_ID at an organization
// with at least a few thousand journal lines — `npm run perf:seed` does not create finance history, so this is
// the one suite that needs a data set built from real activity (`npm run dev:api:reset` then booking and paying
// through the API, repeated, or a restored production-shaped dump).

import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = __ENV.ANON_KEY || 'maak-dev-anon-key';
const ORG_ID = __ENV.ORG_ID;
const TOKEN = __ENV.TOKEN;

const dashboard = new Trend('finance_dashboard_ms', true);

export const options = {
  scenarios: {
    morning: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '2m', target: 20 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    finance_dashboard_ms: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const response = http.post(
    `${BASE_URL}/functions/v1/finance`,
    JSON.stringify({ action: 'finance.dashboard', orgId: ORG_ID }),
    {
      headers: {
        'content-type': 'application/json',
        apikey: ANON_KEY,
        authorization: `Bearer ${TOKEN}`,
      },
      tags: { name: 'finance_dashboard' },
    },
  );

  dashboard.add(response.timings.duration);

  check(response, {
    'dashboard returns 200': (r) => r.status === 200,
    'dashboard carries a ledger summary': (r) => {
      if (r.status !== 200) return false;
      const body = r.json();
      return (
        body &&
        typeof body === 'object' &&
        ('revenue' in body || 'totals' in body || 'currency' in body)
      );
    },
  });
}
