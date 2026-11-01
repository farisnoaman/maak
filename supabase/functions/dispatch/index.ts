/**
 * dispatch — Phase 11's one write path for everything the platform says to a person.
 *
 * Same shape as `finance` and `payments`: one action discriminator, exactly one `cmd_*` per request, and the
 * capability checked here *and* inside the SQL. The action → argument mapping lives in
 * `notificationCommandArgs()` from @maak/core, so the web app, the mobile app, the dev gateway and this file
 * cannot drift.
 *
 * Why this is not a transport. The write guard allows one command per request (ADR-018), and delivery is
 * inherently two: claim, then record. So this function owns the *decisions* — what to claim, what the user
 * chose, what the job should raise — and the worker (`scripts/notify-worker.mjs`, and the phone in Phase 15's
 * skeleton) owns the transport, calling this same endpoint twice: once to claim and once per item to record.
 * That keeps "at most one write per request" true without pretending a push send is a database transaction.
 */

import {
  notificationActionSchema,
  notificationCommandArgs,
  notificationScope,
  policyDenial,
  type Capability,
  type NotificationAction,
} from '@maak/core';
import { ApiError } from '../_shared/errors.ts';
import { defineCommand } from '../_shared/handler.ts';
import { createDb } from '../_shared/db.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const schema = notificationActionSchema;

/**
 * The capability each action needs.
 *
 * Everything a person does to their own inbox is `notification.read` / `notification.preferences`; these
 * commands take the user from the session, so there is no scope to widen and no owner to name. The two
 * exceptions are the worker and support: claiming somebody else's delivery queue is staff work, and the
 * health view is finance's because a dead push queue is a service failure with a money consequence.
 */
const CAPABILITY: Record<NotificationAction['action'], Capability> = {
  'notifications.list': 'notification.read',
  'notifications.read': 'notification.read',
  'notifications.settings': 'notification.preferences',
  'notifications.preference.set': 'notification.preferences',
  'notifications.preference.reset': 'notification.preferences',
  'notifications.settings.update': 'notification.preferences',
  'notifications.device.register': 'notification.preferences',
  'notifications.device.revoke': 'notification.preferences',
  'notifications.health': 'notification.health',
  'notifications.catalogue': 'notification.catalogue',
  'search.save': 'notification.savedSearch',
  'search.list': 'notification.savedSearch',
  'search.update': 'notification.savedSearch',
  'search.delete': 'notification.savedSearch',
  'notifications.dispatch': 'notification.dispatch',
  'notifications.delivery.record': 'notification.dispatch',
  'notifications.job.run': 'notification.dispatch',
};

export default defineCommand({ schema }, async (ctx) => {
  const { actor } = ctx.resolved;
  const actorId = actor.userId as string;
  const input = ctx.input;

  const denial = policyDenial(actor, CAPABILITY[input.action], notificationScope(input));
  if (denial === 'NOT_VERIFIED') {
    throw new ApiError(403, 'NOT_VERIFIED', 'Account is not verified');
  }
  if (denial) throw new ApiError(denial === 'UNAUTHENTICATED' ? 401 : 403, denial, 'Not allowed');

  // A clock: the worker claims in a loop, and every claim must be cheap enough to be boring. A person
  // refreshing a list of saved searches is not a batch job, so the two ceilings are different.
  await enforceRateLimit(actorId, `notifications.${input.action}`, {
    limit: input.action === 'notifications.dispatch' ? 720 : 180,
    windowSeconds: 3600,
  });

  const db = createDb({ requestId: ctx.requestId });
  const { fn, args } = notificationCommandArgs(input, actorId, {
    p_request_id: ctx.requestId,
    p_ip: ctx.ip,
  });

  const result = await db.rpc<Record<string, unknown>>(fn, args);
  return { ...result, requestId: ctx.requestId };
});
