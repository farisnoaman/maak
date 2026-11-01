#!/usr/bin/env node
/**
 * SQL harness — runs the REAL migrations and the REAL pgTAP test files against a real PostgreSQL.
 *
 * Why this exists: `supabase test db` needs Docker, which is not always available (and was not in
 * the environment Phase 0/1 were built in, so the SQL had never actually been executed). An
 * unexecuted migration is a rumour, not a guarantee. This harness closes that gap:
 *
 *   1. boots an embedded PostgreSQL (no Docker, no daemon)
 *   2. installs a minimal Supabase stand-in: roles, `auth.users`, `storage.*`, pgTAP shim
 *      (`scripts/sql-check/bootstrap.sql` — platform surface only, no Maak rules)
 *   3. applies every `supabase/migrations/*.sql` in order and fails on the first error
 *   4. runs every `supabase/tests/*.test.sql` and parses TAP output
 *   5. checks `database.types.ts` against the live schema (table and column drift)
 *
 * Known substitution: PostGIS is not part of the embedded build, so the single
 * `create extension if not exists postgis;` statement in 00001 is skipped (logged loudly). Nothing in
 * Phase 0/1 needs geometry; from Phase 2 the harness reports which files it could not fully cover.
 *
 *   node scripts/sql-check.mjs            # migrations + tests + type drift
 *   node scripts/sql-check.mjs --keep     # leave the data directory behind for inspection
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'supabase', 'migrations');
const testsDir = join(root, 'supabase', 'tests');
const typesPath = join(root, 'apps', 'web', 'src', 'lib', 'supabase', 'database.types.ts');

const keep = process.argv.includes('--keep');
const POSTGIS_MISSING = 'create extension if not exists postgis;';
const PGTAP_MISSING = 'create extension if not exists pgtap;';

const problems = [];
function fail(message) {
  problems.push(message);
  console.log(`  ✗ ${message}`);
}
function pass(message) {
  console.log(`  ✓ ${message}`);
}

/** Multi-statement query → node-postgres returns an array of results. */
function tapLines(results) {
  const lines = [];
  for (const result of Array.isArray(results) ? results : [results]) {
    for (const row of result?.rows ?? []) {
      const value = Object.values(row)[0];
      if (typeof value === 'string' && /^(not ok|ok|\d+\.\.)/.test(value)) lines.push(value);
    }
  }
  return lines;
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'maak-pg-'));
  console.log(`▶ embedded PostgreSQL in ${dataDir}`);

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: 55432,
    persistent: keep,
    // The migrations contain Arabic (names, normalisation rules) and U&'…' escapes; a SQL_ASCII
    // cluster would refuse them. Supabase itself is UTF8, so the harness must be too.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'client_encoding=UTF8', '-c', 'timezone=UTC'],
    onLog: () => {},
  });

  let client;
  try {
    await pg.initialise();
    await pg.start();
    client = pg.getPgClient();
    await client.connect();

    console.log('\n▶ bootstrap: Supabase stand-in');
    await client.query(await readFile(join(root, 'scripts', 'sql-check', 'bootstrap.sql'), 'utf8'));
    pass('roles, auth.users, storage.* and the pgTAP shim are in place');

    console.log('\n▶ migrations');
    const migrations = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of migrations) {
      let sql = await readFile(join(migrationsDir, file), 'utf8');
      let substituted = false;
      if (sql.includes(POSTGIS_MISSING)) {
        sql = sql.replace(POSTGIS_MISSING, '-- [sql-check] postgis is not in the embedded build');
        substituted = true;
      }
      try {
        await client.query(sql);
        pass(`${file}${substituted ? ' (postgis line skipped)' : ''}`);
      } catch (error) {
        fail(`${file}: ${error.message}`);
        throw new Error(`migration ${file} failed`, { cause: error });
      }
    }

    console.log('\n▶ pgTAP suites');
    const tests = (await readdir(testsDir)).filter((f) => f.endsWith('.test.sql')).sort();
    for (const file of tests) {
      let sql = await readFile(join(testsDir, file), 'utf8');
      // The committed files request the real extension; here the shim from bootstrap.sql provides
      // the same function names, so only the `create extension` line is dropped.
      sql = sql.replace(PGTAP_MISSING, '-- [sql-check] pgtap extension replaced by the shim');
      // The shim lives in `tap`; the real extension lives in `public`. Put both on the path so the
      // committed test files run unmodified (they call plan/ok/is unqualified).
      sql = sql.replace(/begin;/i, 'begin;\nset local search_path = public, tap;');
      try {
        const results = await client.query(sql);
        const lines = tapLines(results);
        const failed = lines.filter((line) => line.startsWith('not ok'));
        const ran = lines.filter((line) => /^(not )?ok/.test(line)).length;
        if (failed.length > 0) {
          for (const line of failed) fail(`${file}: ${line}`);
        } else {
          pass(`${file}: ${ran} assertions`);
        }
      } catch (error) {
        // `position` is the character offset into the multi-statement string, so it maps back to the
        // line of the test file that failed — without it a 900-line suite says only "syntax error".
        const position = Number(error.position);
        const line = Number.isFinite(position) ? sql.slice(0, position).split('\n').length : null;
        const detail = error.detail ? ` [${error.detail}]` : '';
        fail(`${file}: ${error.message}${detail}${line === null ? '' : ` (line ${line})`}`);
        // The file opens a transaction; an error leaves it aborted, which would poison everything
        // that follows (including the type check).
        await client.query('rollback').catch(() => {});
      }
    }

    console.log('\n▶ database.types.ts drift');
    const drift = await checkTypes(client);
    if (drift.length === 0) {
      pass('every public table and column is present in database.types.ts');
    } else {
      for (const item of drift) fail(item);
    }

    console.log('\n▶ security posture');
    const security = await checkSecurity(client);
    if (security.length === 0) {
      pass(
        'RLS everywhere, definer functions pinned to a search_path, no client-executable command',
      );
    } else {
      for (const item of security) fail(item);
    }

    console.log('\n▶ write lockdown spot-check');
    const leaks = await client.query(`
      select table_name, grantee, privilege
      from app.audit_client_write_grants()
    `);
    if (leaks.rowCount === 0) {
      pass('no public table grants INSERT/UPDATE/DELETE to anon or authenticated');
    } else {
      for (const row of leaks.rows) {
        fail(`write grant leak: ${row.table_name} ${row.privilege} → ${row.grantee}`);
      }
    }
  } finally {
    if (client) await client.end().catch(() => {});
    await pg.stop().catch(() => {});
    if (!keep) await rm(dataDir, { recursive: true, force: true });
  }

  console.log('');
  if (problems.length > 0) {
    console.log(`✗ sql-check failed: ${problems.length} problem(s)`);
    process.exitCode = 1;
  } else {
    console.log('✓ sql-check passed: migrations applied, pgTAP suites green, types in sync');
  }
}

