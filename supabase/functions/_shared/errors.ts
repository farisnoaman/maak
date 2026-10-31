/**
 * Server-side error contract. Mirrors `packages/core/src/api/errors.ts` so a code raised here is
 * understood by every client without translation tables drifting.
 */

import { errorCodeFromMessage, HTTP_STATUS_BY_CODE, type ErrorCode } from '@maak/core';

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

/**
 * Maps a Postgres error raised by a `cmd_*` function onto the client contract.
 *
 * The status table and the prefix parser live in `@maak/core` so this cannot drift from the dev
 * gateway, which used to keep its own copy and disagree about which codes it recognised.
 */
export function fromPostgres(error: { message?: string; code?: string }): ApiError {
  const message = error.message ?? '';

  // Commands raise with a machine code prefix, e.g. `raise exception 'EDIT_WINDOW_CLOSED: ...'`.
  const code = errorCodeFromMessage(message);
  if (code) {
    const detail = message.replace(new RegExp(`^\\s*${code}\\s*:?\\s*`), '').trim();
    return new ApiError(HTTP_STATUS_BY_CODE[code], code, detail || code);
  }

  // No prefix: the database itself refused. A unique violation is the one case a person can act on, so
  // it gets its own code instead of a generic conflict with a raw constraint name inside it.
  if (error.code === '23505') {
    return new ApiError(409, 'DUPLICATE_REFERENCE', 'That entry already exists');
  }
  if (error.code === '23503') return new ApiError(409, 'CONFLICT', 'Related row missing');
  return internal(message || 'Database error');
}
