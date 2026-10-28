/**
 * Gateway rules, as pure functions.
 *
 * These are the checks every edge function performs before it touches the database. Keeping them
 * here (rather than inline in Deno handlers) means they are unit-testable in milliseconds and a
 * client/edge divergence is impossible: the same origin rules run on both sides.
 */

export const MAX_BODY_BYTES = 256 * 1024;

export interface ZodIssueLike {
  readonly path: ReadonlyArray<string | number | symbol>;
  readonly message: string;
}

/** Turns zod issues into the field map the client renders next to each input. */
export function mapZodIssues(issues: readonly ZodIssueLike[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map((part) => String(part)).join('.') || '_';
    // Keep the first message per field: the user needs one clear problem, not a stack.
    if (!Object.hasOwn(fields, key)) fields[key] = issue.message;
  }
  return fields;
}

/**
 * Browser-originated writes must come from a known origin.
 * Requests with no Origin header (mobile apps, server-to-server) are allowed through here and
 * authenticated by bearer token instead — CORS is a browser control, not an auth mechanism.
 */
export function isOriginAllowed(
  origin: string | null | undefined,
  allowList: readonly string[],
): boolean {
  if (!origin) return true;
  return allowList.some((allowed) => allowed === origin);
}

export function isBodyTooLarge(byteLength: number, limit: number = MAX_BODY_BYTES): boolean {
  return !Number.isFinite(byteLength) || byteLength > limit;
}

export class WriteGuardError extends Error {
  readonly code = 'MULTIPLE_WRITES';
  constructor(fn: string) {
    super(`Command attempted more than one database write (second call: ${fn})`);
    this.name = 'WriteGuardError';
  }
}

export class NonCommandError extends Error {
  readonly code = 'NOT_A_COMMAND';
  constructor(fn: string) {
    super(`Only cmd_* functions may be called as writes (got ${fn})`);
    this.name = 'NonCommandError';
  }
}

/**
 * Enforces "one command = one transaction" (ADR-018).
 *
 * A handler gets exactly one write. The second attempt throws *before* reaching the database,
 * because a half-applied payment is worse than a failed request.
 */
export function createWriteGuard(): { use: (fn: string) => void; readonly count: () => number } {
  let count = 0;
  return {
    use(fn: string) {
      if (!fn.startsWith('cmd_')) throw new NonCommandError(fn);
      count += 1;
      if (count > 1) throw new WriteGuardError(fn);
    },
    count: () => count,
  };
}

/** Maps an HTTP status to the client error contract when the body carries no code. */
export function codeFromStatus(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 413) return 'VALIDATION_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL';
  return 'VALIDATION_FAILED';
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

/**
 * Sliding-window accounting, mirroring `app.consume_rate_limit` in SQL.
 * The database remains the source of truth (multi-instance safe); this exists so the edge can
 * fail fast and so the maths is tested once.
 */
export function evaluateRateLimit(input: {
  readonly used: number;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly elapsedSeconds: number;
}): RateLimitDecision {
  const { used, limit, windowSeconds, elapsedSeconds } = input;
  if (used < limit) {
    return { allowed: true, remaining: Math.max(0, limit - used - 1), retryAfterSeconds: 0 };
  }
  const retryAfter = Math.max(1, Math.ceil(windowSeconds - elapsedSeconds));
  return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter };
}