/**
 * The security review, as a query.
 *
 * Phase 12 asks for an "RLS matrix re-audit" and a "definer-function review". Both are answerable from the
 * catalogue, so they are answered on every run rather than in a document that ages: a new table without
 * `enable row level security`, a `security definer` function without `set search_path`, or a `cmd_*` that a
 * browser can execute is a build failure here.
 */
async function checkSecurity(client) {
  const problems = [];

  // 1. RLS on every table. A table without it is readable by anybody holding the anon key, which is in the
  //    browser bundle by definition.
  const noRls = await client.query(`
    select k.relname
      from pg_class k
      join pg_namespace n on n.oid = k.relnamespace
     where n.nspname = 'public'
       and k.relkind = 'r'
       and not k.relrowsecurity
     order by k.relname
  `);
  for (const row of noRls.rows)
    problems.push(`table without row level security: public.${row.relname}`);

  // 2. A read grant on a table with no policy is a screen that silently shows nothing someone expected to see.
  //    It is not a leak, but it is always a mistake, so it fails the same way.
  const silent = await client.query(`
    select k.relname
      from pg_class k
      join pg_namespace n on n.oid = k.relnamespace
     where n.nspname = 'public'
       and k.relkind = 'r'
       and k.relrowsecurity
       and not exists (select 1 from pg_policy p where p.polrelid = k.oid)
       and exists (
         select 1 from information_schema.role_table_grants g
          where g.table_schema = 'public' and g.table_name = k.relname
            and g.grantee in ('anon', 'authenticated')
            and g.privilege_type = 'SELECT'
       )
     order by k.relname
  `);
  for (const row of silent.rows)
    problems.push(
      `SELECT granted with no policy (a screen would read nothing): public.${row.relname}`,
    );

  // 3. Every SECURITY DEFINER function must pin its search_path. Without it, a caller who can create objects in
  //    a schema earlier on the path chooses which `public.foo` the body runs.
  const unpinned = await client.query(`
    select n.nspname, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'app')
       and p.prosecdef
       and not exists (
         select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
          where c like 'search_path=%'
       )
     order by n.nspname, p.proname
  `);
  for (const row of unpinned.rows)
    problems.push(`security definer without search_path: ${row.nspname}.${row.proname}`);

  // 4. No command may be executable by a browser role. The gateway is the only caller, with the service role.
  const clientCallable = await client.query(`
    select p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'cmd\\_%'
       and (has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('authenticated', p.oid, 'execute')
            or has_function_privilege('public', p.oid, 'execute'))
     order by p.proname
  `);
  for (const row of clientCallable.rows)
    problems.push(`command executable by a client role: public.${row.proname}`);

  return problems;
}

