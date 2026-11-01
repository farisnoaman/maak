#!/usr/bin/env node
/**
 * The restore drill, executed instead of described.
 *
 * `docs/runbook.md` §3 has said since Phase 12 that "a restore is only real once it has been executed", and the
 * report has said just as long that the RTO is therefore a *target*, not a measurement. Both statements were
 * honest and neither was useful: nobody runs a runbook page under pressure for the first time.
 *
 * This does the drill, on the database in front of it, and fails if the restored copy is not the same database:
 *
 *   1. **back up** — `pg_backup_start()` opens a hot-backup window, the data directory is copied while the
 *      server keeps serving, `pg_backup_stop()` closes it. That is exactly what a volume snapshot is, and it is
 *      the cheapest thing to rehearse;
 *   2. **restore** — a second embedded PostgreSQL is started *from the copy*, which means crash recovery from the
 *      copied WAL: the same path a snapshot restore takes;
 *   3. **verify** — row counts for the tables that matter, the ledger's two sides, `cmd_run_integrity_check`,
 *      the RLS/definer/command-grant posture, and a real `search_public_trips()` call whose total must match the
 *      source to the row. A restore that is not ledger-consistent and does not answer the same search is not a
 *      restore, it is a directory with files in it;
 *   4. **report** — phase timings and the verdict, printed and written to `docs/perf/restore-drill.txt`.
 *
 *   npm run drill:restore               # needs the dev database running (npm run dev:api)
 *   npm run drill:restore -- --keep      # leave the restored cluster in .dev/restore-drill for inspection
 *
 * Three things this deliberately does not claim:
 *   · it is **dev scale** — 50,000 seeded trips and 60-odd MB, not the hosted project, so the seconds below are a
 *     floor: production adds the download, WAL replay to a point in time, and pointing the app at the result;
 *   · it rehearses the **file-copy** restore, not `pg_dump`/`pg_restore`. The logical path is in the runbook and
 *     it exercises the same verification block — the checks are the part that has to be right, and they are
 *     the part this script proves;
 *   · Storage is copied file-for-file and compared against `storage.objects`, not through a bucket API.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};

const HOST = String(process.env.MAAK_PG_HOST ?? '127.0.0.1');
const SOURCE_PORT = Number(process.env.MAAK_PG_PORT ?? 54322);
const TARGET_PORT = Number(arg('target-port', String(SOURCE_PORT + 1)));
const KEEP = arg('keep', false) === true;
const OUT = resolve(root, String(arg('out', 'docs/perf/restore-drill.txt')));
const DRILL_DIR = join(root, '.dev', 'restore-drill');
const RTO_SECONDS = 3600;

const CONNECTION = {
  host: HOST,
  port: SOURCE_PORT,
  user: process.env.MAAK_PG_USER ?? 'postgres',
  password: process.env.MAAK_PG_PASSWORD ?? 'postgres',
  database: process.env.MAAK_PG_DATABASE ?? 'postgres',
};

/**
 * The tables whose row counts go in the report.
 *
 * Not every table — the ones whose loss or truncation would be discovered too late: the people, the catalogue,
 * the books, the notification stack, and the two search structures that are derived and therefore usually the
 * first things a restore forgets to rebuild.
 */
const TABLES = [
  'public.profiles',
  'public.organizations',
  'public.vehicles',
  'public.trips',
  'public.trips_search',
  'public.bookings',
  'public.ledger_entries',
  'public.journal_entries',
  'public.invoices',
  'public.payouts',
  'public.refunds',
  'public.notifications',
  'public.saved_searches',
  'public.search_counts',
  'audit.log',
  'storage.objects',
];

/**
 * `audit.log` cannot be counted whole: verifying the copy calls `cmd_run_integrity_check`, which appends a
 * `finance.integrity_check` row. Both databases run that check, at different points, so the only meaningful
 * comparison is of the rows the drill did not write itself. (The first version of this script failed here —
 * 37 against 38 — and the failure was the script, not the restore, which is the right way round to find out.)
 */
const COUNT_EXCEPT = {
  'audit.log': `where action <> 'finance.integrity_check'`,
};

const log = (line) => console.log(line);

