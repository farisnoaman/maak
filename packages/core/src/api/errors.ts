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
  'NOT_FOUND',
  'CONFLICT',
  'QUOTA_EXCEEDED',
  'EDIT_WINDOW_CLOSED',
  'CANCEL_WINDOW_CLOSED',
  'NO_SEATS_LEFT',
  'PRICE_CHANGED',
  'TRIP_NOT_VERIFIED',
  'TRIP_NOT_STARTABLE',
  'ODO_REGRESSION',
  'PROOF_ALREADY_USED',
  'DUPLICATE_REFERENCE',
  'PAYMENT_ALREADY_CONFIRMED',
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
  NOT_FOUND: 'errors.NOT_FOUND',
  CONFLICT: 'errors.CONFLICT',
  QUOTA_EXCEEDED: 'errors.QUOTA_EXCEEDED',
  EDIT_WINDOW_CLOSED: 'errors.EDIT_WINDOW_CLOSED',
  CANCEL_WINDOW_CLOSED: 'errors.CANCEL_WINDOW_CLOSED',
  NO_SEATS_LEFT: 'errors.NO_SEATS_LEFT',
  PRICE_CHANGED: 'errors.PRICE_CHANGED',
  TRIP_NOT_VERIFIED: 'errors.TRIP_NOT_VERIFIED',
  TRIP_NOT_STARTABLE: 'errors.INTERNAL',
  ODO_REGRESSION: 'errors.VALIDATION_FAILED',
  PROOF_ALREADY_USED: 'errors.VALIDATION_FAILED',
  DUPLICATE_REFERENCE: 'errors.VALIDATION_FAILED',
  PAYMENT_ALREADY_CONFIRMED: 'errors.CONFLICT',
  RATE_LIMITED: 'errors.RATE_LIMITED',
  IDEMPOTENCY_CONFLICT: 'errors.CONFLICT',
  INTERNAL: 'errors.INTERNAL',
  NETWORK: 'errors.NETWORK',
};

export function errorKey(code: ErrorCode): TranslationKey {
  return ERROR_KEYS[code] ?? 'errors.INTERNAL';
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