/**
 * Compares the live schema with the committed types file.
 *
 * This is deliberately blunt: table names and column names must match exactly. It catches the
 * failure that actually happens (a migration adds a column and the types are forgotten), without
 * reimplementing the Supabase type generator.
 */
async function checkTypes(client) {
  // Partitions are excluded: `trip_location_pings_202611` and `_default` are storage for one logical
  // table, and a monthly cron would otherwise turn into a weekly types edit.
  const { rows } = await client.query(`
    select c.table_name, c.column_name
    from information_schema.columns c
    join pg_class k on k.relname = c.table_name and k.relnamespace = 'public'::regnamespace
    where c.table_schema = 'public'
      and not k.relispartition
    order by c.table_name, c.ordinal_position
  `);

  const live = new Map();
  for (const row of rows) {
    if (!live.has(row.table_name)) live.set(row.table_name, new Set());
    live.get(row.table_name).add(row.column_name);
  }

  if (!existsSync(typesPath)) return ['database.types.ts is missing'];
  const source = await readFile(typesPath, 'utf8');

  const problems = [];

  // public.Tables block: the keys are the table names. Brace-counted, because the block contains
  // many nested `{ … }` object literals and a non-greedy regex would stop at the first one.
  const tablesBlock = extractBlock(source, 'Tables:');
  const typedTables = new Set(
    [...(tablesBlock ?? '').matchAll(/^\s{6}([a-z_]+):\s*\{/gm)].map((m) => m[1]),
  );

  for (const table of live.keys()) {
    if (!typedTables.has(table)) problems.push(`missing table in types: ${table}`);
  }
  for (const table of typedTables) {
    if (!live.has(table)) problems.push(`types mention a table that does not exist: ${table}`);
  }

  // Column names: each interface body, matched through the `Row:` reference in the Tables block.
  const rowMap = [...(tablesBlock ?? '').matchAll(/([a-z_]+):\s*\{\s*Row:\s*([A-Za-z]+);/g)].map(
    (m) => [m[1], m[2]],
  );

  for (const [table, interfaceName] of rowMap) {
    if (!live.has(table)) continue;
    const body = source.match(
      new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`),
    );
    if (!body) {
      problems.push(`interface ${interfaceName} (for ${table}) not found`);
      continue;
    }
    const typedColumns = new Set([...body[1].matchAll(/^\s{2}([a-z_]+)\??:/gm)].map((m) => m[1]));
    for (const column of live.get(table)) {
      if (!typedColumns.has(column)) problems.push(`missing column: ${table}.${column}`);
    }
    for (const column of typedColumns) {
      if (!live.get(table).has(column)) {
        problems.push(`types mention a column that does not exist: ${table}.${column}`);
      }
    }
  }

  return problems;
}

/** Returns the source inside the braced block that follows `marker`, brace-balanced. */
function extractBlock(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return null;
}

main().catch((error) => {
  console.error(`\n✗ sql-check crashed: ${error.message}`);
  process.exitCode = 1;
});
