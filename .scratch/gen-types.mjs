import pg from 'pg';
import { readFileSync, writeFileSync } from 'node:fs';

const TABLES = ['trips', 'trip_stops', 'trip_events', 'trip_verifications', 'trips_search', 'search_cache'];
const IFACE = {
  trips: 'Trip', trip_stops: 'TripStop', trip_events: 'TripEvent',
  trip_verifications: 'TripVerification', trips_search: 'TripSearchRow', search_cache: 'SearchCacheRow',
};
const ENUMS = {
  trip_status: 'TripStatus', trip_event_kind: 'TripEventKind',
  trip_booking_mode: 'TripBookingMode', trip_pricing_mode: 'TripPricingMode',
  trip_discount_kind: 'TripDiscountKind', trip_discount_scope: 'TripDiscountScope',
  trip_gender_policy: 'TripGenderPolicy', trip_payment_policy: 'TripPaymentPolicy',
  verification_status: 'VerificationStatus',
};
const TS = {
  uuid: 'string', text: 'string', timestamptz: 'string', date: 'string',
  integer: 'number', smallint: 'number', bigint: 'number', boolean: 'boolean', jsonb: 'Json',
  'uuid[]': 'string[]',
};

const c = new pg.Client({ host: '127.0.0.1', port: 54322, user: 'postgres', password: 'postgres', database: 'postgres' });
await c.connect();
const cols = await c.query(
  `select table_name, column_name, data_type, udt_name,
          (data_type = 'ARRAY') as is_array
   from information_schema.columns
   where table_schema = 'public' and table_name = any($1::text[])
   order by table_name, ordinal_position`, [TABLES]);
const notNull = await c.query(
  `select table_name, column_name, is_nullable from information_schema.columns
   where table_schema='public' and table_name = any($1::text[])`, [TABLES]);
const nulls = new Set(notNull.rows.filter(r => r.is_nullable === 'YES').map(r => `${r.table_name}.${r.column_name}`));

const BY_UDT = {
  timestamptz: 'string', timestamp: 'string', date: 'string', uuid: 'string',
  text: 'string', varchar: 'string', bpchar: 'string', citext: 'string',
  int4: 'number', int8: 'number', int2: 'number', numeric: 'number', float8: 'number',
  bool: 'boolean', jsonb: 'Json', json: 'Json', inet: 'string', _text: 'string[]', _uuid: 'string[]',
};

function tsType(row) {
  const udt = row.data_type === 'ARRAY' ? `_${row.udt_name.replace(/^_/, '')}` : row.udt_name;
  if (ENUMS[udt]) return ENUMS[udt];
  return BY_UDT[udt] ?? `unknown /* ${row.data_type} ${row.udt_name} */`;
}

let out = '';
for (const table of TABLES) {
  const rows = cols.rows.filter(r => r.table_name === table);
  out += `export interface ${IFACE[table]} {\n`;
  for (const r of rows) {
    const optional = nulls.has(`${table}.${r.column_name}`) ? ' | null' : '';
    out += `  ${r.column_name}: ${tsType(r)}${optional};\n`;
  }
  out += `}\n\n`;
}
writeFileSync('/home/user/.scratch/interfaces.txt', out);

let entries = '';
for (const table of TABLES) {
  entries += `      ${table}: {\n        Row: ${IFACE[table]};\n        Insert: Partial<${IFACE[table]}>;\n        Update: Partial<${IFACE[table]}>;\n      };\n`;
}
writeFileSync('/home/user/.scratch/entries.txt', entries);
console.log(out.slice(0, 900));
console.log('---');
console.log('tables:', TABLES.length);
await c.end();
