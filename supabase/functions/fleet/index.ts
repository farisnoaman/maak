/**
 * fleet — every Phase 3 write (vehicles, photos, documents, drivers, assignments).
 *
 * Same shape as `identity` and `geography`: one action discriminator, exactly one `cmd_*` per
 * request (one transaction), and the policy matrix checked here *and* inside the SQL command. The
 * action → argument mapping lives in `fleetCommandArgs()` from @maak/core so the web app, the mobile
 * app and the tests cannot drift from this file.
 */

import {
  fleetActionSchema,
  fleetCommandArgs,
  fleetScope,
  policyDenial,
  type Capability,
  type FleetAction,
} from '@maak/core';
import { ApiError } from '../_shared/errors.ts';
import { defineCommand } from '../_shared/handler.ts';
import { createDb } from '../_shared/db.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const schema = fleetActionSchema;

const CAPABILITY: Record<FleetAction['action'], Capability> = {
  'vehicle.create': 'vehicle.create',
  'vehicle.update': 'vehicle.update',
  'vehicle.submitVerification': 'vehicle.update',
  'vehicle.decide': 'vehicle.verify',
  'vehicle.setStatus': 'vehicle.setStatus',
  'vehicle.setPhotos': 'vehicle.update',
  'driver.invite': 'driver.invite',
  'driver.accept': 'driver.accept',
  'driver.verify': 'driver.verify',
  'driver.assign': 'driver.assign',
  'driver.unassign': 'driver.assign',
};

export default defineCommand({ schema }, async (ctx) => {
  const { actor } = ctx.resolved;
  const actorId = actor.userId as string;
  const input = ctx.input;

  // `vehicle.create` and `driver.invite` carry `verified: true`, so an unverified account is refused
  // here — before a database round trip. The SQL raises `NOT_VERIFIED` for the same case, which is
  // what a direct RPC call sees.
  const denial = policyDenial(actor, CAPABILITY[input.action], fleetScope(input));
  if (denial === 'NOT_VERIFIED') {
    throw new ApiError(403, 'NOT_VERIFIED', 'Account is not verified');
  }
  if (denial) throw new ApiError(denial === 'UNAUTHENTICATED' ? 401 : 403, denial, 'Not allowed');

  const heavy = input.action === 'vehicle.create' || input.action === 'vehicle.update';
  await enforceRateLimit(actorId, `fleet.${input.action}`, {
    limit: heavy ? 60 : 240,
    windowSeconds: 3600,
  });

  const db = createDb({ requestId: ctx.requestId });
  const { fn, args } = fleetCommandArgs(input, actorId, {
    p_request_id: ctx.requestId,
    p_ip: ctx.ip,
  });

  const result = await db.rpc<Record<string, unknown>>(fn, args);
  return { ...result, requestId: ctx.requestId };
});
