'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PHONE_PLACEHOLDER, translate, type Locale, type TranslationKey } from '@maak/core';
import { getBrowserClient } from '@/lib/supabase/browser';
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
  const router = useRouter();
  const { push } = useToast();

  const [mode, setMode] = useState<Mode>('email');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEmailSignIn(event: React.FormEvent) {
    event.preventDefault();
    const client = getBrowserClient();
    if (!client) return;

    setBusy(true);
    setError(null);
    const { error: authError } = await client.auth.signInWithPassword({ email, password });
    setBusy(false);

    if (authError) {
      setError(t('auth.invalidCredentials'));
      return;
    }
    push({ title: t('auth.signIn'), tone: 'success' });
    router.push(next ?? `/${locale}/account`);
    router.refresh();
  }

  async function handleSendCode(event: React.FormEvent) {
    event.preventDefault();
    const client = getBrowserClient();
    if (!client) return;

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
    setBusy(false);

    if (authError) {
      setError(t('errors.VALIDATION_FAILED'));
      return;
    }
    router.push(next ?? `/${locale}/account`);
    router.refresh();
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
