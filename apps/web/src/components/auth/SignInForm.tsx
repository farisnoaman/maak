'use client';

import { useState } from 'react';
import { PHONE_PLACEHOLDER, translate, type Locale, type TranslationKey } from '@maak/core';
import { getBrowserClient } from '@/lib/supabase/browser';
import { AUTH_COOKIE_NAME } from '@/lib/supabase/config';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';

type Mode = 'email' | 'phone';

/**
 * Two sign-in paths, because Yemen is phone-first but email is the reliable fallback:
 *  - email + password (works everywhere, no SMS cost)
 *  - phone + OTP (primary for passengers; provider configured in Supabase Auth)
 *
 * All copy comes from the dictionaries; all errors are localized codes, never raw provider text.
 */
export function SignInForm({
  locale,
  configured,
  next,
}: {
  readonly locale: Locale;
  readonly configured: boolean;
  readonly next?: string;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const { push } = useToast();

  const [mode, setMode] = useState<Mode>('email');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the browser accepted the credentials but refused to keep the session cookie — which is
  // what a cross-site preview frame does when it blocks third-party storage.
  const [blocked, setBlocked] = useState(false);

  /**
   * The server gates protected pages on the session cookie, so a client-only "success" is not a
   * success. Confirm the cookie survived before navigating: a cross-site iframe that refuses it would
   * otherwise bounce the user straight back here with nothing to read.
   */
  function sessionPersisted(): boolean {
    return document.cookie.split('; ').some((part) => part.startsWith(`${AUTH_COOKIE_NAME}=`));
  }

  function finish() {
    push({ title: t('auth.signIn'), tone: 'success' });
    // A full navigation, not `router.push`: the point is to make the next request carry the cookie we
    // just wrote, and the client router may serve the destination from its cache instead.
    window.location.assign(next ?? `/${locale}/account`);
  }

  async function handleEmailSignIn(event: React.FormEvent) {
    event.preventDefault();
    const client = getBrowserClient();
    if (!client) {
      setError(t('auth.notConfigured'));
      return;
    }

    setBusy(true);
    setError(null);
    const { error: authError } = await client.auth.signInWithPassword({ email, password });

    if (authError) {
      setBusy(false);
      setError(t('auth.invalidCredentials'));
      return;
    }
    if (!sessionPersisted()) {
      setBusy(false);
      setBlocked(true);
      setError(t('auth.sessionBlocked'));
      return;
    }

    finish();
  }

  async function handleSendCode(event: React.FormEvent) {
    event.preventDefault();
    const client = getBrowserClient();
    if (!client) {
      setError(t('auth.notConfigured'));
      return;
    }

    setBusy(true);
    setError(null);
    const { error: authError } = await client.auth.signInWithOtp({ phone });
    setBusy(false);

    if (authError) {
      setError(t('errors.INTERNAL'));
      return;
    }
    setCodeSent(true);
  }

  async function handleVerifyCode(event: React.FormEvent) {
    event.preventDefault();
    const client = getBrowserClient();
    if (!client) return;

    setBusy(true);
    setError(null);
    const { error: authError } = await client.auth.verifyOtp({ phone, token: code, type: 'sms' });

    if (authError) {
      setBusy(false);
      setError(t('errors.VALIDATION_FAILED'));
      return;
    }
    if (!sessionPersisted()) {
      setBusy(false);
      setBlocked(true);
      setError(t('auth.sessionBlocked'));
      return;
    }

    finish();
  }

  return (
    <div className="card auth-card">
      <h1>{t('auth.title')}</h1>
      <p className="sub">{t('auth.subtitle')}</p>

      {!configured ? (
        <p className="auth-notice" role="status">
          {t('auth.notConfigured')}
        </p>
      ) : null}

      {blocked ? (
        <Button
          variant="ghost"
          fullWidth
          onClick={() => window.open(window.location.href, '_blank')}
        >
          {t('auth.openInTab')}
        </Button>
      ) : null}

      <div className="auth-tabs" role="tablist" aria-label={t('auth.title')}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'email'}
          onClick={() => setMode('email')}
        >
          {t('auth.email')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'phone'}
          onClick={() => setMode('phone')}
        >
          {t('auth.signInWithPhone')}
        </button>
      </div>

      {mode === 'email' ? (
        <form className="auth-form" onSubmit={handleEmailSignIn}>
          <Field
            label={t('auth.email')}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={!configured}
          />
          <Field
            label={t('auth.password')}
            type="password"
            autoComplete="current-password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={!configured}
            error={error ?? undefined}
          />
          <Button type="submit" fullWidth loading={busy} disabled={!configured}>
            {t('auth.signIn')}
          </Button>
        </form>
      ) : (
        <form className="auth-form" onSubmit={codeSent ? handleVerifyCode : handleSendCode}>
          <Field
            label={t('auth.phone')}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder={PHONE_PLACEHOLDER}
            required
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            disabled={!configured}
          />
          {codeSent ? (
            <Field
              label={t('auth.code')}
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
              error={error ?? undefined}
            />
          ) : null}
          <Button type="submit" fullWidth loading={busy} disabled={!configured}>
            {codeSent ? t('auth.verify') : t('auth.sendCode')}
          </Button>
        </form>
      )}
    </div>
  );
}
