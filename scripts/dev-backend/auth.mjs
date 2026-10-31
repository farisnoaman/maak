/**
 * `/auth/v1/*` — a small subset of GoTrue, enough for `@supabase/ssr` to hold a real session.
 *
 * Supported: password grant, refresh grant, signup, current user, update user, sign-out.
 * Everything else (magic links, OAuth, MFA, anonymous sign-in) answers 404 on purpose: the app does
 * not use it, and a silent stub would be worse than a loud miss.
 *
 * Refresh tokens are signed JWTs with a separate `kind`, so there is no session table to keep in
 * sync and no state that can leak between accounts.
 */

import { randomUUID } from 'node:crypto';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { signJwt, verifyJwt } from './jwt.mjs';
import { publicUser } from './rest.mjs';

const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Dev-only OTP. There is no SMS provider in a sandbox, so every number accepts the same code.
 * Documented in docs/dev-database.md and refused in production by construction: this file is never
 * shipped, and the real auth server is GoTrue.
 */
export const DEV_OTP_CODE = '111111';

/** Same rule as `normalizeYemeniPhone` in @maak/core (this file is plain Node, so it is repeated). */
function normalizePhone(input) {
  let local = String(input ?? '').replace(/[\s\-()]/g, '');
  if (local.startsWith('+967')) local = local.slice(4);
  else if (local.startsWith('00967')) local = local.slice(5);
  else if (local.startsWith('967') && local.length === 12) local = local.slice(3);
  return /^7[0-9]{8}$/.test(local) ? `+967${local}` : null;
}

