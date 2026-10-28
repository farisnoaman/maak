/**
 * me — the session probe every client calls on boot.
 *
 * Returns the resolved actor and the *server-computed* capability list from @maak/core.
 * No client decides what it may do; it asks, then renders what it is told.
 */

import { z } from 'zod';
import { capabilitiesOf, isOperator, isPlatformStaff } from '@maak/core';
import { defineCommand } from '../_shared/handler.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const schema = z.object({});

export default defineCommand({ schema }, async (ctx) => {
  const { actor, orgIds, hasGeoScope, preferredLanguage } = ctx.resolved;

  await enforceRateLimit(actor.userId as string, 'session.probe');

  return {
    user: {
      id: actor.userId,
      roles: actor.roles,
      verification: actor.verification,
      plan: actor.plan,
      preferredLanguage,
      organizations: orgIds,
      hasGeoScope,
    },
    capabilities: capabilitiesOf(actor),
    flags: {
      isOperator: isOperator(actor),
      isStaff: isPlatformStaff(actor),
      canOperate: isOperator(actor) && actor.verification === 'verified',
    },
    requestId: ctx.requestId,
  };
});
