/**
 * The PostgREST subset the app actually uses — executed as a real Postgres role, under real RLS.
 *
 * This is the important property: reads are **not** proxied through a privileged connection. Every
 * request runs `set local role authenticated` (or `anon`) with `request.jwt.claims` set, so the
 * policies in `supabase/migrations` decide what comes back. If a policy is wrong, the dev stack
 * shows it — which is exactly what a preview mode with fixtures could never do.
 *
 * Supported (deliberately small, documented in docs/dev-database.md):
 *   select=col,embed(cols) · col=eq.value · col=neq.value · col=in.(a,b) · col=is.null · col=not.is.null
 *   order=col.asc|desc · limit=n · Accept: application/vnd.pgrst.object+json (maybeSingle/single)
 */

import { signJwt } from './jwt.mjs';

/** Serialises access to the single pg connection: `set local role` must not leak between requests. */
export function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

/**
 * Parses `select=id,name,organizations(id,name_en)` into a tree.
 * Only `name` and `name(cols)` nodes are valid PostgREST select syntax, so anything else is a 400.
 */
export function parseSelect(select) {
  if (!select || select.trim() === '*') return { kind: 'all' };
  const nodes = [];
  let index = 0;

  const parseList = (stopAtParen) => {
    const items = [];
    let current = '';
    while (index < select.length) {
      const char = select[index];
      if (char === '(') {
        const name = current.trim();
        if (!name) throw new Error(`invalid select near "${name}"`);
        index += 1;
        const children = parseList(true);
        items.push({ name, children });
        current = '';
        continue;
      }
      if (char === ')') {
        if (!stopAtParen) throw new Error('unbalanced ")" in select');
        index += 1;
        if (current.trim()) items.push({ name: current.trim() });
        return items;
      }
      if (char === ',') {
        if (current.trim()) items.push({ name: current.trim() });
        current = '';
        index += 1;
        continue;
      }
      current += char;
      index += 1;
    }
    if (stopAtParen) throw new Error('unbalanced "(" in select');
    if (current.trim()) items.push({ name: current.trim() });
    return items;
  };

  nodes.push(...parseList(false));
  return { kind: 'list', nodes };
}

const quote = (identifier) => `"${String(identifier).replace(/"/g, '""')}"`;

/** Foreign keys, read once at startup: `{ table: { column: targetTable } }` and the reverse. */
export async function loadForeignKeys(client) {
  const { rows } = await client.query(`
    select
      tc.table_name      as table,
      kcu.column_name    as column,
      ccu.table_name     as foreign_table,
      ccu.column_name    as foreign_column
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
     and kcu.table_schema = tc.table_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
     and ccu.table_schema = tc.table_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema = 'public'
  `);

  const forward = new Map(); // table -> [{ column, foreignTable }]
  const reverse = new Map(); // table -> [{ foreignTable, foreignColumn }]
  for (const row of rows) {
    if (!forward.has(row.table)) forward.set(row.table, []);
    forward.get(row.table).push({ column: row.column, foreignTable: row.foreign_table });
    if (!reverse.has(row.foreign_table)) reverse.set(row.foreign_table, []);
    reverse.get(row.foreign_table).push({ table: row.table, column: row.column });
  }
  return { forward, reverse };
}

export async function loadColumns(client) {
  const { rows } = await client.query(`
    select table_name as table, column_name as column
    from information_schema.columns
    where table_schema = 'public'
  `);
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.table)) map.set(row.table, new Set());
    map.get(row.table).add(row.column);
  }
  return map;
}

function buildEmbed(node, baseTable, baseAlias, fks, columns) {
  const target = node.name;
  if (!columns.has(target)) throw new Error(`unknown relation "${target}"`);

  const children = node.children.length > 0 ? node.children : [{ name: '*' }];
  const inner = buildColumns(children, target, 'e', fks, columns, true);

  const fwd = (fks.forward.get(baseTable) ?? []).find((fk) => fk.foreignTable === target);
  const rev = (fks.reverse.get(baseTable) ?? []).find((fk) => fk.table === target);

  if (fwd) {
    // to-one: the base row points at the parent (places.governorate_id → governorates.id)
    return `(select row_to_json(x) from (select ${inner} from public.${quote(target)} e
             where e.${quote(fwd.column.includes('.') ? 'id' : 'id')} = ${baseAlias}.${quote(fwd.column)} limit 1) x)`;
  }
  if (rev) {
    // to-many: the child table points back at the base (region_governorates.region_id → regions.id)
    return `(select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
              select ${inner} from public.${quote(target)} e where e.${quote(rev.column)} = ${baseAlias}.id
            ) x)`;
  }
  throw new Error(`no foreign key links ${baseTable} and ${target}`);
}

