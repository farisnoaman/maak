/**
 * Audit helper for edge functions.
 *
 * The authoritative audit row is written **inside** the SQL command's transaction, so an action
 * can never commit without a trace. This module covers the cases that have no transaction:
 * refused requests (denied authorisation, rate limits, validation failures) which must still be
 * visible to support and security review.
 */

import { serviceClient } from './auth.ts';

export interface DeniedEvent {
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string;
  readonly reason: string;
  readonly requestId: string;
  readonly ip?: string | null;
  readonly context?: Record<string, unknown>;
}

/**
 * Best-effort: a failed audit write must never turn a 403 into a 500.
 * Outcomes are constrained by the table to success | denied | failed.
 */
export async function recordDenied(event: DeniedEvent): Promise<void> {
  try {
    const { error } = await serviceClient().rpc('app_write_audit', {
      p_actor: event.actorId,
      p_action: event.action,
      p_entity_type: event.entityType,
      p_entity_id: event.entityId ?? null,
      p_before: null,
      p_after: event.context ?? null,
      p_reason: event.reason,
      p_request_id: event.requestId,
      p_ip: event.ip ?? null,
      p_outcome: 'denied',
    });
    if (error) console.warn('[audit] denied-event not recorded:', error.message);
  } catch (error) {
    console.warn('[audit] denied-event not recorded:', (error as Error).message);
  }
}
