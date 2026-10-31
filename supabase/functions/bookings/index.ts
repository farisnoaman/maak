/**
 * bookings — every Phase 5 write (create, identity, accept, reject, cancel, no-show, share).
 *
 * Same shape as `trips`, `fleet` and `geography`: one action discriminator, exactly one `cmd_*` per
 * request (one transaction), and the policy matrix checked here *and* inside the SQL command. The
 * action → argument mapping lives in `bookingsCommandArgs()` from @maak/core, so the web app, the
 * mobile app, the dev gateway and this file cannot drift apart.
 *
 * Reads are deliberately absent: a passenger's bookings, an operator's manifest and an ID document are
 * RLS-filtered PostgREST reads. The one exception is `resolve_id_share_token`, which is a read that
 * writes an audit row, so it is granted to `authenticated` and called directly.
 */

import {
  bookingsActionSchema,
  bookingsCommandArgs,
  bookingsScope,
  policyDenial,
  type BookingsAction,
  type Capability,
} from '@maak/core';
import { ApiError } from '../_shared/errors.ts';
import { defineCommand } from '../_shared/handler.ts';
import { createDb } from '../_shared/db.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const schema = bookingsActionSchema;

/**
 * The capability each action needs.
 *
 * Recording a passenger's identity is part of creating that booking, so it reuses `booking.create`;
 * accepting, rejecting and recording a no-show are all "the operator decides about a seat", so they
 * reuse `booking.accept`. Inventing a capability per verb would give the policy matrix and the SQL two
 * vocabularies for one permission.
 */
const CAPABILITY: Record<BookingsAction['action'], Capability> = {
  'booking.create': 'booking.create',
  'booking.setDocument': 'booking.create',
  'booking.accept': 'booking.accept',
  'booking.bulkAccept': 'booking.accept',
  'booking.reject': 'booking.accept',
  'booking.cancelByPassenger': 'booking.cancelAsPassenger',
  'booking.cancelByOperator': 'booking.cancelAsOperator',
  'booking.markNoShow': 'booking.accept',
  'booking.shareLink': 'booking.create',
};

export default defineCommand({ schema }, async (ctx) => {
  const { actor } = ctx.resolved;
  const actorId = actor.userId as string;
  const input = ctx.input;

  const denial = policyDenial(actor, CAPABILITY[input.action], bookingsScope(input));
  if (denial === 'NOT_VERIFIED') {
    throw new ApiError(403, 'NOT_VERIFIED', 'Account is not verified');
  }
  if (denial) throw new ApiError(denial === 'UNAUTHENTICATED' ? 401 : 403, denial, 'Not allowed');

  // A person books a seat; a booking form is not a scraper's endpoint. Everything else here is an
  // operator clicking through an inbox, which is cheaper but also worth a ceiling.
  const passengerSide = input.action === 'booking.create' || input.action === 'booking.setDocument';
  await enforceRateLimit(actorId, `bookings.${input.action}`, {
    limit: passengerSide ? 30 : 240,
    windowSeconds: 3600,
  });

  const db = createDb({ requestId: ctx.requestId });
  const { fn, args } = bookingsCommandArgs(input, actorId, {
    p_request_id: ctx.requestId,
    p_ip: ctx.ip,
  });

  const result = await db.rpc<Record<string, unknown>>(fn, args);
  return { ...result, requestId: ctx.requestId };
});