/**
 * Exiting is not `process.exitCode` here, and the reason is worth the paragraph.
 *
 * `embedded-postgres` depends on `async-exit-hook`, which hooks `beforeExit` and calls `process.exit(0)` from it —
 * so a drill that *failed* exited 0 and told CI everything was fine. (Found by testing the failure path, which is
 * the only way this kind of thing is ever found.) Flushing stdout and exiting explicitly is the one ordering a
 * dependency cannot rewrite.
 */
async function finish(code) {
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(code);
}
const ms = (value) => `${(value / 1000).toFixed(2)} s`;
const bytes = (value) =>
  value > 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(value / 1024))} kB`;

async function sizeOf(path) {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += await sizeOf(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

async function countFiles(path) {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countFiles(join(path, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

/**
 * Everything the drill compares, computed the same way on both databases.
 *
 * A fingerprint beats a hand-written list of assertions because it cannot quietly skip the check that would have
 * caught the problem: every key is compared, and a key that exists on one side only is a failure.
 */
async function fingerprint(client, label) {
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];

  const rows = {};
  for (const table of TABLES) {
    rows[table] = Number(
      (await one(`select count(*)::int as n from ${table} ${COUNT_EXCEPT[table] ?? ''}`)).n,
    );
  }

  const ledger = await one(`
    select coalesce(sum(amount_yer) filter (where direction = 'debit'), 0)::numeric as debit,
           coalesce(sum(amount_yer) filter (where direction = 'credit'), 0)::numeric as credit
      from public.ledger_entries
  `);

  const integrity = await one('select public.cmd_run_integrity_check(null, null, null) as r');
  // A search answer, not a row count: the restored database has to serve the same result set. `priceMax` here is
  // above every seeded price, so the total is "every public trip departing in the future" — 49,998 at seed time.
  const search = await one(`
    select public.search_public_trips('ar', '{"priceMax": 9000000}'::jsonb, 'soonest', null, 3) as r
  `);
  const rls = await one(`
    select count(*)::int as n
      from pg_class k
      join pg_namespace n on n.oid = k.relnamespace
     where n.nspname = 'public' and k.relkind = 'r' and not k.relrowsecurity
  `);
  const unpinned = await one(`
    select count(*)::int as n
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'app') and p.prosecdef
       and not exists (
         select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%'
       )
  `);
  const callable = await one(`
    select count(*)::int as n
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'cmd\\_%'
       and (has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('authenticated', p.oid, 'execute')
            or has_function_privilege('public', p.oid, 'execute'))
  `);

  if (label) {
    log(`  ${label}: ${rows['public.trips']} trips, integrity ${integrity.r?.status ?? 'unknown'}`);
  }

  return {
    rows,
    ledgerDebit: String(ledger.debit),
    ledgerCredit: String(ledger.credit),
    integrity: integrity.r?.status ?? 'unknown',
    integrityFailures: Number(integrity.r?.failed ?? 0),
    searchTotal: Number(search.r?.total ?? -1),
    rlsOff: Number(rls.n),
    unpinnedDefiners: Number(unpinned.n),
    clientCallableCommands: Number(callable.n),
  };
}

function compare(source, restored) {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  for (const table of TABLES) {
    const a = source.rows[table];
    const b = restored.rows[table];
    push(`${table}`, a === b, `${a} → ${b}`);
  }
  push(
    'ledger debit = credit',
    restored.ledgerDebit === restored.ledgerCredit,
    `${restored.ledgerDebit} / ${restored.ledgerCredit}`,
  );
  push(
    'ledger matches source',
    source.ledgerDebit === restored.ledgerDebit && source.ledgerCredit === restored.ledgerCredit,
    `${source.ledgerDebit} → ${restored.ledgerDebit}`,
  );
  push(
    'integrity check',
    restored.integrity === 'ok' && restored.integrityFailures === 0,
    `${restored.integrity}, ${restored.integrityFailures} failed`,
  );
  push(
    'search answers the same total',
    source.searchTotal === restored.searchTotal,
    `${source.searchTotal} → ${restored.searchTotal}`,
  );
  push('RLS on every table', restored.rlsOff === 0, `${restored.rlsOff} without`);
  push(
    'definer search_path pinned',
    restored.unpinnedDefiners === 0,
    `${restored.unpinnedDefiners} unpinned`,
  );
  push(
    'no client-executable command',
    restored.clientCallableCommands === 0,
    `${restored.clientCallableCommands} callable`,
  );

  return checks;
}

/**
 * A drill that fails has to leave the same evidence a drill that passes does — otherwise the interesting run is
 * the one with no artifact, and the next person cannot tell a broken restore from a broken script.
 */
const report = { startedAt: new Date().toISOString(), phases: {}, checks: [], notes: [] };

async function main() {
  log('▸ restore drill');
  let code;
  const source = new Client(CONNECTION);
  let cluster;
  let target;

  try {
    await source.connect().catch((error) => {
      throw new Error(
        `cannot reach the database at ${HOST}:${SOURCE_PORT} (${error.code ?? error.message}).\n` +
          '  start the dev stack first:  npm run dev:api',
      );
    });

    const settings = await source.query(
      `select current_setting('data_directory') as dir,
              current_setting('server_version') as version,
              pg_size_pretty(pg_database_size(current_database())) as size`,
    );
    const { dir: dataDir, version, size } = settings.rows[0];
    log(`  source: PostgreSQL ${version}, ${size} — ${dataDir}`);

    const sourceFingerprint = await fingerprint(source);
    log(
      `  source: ${sourceFingerprint.rows['public.trips']} trips, integrity ${sourceFingerprint.integrity}`,
    );

    // ---- 1. back up -------------------------------------------------------------------------------------
    let started = Date.now();
    await rm(DRILL_DIR, { recursive: true, force: true });
    await mkdir(DRILL_DIR, { recursive: true });
    const copiedData = join(DRILL_DIR, 'pgdata');
    const copiedStorage = join(DRILL_DIR, 'storage');
    const storageDir = join(root, '.dev', 'storage');

    // Both statements must run on this connection, and outside an explicit transaction.
    const backup = await source.query(`select pg_backup_start('maak-restore-drill', true) as lsn`);
    try {
      await run('cp', ['-a', dataDir, copiedData]);
      if (existsSync(storageDir)) await run('cp', ['-a', storageDir, copiedStorage]);
    } finally {
      await source.query('select pg_backup_stop()');
    }
    // The copy is a second cluster now: the first one's lock file points at a directory that is not this one, and
    // PostgreSQL refuses to start on a mismatched lock.
    await rm(join(copiedData, 'postmaster.pid'), { force: true });
    await rm(join(copiedData, 'postmaster.opts'), { force: true });

    report.phases.backup = Date.now() - started;
    report.backupLsn = backup.rows[0].lsn;
    report.backupBytes = await sizeOf(copiedData);
    log(`  backed up in ${ms(report.phases.backup)} — ${bytes(report.backupBytes)}`);

    // ---- 2. restore -------------------------------------------------------------------------------------
    started = Date.now();
    cluster = new EmbeddedPostgres({
      databaseDir: copiedData,
      user: CONNECTION.user,
      password: CONNECTION.password,
      port: TARGET_PORT,
      persistent: true,
      onLog: () => {},
    });
    await cluster.start();
    report.phases.restore = Date.now() - started;
    log(
      `  restored onto ${HOST}:${TARGET_PORT} in ${ms(report.phases.restore)} (crash recovery from the copied WAL)`,
    );

    // ---- 3. verify --------------------------------------------------------------------------------------
    started = Date.now();
    target = new Client({ ...CONNECTION, port: TARGET_PORT });
    await target.connect();
    const restoredFingerprint = await fingerprint(target);
    const storageFiles = {
      source: await countFiles(storageDir),
      restored: await countFiles(copiedStorage),
    };
    report.checks = compare(sourceFingerprint, restoredFingerprint);
    report.checks.push({
      name: 'storage objects copied file for file',
      ok: storageFiles.source === storageFiles.restored,
      detail: `${storageFiles.source} → ${storageFiles.restored}`,
    });
    if (storageFiles.source !== restoredFingerprint.rows['storage.objects']) {
      report.notes.push(
        `storage drift already present in the source: ${storageFiles.source} files, ` +
          `${restoredFingerprint.rows['storage.objects']} storage.objects rows`,
      );
    }
    report.phases.verify = Date.now() - started;

    const failed = report.checks.filter((check) => !check.ok);
    log('');
    log('  check                                         result');
    log('  ─────────────────────────────────────────────────────────────────');
    for (const check of report.checks) {
      log(`  ${check.name.padEnd(44)} ${(check.ok ? '✓' : '✗').padEnd(4)} ${check.detail}`);
    }
    log('');

    report.totalMs = report.phases.backup + report.phases.restore + report.phases.verify;

    // ---- 4. tear down -----------------------------------------------------------------------------------
    started = Date.now();
    await target.end();
    target = null;
    await cluster.stop();
    cluster = null;
    if (!KEEP) await rm(DRILL_DIR, { recursive: true, force: true });
    report.phases.teardown = Date.now() - started;

    writeReport({
      ...report,
      failed,
      dataDir,
      version,
      size,
      storageFiles,
      sourceFingerprint,
      restoredFingerprint,
    });

    log(
      `  ${failed.length === 0 ? '✓ drill passed' : `✗ drill failed: ${failed.length} check(s)`}`,
    );
    log(
      `  end to end ${ms(report.totalMs)} (backup ${ms(report.phases.backup)}, restore ${ms(report.phases.restore)}, verify ${ms(report.phases.verify)})`,
    );
    log(
      `  RTO target ${RTO_SECONDS / 60} min — ${report.totalMs / 1000 < RTO_SECONDS ? 'inside it' : 'OVER it'}; written to ${OUT.slice(root.length + 1)}`,
    );
    if (KEEP)
      log(`  restored cluster kept in ${DRILL_DIR.slice(root.length + 1)} (port ${TARGET_PORT})`);

    code = failed.length === 0 ? 0 : 1;
  } catch (error) {
    if (target) await target.end().catch(() => {});
    if (cluster) await cluster.stop().catch(() => {});
    report.error = error.message;
    await writeReport(report);
    console.error(`✖ restore drill failed to run: ${error.message}`);
    code = 1;
  } finally {
    await source.end().catch(() => {});
  }

  await finish(code);
}

/**
 * The artifact is the point of the exercise: a drill whose result lives in a terminal scrollback is a drill
 * nobody can point at during an incident.
 */
async function writeReport(report) {
  const phase = (name) => ms(report.phases[name] ?? 0);
  const lines = [
    '# The restore drill, executed',
    '',
    `Run ${report.startedAt} by \`npm run drill:restore\` on PostgreSQL ${report.version ?? '?'},`,
    `${report.size ?? '?'} of data, backup ${bytes(report.backupBytes ?? 0)} taken hot`,
    `(\`pg_backup_start\` at LSN ${report.backupLsn ?? '—'}).`,
    '',
    ...(report.error
      ? [`**The drill did not complete:** ${report.error}`, '']
      : [
          `**Outcome:** ${report.failed.length === 0 ? 'passed' : `${report.failed.length} check(s) failed`}.`,
          '',
        ]),
    '| Phase | What it did | Time |',
    '| --- | --- | --- |',
    `| Backup | copy of \`${report.dataDir ?? '—'}\` inside a hot-backup window | ${phase('backup')} |`,
    `| Restore | second cluster started from the copy, crash recovery over the copied WAL | ${phase('restore')} |`,
    `| Verify | ${report.checks.length} checks against the source | ${phase('verify')} |`,
    `| Teardown | stop and remove the restored cluster | ${phase('teardown')} |`,
    `| **End to end** | | **${ms(report.totalMs ?? 0)}** |`,
    '',
    `RTO target: under ${RTO_SECONDS / 60} minutes. Measured: **${ms(report.totalMs ?? 0)}** — ` +
      `${(report.totalMs ?? 0) / 1000 < RTO_SECONDS ? 'inside the target' : 'OVER the target'}.`,
    '',
    '## Checks',
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    ...report.checks.map(
      (check) => `| ${check.name} | ${check.ok ? 'pass' : '**fail**'} | ${check.detail} |`,
    ),
    '',
    ...(report.notes.length > 0
      ? ['## Notes', '', ...report.notes.map((note) => `- ${note}`), '']
      : []),
    '## What this does not prove',
    '',
    '- It is dev scale. Production adds the download, replay to a point in time and pointing the app at the',
    '  result; the target has to be re-measured there, and `docs/runbook.md` §3 says how.',
    '- It rehearses the file-copy restore, not `pg_dump`/`pg_restore`. The verification block above is the same',
    '  one to run after either, which is why it is a script and not a paragraph.',
    '- It copies Storage file for file and compares it with `storage.objects`; a bucket-level restore (versioning,',
    '  missing objects) still has to be shown on the hosted project.',
    '',
  ];
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, lines.join('\n'), 'utf8').catch((error) =>
    console.error(`  ⚠ could not write ${OUT}: ${error.message}`),
  );
}

main();