function buildColumns(nodes, table, alias, fks, columns, skipUnknown = false) {
  const known = columns.get(table);
  const parts = [];
  for (const node of nodes) {
    if (node.name === '*') {
      parts.push(`${alias}.*`);
      continue;
    }
    if (node.children) {
      parts.push(`${buildEmbed(node, table, alias, fks, columns)} as ${quote(node.name)}`);
      continue;
    }
    if (!known || !known.has(node.name)) {
      if (skipUnknown) continue;
      throw new Error(`column ${table}.${node.name} does not exist`);
    }
    parts.push(`${alias}.${quote(node.name)}`);
  }
  return parts.length > 0 ? parts.join(', ') : `${alias}.*`;
}

/** `col=eq.x` → SQL predicate. `params` are passed through node-postgres, never interpolated. */
function buildFilters(searchParams, tableAlias, columns, table, params) {
  const reserved = new Set(['select', 'order', 'limit', 'offset']);
  const clauses = [];

  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    if (!columns.get(table)?.has(key)) throw new Error(`column ${table}.${key} does not exist`);
    const dot = raw.indexOf('.');
    // `col=not.is.null` is PostgREST's spelling of `.not('col', 'is', null)`, and this subset has to accept it
    // or the dev stack answers a filter the hosted one does honour: the divergence that sends you looking for a
    // bug in the client (see the note at the top of gateway.mjs).
    let operator = dot === -1 ? 'eq' : raw.slice(0, dot);
    let value = dot === -1 ? raw : raw.slice(dot + 1);
    const negated = operator === 'not';
    if (negated) {
      const next = value.indexOf('.');
      operator = next === -1 ? value : value.slice(0, next);
      value = next === -1 ? '' : value.slice(next + 1);
    }
    const column = `${tableAlias}.${quote(key)}`;
    const clause = (() => {
      if (operator === 'is') {
        if (value === 'null') return `${column} is null`;
        if (value === 'not.null') return `${column} is not null`;
        return `${column} is ${value === 'true'}`;
      }
      if (operator === 'in') {
        const list = value
          .replace(/^\(|\)$/g, '')
          .split(',')
          .filter(Boolean);
        params.push(list);
        return `${column} = any($${params.length})`;
      }
      const sqlOperator = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[operator];
      if (!sqlOperator) throw new Error(`unsupported operator "${operator}"`);
      params.push(value);
      return `${column} ${sqlOperator} $${params.length}`;
    })();
    clauses.push(negated ? `not (${clause})` : clause);
  }
  return clauses;
}

const SINGLE_OBJECT = 'application/vnd.pgrst.object+json';

