'use client';

import { PHONE_PLACEHOLDER, translate, type Locale, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';

export type SignInTab = 'email' | 'phone';

export interface SignInFormProps {
  readonly locale: Locale;
  readonly configured: boolean;
  readonly next?: string;
  readonly tab: SignInTab;
  /** Present while waiting for the code: the account is already known, only the code is missing. */
  readonly phone?: string;
  readonly error?: string;
}

/**
 * A plain HTML form. No client-side auth state, no JavaScript in the submit path.
 *
 * The POST goes to `/api/auth/sign-in`, which holds the session cookie on the redirect response, so
 * there is nothing here that can succeed on the client and fail on the server. Errors come back as a
 * redirect with `?error=` and are rendered from the dictionaries, which keeps both locales honest.
 */
export function SignInForm({ locale, configured, next, tab, phone, error }: SignInFormProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  const waitingForCode = Boolean(phone);

  const errorMessage =
    error === 'invalid'
      ? t('auth.invalidCredentials')
      : error === 'otp-send'
        ? t('errors.INTERNAL')
        : error === 'otp-invalid'
          ? t('errors.VALIDATION_FAILED')
          : error === 'not-configured'
            ? t('auth.notConfigured')
            : error === 'blocked'
              ? t('auth.sessionBlocked')
              : error === 'origin'
                ? t('auth.originMismatch')
                : null;

  return (
    <div className="card auth-card">
      <h1>{t('auth.title')}</h1>
      <p className="sub">{t('auth.subtitle')}</p>

      {!configured ? (
        <p className="auth-notice" role="status">
          {t('auth.notConfigured')}
        </p>
      ) : null}

      {errorMessage ? (
        <p className="auth-notice" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {error === 'blocked' ? (
        // A top-level tab has no third-party restrictions, so this always works when the browser is
        // refusing to keep cookies inside the embedded preview.
        <a
          className="ui-btn ui-btn--ghost ui-btn--block"
          href={`/${locale}/auth/sign-in`}
          target="_blank"
          rel="noreferrer"
        >
          {t('auth.openInTab')}
        </a>
      ) : null}

      <div className="auth-tabs" role="tablist" aria-label={t('auth.title')}>
        <a
          role="tab"
          aria-selected={tab === 'email'}
          className={tab === 'email' ? 'is-active' : undefined}
          href={`/${locale}/auth/sign-in${next ? `?next=${encodeURIComponent(next)}` : ''}`}
        >
          {t('auth.email')}
        </a>
        <a
          role="tab"
          aria-selected={tab === 'phone'}
          className={tab === 'phone' ? 'is-active' : undefined}
          href={`/${locale}/auth/sign-in?tab=phone${next ? `&next=${encodeURIComponent(next)}` : ''}`}
        >
          {t('auth.signInWithPhone')}
        </a>
      </div>

      <form className="auth-form" method="post" action="/api/auth/sign-in">
        <input type="hidden" name="locale" value={locale} />
        {next ? <input type="hidden" name="next" value={next} /> : null}

        {tab === 'email' ? (
          <>
            <input type="hidden" name="mode" value="email" />
            <Field
              label={t('auth.email')}
              type="email"
              name="email"
              autoComplete="email"
              required
              disabled={!configured}
            />
            <Field
              label={t('auth.password')}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              minLength={8}
              disabled={!configured}
            />
            <Button type="submit" fullWidth disabled={!configured}>
              {t('auth.signIn')}
            </Button>
          </>
        ) : waitingForCode ? (
          <>
            <input type="hidden" name="mode" value="otp-verify" />
            <input type="hidden" name="phone" value={phone} />
            <Field label={t('auth.phone')} type="tel" value={phone} readOnly disabled />
            <Field
              label={t('auth.code')}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
            />
            <Button type="submit" fullWidth disabled={!configured}>
              {t('auth.verify')}
            </Button>
          </>
        ) : (
          <>
            <input type="hidden" name="mode" value="otp-send" />
            <Field
              label={t('auth.phone')}
              type="tel"
              name="phone"
              inputMode="tel"
              autoComplete="tel"
              placeholder={PHONE_PLACEHOLDER}
              required
              disabled={!configured}
            />
            <Button type="submit" fullWidth disabled={!configured}>
              {t('auth.sendCode')}
            </Button>
          </>
        )}
      </form>
    </div>
  );
}
