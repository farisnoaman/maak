'use client';

import Link from 'next/link';
import { PHONE_PLACEHOLDER, translate, type Locale, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { PasswordField } from '@/components/ui/PasswordField';

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
 *
 * The two methods are **links, not tabs**. They were `<a role="tab">` inside a `role="tablist"` with no tabpanel
 * anywhere: that tells a screen reader two panels exist and that the arrow keys move between them, neither of
 * which was true — and the stylesheet only styled `button[aria-selected]`, so the "active" tab looked exactly like
 * the inactive one. Two links that load two URLs are two links; `aria-current` says which one you are on.
 */
export function SignInForm({ locale, configured, next, tab, phone, error }: SignInFormProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  const waitingForCode = Boolean(phone);
  const withNext = (path: string) =>
    next ? `${path}${path.includes('?') ? '&' : '?'}next=${encodeURIComponent(next)}` : path;

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
                : error === 'backend'
                  ? t('auth.backendDown')
                  : error === 'expired'
                    ? t('auth.sessionExpired')
                    : null;

  return (
    <div className="auth-panel">
      <h1 className="auth-title">{t('auth.title')}</h1>
      <p className="auth-sub">{t('auth.subtitle')}</p>

      {!configured ? (
        <p className="auth-notice" role="status">
          {t('auth.notConfigured')}
        </p>
      ) : null}

      {errorMessage ? (
        <p className="auth-notice auth-notice--error" role="alert">
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

      <nav className="auth-methods" aria-label={t('auth.method')}>
        <Link
          className="auth-method"
          aria-current={tab === 'email' ? 'page' : undefined}
          href={withNext(`/${locale}/auth/sign-in`)}
        >
          {t('auth.tabEmail')}
        </Link>
        <Link
          className="auth-method"
          aria-current={tab === 'phone' ? 'page' : undefined}
          href={withNext(`/${locale}/auth/sign-in?tab=phone`)}
        >
          {t('auth.tabPhone')}
        </Link>
      </nav>

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
            <PasswordField
              locale={locale}
              label={t('auth.password')}
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

      <p className="auth-alt">
        <span>{t('auth.newHere')}</span>
        <Link href={withNext(`/${locale}/auth/sign-up`)}>{t('auth.createAccount')}</Link>
      </p>
    </div>
  );
}
