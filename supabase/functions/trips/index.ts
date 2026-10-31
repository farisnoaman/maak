/**
 * trips — every Phase 4 write (create, edit, stops, publish, review, cancel).
 *
 * Same shape as `fleet` and `geography`: one action discriminator, exactly one `cmd_*` per request (one
 * transaction), and the policy matrix checked here *and* inside the SQL command. The action → argument
 * mapping lives in `tripsCommandArgs()` from @maak/core, so the web app, the mobile app, the dev
 * gateway and this file cannot drift apart.
 *
 * The marketplace is not here: `search_public_trips` and `get_trip_public` are granted to `anon` and
 * read straight from PostgREST by the public pages, because a visitor has no account to authenticate
 * with — and a trip page that requires a session is not a marketplace.
 */

import {
  policyDenial,
  tripsActionSchema,
  tripsCommandArgs,
  tripsScope,
  type Capability,
  type TripsAction,
} from '@maak/core';
import { ApiError } from '../_shared/errors.ts';
import { defineCommand } from '../_shared/handler.ts';
import { createDb } from '../_shared/db.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const schema = tripsActionSchema;

/**
 * The capability each action needs.
 *
 * Kept literal on purpose: `check:guards` reads this object and the dev gateway's twin, and fails when
 * one has an action the other does not. That guard is the reason `driver.setLicence` could not ship into
 * one gateway only — see §10 of `scripts/check-guards.mjs`.
 */
const CAPABILITY: Record<TripsAction['action'], Capability> = {
  'trip.create': 'trip.create',
  'trip.update': 'trip.update',
  'trip.setStops': 'trip.update',
  'trip.publish': 'trip.update',
  'trip.submitVerification': 'trip.update',
  'trip.decideVerification': 'trip.verify',
  'trip.cancel': 'trip.cancel',
  'trip.start': 'trip.start',
  'trip.stopReached': 'trip.start',
  'trip.end': 'trip.start',
  'trip.recordPing': 'trip.start',
  'trip.bulkVerify': 'trip.verify',
  'trip.rotateQr': 'trip.update',
};

export default defineCommand({ schema }, async (ctx) => {
  const { actor } = ctx.resolved;
  const actorId = actor.userId as string;
  const input = ctx.input;

  // `trip.create` carries `verified: true`, so an unverified account is refused before a database
  // round trip. The SQL raises `NOT_VERIFIED` for the same case, which is what a direct RPC call sees.
  const denial = policyDenial(actor, CAPABILITY[input.action], tripsScope(input));
  if (denial === 'NOT_VERIFIED') {
    throw new ApiError(403, 'NOT_VERIFIED', 'Account is not verified');
  }
  if (denial) throw new ApiError(denial === 'UNAUTHENTICATED' ? 401 : 403, denial, 'Not allowed');

  const heavy = input.action === 'trip.create' || input.action === 'trip.update';
  await enforceRateLimit(actorId, `trips.${input.action}`, {
    limit: heavy ? 60 : 240,
    windowSeconds: 3600,
  });

  const db = createDb({ requestId: ctx.requestId });
  const { fn, args } = tripsCommandArgs(input, actorId, {
    p_request_id: ctx.requestId,
    p_ip: ctx.ip,
  });

  const result = await db.rpc<Record<string, unknown>>(fn, args);
  return { ...result, requestId: ctx.requestId };
});
