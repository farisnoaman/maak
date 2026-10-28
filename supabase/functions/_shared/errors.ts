/**
 * Server-side error contract. Mirrors `packages/core/src/api/errors.ts` so a code raised here is
 * understood by every client without translation tables drifting.
 */

import type { ErrorCode } from '@maak/core';

export interface ErrorBody {
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly fields?: Record<string, string>;
  readonly context?: Record<string, unknown>;
  readonly requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorBody;

  constructor(status: number, code: ErrorCode, detail?: string, extra?: Partial<ErrorBody>) {
    super(detail ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.body = {
      code,
      ...(detail ? { detail } : {}),
      ...(extra?.fields ? { fields: extra.fields } : {}),
      ...(extra?.context ? { context: extra.context } : {}),
      ...(extra?.requestId ? { requestId: extra.requestId } : {}),
    };
  }
}

export const unauthorized = (detail = 'Missing or invalid token') =>
  new ApiError(401, 'UNAUTHENTICATED', detail);
export const forbidden = (detail = 'Not allowed') => new ApiError(403, 'FORBIDDEN', detail);
export const notVerified = () => new ApiError(403, 'NOT_VERIFIED', 'Account is not verified');
export const invalid = (fields?: Record<string, string>) =>
  new ApiError(
    400,
    'VALIDATION_FAILED',
    'Request validation failed',
    fields ? { fields } : undefined,
  );
export const notFound = (detail = 'Not found') => new ApiError(404, 'NOT_FOUND', detail);
export const rateLimited = (retryAfterSeconds: number) =>
  new ApiError(429, 'RATE_LIMITED', `Retry in ${retryAfterSeconds}s`, {
    context: { retryAfterSeconds },
  });
export const internal = (detail = 'Unexpected error') => new ApiError(500, 'INTERNAL', detail);

/** Maps a Postgres error raised by a cmd_* function onto the client contract. */
export function fromPostgres(error: { message?: string; code?: string }): ApiError {
  const message = error.message ?? '';
  const known: ErrorCode[] = [
    'FORBIDDEN',
    'NOT_VERIFIED',
    'SELF_LOCKOUT',
    'VALIDATION_FAILED',
    'MISSING_DOCUMENT',
    'INVITE_INVALID',
    'INVITE_EXPIRED',
    'NOT_FOUND',
    'CONFLICT',
    'QUOTA_EXCEEDED',
    'EDIT_WINDOW_CLOSED',
    'CANCEL_WINDOW_CLOSED',
    'NO_SEATS_LEFT',
    'PRICE_CHANGED',
    'TRIP_NOT_VERIFIED',
    'ODO_REGRESSION',
    'PROOF_ALREADY_USED',
    'DUPLICATE_REFERENCE',
    'PAYMENT_ALREADY_CONFIRMED',
    'IDEMPOTENCY_CONFLICT',
  ];
  // Commands raise with a machine code prefix, e.g. `raise exception 'EDIT_WINDOW_CLOSED: ...'`.
  const prefix = message.split(':')[0]?.trim();
  if (prefix && (known as string[]).includes(prefix)) {
    const status =
      prefix === 'FORBIDDEN' || prefix === 'NOT_VERIFIED' || prefix === 'SELF_LOCKOUT'
        ? 403
        : prefix === 'VALIDATION_FAILED' ||
            prefix === 'MISSING_DOCUMENT' ||
            prefix === 'INVITE_INVALID' ||
            prefix === 'INVITE_EXPIRED'
          ? 400
          : prefix === 'NOT_FOUND'
            ? 404
            : 409;
    return new ApiError(status, prefix as ErrorCode, message);
  }
  if (error.code === '23505') return new ApiError(409, 'CONFLICT', 'Duplicate');
  if (error.code === '23503') return new ApiError(409, 'CONFLICT', 'Related row missing');
  return internal(message || 'Database error');
}
