/**
 * The dev backend — one process, four surfaces.
 *
 *   /auth/v1/*        GoTrue subset (password + refresh sessions)
 *   /rest/v1/*        PostgREST subset, executed **as the caller** so RLS really applies
 *   /functions/v1/*   the write path (one `cmd_*` per request)
 *   /storage/*        local files, for verification documents
 *
 * It is deliberately *not* a Supabase emulator. It is the smallest thing that lets the real app —
 * real sessions, real RLS, real commands — run on a laptop without Docker.
 *
 *   node scripts/dev-backend/server.mjs          # 0.0.0.0:54321
 *   node scripts/dev-backend/server.mjs --reset  # drop the cluster first
 */

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

import { startDatabase } from './db.mjs';
import { verifyJwt, tokenFromRequest } from './jwt.mjs';
import { createMutex, handleRest, handleRpc, loadColumns, loadForeignKeys } from './rest.mjs';
import { handleAuth } from './auth.mjs';
import { handleFunction } from './gateway.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const storageDir = join(root, '.dev', 'storage');

export const API_PORT = Number(process.env.MAAK_API_PORT ?? 54321);
export const ANON_KEY = process.env.MAAK_ANON_KEY ?? 'maak-dev-anon-key';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, apikey, content-type, accept, prefer, x-client-info, x-upsert, x-maak-client, x-request-id, content-range',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'access-control-expose-headers': 'content-range, content-location, x-request-id',
  'access-control-max-age': '86400',
};

