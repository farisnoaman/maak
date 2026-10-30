/**
 * Minimal HS256 JWT — enough for a local dev stack, and clearly not a production auth server.
 *
 * Real Supabase signs tokens with a project secret; the dev backend does the same with a fixed local
 * secret so `@supabase/ssr` and our own gateway agree. Verification is constant-time and checks
 * `exp`, so an expired session behaves exactly like it does against GoTrue.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const JWT_SECRET =
  process.env.MAAK_JWT_SECRET ?? 'maak-local-dev-secret-do-not-use-in-production-32';
const TTL_SECONDS = 3600;

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(input) {
  return createHmac('sha256', JWT_SECRET).update(input).digest('base64url');
}

export function signJwt(claims, ttlSeconds = TTL_SECONDS) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({ iat: now, exp: now + ttlSeconds, ...claims, aud: 'authenticated' }),
  );
  const signature = sign(`${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

/** Returns the claims, or null when the token is malformed, forged or expired. */
export function verifyJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expected = sign(`${header}.${payload}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims.exp === 'number' && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

export function tokenFromRequest(request) {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}
