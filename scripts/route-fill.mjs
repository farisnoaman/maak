#!/usr/bin/env node
/**
 * The route filler — the half of "routing provider at publish" that cannot live in Postgres.
 *
 * `00042` added the queue (`public.get_trips_needing_routes()`) and the single write
 * (`public.cmd_store_trip_route()`). This script is the transport between them and a provider, and it is
 * deliberately the same shape as `scripts/notify-worker.mjs`: a `--once` pass a cron can run, a `--check` that
 * prints configuration without touching anything, and an exit code that fails the run only when asked.
 *
 * Three properties worth stating, because each is a decision:
 *
 *   · **One provider call per corridor, not per trip.** The queue is grouped by `route_key` before anything is
 *     fetched, so 200 departures on the Aden–Sana'a road cost one request. That is the entire reason the cache
 *     table exists.
 *   · **A missing or unhappy provider is not a failure of the system.** No `MAAK_ROUTE_URL`, no DNS, a timeout or
 *     a malformed answer all mean the same thing: nothing is stored, `app.trip_route_for()` keeps returning the
 *     straight line, and the script says so once. A trip with a straight-line route is a worse estimate, not a
 *     broken trip.
 *   · **The service key is the credential.** The two functions are granted to `service_role` only — a route is
 *     platform infrastructure, not something an operator's session should be able to write — so this is one of
 *     the few processes that holds it, alongside the auth lookup in the notification worker.
 *
 *   MAAK_API_URL=http://127.0.0.1:54321            (PostgREST root, not /functions/v1)
 *   MAAK_SERVICE_ROLE_KEY=…                        required to write
 *   MAAK_ROUTE_URL=https://router.project-osrm.org required to fetch
 *   npm run routes:fill                            # one pass
 *   npm run routes:fill -- --check                 # configuration only
 *   npm run routes:fill -- --limit 500 --fail-on-error
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};
const flags = new Set(process.argv.slice(2));
const check = flags.has('--check');
const failOnError = flags.has('--fail-on-error');
const dryRun = flags.has('--dry-run') || check;

const API_URL = (process.env.MAAK_API_URL ?? 'http://127.0.0.1:54321').replace(/\/$/, '');
const SERVICE_KEY = process.env.MAAK_SERVICE_ROLE_KEY ?? '';
const ROUTE_URL = (process.env.MAAK_ROUTE_URL ?? '').replace(/\/$/, '');
const LIMIT = Number(arg('limit', 200));
const TIMEOUT_MS = Number(process.env.MAAK_ROUTE_TIMEOUT_MS ?? 8000);

/** The same one-shot bundle the dev gateway and the notification worker use. */
async function loadCore() {
  const outfile = join(root, '.dev', 'core.bundle.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [join(root, 'scripts', 'dev-backend', 'core-entry.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function rpc(fn, body) {
  const response = await fetch(`${API_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.message ?? payload.details ?? response.status;
    throw new Error(`${fn}: ${detail}`);
  }
  return payload;
}

/** A provider call that cannot hang the pass: one timeout, no retries, `null` on anything but a route. */
async function fetchRoute(core, from, to) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(core.osrmRouteUrl(ROUTE_URL, from, to), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { reason: `provider: ${response.status}` };
    const body = await response.json().catch(() => null);
    const route = core.parseOsrmRoute(body);
    if (!route) return { reason: 'provider: unusable answer' };
    if (!core.routeLooksPlausible(route, from, to))
      return { reason: 'provider: implausible distance' };
    return { route };
  } catch (error) {
    const reason =
      error?.name === 'AbortError' ? 'provider: timeout' : `provider: ${error.message}`;
    return { reason: String(reason).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const core = await loadCore();

  if (check) {
    console.log('route filler: configuration');
    console.log(`· api        ${API_URL}`);
    console.log(`· service    ${SERVICE_KEY ? 'set' : 'MISSING (MAAK_SERVICE_ROLE_KEY)'}`);
    console.log(
      `· provider   ${ROUTE_URL || 'not set — routes will not be filled (straight-line fallback stays)'}`,
    );
    console.log(`· limit      ${LIMIT} trips per pass`);
    console.log(`· timeout    ${TIMEOUT_MS} ms per provider call`);
  }

  if (!SERVICE_KEY) {
    console.error('✗ MAAK_SERVICE_ROLE_KEY is required: the route functions are service_role only');
    process.exitCode = 1;
    return;
  }

  const queue = await rpc('get_trips_needing_routes', { p_limit: LIMIT });
  const trips = Array.isArray(queue) ? queue : [];
  if (check) {
    console.log(`· queue      ${trips.length} trip(s) awaiting geometry`);
    return;
  }
  if (trips.length === 0) {
    console.log(JSON.stringify({ at: new Date().toISOString(), queued: 0, filled: 0 }));
    return;
  }

  // One provider call per corridor: `cached` rows already have geometry in `route_cache`, so a trip on a known
  // road is filled without a network round trip at all.
  const corridors = new Map();
  for (const trip of trips) {
    if (!corridors.has(trip.route_key)) {
      corridors.set(trip.route_key, {
        key: trip.route_key,
        from: { lat: trip.from_lat, lng: trip.from_lng },
        to: { lat: trip.to_lat, lng: trip.to_lng },
        cached: trip.cached,
        trips: [],
        route: null,
        reason: null,
      });
    }
    corridors.get(trip.route_key).trips.push(trip);
  }

  let fetched = 0;
  const skipped = [];

  if (ROUTE_URL) {
    for (const corridor of corridors.values()) {
      if (corridor.cached) continue; // the cache row is written per trip below, without a provider call
      for (;;) {
        const result = await fetchRoute(core, corridor.from, corridor.to);
        if (result.route) {
          corridor.route = result.route;
          fetched += 1;
          break;
        }
        // One retry for a transient failure (a timeout or a 5xx); a malformed answer is not retried.
        if (result.reason === 'provider: timeout' || /provider: 5\d\d/.test(result.reason)) {
          const retry = await fetchRoute(core, corridor.from, corridor.to);
          if (retry.route) {
            corridor.route = retry.route;
            fetched += 1;
            break;
          }
          corridor.reason = retry.reason;
          break;
        }
        corridor.reason = result.reason;
        break;
      }
      if (!corridor.route) skipped.push({ key: corridor.key, reason: corridor.reason });
    }
  } else {
    for (const corridor of corridors.values()) {
      if (!corridor.cached) skipped.push({ key: corridor.key, reason: 'provider_not_configured' });
    }
  }

  let filled = 0;
  let failed = 0;
  for (const corridor of corridors.values()) {
    // A cold corridor with no route has nothing to store — it was skipped above with a reason.
    if (!corridor.route && !corridor.cached) continue;
    if (dryRun) {
      filled += corridor.trips.length;
      continue;
    }
    for (const trip of corridor.trips) {
      try {
        if (corridor.route) {
          await rpc('cmd_store_trip_route', {
            p_actor: null,
            p_trip_id: trip.trip_id,
            p_provider: corridor.route.provider,
            // Sent as JSON text, not as an array: node-postgres renders a JS array as a Postgres *array*
            // literal, which jsonb rejects. PostgREST coerces a JSON string into jsonb on both stacks.
            p_polyline: JSON.stringify(corridor.route.points),
            p_distance_km: corridor.route.distanceKm,
          });
        } else {
          // Warm corridor: the trip row is filled from `route_cache` without a provider call.
          await rpc('cmd_attach_cached_route', { p_trip_id: trip.trip_id });
        }
        filled += 1;
      } catch (error) {
        failed += 1;
        console.error(`! ${trip.trip_id}: ${error.message}`);
      }
    }
  }

  const summary = {
    at: new Date().toISOString(),
    queued: trips.length,
    corridors: corridors.size,
    fetched,
    filled,
    failed,
    skipped,
  };
  console.log(JSON.stringify(summary));

  if (failOnError && (failed > 0 || skipped.length > 0)) {
    console.error(`✗ ${failed} write(s) failed, ${skipped.length} corridor(s) skipped`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
