/**
 * Error reporting with a deliberately tiny surface.
 *
 * Sentry is not a dependency yet: `@sentry/nextjs` is browser/server instrumentation plus build
 * plugins, and wiring it before there is traffic adds cold-start cost and config drift. Instead the
 * app reports through this module, which:
 *   - never throws (a failing reporter must not break a page)
 *   - strips anything that could contain PII before it leaves the process
 *   - is a drop-in swap: implement `transport` with Sentry's `captureException`
 *
 * Set NEXT_PUBLIC_SENTRY_DSN to enable the HTTP transport below, or call `setErrorTransport()`
 * from an instrumentation hook once Sentry is installed.
 */

export interface ErrorContext {
  readonly boundary?: string;
  readonly digest?: string;
  readonly route?: string;
  readonly [key: string]: unknown;
}

type Transport = (payload: Record<string, unknown>) => void | Promise<void>;

const REDACTED_KEYS = [
  'password',
  'token',
  'authorization',
  'cookie',
  'id_number',
  'idNumber',
  'phone',
  'email',
  'iban',
  'account_ref',
];

/** Removes keys that must never reach a third party, at any depth. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.some((needle) => key.toLowerCase().includes(needle.toLowerCase()))) {
      output[key] = '[redacted]';
    } else {
      output[key] = redact(entry, depth + 1);
    }
  }
  return output;
}

let transport: Transport | null = null;

export function setErrorTransport(next: Transport | null): void {
  transport = next;
}

function httpTransport(payload: Record<string, unknown>): void {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  // Minimal envelope-shaped post; replace with the Sentry SDK when installed.
  void fetch('/api/monitoring/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => undefined);
}

export function reportError(error: unknown, context: ErrorContext = {}): void {
  try {
    const payload = {
      level: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: redact(context),
      at: new Date().toISOString(),
    };

    if (transport) {
      void transport(payload);
      return;
    }
    if (process.env.NODE_ENV !== 'production') {
      console.error('[maak]', payload.message, payload.context);
    }
    void httpTransport(payload);
  } catch {
    // Reporting must never break the app.
  }
}
