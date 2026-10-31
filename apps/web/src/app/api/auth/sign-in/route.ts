import type { NextRequest } from 'next/server';
import { redirectTo } from '@/lib/redirect';
import { isSameOriginRequest } from '@/lib/origin';
import { getServerClient } from '@/lib/supabase/server';
import { getSupabaseConfig } from '@/lib/supabase/config';

/**
 * Sign-in as a plain form POST.
 *
 * Why server-side instead of `supabase.auth.signInWithPassword()` in the browser:
 *
 *   · the session cookie is written by the server on the redirect response, so the browser never has
 *     to expose it to JavaScript (`httpOnly`) and the next page load is guaranteed to carry it;
 *   · it works with JavaScript disabled, and it works when the client bundle is stale;
 *   · there is one code path to reason about, and it can be exercised end-to-end with `curl`.
 *
 * Three modes, one endpoint: `email`, `otp-send`, `otp-verify`.
 */

type Mode = 'email' | 'otp-send' | 'otp-verify';

/** Only same-origin, locale-prefixed destinations — an open redirect is a phishing primitive. */
function safeNext(value: FormDataEntryValue | null, locale: string): string {
  const candidate = typeof value === 'string' ? value : '';
  return /^\/[a-z]{2}(\/|$)/.test(candidate) ? candidate : `/${locale}/account`;
}

/**
 * "Could not reach the auth server" is not "wrong password", and telling them apart is the difference
 * between a user retrying a typo and a user staring at a login screen while the database is down.
 */
function isUnreachable(
  error: { status?: number; message?: string; name?: string } | null,
): boolean {
  if (!error) return false;
  if (error.status === 0) return true;
  return /fetch|network|failed to fetch|ECONNREFUSED|ENOTFOUND/i.test(
    `${error.name ?? ''} ${error.message ?? ''}`,
  );
}

function failure(request: NextRequest, locale: string, error: string, query = '') {
  const params = new URLSearchParams(query);
  params.set('error', error);
  return redirectTo(request, `/${locale}/auth/sign-in?${params}`, 303);
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const localeForError = String(form.get('locale') ?? 'ar');

  // A cross-site form post must not be able to sign a victim in to the attacker's account. The check
  // runs *after* parsing, so a rejection can be a readable redirect instead of a blank JSON page.
  if (!isSameOriginRequest(request)) {
    console.warn(
      `[auth] rejected a sign-in post from origin ${request.headers.get('origin') ?? '(none)'}`,
    );
    return redirectTo(request, `/${localeForError}/auth/sign-in?error=origin`, 303);
  }

  const locale = String(form.get('locale') ?? 'ar');
  const next = safeNext(form.get('next'), locale);
  const mode = String(form.get('mode') ?? 'email') as Mode;

  const client = await getServerClient();
  if (!client || !getSupabaseConfig()) return failure(request, locale, 'not-configured');

  if (mode === 'email') {
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    if (!email || !password) return failure(request, locale, 'invalid');

    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      console.warn(
        `[auth] sign-in failed: ${error.name ?? 'error'} ${error.status ?? ''} ${error.message}`,
      );
      return failure(request, locale, isUnreachable(error) ? 'backend' : 'invalid');
    }
    return redirectTo(request, next, 303);
  }

  const phone = String(form.get('phone') ?? '').trim();

  if (mode === 'otp-send') {
    if (!phone) return failure(request, locale, 'invalid');
    const { error } = await client.auth.signInWithOtp({ phone });
    if (error) return failure(request, locale, isUnreachable(error) ? 'backend' : 'otp-send');

    const params = new URLSearchParams({ step: 'code', phone });
    if (next !== `/${locale}/account`) params.set('next', next);
    return redirectTo(request, `/${locale}/auth/sign-in?${params}`, 303);
  }

  if (mode === 'otp-verify') {
    const token = String(form.get('code') ?? '').trim();
    if (!phone || !token) return failure(request, locale, 'otp-invalid', 'step=code');
    const { error } = await client.auth.verifyOtp({ phone, token, type: 'sms' });
    if (error)
      return failure(
        request,
        locale,
        'otp-invalid',
        `step=code&phone=${encodeURIComponent(phone)}`,
      );
    return redirectTo(request, next, 303);
  }

  return failure(request, locale, 'invalid');
}
