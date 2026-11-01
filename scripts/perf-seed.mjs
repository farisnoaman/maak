#!/usr/bin/env node
/**
 * Seeds a database at the volume the launch plan assumes, so the performance numbers mean something.
 *
 * `docs/perf/smoke-dev.json` measures a demo database with three trips. It answers "is one request slow?",
 * which is the question that catches a missing index, but it cannot answer "is search still fast at 50,000
 * trips?" — a query plan that is 8 ms over 3 rows can be 900 ms over 50,000.
 *
 * This inserts published trips by cloning one real trip, in batches, straight into the local cluster:
 *
 *   npm run perf:seed -- --trips 50000
 *   npm run perf:smoke -- --runs 200
 *   npm run perf:seed -- --reset          # remove every seeded row again
 *
 * The rows are marked by their code prefix (`PF-`) and are only ever inserted into a *local* database: the
 * script refuses to run against anything that is not 127.0.0.1 by default, because 50,000 fabricated trips in
 * production is not a benchmark, it is an incident.
 *
 * What a seed does not reproduce: booking contention, concurrent writers, ping ingest or payment volume. Those
 * need the k6 suites in `docs/perf/`, which drive the API rather than the database.
 */

import { Client } from 'pg';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};

const TRIPS = Number(arg('trips', 50_000));
const LIVE = Number(arg('live', 200));
const BATCH = Number(arg('batch', 5_000));
const RESET = Boolean(arg('reset', false));
const HOST = String(process.env.MAAK_PG_HOST ?? '127.0.0.1');
const PORT = Number(process.env.MAAK_PG_PORT ?? 54322);

if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  console.error(`✗ refusing to seed ${HOST}: perf seeds are for a local cluster only`);
  process.exit(1);
}

/**
 * A trip code is `AA-BB-0001` and must stay unique and well formed. 100k rows fit comfortably in the
 * 90 groups × 10,000 tail this scheme allows, and a rerun after `--reset` reuses the same codes.
 */
const CODE_SQL = `
  'PF-' || lpad(g::text, 2, '0') || '-' || lpad(n::text, 4, '0')
`;

async function main() {
  const client = new Client({
    host: HOST,
    port: PORT,
    user: process.env.MAAK_PG_USER ?? 'postgres',
    password: process.env.MAAK_PG_PASSWORD ?? 'postgres',
    database: process.env.MAAK_PG_DATABASE ?? 'postgres',
  });
  await client.connect();

  try {
    const before = await client.query('select count(*)::int as n from public.trips');
    console.log(`▶ perf seed — ${HOST}:${PORT}, ${before.rows[0].n} trips now`);

    if (RESET) {
      await client.query('begin');
      await client.query(`delete from public.trips where code like 'PF-%'`);
      await client.query('commit');
      const after = await client.query('select count(*)::int as n from public.trips');
      console.log(`✓ removed every seeded trip: ${after.rows[0].n} left`);
      return;
    }

    // The template: a real published trip, so the clone inherits governorates, an operator, a vehicle and a
    // price that RLS and the search projection both accept. Without one there is nothing to scale up.
    const template = await client.query(`
      select id, owner_user_id, owner_org_id, vehicle_id, driver_id,
             origin_governorate_id, destination_governorate_id,
             seats_total, price_per_seat_yer, whole_trip_price_yer, arrive_estimate_minutes,
             booking_mode, pricing_mode, discount_kind, discount_value,
             gender_policy, payment_policy, luggage_allowance_kg
      from public.trips
      where status = 'published' and code not like 'PF-%'
      order by departure_at
      limit 1
    `);

    if (template.rowCount === 0) {
      console.error('✗ no published trip to clone — run `npm run dev:api:reset` first');
      process.exitCode = 1;
      return;
    }
    const t = template.rows[0];

    // Departure times: `LIVE` trips in the next fortnight (what a passenger actually searches), the rest spread
    // over the coming year so the index has realistic selectivity instead of one crowded day.
    const liveCount = Math.min(LIVE, TRIPS);
    let inserted = 0;

    for (let start = 0; start < TRIPS; start += BATCH) {
      const count = Math.min(BATCH, TRIPS - start);
      const sql = `
        with gen as (
          select (${start} + i) as i from generate_series(1, $1) as i
        ), numbered as (
          select i, ((i - 1) / 10000) + 1 as g, ((i - 1) % 10000) + 1 as n from gen
        ), shaped as (
          select
            ${CODE_SQL} as code,
            case
              when i <= $2 then now() + (interval '2 hours' * (i % 336))
              else now() + interval '14 days' + (interval '6 hours' * (i - $2))
            end as departure_at
          from numbered
        )
        insert into public.trips (
          code, owner_user_id, owner_org_id, vehicle_id, driver_id,
          origin_governorate_id, destination_governorate_id, departure_at,
          arrive_estimate_minutes, seats_total, seats_available,
          booking_mode, pricing_mode, price_per_seat_yer, whole_trip_price_yer,
          discount_kind, discount_value, gender_policy, payment_policy,
          luggage_allowance_kg, status, verification_status, published_at
        )
        select
          s.code, $3, $4, $5, $6,
          $7, $8, s.departure_at,
          $9, $10, $10,
          $11::public.trip_booking_mode, $12::public.trip_pricing_mode, $13, $14,
          $15::public.trip_discount_kind, $16, $17::public.trip_gender_policy, $18::public.trip_payment_policy,
          $19, 'published', 'verified', now()
        from shaped s
        on conflict (code) do nothing
      `;

      await client.query(sql, [
        count,
        liveCount,
        t.owner_user_id,
        t.owner_org_id,
        t.vehicle_id,
        t.driver_id,
        t.origin_governorate_id,
        t.destination_governorate_id,
        t.arrive_estimate_minutes,
        t.seats_total,
        t.booking_mode,
        t.pricing_mode,
        t.price_per_seat_yer,
        t.whole_trip_price_yer,
        t.discount_kind,
        t.discount_value,
        t.gender_policy,
        t.payment_policy,
        t.luggage_allowance_kg,
      ]);

      inserted += count;
      const done = await client.query('select count(*)::int as n from public.trips');
      process.stdout.write(`\r  seeded ${inserted}/${TRIPS} · ${done.rows[0].n} trips`);
    }
    process.stdout.write('\n');

    // Statistics, not rows: without this the planner works from the three-row estimates and the benchmark
    // measures a bad plan rather than a slow query — which is a real finding, but the wrong one to publish.
    await client.query('analyze public.trips');
    await client.query('analyze public.trips_search');

    const summary = await client.query(`
      select
        count(*)::int as trips,
        count(*) filter (where departure_at > now())::int as live,
        count(*) filter (where code like 'PF-%')::int as seeded
      from public.trips
    `);
    const { trips, live, seeded } = summary.rows[0];
    console.log(`✓ ${trips} trips (${seeded} seeded, ${live} departing in the future)`);
    console.log('  next: npm run perf:smoke -- --runs 200 --concurrency 8');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
});
