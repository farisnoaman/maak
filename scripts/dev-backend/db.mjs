/**
 * Local PostgreSQL for development — the real schema, the real migrations, the real RLS.
 *
 * Why this exists: the sandbox (and a fresh clone) has no Docker, no Supabase CLI and no Postgres
 * service, so the app ran in "preview mode" with fixture data. This module boots an actual
 * PostgreSQL cluster from the `embedded-postgres` package (the same one `npm run sql:check` uses),
 * applies every migration in order, and seeds demo rows you can sign in with.
 *
 * It is a *development* database, not a stand-in for production:
 *   · `auth.users` and `storage.*` are the minimal platform tables from `scripts/sql-check/bootstrap.sql`
 *     — the same subset the pgTAP suites run against;
 *   · credentials live in `dev.accounts`, a dev-only table created here and never in a migration.
 *
 * The cluster is persistent (`.dev/pgdata`) so data survives a restart; delete the folder for a
 * clean slate.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = join(root, '.dev', 'pgdata');
const migrationsDir = join(root, 'supabase', 'migrations');

export const PG_PORT = Number(process.env.MAAK_PG_PORT ?? 54322);

export async function startDatabase({ reset = false, quiet = false } = {}) {
  const log = quiet ? () => {} : (line) => console.log(line);
  const alreadyInitialised = existsSync(join(dataDir, 'PG_VERSION'));

  if (reset && existsSync(dataDir)) {
    const { rm } = await import('node:fs/promises');
    await rm(dataDir, { recursive: true, force: true });
  }
  await mkdir(dataDir, { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: true,
    // The schema contains Arabic; a SQL_ASCII cluster refuses it (see docs/phase-2-report.md).
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'client_encoding=UTF8', '-c', 'timezone=UTC'],
    onLog: () => {},
  });

  if (!reset && alreadyInitialised) {
    log(`  reusing cluster in .dev/pgdata`);
  } else {
    log('  initialising a fresh cluster…');
    await pg.initialise();
  }
  await pg.start();

  const client = pg.getPgClient();
  await client.connect();

  await applySchema(client, { reset, log });
  return { pg, client };
}

/**
 * Applies bootstrap + migrations, then the dev-only extras and the seed.
 *
 * Migrations are tracked **per file**, not as one fingerprint. Tracking the whole set meant that adding a
 * single migration made the next `npm run dev` re-run every earlier one against an existing cluster,
 * which fails (`relation "log" already exists`) — the app simply would not start after a schema change.
 * That is the worst possible time to break the dev loop.
 */
