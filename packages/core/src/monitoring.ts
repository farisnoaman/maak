/**
 * Error reporting, minus the I/O.
 *
 * The app must never send a phone number, an ID number or a token to a third party. That rule is
 * easy to state and easy to break in a component that "just adds context". So the shaping and the
 * redaction live here, as pure functions with tests, and every surface (web, mobile, edge) builds its
 * payload through them. Shipping the payload is a one-line transport the app injects.
 */

export interface ErrorContext {
  readonly boundary?: string;
  readonly digest?: string;
  readonly route?: string;
  readonly [key: string]: unknown;
}

export interface ErrorPayload {
  readonly level: 'error';
  readonly message: string;
  readonly stack?: string;
  readonly context: unknown;
  readonly at: string;
}

/** Substring matches, case-insensitive, anywhere in a key. Erring wide is the point. */
export const REDACTED_KEYS = [
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'id_number',
  'idnumber',
  'national_id',
  'phone',
  'email',
  'iban',
  'account_ref',
  'card',
] as const;

export const REDACTED = '[redacted]';
const MAX_DEPTH = 5;
const MAX_STRING = 500;

function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return REDACTED_KEYS.some((needle) => lowered.includes(needle));
}

/**
 * Deep-copies `value`, replacing sensitive keys. Depth-limited and cycle-safe, because an error
 * reporter that throws or hangs is worse than no reporter.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…`
      : value;
  }
  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redact(entry, depth + 1, seen);
  }
  return output;
}

export function buildErrorPayload(
  error: unknown,
  context: ErrorContext = {},
  now: Date = new Date(),
): ErrorPayload {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : undefined;

  return {
    level: 'error',
    // Even the message is redacted: an API error can echo a phone number back.
    message: String(redact(message.slice(0, MAX_STRING))),
    ...(stack ? { stack: stack.split('\n').slice(0, 20).join('\n') } : {}),
    context: redact(context),
    at: now.toISOString(),
  };
}
