#!/usr/bin/env node
/**
 * Districts import helper (dry-run first, always).
 *
 * The seed in `00009_geography_seed.sql` is deliberately a *starter* set (Aden, Amanat Al Asimah,
 * Hadramaut and a few towns). The complete administrative list is OCHA's 333 districts (HDX
 * "Yemen — Subnational Administrative Boundaries"), which is not shipped in this repository: it
 * changes, and it is someone else's licence.
 *
 * This script converts that CSV into the exact row array `cmd_import_geo` expects, validates it,
 * and prints the command to run. It never touches the database itself — importing reference data
 * should be a deliberate, reviewable step, and the command is idempotent by
 * (governorate, normalised Arabic name).
 *
 *   node scripts/geo/import-districts.mjs --file ocha-districts.csv
 *   node scripts/geo/import-districts.mjs --file ocha-districts.csv --out districts.json
 *
 * Expected CSV header (order is free, extra columns are ignored):
 *   governorate_code,name_ar,name_en,pcode,lat,lng
 *   YE-AD,كريتر,Crater,YE-AD-01,12.7749,45.0369
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REQUIRED = ['governorate_code', 'name_ar', 'name_en'];

/** Minimal RFC-4180 parser: quotes, escaped quotes, CRLF. No dependencies. */
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      record.push(field);
      rows.push(record);
      record = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    rows.push(record);
  }
  return rows.filter((row) => row.some((cell) => cell.trim() !== ''));
}

function toNumber(value) {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Pure validation, so the rules can be reviewed (and tested) without touching a file. */
export function buildRows(text) {
  const table = parseCsv(text);
  if (table.length < 2) return { error: 'the CSV has no data rows', rows: [], problems: [] };

  const header = table[0].map((cell) => cell.trim().toLowerCase());
  const missing = REQUIRED.filter((name) => !header.includes(name));
  if (missing.length > 0) {
    return { error: `missing required column(s): ${missing.join(', ')}`, rows: [], problems: [] };
  }

  const column = (name) => header.indexOf(name);
  const rows = [];
  const problems = [];
  const seen = new Set();
  const perGovernorate = new Map();

  table.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const governorateCode = (cells[column('governorate_code')] ?? '').trim().toUpperCase();
    const nameAr = (cells[column('name_ar')] ?? '').trim();
    const nameEn = (cells[column('name_en')] ?? '').trim();

    if (!/^YE-[A-Z]{2}$/.test(governorateCode)) {
      problems.push(`line ${line}: governorate_code "${governorateCode}" is not ISO YE-xx`);
      return;
    }
    if (nameAr.length < 2 || nameEn.length < 2) {
      problems.push(`line ${line}: name_ar and name_en are required`);
      return;
    }

    const key = `${governorateCode}|${nameAr}`;
    if (seen.has(key)) {
      problems.push(`line ${line}: duplicate ${governorateCode} / ${nameAr}`);
      return;
    }
    seen.add(key);
    perGovernorate.set(governorateCode, (perGovernorate.get(governorateCode) ?? 0) + 1);

    rows.push({
      governorate_code: governorateCode,
      name_ar: nameAr,
      name_en: nameEn,
      pcode: (cells[column('pcode')] ?? '').trim() || null,
      lat: toNumber(cells[column('lat')]),
      lng: toNumber(cells[column('lng')]),
    });
  });

  return { error: null, rows, problems, perGovernorate };
}

async function main() {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf('--file');
  const outIndex = args.indexOf('--out');

  if (fileIndex === -1 || !args[fileIndex + 1]) {
    console.error('usage: node scripts/geo/import-districts.mjs --file <csv> [--out <json>]');
    process.exitCode = 2;
    return;
  }

  const file = resolve(process.cwd(), args[fileIndex + 1]);
  const out = outIndex === -1 ? null : resolve(process.cwd(), args[outIndex + 1]);

  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    console.error(`✗ cannot read ${file}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const { error, rows, problems, perGovernorate = new Map() } = buildRows(text);
  if (error) {
    console.error(`✗ ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`▶ ${file}`);
  console.log(`  rows parsed:   ${rows.length}`);
  console.log(`  governorates:  ${perGovernorate.size}`);
  if (perGovernorate.size !== 22) {
    console.log('  ⚠ Yemen has 22 governorates; check the governorate_code column');
  }
  if (rows.length < 300) {
    console.log(`  ⚠ Yemen has 333 districts; ${rows.length} rows looks incomplete`);
  }
  for (const problem of problems) console.log(`  ✗ ${problem}`);

  if (problems.length > 0) {
    console.error('\n✗ fix the problems above before importing');
    process.exitCode = 1;
    return;
  }

  const payload = { action: 'geo.import', kind: 'districts', dryRun: true, rows };
  if (out) {
    await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`\n✓ wrote ${out}`);
  }

  console.log(`
Next steps (dryRun is true, so the command writes nothing):
  1. POST the payload to the \`geography\` edge function as a platform admin:
       curl -sS "$SUPABASE_URL/functions/v1/geography" \\
         -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \\
         --data @${out ?? 'payload.json'}
     Compare added / updated / skipped with what you expect.
  2. Flip "dryRun" to false and POST again.
  3. Re-run the same import: it must report +0 ~0 -0.
`);
}

await main();