export async function applySchema(client, { reset = false, log = () => {} } = {}) {
  await client.query(`create schema if not exists dev`);
  await client.query(`
    create table if not exists dev.meta (key text primary key, value text not null)
  `);

  const migrations = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

  const marker = await client.query(
    `select key, value from dev.meta where key in ('applied_files', 'schema_hash')`,
  );
  const rows = new Map(marker.rows.map((row) => [row.key, row.value]));

  /** @type {Set<string>} */
  let applied = new Set();
  if (!reset) {
    const recorded = rows.get('applied_files');
    if (recorded) {
      try {
        applied = new Set(JSON.parse(recorded));
      } catch {
        applied = new Set();
      }
    } else if (rows.get('schema_hash')) {
      // A cluster from before per-file tracking: the old marker was the whole list, joined by commas, so
      // it still tells us exactly which files had run.
      applied = new Set(String(rows.get('schema_hash')).split(',').filter(Boolean));
    }
  }

  const pending = migrations.filter((file) => !applied.has(file));

  if (pending.length === 0) {
    log('  schema already applied');
    await seed(client, log);
    return;
  }

  // The bootstrap is idempotent (`if not exists` everywhere) and cheap; the migrations are not, which is
  // the whole reason for the per-file ledger above.
  const bootstrap = await readFile(join(root, 'scripts', 'sql-check', 'bootstrap.sql'), 'utf8');
  await client.query(bootstrap);

  for (const file of pending) {
    let sql = await readFile(join(migrationsDir, file), 'utf8');
    // PostGIS is not part of the embedded build; migrations guard it, but the statement itself still has
    // to be dropped.
    sql = sql.replace('create extension if not exists postgis;', '-- [dev] postgis unavailable');
    try {
      await client.query(sql);
    } catch (error) {
      throw new Error(`migration ${file} failed: ${error.message}`, { cause: error });
    }
    applied.add(file);
    await client.query(
      `insert into dev.meta (key, value) values ('applied_files', $1)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify([...applied])],
    );
    log(`  applied ${file}`);
  }

  await client.query(
    `insert into dev.meta (key, value) values ('schema_hash', $1)
     on conflict (key) do update set value = excluded.value`,
    [migrations.join(',')],
  );

  await seed(client, log);
}

/** Demo accounts. Passwords are hashed with scrypt and stored only in `dev.accounts`. */
export const DEMO_PASSWORD = 'Maak!2026';

const DEMO_USERS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'admin@maak.test',
    phone: '+967733000001',
    name: 'فارس نعمان',
    role: 'platform_admin',
    verified: 'verified',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'staff@maak.test',
    phone: '+967733000002',
    name: 'هدى باشراحيل',
    role: 'platform_staff',
    verified: 'verified',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'owner@maak.test',
    phone: '+967733000003',
    name: 'سامي القباطي',
    role: null,
    verified: 'verified',
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'new@maak.test',
    phone: '+967733000004',
    name: 'عبدالله المخلافي',
    role: null,
    verified: 'unverified',
  },
  {
    // The driver the seeded fleet already had a profile for (`+967733000101`). Without an account to
    // bind it to, the licence screen answered "no driver profile" and the whole photo flow — the one
    // thing the screen exists for — could not be tried on a laptop at all.
    id: '55555555-5555-4555-8555-555555555555',
    email: 'driver@maak.test',
    phone: '+967733000101',
    name: 'خالد الحميري',
    role: null,
    verified: 'verified',
  },
];

async function seed(client, log = () => {}) {
  const { scryptSync, randomBytes } = await import('node:crypto');

  await client.query(`
    create table if not exists dev.accounts (
      user_id    uuid primary key references auth.users (id) on delete cascade,
      password   text not null,
      created_at timestamptz not null default now()
    )
  `);

  // Every insert below is idempotent, so the seed can run on every start instead of being skipped
  // wholesale. Skipping taught us a lesson: a later addition to the seed silently never ran on a
  // database that had already been initialised.
  log('  seeding demo accounts and reference data…');

  for (const user of DEMO_USERS) {
    await client.query(
      `insert into auth.users (id, email, phone, raw_user_meta_data)
       values ($1, $2, $3, jsonb_build_object('locale', 'ar'))
       on conflict (id) do nothing`,
      [user.id, user.email, user.phone],
    );
    await client.query(
      `update public.profiles
       set full_name = $2, phone = $3, email = $4, verification_status = $5::public.verification_status
       where id = $1`,
      [user.id, user.name, user.phone, user.email, user.verified],
    );
    // `public.user_roles` holds *platform* roles only; being an individual operator is derived
    // from profile + organization facts, not from a role row.
    if (user.role) {
      await client.query(
        `insert into public.user_roles (user_id, role) values ($1, $2::public.platform_role)
         on conflict do nothing`,
        [user.id, user.role],
      );
    }

    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(DEMO_PASSWORD, salt, 32).toString('hex');
    // `do nothing`: a password changed through the UI survives a restart, which is exactly what you
    // want while testing the account screens.
    await client.query(
      `insert into dev.accounts (user_id, password) values ($1, $2)
       on conflict (user_id) do nothing`,
      [user.id, `${salt}:${hash}`],
    );
  }

  // A company owned by the verified individual, so the operator console has real context.
  await client.query(
    `insert into public.organizations (
       id, name, name_en, kind, registration_no, phone, email, owner_id, verification_status
     )
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'شركة معك للنقل', 'Maak Transport', 'company',
             'CR-100200', '+967733000003', 'ops@maak.test',
             '33333333-3333-4333-8333-333333333333', 'verified')
     on conflict (id) do nothing`,
  );
  await client.query(
    `insert into public.organization_members (org_id, user_id, role, status)
     values ('aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'owner', 'active')
     on conflict do nothing`,
  );

  // Pro, not Basic, and deliberately: a Basic organization may hold one vehicle, one driver and five
  // trips, which turns every console into a demo of empty states and — worse — makes the second-invite,
  // second-vehicle and quota-refusal paths untestable without hand-editing the database. The demo
  // account is not sold anything; it exists to be exercised.
  await client.query(
    `update public.organizations set plan = 'pro' where id = 'aaaaaaaa-0000-4000-8000-000000000001'`,
  );

  await seedDemoFleet(client);

  // Fuel and maintenance, through the commands. Without it the fleet dashboard and the health card are
  // empty on every reset — and a Phase 8 screen that has never shown a consumption figure is a screen
  // nobody has looked at.
  try {
    await seedDemoOperations(client, log);
  } catch (error) {
    log(`  (demo operations skipped: ${error.message})`);
  }

  // Bookable inventory, created through the same three commands the console uses. Without it the
  // marketplace is an empty page after every reset and there is nothing to book — which is how a
  // booking defect stays invisible until somebody hand-inserts a trip.
  try {
    await seedDemoTrip(client, log);
  } catch (error) {
    log(`  (demo trip skipped: ${error.message})`);
  }

  // Two more vans, so the fleet dashboard is a fleet and not a single row: one overdue, one healthy, one
  // due soon. Seeded after the primary van so the phase-8 acceptance numbers on 7925cdf3 stay identical.
  await client.query(
    `insert into public.vehicles (
       id, owner_org_id, make, model, model_year, plate_number, plate_governorate_id,
       fuel_type, seats_passenger, seats_total, odometer_km, status, verification_status,
       insurance_expiry, inspection_expiry, registration_expiry, created_by
     )
     values
       ('7925cdf3-0000-4000-8000-00000000c001', 'aaaaaaaa-0000-4000-8000-000000000001',
        'Toyota', 'Coaster', 2017, '8-4471',
        (select id from public.governorates where code = 'YE-AD'),
        'diesel', 22, 23, 340_900, 'active', 'verified',
        current_date + 120, current_date + 60, current_date + 200,
        '33333333-3333-4333-8333-333333333333'),
       ('7925cdf3-0000-4000-8000-00000000c002', 'aaaaaaaa-0000-4000-8000-000000000001',
        'Hyundai', 'County', 2021, '5-2210',
        (select id from public.governorates where code = 'YE-AD'),
        'diesel', 25, 26, 95_400, 'active', 'verified',
        current_date + 260, current_date + 310, current_date + 340,
        '33333333-3333-4333-8333-333333333333')
     on conflict (id) do nothing`,
  );

  // Now that the two extra vans exist, the marketplace can have more than one departure.
  try {
    await seedMarketplaceTrips(client, log);
  } catch (error) {
    log(`  (extra demo trips skipped: ${error.message})`);
  }

  try {
    await seedDemoBooking(client, log);
  } catch (error) {
    log(`  (demo booking skipped: ${error.message})`);
  }

  try {
    await seedDemoPayments(client, log);
  } catch (error) {
    log(`  (demo payments skipped: ${error.message})`);
  }

  await seedExtraFleetOperations(client, log);

  // Phase 10 data, through the commands the screens call. A finance desk that has never had a journal in it
  // shows only empty states, and the one thing this phase must not do is look plausible while posting
  // nothing: the ledger, the invoice and the expenses below are real rows with real double entries.
  try {
    await seedDemoFinance(client, log);
  } catch (error) {
    log(`  (demo finance skipped: ${error.message})`);
  }

  await grantDemoScope(client);
  log(`  demo sign-in: admin@maak.test · owner@maak.test · driver@maak.test / ${DEMO_PASSWORD}`);
}

/**
 * One real vehicle and one real driver, so the console is not a wall of empty states.
 *
 * This exists because of a smaller failure than it looks: with no rows, the vehicle detail page — the
 * screen that renders all sixty attributes — was never parsed by `check-a11y.mjs`, and every screenshot
 * of Phase 3 showed "0 vehicles". The insurance expiry is deliberately 20 days out so the amber badge
 * has something to colour, and the odometer baseline row matches the vehicle's odometer.
 *
 * Fixed ids, `on conflict do nothing`: re-running the seed is a no-op and a row edited in the UI stays
 * edited. The vehicle belongs to the company, which is also what fills the `?org=` context switcher.
 */
async function seedDemoFleet(client) {
  await client.query(
    `insert into public.vehicles (
       id, owner_org_id, make, model, model_year, trim, plate_number, plate_governorate_id,
       vin, chassis_no, color, body_type, drive_type, transmission, fuel_type, engine_cc, cylinders,
       fuel_tank_l, tyre_size, tyre_count, spare_tyre, vehicle_condition, ownership_kind,
       seats_passenger, seats_total, luggage_capacity_l, roof_rack,
       air_conditioning, heating, reclining_seats, usb_charging, curtains,
       airbags, abs, esp, seatbelts_all, fire_extinguisher, first_aid, emergency_exit, gps_device,
       child_seat, step_assist,
       insurance_company, insurance_policy_no, insurance_expiry, inspection_expiry,
       registration_expiry, transport_permit_expiry,
       exterior_condition, interior_condition, odometer_km, status, verification_status,
       verified_by, verified_at, created_by
     )
     values (
       '7925cdf3-5648-4b52-9f84-8ad8fa68aae2',
       'aaaaaaaa-0000-4000-8000-000000000001',
       'Toyota', 'Hiace', 2019, 'GL', '12345-ع',
       (select id from public.governorates where code = 'YE-AD'),
       'JTFSK22P7J0123456', 'CH-2019-88421', 'أبيض', 'van', 'rear_wheel_drive', 'manual', 'diesel',
       2982, 4, 70, '195R15', 5, true, 'used', 'owned',
       13, 14, 1200, true,
       true, true, true, true, true,
       2, true, false, true, true, true, true, true,
       true, false,
       'شركة اليمن للتأمين', 'POL-2026-004178', current_date + 20, current_date + 240,
       current_date + 300, current_date + 90,
       'good', 'good', 184320, 'active', 'verified',
       '22222222-2222-4222-8222-222222222222', now(), '33333333-3333-4333-8333-333333333333'
     )
     on conflict (id) do nothing`,
  );

  await client.query(
    `insert into public.odometer_readings (id, vehicle_id, reading_km, kind, recorded_by, note)
     values ('7925cdf3-0000-4000-8000-00000000a001', '7925cdf3-5648-4b52-9f84-8ad8fa68aae2',
             184320, 'baseline', '33333333-3333-4333-8333-333333333333', 'قراءة خط الأساس')
     on conflict (id) do nothing`,
  );

  await client.query(
    `insert into public.driver_profiles (
       id, invited_phone, full_name, org_id, invited_by, licence_no, licence_class,
       licence_expiry, status, verification_status, verified_by, verified_at
     )
     values (
       '7925cdf3-0000-4000-8000-00000000d001', '+967733000101', 'خالد الحميري',
       'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333',
       'YE-DL-448213', 'C', current_date + 420, 'active', 'verified',
       '22222222-2222-4222-8222-222222222222', now()
     )
     on conflict (id) do nothing`,
  );

  // Bind the seeded driver profile to the seeded driver account, once. A row edited in the UI stays
  // edited: the condition is "nobody", not "not this user".
  await client.query(
    `update public.driver_profiles
        set user_id = '55555555-5555-4555-8555-555555555555'
      where id = '7925cdf3-0000-4000-8000-00000000d001' and user_id is null`,
  );

  await client.query(
    `insert into public.vehicle_driver_assignments (id, vehicle_id, driver_id, assigned_by)
     values ('7925cdf3-0000-4000-8000-00000000b001', '7925cdf3-5648-4b52-9f84-8ad8fa68aae2',
             '7925cdf3-0000-4000-8000-00000000d001', '33333333-3333-4333-8333-333333333333')
     on conflict (id) do nothing`,
  );
}

/**
 * Two full tanks 450 km apart and an oil rule that is nearly due.
 *
 * These are the plan's own acceptance numbers, seeded as data: 38 litres over 450 km is the 8.44 L/100km
 * the dashboard is supposed to show, and "oil every 5 000 km from 179 500" puts the van 180 km from a
 * 184 500 due point — inside the 500 km window, so the badge is amber rather than green. A demo that
 * only ever shows "ok" does not demonstrate the feature.
 *
 * Written through `cmd_log_fuel` / `cmd_upsert_maintenance_schedule` rather than inserts, for the same
 * reason as the trip seed: the seed then proves the commands still work.
 */
async function seedDemoOperations(client, log = () => {}) {
  const owner = '33333333-3333-4333-8333-333333333333';
  const vehicle = '7925cdf3-5648-4b52-9f84-8ad8fa68aae2';

  const existing = await client.query(
    'select 1 from public.fuel_logs where vehicle_id = $1 limit 1',
    [vehicle],
  );
  if (existing.rows.length > 0) return;

  log('  seeding demo fuel and maintenance…');

  // Two real stations in the directory, because the picker is only worth demonstrating with something in
  // it: a fuel form whose "station from the directory" list offers a market is a control that looks broken.
  // They are `kind = 'station'` and public, so they belong to the geo directory rather than to the seed's
  // private gathering point.
  await client.query(`
    insert into public.places (kind, name_ar, name_en, lat, lng, is_public, created_by,
                               verification_status)
    select v.kind, v.ar, v.en, v.lat, v.lng, true, '11111111-1111-4111-8111-111111111111',
           'verified'
    from (values
      ('station', 'محطة الروضة — عدن', 'Al Rawda Station — Aden', 12.7855, 45.0184),
      ('station', 'محطة النور — الزنجبار', 'Al Noor Station — Zinjibar', 13.1289, 45.3807)
    ) as v(kind, ar, en, lat, lng)
    where not exists (select 1 from public.places p where p.name_ar = v.ar)
  `);

  const stationId = async (name) => {
    const found = await client.query('select id from public.places where name_ar = $1 limit 1', [
      name,
    ]);
    return found.rows[0]?.id ?? null;
  };

  const fill = async (odometerKm, litres, daysAgo, station) => {
    await client.query('select public.cmd_log_fuel($1::uuid, $2::uuid, $3::jsonb, $4, null)', [
      owner,
      vehicle,
      JSON.stringify({
        odometerKm,
        litres,
        pricePerLitreYer: 500,
        isFullTank: true,
        filledAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
        stationName: station,
        // Linked as well as named, so the demo shows the directory doing its job rather than a text field
        // that happens to be filled in.
        stationPlaceId: await stationId(station),
      }),
      `dev-seed-fuel-${odometerKm}`,
    ]);
  };

  // Above the seeded baseline (184 320), because the odometer only goes forward for the seed too — the
  // commands would refuse a fill that pretends the van un-drove its last delivery.
  await fill(184_770, 41, 12, 'محطة الروضة — عدن');
  await fill(185_220, 40, 7, 'محطة النور — الزنجبار');
  await fill(185_670, 38, 2, 'محطة الروضة — عدن');

  await client.query(
    'select public.cmd_upsert_maintenance_schedule($1::uuid, $2::uuid, $3::jsonb, $4, null)',
    [
      owner,
      vehicle,
      JSON.stringify({
        kind: 'oil_change',
        // Due at 186 000 with the van at 185 670: 330 km out, inside the 500 km window, so the badge is
        // amber. A seed that only ever shows "ok" does not demonstrate the feature.
        intervalKm: 5000,
        lastDoneKm: 181_000,
        note: 'زيت المحرك والفلتر',
      }),
      'dev-seed-schedule-oil',
    ],
  );

  await client.query(
    'select public.cmd_upsert_maintenance_schedule($1::uuid, $2::uuid, $3::jsonb, $4, null)',
    [
      owner,
      vehicle,
      JSON.stringify({
        kind: 'inspection',
        intervalDays: 180,
        lastDoneOn: new Date(Date.now() - 150 * 86_400_000).toISOString().slice(0, 10),
      }),
      'dev-seed-schedule-inspection',
    ],
  );

  // This month's maintenance figure needs something in it, or the rollup shows a zero that reads like a
  // bug. Five days ago is inside the current month; the brake job below is the one that lands outside it.
  await client.query('select public.cmd_log_maintenance($1::uuid, $2::uuid, $3::jsonb, $4, null)', [
    owner,
    vehicle,
    JSON.stringify({
      kind: 'tyres',
      performedOn: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10),
      costYer: 18_000,
      vendor: 'مؤسسة الإطارات الحديثة — عدن',
      note: 'إطاران خلفيان',
    }),
    'dev-seed-tyres',
  ]);

  await client.query('select public.cmd_log_maintenance($1::uuid, $2::uuid, $3::jsonb, $4, null)', [
    owner,
    vehicle,
    JSON.stringify({
      kind: 'brakes',
      // No odometer on purpose: this happened before the seeded fills, and a maintenance record is
      // evidence of work, not a claim about when the van last moved.
      performedOn: new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10),
      costYer: 12_000,
      vendor: 'ورشة الدائري — عدن',
    }),
    'dev-seed-brakes',
  ]);
}

/**
 * One published trip, three stops out, so `/trips` has something to show and the booking form has
 * something to book.
 *
 * Created with `cmd_create_trip` → `cmd_set_trip_stops` → `cmd_publish_trip` rather than with an insert:
 * the seed then exercises the same rules a real operator does (quota, verification, search refresh,
 * events), and a regression in any of them breaks the seed instead of hiding behind it.
 *
 * The check is "is there a *future* published trip", not "is there a trip": a stack left running for a
 * week would otherwise keep announcing a departure that left on Monday.
 */
async function seedDemoTrip(client, log = () => {}) {
  const owner = '33333333-3333-4333-8333-333333333333';
  const org = 'aaaaaaaa-0000-4000-8000-000000000001';
  const vehicle = '7925cdf3-5648-4b52-9f84-8ad8fa68aae2';
  const driver = '7925cdf3-0000-4000-8000-00000000d001';

  const existing = await client.query(
    `select 1 from public.trips
      where owner_org_id = $1
        and status = 'published'
        and departure_at > now() + interval '12 hours'
      limit 1`,
    [org],
  );
  if (existing.rows.length > 0) return;

  const governorateId = async (code) =>
    (await client.query('select id from public.governorates where code = $1', [code])).rows[0]
      ?.id ?? null;

  const created = await client.query(
    `select public.cmd_create_trip($1::uuid, $2::uuid, $3::jsonb, 'dev-seed', null) as result`,
    [
      owner,
      org,
      JSON.stringify({
        vehicleId: vehicle,
        driverId: driver,
        originGovernorateId: await governorateId('YE-AD'),
        destinationGovernorateId: await governorateId('YE-SA'),
        // A day and a bit out, at a tidy hour, so "departs tomorrow morning" reads like a timetable.
        departureAt: new Date(Date.now() + 39 * 60 * 60 * 1000).toISOString(),
        arriveEstimateMinutes: 480,
        seatsTotal: 14,
        bookingMode: 'per_seat',
        pricingMode: 'flat',
        pricePerSeatYer: 5000,
        discountKind: 'none',
        discountValue: 0,
        genderPolicy: 'any',
        paymentPolicy: 'cash',
        luggageAllowanceKg: 20,
        notes: 'رحلة تجريبية من عدن إلى صنعاء.',
      }),
    ],
  );
  const tripId = created.rows[0].result.trip.id;

  // The stops are gazetteer places, not free text, so the demo trip has coordinates: without them the
  // live screen can say which stop is next but never how far away it is, and Phase 6's distance story
  // would be invisible in every demo. The ids are looked up by name rather than hard-coded, because the
  // geography seed owns them.
  const { rows: cityRows } = await client.query(
    `select id, name_ar from public.places
      where name_ar = any($1::text[]) and lat is not null and lng is not null`,
    [['عدن', 'تعز', 'صنعاء']],
  );
  const placeId = new Map(cityRows.map((row) => [row.name_ar, row.id]));

  await client.query(
    `select public.cmd_set_trip_stops($1::uuid, $2::uuid, $3::jsonb, 'dev-seed', null)`,
    [
      owner,
      tripId,
      JSON.stringify([
        {
          placeId: placeId.get('عدن') ?? null,
          nameAr: 'عدن',
          nameEn: 'Aden',
          arriveOffsetMinutes: 0,
        },
        {
          placeId: placeId.get('تعز') ?? null,
          nameAr: 'تعز',
          nameEn: 'Taiz',
          arriveOffsetMinutes: 240,
        },
        {
          placeId: placeId.get('صنعاء') ?? null,
          nameAr: 'صنعاء',
          nameEn: 'Sanaa',
          arriveOffsetMinutes: 480,
        },
      ]),
    ],
  );

  await client.query(`select public.cmd_publish_trip($1::uuid, $2::uuid, 'dev-seed', null)`, [
    owner,
    tripId,
  ]);

  log(`  seeded a bookable trip: ${created.rows[0].result.trip.code}`);
}

/**
 * Two more departures, so the marketplace is a marketplace.
 *
 * One published trip is enough to prove the booking flow works and far too little to prove the
 * marketplace does: with a single card there is no second column to get wrong, no sort to change, no
 * origin facet with two counts in it, and the "direct" badge — the one that says a trip has no stops —
 * can never appear at all. Every layout bug that only shows up with a real list stays invisible in the
 * demo that is meant to show the list.
 *
 * The extra vans are seeded first (this runs after them), so these are three departures on three
 * different vehicles and two different routes. Written through the same three commands as the primary
 * trip, so a reset re-proves `cmd_create_trip`, `cmd_set_trip_stops` and `cmd_publish_trip` for each.
 */
async function seedMarketplaceTrips(client, log = () => {}) {
  const owner = '33333333-3333-4333-8333-333333333333';
  const org = 'aaaaaaaa-0000-4000-8000-000000000001';
  const driver = '7925cdf3-0000-4000-8000-00000000d001';

  const governorateId = async (code) =>
    (await client.query('select id from public.governorates where code = $1', [code])).rows[0]
      ?.id ?? null;
  const placeId = async (nameAr) =>
    (
      await client.query(
        'select id from public.places where name_ar = $1 and lat is not null and lng is not null limit 1',
        [nameAr],
      )
    ).rows[0]?.id ?? null;

  const departures = [
    {
      vehicle: '7925cdf3-0000-4000-8000-00000000c001',
      origin: 'YE-AD',
      destination: 'YE-TA',
      inHours: 55,
      arriveEstimateMinutes: 300,
      seatsTotal: 22,
      pricePerSeatYer: 2_500,
      luggageAllowanceKg: 15,
      notes: 'رحلة تجريبية مباشرة من عدن إلى تعز.',
      // No stops at all: this is the trip that gives the "direct" badge and the direct filter a count.
      stops: [],
    },
    {
      vehicle: '7925cdf3-0000-4000-8000-00000000c002',
      origin: 'YE-SA',
      destination: 'YE-AD',
      inHours: 74,
      arriveEstimateMinutes: 480,
      seatsTotal: 26,
      pricePerSeatYer: 4_500,
      genderPolicy: 'women_only',
      luggageAllowanceKg: 25,
      notes: 'رحلة تجريبية من صنعاء إلى عدن عبر تعز.',
      stops: [
        { nameAr: 'صنعاء', nameEn: 'Sanaa', arriveOffsetMinutes: 0 },
        { nameAr: 'تعز', nameEn: 'Taiz', arriveOffsetMinutes: 240 },
        { nameAr: 'عدن', nameEn: 'Aden', arriveOffsetMinutes: 480 },
      ],
    },
  ];

  for (const spec of departures) {
    const originId = await governorateId(spec.origin);
    const destinationId = await governorateId(spec.destination);
    if (!originId || !destinationId) continue;

    // Per route, not per organization: a stack that was left running must not grow a second copy of the
    // same departure every time it restarts, and the primary trip already exists by the time this runs.
    const already = await client.query(
      `select 1 from public.trips
        where owner_org_id = $1
          and status = 'published'
          and origin_governorate_id = $2
          and destination_governorate_id = $3
          and departure_at > now() + interval '12 hours'
        limit 1`,
      [org, originId, destinationId],
    );
    if (already.rows.length > 0) continue;

    const created = await client.query(
      `select public.cmd_create_trip($1::uuid, $2::uuid, $3::jsonb, 'dev-seed', null) as result`,
      [
        owner,
        org,
        JSON.stringify({
          vehicleId: spec.vehicle,
          driverId: driver,
          originGovernorateId: originId,
          destinationGovernorateId: destinationId,
          departureAt: new Date(Date.now() + spec.inHours * 60 * 60 * 1000).toISOString(),
          arriveEstimateMinutes: spec.arriveEstimateMinutes,
          seatsTotal: spec.seatsTotal,
          bookingMode: 'per_seat',
          pricingMode: 'flat',
          pricePerSeatYer: spec.pricePerSeatYer,
          discountKind: 'none',
          discountValue: 0,
          genderPolicy: spec.genderPolicy ?? 'any',
          paymentPolicy: 'cash',
          luggageAllowanceKg: spec.luggageAllowanceKg,
          notes: spec.notes,
        }),
      ],
    );
    const trip = created.rows[0].result.trip;

    if (spec.stops.length > 0) {
      const stops = [];
      for (const stop of spec.stops) {
        stops.push({
          placeId: await placeId(stop.nameAr),
          nameAr: stop.nameAr,
          nameEn: stop.nameEn,
          arriveOffsetMinutes: stop.arriveOffsetMinutes,
        });
      }
      await client.query(
        `select public.cmd_set_trip_stops($1::uuid, $2::uuid, $3::jsonb, 'dev-seed', null)`,
        [owner, trip.id, JSON.stringify(stops)],
      );
    }

    await client.query(`select public.cmd_publish_trip($1::uuid, $2::uuid, 'dev-seed', null)`, [
      owner,
      trip.id,
    ]);

    log(`  seeded a marketplace trip: ${trip.code}`);
  }
}

/**
 * One passenger booking, accepted, so `/account/bookings` is a list rather than an empty state.
 *
 * The booking card — route, status badge, reference, fare, and the "finish identity" action — is the whole
 * screen when a passenger has bookings, and it was never rendered by the demo. Booked on the *direct* trip
 * because that one has no stops: the flow then runs with a null destination stop, which is the branch a
 * stop-priced trip never reaches.
 *
 * Accepted, not pending: a pending booking carries a 30-minute hold, and a demo that expires while somebody
 * is looking at it is worse than no demo. Accepted by the owner account because that is the actor
 * `cmd_accept_booking` accepts for this trip, and it is also the account the accessibility guard signs in as.
 */
async function seedDemoBooking(client, log = () => {}) {
  const owner = '33333333-3333-4333-8333-333333333333';
  const org = 'aaaaaaaa-0000-4000-8000-000000000001';

  const existing = await client.query(
    `select 1 from public.bookings b
       join public.trips t on t.id = b.trip_id
      where b.passenger_id = $1
        and b.status in ('pending', 'accepted')
        and t.departure_at > now()
      limit 1`,
    [owner],
  );
  if (existing.rows.length > 0) return;

  const trip = (
    await client.query(
      `select t.id from public.trips t
        where t.owner_org_id = $1
          and t.status = 'published'
          and t.departure_at > now() + interval '24 hours'
          and not exists (select 1 from public.trip_stops s where s.trip_id = t.id)
        order by t.departure_at
        limit 1`,
      [org],
    )
  ).rows[0];
  if (!trip) return;

  // `p_claimed_total` is null on purpose: this is a seed, not a client, and a claim it cannot compute is a
  // `PRICE_CHANGED` the seed has no business arguing with.
  const created = await client.query(
    `select public.cmd_create_booking(
       $1::uuid, $2::uuid, 1, null, null, 'مستخدم تجريبي', '+967733000101', null, null, 'dev-seed', null
     ) as result`,
    [owner, trip.id],
  );
  const booking = created.rows[0].result.booking;

  await client.query(`select public.cmd_accept_booking($1::uuid, $2::uuid, 'dev-seed', null)`, [
    owner,
    booking.id,
  ]);

  log(`  seeded a passenger booking: ${booking.code}`);
}

/**
 * A platform wallet and one receipt waiting for a human.
 *
 * Phase 9's screens are all empty states without this: the confirmation queue has nothing to confirm, the
 * accounts page has no rails to show, and the pay page cannot be reached because no intent exists. Seeded
 * through the commands — like every other seed — so a reset also re-proves the amount computation, the
 * one-receipt rule and the notification.
 */
async function seedDemoPayments(client, log = () => {}) {
  const admin = '11111111-1111-4111-8111-111111111111';
  const owner = '33333333-3333-4333-8333-333333333333';

  const existing = await client.query('select 1 from public.payment_intents limit 1');
  if (existing.rows.length > 0) return;

  await client.query(
    `select public.cmd_create_payment_account($1::uuid, $2::jsonb, 'dev-seed', null)`,
    [
      admin,
      JSON.stringify({
        kind: 'platform',
        method: 'jaib',
        accountNumber: '777111222',
        holderName: 'شركة معك للخدمات اللوجستية',
        providerLabel: 'Jaib',
        isDefault: true,
        instructionsAr: 'حوّل المبلغ إلى محفظة جيب 777111222 ثم أرفق صورة الإيصال.',
        instructionsEn: 'Transfer to the Jaib wallet 777111222, then attach the receipt.',
      }),
    ],
  );

  const booking = (
    await client.query(
      `select b.id, b.total_yer from public.bookings b
        where b.passenger_id = $1 and b.status = 'accepted'
        order by b.created_at desc limit 1`,
      [owner],
    )
  ).rows[0];
  if (!booking) return;

  // `claimedAmountYer` is the real fare, not a guess: a seed that lies about the amount is a seed that
  // proves `PRICE_CHANGED` works rather than that payments do.
  const created = await client.query(
    `select public.cmd_create_payment_intent($1::uuid, $2::jsonb, 'dev-seed', null) as result`,
    [
      owner,
      JSON.stringify({
        bookingId: booking.id,
        method: 'jaib',
        purpose: 'booking',
        claimedAmountYer: booking.total_yer,
        clientReference: 'dev-seed-payment',
      }),
    ],
  );
  const intent = created.rows[0].result.intent;

  await client.query(
    `select public.cmd_submit_payment_proof(
       $1::uuid, $2::uuid, $3, $4, $5, $6, 'dev-seed', null
     )`,
    [
      owner,
      intent.id,
      `${intent.id}/dev-receipt.jpg`,
      'f'.repeat(64),
      'JAIB-DEV-1001',
      booking.total_yer,
    ],
  );

  log(`  seeded a payment receipt awaiting confirmation: ${intent.code}`);
}

/**
 * Gives the demo staff account a supervisor assignment over the seeded region, so the
 * "districts covered" number on /admin/regions is not a hardcoded zero.
 */
/**
 * Money, from the events Phase 9 already queued.
 *
 * The outbox is drained first (`cmd_consume_outbox`), because that is what turns the confirmed payments the
 * seed created into journals — and draining it is also the code path the nightly job takes, so a broken job
 * shows up on the demo laptop rather than in production. Then one subscription, paid, and two expenses: one
 * from the operator's own pocket (no journal) and one settled from the balance (a journal), which is the
 * distinction the expenses screen exists to teach.
 */
async function seedDemoFinance(client, log = () => {}) {
  const ADMIN = '11111111-1111-4111-8111-111111111111';
  const OWNER = '33333333-3333-4333-8333-333333333333';
  const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';

  // The Phase 9 seed leaves one receipt awaiting confirmation — that is what the payments desk is for. It is
  // confirmed here so the ledger has a *booking* journal (cash, commission and the operator's payable), not
  // only the subscription one: a ledger with a single kind of entry proves very little.
  const pending = await client.query(
    `select id from public.payment_intents
      where status = 'awaiting_confirmation'
      order by created_at desc limit 1`,
  );
  if (pending.rows.length > 0) {
    await client.query('select public.cmd_confirm_payment($1, $2, $3, $4, null)', [
      ADMIN,
      pending.rows[0].id,
      'تأكيد تجريبي',
      'seed',
    ]);
  }

  await client.query('select public.cmd_consume_outbox($1, $2)', [ADMIN, 200]);

  // One subscription, started without a trial so an invoice exists, then paid so the revenue side of the
  // ledger has something in it. Idempotent: the commands refuse a second live subscription.
  const existing = await client.query(
    `select 1 from public.subscriptions where owner_org_id = $1 limit 1`,
    [ORG],
  );
  if (existing.rowCount === 0) {
    const started = await client.query(
      `select public.cmd_start_subscription($1, jsonb_build_object(
         'orgId', $2::text, 'planCode', 'pro', 'trial', false)) as result`,
      [ADMIN, ORG],
    );
    // The invoice is issued by the same command, so it is looked up rather than returned: the start command
    // answers with the subscription, and the bill is the next fact about it.
    const invoice = await client.query(
      `select id from public.invoices
        where subscription_id = $1 and status in ('issued', 'overdue')
        order by issued_at desc limit 1`,
      [started.rows[0]?.result?.subscription?.id ?? null],
    );
    const invoiceId = invoice.rows[0]?.id;
    if (invoiceId) {
      await client.query(`select public.cmd_pay_invoice($1, $2, 'ADP-2026-0001', 'seed', null)`, [
        ADMIN,
        invoiceId,
      ]);
    }
  }

  const expenses = await client.query(`select count(*)::int as count from public.expenses`);
  if (expenses.rows[0].count === 0) {
    await client.query(
      `select public.cmd_record_expense($1, jsonb_build_object(
         'orgId', $2::text, 'category', 'fuel', 'amountYer', 4200,
         'incurredOn', (current_date - 3)::text,
         'description', 'ديزل — خط عدن/المنصورة', 'settleFromBalance', true), 'seed', null)`,
      [OWNER, ORG],
    );
    await client.query(
      `select public.cmd_record_expense($1, jsonb_build_object(
         'orgId', $2::text, 'category', 'maintenance', 'amountYer', 15000,
         'incurredOn', (current_date - 6)::text,
         'description', 'صيانة فرامل — من جيب المشغّل', 'settleFromBalance', false), 'seed', null)`,
      [OWNER, ORG],
    );
  }

  const checks = await client.query('select public.cmd_run_integrity_check($1) as result', [ADMIN]);
  const failed = checks.rows[0]?.result?.failed ?? 0;
  log(
    `  finance seeded: journals, one paid subscription, two expenses, ${failed} integrity alert(s)`,
  );
}

async function grantDemoScope(client) {
  await client.query(`
    insert into public.geo_assignments (user_id, region_id, granted_by, reason)
    select '22222222-2222-4222-8222-222222222222', r.id,
           '11111111-1111-4111-8111-111111111111', 'تغطية تجريبية'
    from public.regions r
    where r.name_ar_norm = app.normalize_arabic('إقليم عدن والساحل')
      and not exists (
        select 1 from public.geo_assignments ga
        where ga.user_id = '22222222-2222-4222-8222-222222222222' and ga.region_id = r.id
      )
  `);

  // One pending place so the review queue has something in it.
  await client.query(`
    insert into public.places (kind, name_ar, name_en, governorate_id, district_id, lat, lng,
                               is_public, created_by, verification_status)
    select 'gathering_point', 'نقطة تجمع الشارع الخامس', 'Fifth Street gathering point',
           g.id, d.id, 12.7801, 45.0302, false,
           '33333333-3333-4333-8333-333333333333', 'pending'
    from public.governorates g
    join public.districts d on d.governorate_id = g.id
    where g.code = 'YE-AD' and d.name_ar_norm = app.normalize_arabic('كريتر')
      and not exists (select 1 from public.places where name_ar = 'نقطة تجمع الشارع الخامس')
  `);

  // Notifications for the admin, so the account screen shows a real list.
  await client.query(`
    insert into public.notifications (user_id, kind, title_key, params, link)
    select '11111111-1111-4111-8111-111111111111', 'verification_submitted',
           'notifications.placePending', jsonb_build_object('name', 'نقطة تجمع الشارع الخامس'), '/admin/places'
    where not exists (
      select 1 from public.notifications
      where user_id = '11111111-1111-4111-8111-111111111111'
        and title_key = 'notifications.placePending'
    )
  `);
}

/**
 * The other two vans: an overdue service and a healthy one.
 *
 * Everything here is dated **last month**, which is the point — the fleet dashboard's month columns must
 * keep showing the phase-8 acceptance numbers (59 500 fuel, 18 000 maintenance) while the *list* has
 * enough rows to be worth laying out. A demo with one row cannot show a filter, a stacked card, or a
 * three-state column, and every screenshot of this page would be a single line of table.
 *
 * Written through the commands, like every other seed, so a reset also re-proves them.
 */
async function seedExtraFleetOperations(client, log = () => {}) {
  const owner = '33333333-3333-4333-8333-333333333333';
  const dueVan = '7925cdf3-0000-4000-8000-00000000c001';
  const fineVan = '7925cdf3-0000-4000-8000-00000000c002';

  const existing = await client.query(
    'select 1 from public.fuel_logs where vehicle_id = $1 limit 1',
    [dueVan],
  );
  if (existing.rows.length > 0) return;

  log('  seeding the rest of the fleet…');

  const fill = async (vehicle, odometerKm, litres, daysAgo, station) => {
    await client.query('select public.cmd_log_fuel($1::uuid, $2::uuid, $3::jsonb, $4, null)', [
      owner,
      vehicle,
      JSON.stringify({
        odometerKm,
        litres,
        pricePerLitreYer: 500,
        isFullTank: true,
        filledAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
        stationName: station,
      }),
      `dev-seed-fuel-${vehicle.slice(-4)}-${odometerKm}`,
    ]);
  };

  // 900 km on 108 litres across two tanks — about 12 L/100km, which is what an old Coaster does.
  await fill(dueVan, 341_100, 55, 46, 'محطة الروضة — عدن');
  await fill(dueVan, 341_550, 53, 39, 'محطة النور — الزنجبار');
  // 640 km on 52 litres — a newer van, better economy, the contrast the list is meant to show. Dated two
  // months back on purpose: anything inside the current month moves the dashboard's month totals, and the
  // phase-8 acceptance figures (59 500 / 18 000) are quoted in the report.
  await fill(fineVan, 95_600, 52, 60, 'محطة الروضة — عدن');
  await fill(fineVan, 96_240, 48, 52, 'محطة الروضة — عدن');

  // Due at 340 000 with the van at 341 550: overdue by 1 550 km, so the red badge, the filter chip and
  // the callout all have a real vehicle behind them.
  await client.query(
    'select public.cmd_upsert_maintenance_schedule($1::uuid, $2::uuid, $3::jsonb, $4, null)',
    [
      owner,
      dueVan,
      JSON.stringify({ kind: 'oil_change', intervalKm: 5000, lastDoneKm: 335_000 }),
      'dev-seed-schedule-due',
    ],
  );
  // And one that is comfortably inside its interval, so "ok" is not an empty state either.
  await client.query(
    'select public.cmd_upsert_maintenance_schedule($1::uuid, $2::uuid, $3::jsonb, $4, null)',
    [
      owner,
      fineVan,
      JSON.stringify({ kind: 'oil_change', intervalKm: 5000, lastDoneKm: 94_000 }),
      'dev-seed-schedule-fine',
    ],
  );
}
