/**
 * CORS with an explicit allow-list. No `*` in production: a browser-based write must prove
 * which origin it came from, and preflight is answered deliberately.
 */

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
  const allowed = allowedOrigins();
  const isAllowed = origin !== null && allowed.includes(origin);

  return {
    // Echo only a known origin; never `*`.
    ...(isAllowed ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key, x-maak-client',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
}

export function rejectDisallowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  // Non-browser callers (mobile apps, server-to-server) send no Origin and are allowed through;
  // they carry a bearer token and are rate-limited by actor.
  if (!origin) return false;
  return !allowedOrigins().includes(origin);
}