/** Bundles `@maak/core` (TypeScript) into a single ESM file Node can import. */
async function loadCore() {
  const outfile = join(root, '.dev', 'core.bundle.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [join(here, 'core-entry.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    external: [],
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

/** Authorization header → the claims RLS sees. `null` means "malformed token". */
function claimsFor(request) {
  const token = tokenFromRequest(request);
  if (!token || token === ANON_KEY) return { role: 'anon' };
  const claims = verifyJwt(token);
  if (!claims || claims.kind === 'refresh') return null;
  return { ...claims, role: 'authenticated' };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseJson(buffer) {
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return {};
  }
}

/** Minimal object storage. Paths are confined to `.dev/storage`, so `..` cannot escape. */
async function handleStorage({ request, url, claims }) {
  const parts = url.pathname.split('/').filter(Boolean); // storage, v1, object, ...
  const [, , kind, bucket, ...rest] = parts;
  const objectPath = rest.join('/');

  if (kind !== 'object' || !bucket) return { status: 404, body: { message: 'not found' } };
  if (claims.role !== 'authenticated') {
    return {
      status: 401,
      body: { statusCode: '401', error: 'Unauthorized', message: 'Unauthorized' },
    };
  }

  const safe = objectPath.replaceAll('..', '').replace(/^\/+/, '');
  const file = join(storageDir, bucket, safe);

  if (request.method === 'POST' || request.method === 'PUT') {
    const body = await readBody(request);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
    return { status: 200, body: { Key: `${bucket}/${safe}`, Id: randomUUID() } };
  }

  if (request.method === 'GET') {
    try {
      const body = await readFile(file);
      return { status: 200, raw: body, headers: { 'content-type': 'application/octet-stream' } };
    } catch {
      return {
        status: 400,
        body: { statusCode: '404', error: 'not_found', message: 'Object not found' },
      };
    }
  }

  if (request.method === 'DELETE') {
    await rm(file, { force: true });
    return { status: 200, body: { message: 'Successfully deleted' } };
  }

  return { status: 405, body: { message: 'method not allowed' } };
}

async function main() {
  const reset = process.argv.includes('--reset');
  console.log('▸ Maak dev backend');
  console.log('  starting PostgreSQL…');
  const { pg, client } = await startDatabase({ reset, quiet: true });
  console.log('  loading @maak/core…');
  const core = await loadCore();

  const mutex = createMutex();
  const fks = await loadForeignKeys(client);
  const columns = await loadColumns(client);
  await mkdir(storageDir, { recursive: true });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const requestId = request.headers['x-request-id']?.toString() ?? randomUUID();

    // The handlers speak the Fetch API (`request.headers.get`), the server speaks `node:http`.
    const webRequest = {
      method: request.method ?? 'GET',
      headers: new Headers(
        Object.entries(request.headers).filter((entry) => typeof entry[1] === 'string'),
      ),
    };

    const send = (result) => {
      const headers = { ...CORS, 'x-request-id': requestId, ...(result.headers ?? {}) };
      if (result.contentRange) headers['content-range'] = result.contentRange;
      if (result.raw) {
        response.writeHead(result.status, headers);
        response.end(result.raw);
        return;
      }
      const payload =
        result.body === null || result.body === undefined ? '' : JSON.stringify(result.body);
      headers['content-type'] ??= 'application/json; charset=utf-8';
      response.writeHead(result.status, headers);
      response.end(payload);
    };

    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, CORS);
        response.end();
        return;
      }

      if (url.pathname === '/health') {
        send({ status: 200, body: { status: 'ok', backend: 'dev', postgres: 'up' } });
        return;
      }

      const claims = claimsFor(webRequest);
      const isAuthPath = url.pathname.startsWith('/auth/');
      if (!claims && !isAuthPath) {
        send({
          status: 401,
          body: { code: 'UNAUTHENTICATED', detail: 'invalid or expired token' },
        });
        return;
      }

      const bodyBuffer =
        request.method === 'GET' || request.method === 'HEAD'
          ? Buffer.alloc(0)
          : await readBody(request);

      if (isAuthPath) {
        const result = await mutex(async () =>
          handleAuth({
            client,
            request: webRequest,
            url,
            body: parseJson(bodyBuffer),
            userId: claims?.sub ?? null,
          }),
        );
        send(result);
        return;
      }

      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        send(await handleRpc({ client, mutex, url, body: parseJson(bodyBuffer), claims }));
        return;
      }

      if (url.pathname.startsWith('/rest/v1/')) {
        send(await handleRest({ client, mutex, request: webRequest, url, claims, fks, columns }));
        return;
      }

      if (url.pathname.startsWith('/functions/v1/')) {
        const name = url.pathname.replace('/functions/v1/', '').split('/')[0];
        if (!claims.sub) {
          send({ status: 401, body: { code: 'UNAUTHENTICATED', detail: 'sign in first' } });
          return;
        }
        const result = await mutex(async () => {
          await client.query('begin');
          try {
            const outcome = await handleFunction({
              name,
              body: parseJson(bodyBuffer),
              userId: claims.sub,
              client,
              core,
              requestId,
            });
            // Commands are transactional: an error reply means nothing was written.
            await client.query(outcome.status >= 400 ? 'rollback' : 'commit');
            return outcome;
          } catch (error) {
            await client.query('rollback');
            throw error;
          }
        });
        send(result);
        return;
      }

      if (url.pathname.startsWith('/storage/v1/')) {
        send(await handleStorage({ request: webRequest, url, claims }));
        return;
      }

      send({ status: 404, body: { code: 'NOT_FOUND', detail: `no route for ${url.pathname}` } });
    } catch (error) {
      console.error('  ✖', error);
      try {
        await client.query('rollback');
      } catch {
        /* no transaction open */
      }
      send({ status: 500, body: { code: 'INTERNAL', detail: String(error.message ?? error) } });
    }
  });

  server.listen(API_PORT, '0.0.0.0', () => {
    console.log(`  ready on http://0.0.0.0:${API_PORT}`);
    console.log(`  anon key: ${ANON_KEY}`);
    console.log('  sign in:  admin@maak.test / Maak!2026');
  });

  const shutdown = async () => {
    server.close();
    try {
      await client.end();
      await pg.stop();
    } catch {
      /* already down */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('✖ dev backend failed:', error);
  process.exit(1);
});
