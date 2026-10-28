import { buildErrorPayload, type ErrorContext, type ErrorPayload } from '@maak/core';

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

export { redact, buildErrorPayload, REDACTED, REDACTED_KEYS } from '@maak/core';
export type { ErrorContext, ErrorPayload } from '@maak/core';

type Transport = (payload: ErrorPayload) => void | Promise<void>;

let transport: Transport | null = null;

export function setErrorTransport(next: Transport | null): void {
  transport = next;
}

function httpTransport(payload: ErrorPayload): void {
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
    // Shaping and redaction are pure and live in @maak/core, where they are unit-tested.
    const payload = buildErrorPayload(error, context);

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
