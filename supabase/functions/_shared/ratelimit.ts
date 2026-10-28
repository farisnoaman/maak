/**
 * Per-actor rate limiting, enforced in Postgres so it holds across edge instances.
 *
 * Limits are policy, not code: the table below is the single place to change them, and the
 * SQL function does the accounting atomically (`insert ... on conflict do update`).
 */

import { evaluateRateLimit, type RateLimitDecision } from '@maak/core';
import { serviceClient } from './auth.ts';
import { rateLimited } from './errors.ts';

export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowSeconds: number;
}

export const RATE_LIMITS: Record<string, RateLimitPolicy> = {
  'booking.create': { limit: 5, windowSeconds: 600 },
  'payment.submit': { limit: 10, windowSeconds: 3600 },
  'verification.decide': { limit: 200, windowSeconds: 3600 },
  'qr.resolve': { limit: 60, windowSeconds: 60 },
  'search.public': { limit: 120, windowSeconds: 60 },
  default: { limit: 60, windowSeconds: 60 },
};

export function policyFor(action: string): RateLimitPolicy {
  return RATE_LIMITS[action] ?? RATE_LIMITS.default!;
}

/**
 * Consumes one unit for `action`. Throws `RATE_LIMITED` with a retry hint when exhausted.
 * Fails closed on infrastructure errors? No — that would take the product down for a
 * bookkeeping table. It fails open but logs loudly, and the write guard still protects money.
 */
export async function enforceRateLimit(
  actorId: string,
  action: string,
  overrides?: Partial<RateLimitPolicy>,
): Promise<RateLimitDecision> {
  const policy = { ...policyFor(action), ...overrides };
  const client = serviceClient();

  const { data, error } = await client.rpc('app_consume_rate_limit', {
    p_actor: actorId,
    p_action: action,
    p_limit: policy.limit,
    p_window_seconds: policy.windowSeconds,
  });

  if (error || !data || typeof data !== 'object') {
    console.error('[rate-limit] unavailable, allowing request', error?.message);
    return { allowed: true, remaining: policy.limit, retryAfterSeconds: 0 };
  }

  const row = data as { used: number; elapsed_seconds: number };
  const decision = evaluateRateLimit({
    used: row.used,
    limit: policy.limit,
    windowSeconds: policy.windowSeconds,
    elapsedSeconds: row.elapsed_seconds,
  });

  if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
  return decision;
}
