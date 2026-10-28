/**
 * CORS with an explicit allow-list — no `*`, ever.
 *
 * The matching logic lives in @maak/core (`isOriginAllowed`) so web, edge and tests share one
 * interpretation of "allowed origin".
 */

import { isOriginAllowed } from '@maak/core';

const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

export function allowedOrigins(): string[] {
  const configured = Deno.env.get('MAAK_ALLOWED_ORIGINS');
  if (!configured) return DEFAULT_ORIGINS;
  return configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');

  return {
    // Echo only a known origin; the browser rejects anything else.
    ...(isOriginAllowed(origin, allowedOrigins()) && origin
      ? { 'Access-Control-Allow-Origin': origin }
      : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key, x-maak-client',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/** True when a browser request comes from somewhere we did not approve. */
export function isDisallowedOrigin(request: Request): boolean {
  return !isOriginAllowed(request.headers.get('origin'), allowedOrigins());
}
