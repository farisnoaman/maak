/**
 * me — the session probe every client calls on boot.
 *
 * Returns the resolved actor and the *server-computed* capability list from @maak/core.
 * No client decides what it may do; it asks, then renders what it is told.
 */

import { z } from 'zod';
import { capabilityContexts, isOperator, isPlatformStaff } from '@maak/core';
import { defineCommand } from '../_shared/handler.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const schema = z.object({});

export default defineCommand({ schema }, async (ctx) => {
  const { actor, memberships, hasGeoScope, preferredLanguage } = ctx.resolved;

  await enforceRateLimit(actor.userId as string, 'session.probe');

  // Capabilities are returned per context, never as one flattened list: an owner of company A must
  // not appear to have those powers while acting for company B.
  const contexts = capabilityContexts(actor, memberships);

  return {
    user: {
      id: actor.userId,
      roles: actor.roles,
      verification: actor.verification,
      plan: actor.plan,
      preferredLanguage,
      organizations: memberships.map((membership) => membership.orgId),
      memberships,
      hasGeoScope,
    },
    contexts,
    capabilities: contexts[0]?.capabilities ?? [],
    flags: {
      isOperator: isOperator(actor),
      isStaff: isPlatformStaff(actor),
      canOperate: isOperator(actor) && actor.verification === 'verified',
    },
    requestId: ctx.requestId,
  };
});