function verifyPassword(stored, candidate) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(candidate, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashPassword(password) {
  const salt = randomUUID().replaceAll('-', '');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

async function loadUser(client, userId) {
  const { rows } = await client.query(
    'select id, email, phone, created_at from auth.users where id = $1',
    [userId],
  );
  return rows[0] ?? null;
}

function issueSession(row) {
  const refreshToken = signJwt({ sub: row.id, kind: 'refresh' }, REFRESH_TTL_SECONDS);
  const accessToken = signJwt({
    sub: row.id,
    role: 'authenticated',
    email: row.email ?? null,
    phone: row.phone ?? null,
    session_id: refreshToken,
  });
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: refreshToken,
    user: publicUser(row),
  };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function error(status, code, message) {
  return {
    status,
    headers: JSON_HEADERS,
    body: { code, error_code: code, msg: message, message },
  };
}

/**
 * One auth request. Returns `{ status, body, headers }`; the caller writes it to the socket.
 */
export async function handleAuth({ client, request, url, body, userId }) {
  const grant = url.searchParams.get('grant_type');
  const path = url.pathname;

  // POST /auth/v1/token?grant_type=password
  if (path === '/auth/v1/token' && grant === 'password') {
    const email = (body?.email ?? '').trim().toLowerCase();
    const phone = (body?.phone ?? '').trim();
    const password = body?.password ?? '';
    if ((!email && !phone) || !password) {
      return error(400, 'validation_failed', 'email/phone and password are required');
    }

    const { rows } = await client.query(
      `select u.id, u.email, u.phone, u.created_at, a.password
         from auth.users u
         left join dev.accounts a on a.user_id = u.id
        where ($1::text <> '' and lower(u.email) = $1)
           or ($2::text <> '' and u.phone = $2)
        limit 1`,
      [email, phone],
    );
    const row = rows[0];
    // Same message and same timing for "no such user" and "wrong password".
    if (!row || !verifyPassword(row.password, password)) {
      return error(400, 'invalid_grant', 'Invalid login credentials');
    }
    return { status: 200, headers: JSON_HEADERS, body: issueSession(row) };
  }

  // POST /auth/v1/token?grant_type=refresh_token
  if (path === '/auth/v1/token' && grant === 'refresh_token') {
    const claims = verifyJwt(body?.refresh_token);
    if (!claims || claims.kind !== 'refresh' || !claims.sub) {
      return error(400, 'invalid_grant', 'Invalid Refresh Token: Refresh Token Not Found');
    }
    const row = await loadUser(client, claims.sub);
    if (!row) return error(400, 'invalid_grant', 'Invalid Refresh Token: user no longer exists');
    return { status: 200, headers: JSON_HEADERS, body: issueSession(row) };
  }

  // POST /auth/v1/signup — the app allows e-mail/password self-service registration.
  if (path === '/auth/v1/signup') {
    const email = (body?.email ?? '').trim().toLowerCase() || null;
    const phone = (body?.phone ?? '').trim() || null;
    const password = body?.password ?? '';
    if (!email && !phone) return error(400, 'validation_failed', 'email or phone is required');
    if (password.length < 8)
      return error(400, 'weak_password', 'Password should be at least 8 characters');

    const existing = await client.query(
      `select 1 from auth.users where ($1::text is not null and lower(email) = $1)
          or ($2::text is not null and phone = $2) limit 1`,
      [email, phone],
    );
    if (existing.rows.length > 0) {
      return error(422, 'user_already_exists', 'User already registered');
    }

    const id = randomUUID();
    const { rows } = await client.query(
      `insert into auth.users (id, email, phone, raw_user_meta_data)
       values ($1, $2, $3, $4::jsonb)
       returning id, email, phone, created_at`,
      [id, email, phone, JSON.stringify(body?.data ?? {})],
    );
    await client.query(
      `insert into dev.accounts (user_id, password) values ($1, $2)
       on conflict (user_id) do update set password = excluded.password`,
      [id, hashPassword(password)],
    );
    return { status: 200, headers: JSON_HEADERS, body: issueSession(rows[0]) };
  }

  // GET /auth/v1/user — the session probe `@supabase/ssr` and `auth.getUser()` rely on.
  if (path === '/auth/v1/user' && request.method === 'GET') {
    if (!userId) return error(401, 'no_authorization', 'Invalid authentication credentials');
    const row = await loadUser(client, userId);
    if (!row) return error(403, 'user_not_found', 'User from sub claim in JWT does not exist');
    return { status: 200, headers: JSON_HEADERS, body: publicUser(row) };
  }

  // PUT /auth/v1/user — profile attributes live in `profiles`; only e-mail/password land here.
  if (path === '/auth/v1/user' && request.method === 'PUT') {
    if (!userId) return error(401, 'no_authorization', 'Invalid authentication credentials');
    if (body?.email) {
      await client.query('update auth.users set email = $2 where id = $1', [
        userId,
        String(body.email).trim().toLowerCase(),
      ]);
    }
    if (body?.password) {
      await client.query(
        `insert into dev.accounts (user_id, password) values ($1, $2)
         on conflict (user_id) do update set password = excluded.password`,
        [userId, hashPassword(String(body.password))],
      );
    }
    const row = await loadUser(client, userId);
    return { status: 200, headers: JSON_HEADERS, body: publicUser(row) };
  }

  // POST /auth/v1/otp — the phone-first path. There is no SMS provider locally, so the dev backend
  // accepts one fixed code and says so in the console. Any other code is rejected, which keeps the
  // failure path (and its UI copy) exercised.
  if (path === '/auth/v1/otp') {
    const phone = normalizePhone(body?.phone);
    if (!phone) return error(400, 'validation_failed', 'a Yemeni mobile number is required');
    const { rows } = await client.query('select id from auth.users where phone = $1 limit 1', [
      phone,
    ]);
    if (rows.length === 0) {
      // Supabase creates the account on first OTP request; mirror that so the flow can be tried
      // with any number.
      const id = randomUUID();
      await client.query(
        `insert into auth.users (id, phone, raw_user_meta_data) values ($1, $2, '{"locale":"ar"}')`,
        [id, phone],
      );
      await client.query(
        `insert into dev.accounts (user_id, password) values ($1, $2)
         on conflict (user_id) do update set password = excluded.password`,
        [id, hashPassword(randomUUID())],
      );
    }
    console.log(`  · OTP for ${phone}: ${DEV_OTP_CODE}`);
    return { status: 200, headers: JSON_HEADERS, body: {} };
  }

  // POST /auth/v1/verify — { phone, token, type: 'sms' }
  if (path === '/auth/v1/verify') {
    const phone = normalizePhone(body?.phone);
    const token = String(body?.token ?? '').trim();
    if (!phone || token !== DEV_OTP_CODE) {
      return error(403, 'otp_expired', 'Token has expired or is invalid');
    }
    const { rows } = await client.query(
      'select id, email, phone, created_at from auth.users where phone = $1 limit 1',
      [phone],
    );
    if (!rows[0]) return error(403, 'otp_expired', 'Token has expired or is invalid');
    return { status: 200, headers: JSON_HEADERS, body: issueSession(rows[0]) };
  }

  // POST /auth/v1/logout — stateless tokens, so this is an acknowledgement.
  if (path === '/auth/v1/logout') {
    return { status: 204, headers: JSON_HEADERS, body: null };
  }

  // GET /auth/v1/settings — supabase-js reads it to decide which providers to render.
  if (path === '/auth/v1/settings') {
    return {
      status: 200,
      headers: JSON_HEADERS,
      body: {
        external: { email: true, phone: true },
        disable_signup: false,
        mailer_autoconfirm: true,
        phone_autoconfirm: true,
      },
    };
  }

  return error(404, 'not_found', `auth endpoint ${path} is not part of the dev backend`);
}

export { hashPassword, verifyPassword };
