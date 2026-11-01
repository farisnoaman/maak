#!/usr/bin/env node
/**
 * Concurrency at the database, without the gateway in the way.
 *
 * `npm run perf:smoke` measures one request at a time through the dev API, which serialises every query on a
 * single connection (`scripts/dev-backend`'s mutex) — deliberately, because that is what a one-process dev
 * stack is. That makes it the right tool for "has this query become slow?" and the wrong tool for "how many can
 * we serve?", since N callers queue for one turn regardless of how fast the query is.
 *
 * This speaks to PostgreSQL over N real connections and runs the marketplace's read functions exactly as the
 * API would. It reports throughput and p95 per concurrency level, which is what turns "105 ms per search" into
 * a capacity statement:
 *
 *   npm run perf:db -- --concurrency 1,4,8,16 --runs 40
 *
 * Two honest caveats, printed with the numbers rather than buried here:
 *   · cache hits are the common path in production (the 30 s `search_cache`), so this measures the *cold* cost —
 *     the number that decides how many distinct queries the database can absorb;
 *   · the sandbox this was written on has two cores. Throughput scales with cores, latency does not.
 */

import { Client } from 'pg';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};

const LEVELS = String(arg('concurrency', '1,4,8')).split(',').map(Number).filter(Boolean);
const RUNS = Number(arg('runs', 60));
const HOST = String(process.env.MAAK_PG_HOST ?? '127.0.0.1');
const PORT = Number(process.env.MAAK_PG_PORT ?? 54322);

const CONNECTION = {
  host: HOST,
  port: PORT,
  user: process.env.MAAK_PG_USER ?? 'postgres',
  password: process.env.MAAK_PG_PASSWORD ?? 'postgres',
  database: process.env.MAAK_PG_DATABASE ?? 'postgres',
};

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/**
 * A cold search: a filter the cache cannot have seen.
 *
 * The price cap is random rather than derived from the run counter: a deterministic value is cached by the
 * *previous* run, so the second time this script executes it measures the cache and reports 3 ms as if it were
 * a query. That mistake was made here once, and the numbers looked wonderful.
 */
async function search(client) {
  const started = process.hrtime.bigint();
  await client.query('select public.search_public_trips($1, $2::jsonb, $3, null, 12)', [
    'ar',
    JSON.stringify({ priceMax: Math.floor(Math.random() * 9_000_000) }),
    'soonest',
  ]);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/** A warm search: the same filter every time, so every call after the first is served by the 30 s cache. */
async function cachedSearch(client) {
  const started = process.hrtime.bigint();
  await client.query('select public.search_public_trips($1, $2::jsonb, $3, null, 12)', [
    'ar',
    JSON.stringify({ priceMax: 411 }),
    'soonest',
  ]);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/** A trip page, by code — the second read every visitor makes. */
async function tripPage(client) {
  const started = process.hrtime.bigint();
  await client.query('select public.get_trip_public($1, $2)', ['AD-SA-66CD', 'ar']);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

async function level(callers, runsPerCaller, task) {
  const clients = await Promise.all(
    Array.from({ length: callers }, async () => {
      const client = new Client(CONNECTION);
      await client.connect();
      return client;
    }),
  );

  try {
    // Warm-up: plan caches and connection setup are not what is being measured.
    await Promise.all(clients.map((client) => task(client)));

    const latencies = [];
    const started = Date.now();
    await Promise.all(
      clients.map(async (client) => {
        for (let run = 0; run < runsPerCaller; run += 1) {
          latencies.push(await task(client));
        }
      }),
    );
    const wall = Date.now() - started;

    return {
      callers,
      requests: latencies.length,
      wallMs: wall,
      throughput: (latencies.length / wall) * 1000,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: Math.max(...latencies),
    };
  } finally {
    await Promise.all(clients.map((client) => client.end()));
  }
}

async function main() {
  const probe = new Client(CONNECTION);
  await probe.connect();

  const volume = await probe.query(`
    select count(*)::int as trips,
           count(*) filter (where departure_at > now())::int as live
    from public.trips where status = 'published'
  `);
  console.log(
    `▶ perf db — ${HOST}:${PORT}, ${volume.rows[0].trips} published trips (${volume.rows[0].live} live)`,
  );
  if (volume.rows[0].trips < 10_000) {
    console.log(
      '  note: fewer than 10,000 trips — run `npm run perf:seed` for numbers worth citing',
    );
  }
  console.log(`  ${RUNS} requests per caller per level\n`);

  const rows = [];
  for (const callers of LEVELS) {
    const searches = await level(callers, RUNS, (client) => search(client));
    const pages = await level(callers, Math.max(1, Math.round(RUNS / 4)), (client) =>
      tripPage(client),
    );
    const warm = await level(callers, RUNS, (client) => cachedSearch(client));

    rows.push({ search: searches, tripPage: pages, cached: warm });
    console.log(
      `  search  ${String(callers).padStart(2)} callers · ${searches.throughput.toFixed(1)} req/s · ` +
        `p50 ${searches.p50.toFixed(0)} ms · p95 ${searches.p95.toFixed(0)} ms  (cold)`,
    );
    console.log(
      `  search  ${String(callers).padStart(2)} callers · ${warm.throughput.toFixed(1)} req/s · ` +
        `p95 ${warm.p95.toFixed(0)} ms  (cache hit)`,
    );
    console.log(
      `  trip    ${String(callers).padStart(2)} callers · ${pages.throughput.toFixed(1)} req/s · ` +
        `p50 ${pages.p50.toFixed(0)} ms · p95 ${pages.p95.toFixed(0)} ms`,
    );
  }

  await probe.end();

  const single = rows[0]?.search;
  if (single) {
    // The number that matters for capacity: one cold search costs this much of one core, so a box with C cores
    // can absorb roughly C / (cpu per search) cold searches per second before p95 starts to grow.
    console.log(
      `\n  one cold search ≈ ${single.p50.toFixed(0)} ms of a core — ` +
        `${(1000 / single.p50).toFixed(1)}/s per core before queueing`,
    );
  }

  /**
   * Informational by default. A 300 ms gate at N callers would be a gate on how many cores this machine has,
   * and failing it teaches nothing; `npm run perf:smoke` is the gate, because "did this query get slow?" is a
   * question a build can answer. `--strict` is for a production-sized box, where the number *is* the claim.
   */
  const crossed = rows.filter((row) => row.search.p95 > 300);
  if (crossed.length > 0) {
    console.log(
      `  note: cold search p95 crossed 300 ms at ${crossed.map((row) => `${row.search.callers} callers`).join(', ')} — ` +
        'CPU-bound facets on this box; see docs/perf/README.md',
    );
  }
  if (process.argv.includes('--strict') && crossed.length > 0) {
    console.log('✗ search p95 crossed 300 ms (--strict)');
    process.exitCode = 1;
  } else {
    console.log('✓ measured');
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  // A failed run must not leave an open connection holding the event loop: the script would hang instead of
  // failing, which is worse than either.
  process.exit(1);
});
