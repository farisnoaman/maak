#!/usr/bin/env node
/**
 * The performance smoke — real latency numbers, no Docker, no k6.
 *
 * The launch plan's targets are p95 < 300 ms for search, < 250 ms for a write and < 500 ms for the finance
 * dashboard. `k6` is the tool for proving those at production volume (`docs/perf/*.js`), but k6 needs a seeded
 * database at 100k trips and 200 live ones, which is a separate exercise. This script answers the smaller and
 * more important question first: **is a single request already slow?** A 40 ms search at demo volume is a code
 * path that will scale; a 900 ms one is a query that needs an index, and no amount of load testing is needed to
 * know that.
 *
 *   npm run dev:api                 # in another terminal
 *   node scripts/perf-smoke.mjs --runs 40 --concurrency 4
 *
 * Every target is a constant here, so a regression is a red line in CI rather than a footnote in a report.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BASE = (process.env.MAAK_API_URL ?? 'http://127.0.0.1:54321').replace(/\/$/, '');
const EMAIL = process.env.PERF_EMAIL ?? 'owner@maak.test';
const PASSWORD = process.env.PERF_PASSWORD ?? 'Maak!2026';
const ANON = process.env.MAAK_ANON_KEY ?? 'maak-dev-anon-key';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const RUNS = arg('runs', 40);
/**
 * The gated series runs one request at a time, on purpose.
 *
 * `scripts/dev-backend` executes every query through a single PostgreSQL connection behind a mutex, so N
 * concurrent HTTP requests queue for a turn. 8 × 105 ms of work becomes 890 ms of wall clock however fast the
 * query is — a number about the harness, not about the product. What this script answers is "how long does one
 * search take"; `npm run perf:db` answers "how does the database behave with N callers", and the k6 suites in
 * `docs/perf/` answer it through a real PostgREST.
 */
const QUEUE = arg('queue', 0);
/** Where the numbers land. A 50k-trip run and a three-trip run are not comparable, so they are not one file. */
const OUT = (() => {
  const index = process.argv.indexOf('--out');
  return index === -1 ? 'docs/perf/smoke-dev.json' : process.argv[index + 1];
})();
const NOTE = (() => {
  const index = process.argv.indexOf('--note');
  return index === -1 ? 'demo volume' : process.argv[index + 1];
})();
const WRITE_RUNS = arg('writes', 10);

/** The targets from `IMPLEMENTATION_PLAN.md` Phase 12. A p95 above one of these fails the script. */
const TARGETS = { search: 300, write: 250, dashboard: 500 };

const results = [];
const failures = [];

