/**
 * geography — every Phase 2 write (regions, coverage, supervisors, places, imports).
 *
 * Same shape as `identity`: one action discriminator, exactly one `cmd_*` per request, and the
 * policy matrix checked here *and* inside the SQL command. The command → argument mapping lives in
 * `geoCommandArgs()` from @maak/core, so this file cannot drift from the tests.
 */

import {
  geoActionSchema,
  geoCommandArgs,
  requirePolicy,
  type Capability,
  type GeoAction,
} from '@maak/core';
import { defineCommand } from '../_shared/handler.ts';
import { createDb } from '../_shared/db.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const schema = geoActionSchema;

const CAPABILITY: Record<GeoAction['action'], Capability> = {
  'region.upsert': 'geo.manage',
  'geo.assignSupervisor': 'geo.assignSupervisor',
  'geo.revokeSupervisor': 'geo.assignSupervisor',
  'geo.import': 'geo.manage',
  'place.create': 'place.create',
  'place.decide': 'place.decide',
};

export default defineCommand({ schema }, async (ctx) => {
  const { actor } = ctx.resolved;
  const actorId = actor.userId as string;
  const input = ctx.input;

  // A denied actor is stopped here, before a database round trip; the command still re-checks.
  requirePolicy(actor, CAPABILITY[input.action]);

  await enforceRateLimit(actorId, `geo.${input.action}`, {
    limit: input.action === 'geo.import' ? 10 : 120,
    windowSeconds: 3600,
  });

  const db = createDb({ requestId: ctx.requestId });
  const { fn, args } = geoCommandArgs(input, actorId, {
    p_request_id: ctx.requestId,
    p_ip: ctx.ip,
  });

  const result = await db.rpc<Record<string, unknown>>(fn, args);
  return { ...result, requestId: ctx.requestId };
});
