import type { NextRequest } from 'next/server';
import { redirectTo } from '@/lib/redirect';
import { isSameOriginRequest } from '@/lib/origin';
import { URL_SESSION_ENABLED, getServerClient } from '@/lib/supabase/server';
import { getSupabaseConfig } from '@/lib/supabase/config';

/**
 * Registration as a plain form POST — the same shape as `/api/auth/sign-in`, for the same reasons: the session cookie
 * is written by the server on the redirect, nothing in the submit path needs JavaScript, and the whole flow can be
 * exercised with `curl`.
 *
 * The profile row is not created here. `app.handle_new_user` fires on the `auth.users` insert and writes it from the
 * metadata below, so the database stays the only thing that creates a person — a client that forgets to call an
 * endpoint cannot leave a half-registered account behind.
 */

/** Only same-origin, locale-prefixed destinations — an open redirect is a phishing primitive. */
function safeNext(value: FormDataEntryValue | null, locale: string): string {
  const candidate = typeof value === 'string' ? value : '';
  return /^\/[a-z]{2}(\/|$)/.test(candidate) ? candidate : `/${locale}/account`;
}

function isUnreachable(
  error: { status?: number; message?: string; name?: string } | null,
): boolean {
  if (!error) return false;
  if (error.status === 0) return true;
  return /fetch|network|failed to fetch|ECONNREFUSED|ENOTFOUND/i.test(
    `${error.name ?? ''} ${error.message ?? ''}`,
  );
}

/**
 * Appends the session token to the redirect target — the cookie-less path for an embedded preview. Development
 * only, exactly as on sign-in.
 */
function withToken(path: string, token: string | undefined): string {
  if (!URL_SESSION_ENABLED || !token) return path;
  const [withoutHash, hash] = path.split('#');
  const separator = (withoutHash ?? '').includes('?') ? '&' : '?';
  return `${withoutHash}${separator}st=${encodeURIComponent(token)}${hash ? `#${hash}` : ''}`;
}

function failure(request: NextRequest, locale: string, error: string) {
  return redirectTo(request, `/${locale}/auth/sign-up?error=${error}`, 303);
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const locale = String(form.get('locale') ?? 'ar');

  // A cross-site post must not be able to create an account with a victim's browser as the author.
  if (!isSameOriginRequest(request)) {
    console.warn(
      `[auth] rejected a sign-up post from origin ${request.headers.get('origin') ?? '(none)'}`,
    );
    return redirectTo(request, `/${locale}/auth/sign-up?error=origin`, 303);
  }

  const next = safeNext(form.get('next'), locale);
  const client = await getServerClient();
  if (!client || !getSupabaseConfig()) return failure(request, locale, 'not-configured');

  const fullName = String(form.get('fullName') ?? '').trim();
  const email = String(form.get('email') ?? '')
    .trim()
    .toLowerCase();
  const password = String(form.get('password') ?? '');

  if (fullName.length < 2 || !email || password.length < 8) {
    return failure(
      request,
      locale,
      password.length > 0 && password.length < 8 ? 'weak' : 'invalid',
    );
  }

  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName, locale } },
  });

  if (error) {
    console.warn(
      `[auth] sign-up failed: ${error.name ?? 'error'} ${error.status ?? ''} ${error.message}`,
    );
    if (isUnreachable(error)) return failure(request, locale, 'backend');
    // GoTrue says `user_already_exists` (422 in recent versions, and a plain "User already registered" message in
    // older ones). Both mean the same thing to the person reading the form.
    if (/already|exists|registered/i.test(`${error.message} ${error.name ?? ''}`)) {
      return failure(request, locale, 'exists');
    }
    if (/password/i.test(error.message ?? '')) return failure(request, locale, 'weak');
    return failure(request, locale, 'invalid');
  }

  /**
   * Two legitimate answers. With e-mail confirmation off (the local stack) `signUp` returns a session and the person
   * is signed in. With confirmation on (a hosted project) there is no session until they click the link, and sending
   * them to `/account` would bounce straight back to this page with no explanation.
   */
  if (data.session?.access_token) {
    return redirectTo(request, withToken(next, data.session.access_token), 303);
  }
  return redirectTo(request, `/${locale}/auth/sign-up?sent=1`, 303);
}