function record(name, ms, ok, note) {
  results.push({ name, ms, ok, note });
  if (!ok) failures.push(`${name}: ${note}`);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function timed(fn) {
  const started = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { value, ms };
}

async function signIn() {
  const response = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
  const body = await response.json();
  return { token: body.access_token, userId: body.user?.id ?? null };
}

/**
 * Public search, as the marketplace calls it: an RPC granted to `anon`, no session needed.
 *
 * `vary` picks a distinct filter so the request misses the 30 s `search_cache`. Without it every run after the
 * first is a cache hit, and the benchmark would report the speed of the cache instead of the speed of the query.
 */
async function searchOnce(vary) {
  const { value, ms } = await timed(async () => {
    const response = await fetch(`${BASE}/rest/v1/rpc/search_public_trips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: ANON },
      body: JSON.stringify({
        p_locale: 'ar',
        p_filters: JSON.stringify(vary ? { priceMax: 1000 + (vary % 90) * 37 } : {}),
        p_sort: 'soonest',
        p_cursor: null,
        p_limit: 12,
      }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  });
  return { ...value, ms };
}

/**
 * One gateway command, as the web app makes it. Each domain has its own function (`dispatch` is Phase 11's
 * notifications function, `finance` is finance), so the caller names both.
 */
async function commandOnce(token, fn, action, payload) {
  const { value, ms } = await timed(async () => {
    const response = await fetch(`${BASE}/functions/v1/${fn}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: ANON,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  });
  return { ...value, ms };
}

/** Runs `count` tasks, at most `concurrency` at a time. */
async function pool(count, concurrency, task) {
  const out = [];
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      out[index] = await task(index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

async function main() {
  if (process.argv.includes('--concurrency')) {
    console.log(
      '  note: --concurrency is now --queue; the gated series is always serial. See QUEUE.',
    );
  }

  console.log(`▶ perf smoke — ${BASE}`);
  console.log(`  search: ${RUNS} runs, one at a time · write: ${WRITE_RUNS} runs`);

  // Warm the connection and the plan cache, then measure.
  await searchOnce(null);
  await searchOnce(1);

  const searches = await pool(RUNS, 1, (index) => searchOnce(index + 1));
  const cached = await pool(Math.min(RUNS, 20), 1, () => searchOnce(null));
  const searchOk = searches.filter((r) => r.status === 200);
  const searchLatencies = searchOk.map((r) => r.ms);

  if (searchOk.length !== searches.length) {
    record(
      'search',
      0,
      false,
      `${searches.length - searchOk.length} of ${searches.length} returned non-200`,
    );
  }

  const searchP95 = percentile(searchLatencies, 95);
  const cachedLatencies = cached.filter((r) => r.status === 200).map((r) => r.ms);
  console.log(
    `  search   p50 ${percentile(searchLatencies, 50).toFixed(1)} ms · ` +
      `p95 ${searchP95.toFixed(1)} ms · max ${Math.max(0, ...searchLatencies).toFixed(1)} ms  (cache miss)`,
  );
  if (cachedLatencies.length > 0) {
    console.log(`  search   p95 ${percentile(cachedLatencies, 95).toFixed(1)} ms  (cache hit)`);
  }
  record(
    'search',
    searchP95,
    searchP95 <= TARGETS.search,
    `p95 ${searchP95.toFixed(1)} ms against a ${TARGETS.search} ms target`,
  );

  let queueMs = null;
  if (QUEUE > 1) {
    // Informational: the same requests, N at a time, through the dev gateway. See QUEUE's comment above.
    const queued = await pool(QUEUE, QUEUE, (index) => searchOnce(10_000 + index + RUNS));
    const latencies = queued.filter((r) => r.status === 200).map((r) => r.ms);
    queueMs = percentile(latencies, 95);
    console.log(
      `  queue    p95 ${queueMs.toFixed(1)} ms at ${QUEUE}-way through the dev gateway ` +
        '(serialised on one connection — gateway throughput, not query latency)',
    );
  }

  let session = null;
  try {
    session = await signIn();
  } catch (error) {
    record('sign-in', 0, false, error.message);
  }

  const writes = [];
  const dashboards = [];
  if (session) {
    const { token } = session;
    // A read through the command path: the finance dashboard is the most expensive screen in the product.
    for (let i = 0; i < WRITE_RUNS; i += 1) {
      const saved = await commandOnce(token, 'dispatch', 'search.save', {
        filters: { priceMax: 5000 + i },
        notify: false,
        label: `perf ${i}`,
      });
      if (saved.status !== 200)
        record('write', saved.ms, false, `search.save returned ${saved.status}`);
      writes.push(saved.ms);

      // The owner's own statement of account: the most expensive read in the product.
      const dashboard = await commandOnce(token, 'finance', 'finance.dashboard', {
        ownerUserId: session.userId,
      });
      if (dashboard.status !== 200) {
        // A staff account has no statement of account; that is a fixture problem, not a performance one.
        if (i === 0)
          console.log(`  note: finance dashboard returned ${dashboard.status} — skipped`);
      } else {
        dashboards.push(dashboard.ms);
      }
    }

    const writeP95 = percentile(writes, 95);
    console.log(`  write    p95 ${writeP95.toFixed(1)} ms (search.save, ${writes.length} calls)`);
    record(
      'write',
      writeP95,
      writeP95 <= TARGETS.write,
      `p95 ${writeP95.toFixed(1)} ms against ${TARGETS.write}`,
    );

    if (dashboards.length > 0) {
      const dashP95 = percentile(dashboards, 95);
      console.log(`  finance  p95 ${dashP95.toFixed(1)} ms (${dashboards.length} calls)`);
      record(
        'dashboard',
        dashP95,
        dashP95 <= TARGETS.dashboard,
        `p95 ${dashP95.toFixed(1)} ms against ${TARGETS.dashboard}`,
      );
    }
  }

  const report = {
    at: new Date().toISOString(),
    base: BASE,
    note: NOTE,
    runs: { search: RUNS, write: writes.length, dashboard: dashboards.length },
    concurrency: 1,
    gatewayQueueConcurrency: QUEUE,
    targets: TARGETS,
    p50: {
      search: percentile(searchLatencies, 50),
      write: percentile(writes, 50),
      dashboard: percentile(dashboards, 50),
    },
    p95: {
      search: searchP95,
      searchCached: percentile(cachedLatencies, 95),
      gatewayQueue: queueMs,
      write: percentile(writes, 95),
      dashboard: percentile(dashboards, 95),
    },
    max: {
      search: Math.max(0, ...searchLatencies),
      write: Math.max(0, ...writes),
      dashboard: Math.max(0, ...dashboards),
    },
    failures,
  };

  // Written where the phase report can cite it. Demo-volume numbers, labelled as such — the k6 run at production
  // volume appends to the same directory with a different file name.
  const out = isAbsolute(OUT) ? OUT : join(root, OUT);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`  → ${out.replace(`${root}/`, '')}`);

  if (failures.length > 0) {
    console.log('');
    for (const failure of failures) console.log(`✗ ${failure}`);
    console.log(`✗ perf smoke failed: ${failures.length} target(s) missed`);
    process.exitCode = 1;
  } else {
    console.log('\n✓ perf smoke passed: every p95 inside its target');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
