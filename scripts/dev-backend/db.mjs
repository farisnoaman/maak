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

  await seedDemoFleet(client);

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
 * Gives the demo staff account a supervisor assignment over the seeded region, so the
 * "districts covered" number on /admin/regions is not a hardcoded zero.
 */
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