/** One REST request. Returns `{ status, body, headers }`. */
export async function handleRest({ client, mutex, request, url, claims, fks, columns }) {
  const table = url.pathname.replace(/^\/rest\/v1\//, '');
  if (!table || table.includes('/')) return { status: 404, body: { message: 'not found' } };

  if (request.method !== 'GET') {
    return {
      status: 405,
      body: {
        code: 'FORBIDDEN',
        message: 'writes go through /functions/v1 (the single write path)',
      },
    };
  }

  return mutex(async () => {
    try {
      const params = [];
      const select = parseSelect(url.searchParams.get('select') ?? '*');
      const projection =
        select.kind === 'all' ? 'b.*' : buildColumns(select.nodes, table, 'b', fks, columns);

      const filters = buildFilters(url.searchParams, 'b', columns, table, params);
      const where = filters.length > 0 ? `where ${filters.join(' and ')}` : '';

      let order = '';
      const orderParam = url.searchParams.get('order');
      if (orderParam) {
        const [column, direction = 'asc'] = orderParam.split('.');
        if (!columns.get(table)?.has(column)) throw new Error(`unknown order column ${column}`);
        order = `order by b.${quote(column)} ${direction.toLowerCase() === 'desc' ? 'desc' : 'asc'}`;
      }

      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? Math.min(Number(limitParam) || 0, 1000) : null;

      const sql = `select ${projection} from public.${quote(table)} b ${where} ${order} ${
        limit ? `limit ${limit}` : ''
      }`;

      await client.query('begin');
      // The whole point: run as the client's role, with the client's claims. RLS applies.
      await client.query(
        claims.role === 'anon' ? 'set local role anon' : 'set local role authenticated',
      );
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(claims),
      ]);

      const result = await client.query(sql, params);
      await client.query('commit');

      const wantsObject = (request.headers.get('accept') ?? '').includes(SINGLE_OBJECT);
      if (wantsObject) {
        if (result.rows.length !== 1) {
          return {
            status: 406,
            body: {
              code: 'PGRST116',
              message: 'JSON object requested, multiple (or no) rows returned',
              details: `Results contain ${result.rows.length} rows`,
            },
          };
        }
        return { status: 200, body: result.rows[0] };
      }
      return {
        status: 200,
        body: result.rows,
        contentRange: `0-${Math.max(result.rows.length - 1, 0)}/${result.rows.length}`,
      };
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        /* the transaction may already be gone */
      }
      const message = String(error.message ?? error);
      const denied = /permission denied|row-level security|violates row-level/i.test(message);
      // A denied read is 200 [] in PostgREST for RLS, but a missing grant is a real 401/403.
      if (/permission denied/i.test(message))
        return { status: 403, body: { code: '42501', message } };
      return { status: denied ? 200 : 400, body: denied ? [] : { code: 'BAD_REQUEST', message } };
    }
  });
}

/** `POST /rest/v1/rpc/<fn>` — only functions explicitly granted to the client may run. */
export async function handleRpc({ client, mutex, url, body, claims }) {
  const fn = url.pathname.replace(/^\/rest\/v1\/rpc\//, '');
  if (!/^[a-z_][a-z0-9_]*$/i.test(fn)) return { status: 404, body: { message: 'not found' } };

  return mutex(async () => {
    try {
      await client.query('begin');
      await client.query(
        claims.role === 'anon' ? 'set local role anon' : 'set local role authenticated',
      );
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(claims),
      ]);

      const entries = Object.entries(body ?? {});
      const args = entries.map(([key], index) => `${quote(key)} => $${index + 1}`).join(', ');
      const result = await client.query(
        `select * from public.${quote(fn)}(${args})`,
        entries.map(([, value]) => value),
      );
      // PostgREST returns a scalar-returning function's value *directly* (`{"items":[…]}`), and only a
      // set-returning one as an array of rows (`[{"region_upsert":{…}}]`). Returning `rows` for both
      // meant a client that read `body.items` worked in production and saw `undefined` in development —
      // the kind of difference that gets debugged twice. Ask the catalog which shape applies.
      const meta = await client.query(
        `select p.proretset
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1
          limit 1`,
        [fn],
      );
      const setReturning = meta.rows[0]?.proretset === true;
      await client.query('commit');
      return {
        status: 200,
        body: setReturning ? result.rows : (result.rows[0]?.[fn] ?? null),
      };
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        /* ignore */
      }
      const message = String(error.message ?? error);
      if (/permission denied/i.test(message))
        return { status: 403, body: { code: '42501', message } };
      return { status: 400, body: { code: 'BAD_REQUEST', message } };
    }
  });
}

/** Signs the session object GoTrue returns after a successful password grant. */
export function sessionFor(user, refreshToken) {
  const claims = {
    sub: user.id,
    role: 'authenticated',
    email: user.email,
    phone: user.phone,
    session_id: refreshToken,
  };
  const accessToken = signJwt(claims);
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: refreshToken,
    user,
  };
}

export function publicUser(row) {
  return {
    id: row.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: row.email ?? null,
    phone: row.phone ?? null,
    email_confirmed_at: row.email ? new Date().toISOString() : null,
    phone_confirmed_at: null,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: row.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
