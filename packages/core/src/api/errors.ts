/**
 * The error contract between the edge gateway and every client.
 *
 * Codes are stable, machine-readable and map to localized messages in `i18n`.
 * A client must never render a raw server message: Arabic-first UX and no leaked internals
 * (specs.md §11 "Response discipline").
 */

import type { TranslationKey } from '../i18n/dictionaries';

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_VERIFIED',
  'VALIDATION_FAILED',
  'MISSING_DOCUMENT',
  'INVITE_INVALID',
  'INVITE_EXPIRED',
  'SELF_LOCKOUT',
  'NOT_FOUND',
  'CONFLICT',
  'QUOTA_EXCEEDED',
  'EDIT_WINDOW_CLOSED',
  'CANCEL_WINDOW_CLOSED',
  'NO_SEATS_LEFT',
  'ALREADY_BOOKED',
  'PRICE_CHANGED',
  'TRIP_NOT_VERIFIED',
  'TOO_EARLY',
  'TRIP_NOT_STARTABLE',
  'ODO_REGRESSION',
  'PROOF_ALREADY_USED',
  'DUPLICATE_REFERENCE',
  'PAYMENT_ALREADY_CONFIRMED',
  // Phase 10: the ledger refuses an edit and a journal that does not balance. Both are user-facing
  // outcomes with their own sentence, not "an unexpected error" — somebody typed a number wrong.
  'UNBALANCED_JOURNAL',
  'IMMUTABLE',
  'RATE_LIMITED',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL',
  'NETWORK',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiFailure {
  readonly code: ErrorCode;
  /** Safe, human-readable English detail for logs/support. Never shown to end users. */
  readonly detail?: string;
  /** Field-level validation issues, keyed by input path. */
  readonly fields?: Record<string, string>;
  /** Extra machine context, e.g. `{ metric: 'vehicles', limit: 1, used: 1 }` for QUOTA_EXCEEDED. */
  readonly context?: Record<string, unknown>;
  readonly requestId?: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail<T = never>(error: ApiFailure): Result<T> {
  return { ok: false, error };
}

const ERROR_KEYS: Record<ErrorCode, TranslationKey> = {
  UNAUTHENTICATED: 'errors.UNAUTHENTICATED',
  FORBIDDEN: 'errors.FORBIDDEN',
  NOT_VERIFIED: 'errors.NOT_VERIFIED',
  VALIDATION_FAILED: 'errors.VALIDATION_FAILED',
  MISSING_DOCUMENT: 'errors.MISSING_DOCUMENT',
  INVITE_INVALID: 'errors.INVITE_INVALID',
  INVITE_EXPIRED: 'errors.INVITE_EXPIRED',
  SELF_LOCKOUT: 'errors.SELF_LOCKOUT',
  NOT_FOUND: 'errors.NOT_FOUND',
  CONFLICT: 'errors.CONFLICT',
  QUOTA_EXCEEDED: 'errors.QUOTA_EXCEEDED',
  EDIT_WINDOW_CLOSED: 'errors.EDIT_WINDOW_CLOSED',
  CANCEL_WINDOW_CLOSED: 'errors.CANCEL_WINDOW_CLOSED',
  NO_SEATS_LEFT: 'errors.NO_SEATS_LEFT',
  ALREADY_BOOKED: 'errors.ALREADY_BOOKED',
  PRICE_CHANGED: 'errors.PRICE_CHANGED',
  TRIP_NOT_VERIFIED: 'errors.TRIP_NOT_VERIFIED',
  TOO_EARLY: 'errors.TOO_EARLY',
  TRIP_NOT_STARTABLE: 'errors.CONFLICT',
  ODO_REGRESSION: 'errors.VALIDATION_FAILED',
  PROOF_ALREADY_USED: 'errors.VALIDATION_FAILED',
  DUPLICATE_REFERENCE: 'errors.DUPLICATE_REFERENCE',
  PAYMENT_ALREADY_CONFIRMED: 'errors.CONFLICT',
  UNBALANCED_JOURNAL: 'errors.UNBALANCED_JOURNAL',
  IMMUTABLE: 'errors.IMMUTABLE',
  RATE_LIMITED: 'errors.RATE_LIMITED',
  IDEMPOTENCY_CONFLICT: 'errors.CONFLICT',
  INTERNAL: 'errors.INTERNAL',
  NETWORK: 'errors.NETWORK',
};

export function errorKey(code: ErrorCode): TranslationKey {
  return ERROR_KEYS[code] ?? 'errors.INTERNAL';
}

/**
 * The one table that turns a contract code into an HTTP status.
 *
 * Both mappers — the production gateway (`supabase/functions/_shared/errors.ts`) and the local dev
 * gateway (`scripts/dev-backend/gateway.mjs`) — read this, because they used to keep separate lists and
 * drifted: a code known to one was `INTERNAL` in the other. A client that sees `INTERNAL` where the API
 * documented `DUPLICATE_REFERENCE` has no way to recover, and the drift is invisible until someone
 * hits that exact error.
 */
export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_VERIFIED: 403,
  SELF_LOCKOUT: 403,
  VALIDATION_FAILED: 422,
  MISSING_DOCUMENT: 422,
  INVITE_INVALID: 400,
  INVITE_EXPIRED: 410,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUOTA_EXCEEDED: 409,
  EDIT_WINDOW_CLOSED: 409,
  CANCEL_WINDOW_CLOSED: 409,
  NO_SEATS_LEFT: 409,
  ALREADY_BOOKED: 409,
  PRICE_CHANGED: 409,
  TRIP_NOT_VERIFIED: 409,
  TOO_EARLY: 409,
  TRIP_NOT_STARTABLE: 409,
  ODO_REGRESSION: 422,
  PROOF_ALREADY_USED: 409,
  DUPLICATE_REFERENCE: 409,
  PAYMENT_ALREADY_CONFIRMED: 409,
  UNBALANCED_JOURNAL: 422,
  IMMUTABLE: 409,
  RATE_LIMITED: 429,
  IDEMPOTENCY_CONFLICT: 409,
  INTERNAL: 500,
  NETWORK: 502,
};

/**
 * Stateless calls raise with a machine prefix, e.g. `raise exception 'CONFLICT: already decided'`.
 *
 * Matching is anchored at the start and longest-code-first: a detail that merely *mentions* a code
 * ("CONFLICT: the CONFLICT table…") must not be reclassified, and `PAYMENT_ALREADY_CONFIRMED` must win
 * over any shorter code that happens to be a prefix of it.
 */
const PREFIXES = [...ERROR_CODES].sort((a, b) => b.length - a.length);

export function errorCodeFromMessage(message: string): ErrorCode | null {
  const trimmed = message.trimStart();
  for (const code of PREFIXES) {
    if (trimmed.startsWith(`${code}:`) || trimmed === code) return code;
  }
  return null;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** Normalizes anything the network/DOM throws into the contract above. */
export function toApiFailure(input: unknown): ApiFailure {
  if (input && typeof input === 'object') {
    const candidate = input as Partial<ApiFailure>;
    if (isErrorCode(candidate.code)) {
      return {
        code: candidate.code,
        ...(candidate.detail ? { detail: candidate.detail } : {}),
        ...(candidate.fields ? { fields: candidate.fields } : {}),
        ...(candidate.context ? { context: candidate.context } : {}),
        ...(candidate.requestId ? { requestId: candidate.requestId } : {}),
      };
    }
  }
  if (input instanceof Error) return { code: 'NETWORK', detail: input.message };
  return { code: 'INTERNAL' };
}
