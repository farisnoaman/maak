import Link from 'next/link';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { PasswordField } from '@/components/ui/PasswordField';

export interface SignUpFormProps {
  readonly locale: Locale;
  readonly configured: boolean;
  readonly next?: string;
  /** Set after a successful sign-up that needs the address confirmed before there is a session. */
  readonly sent?: boolean;
  readonly error?: string;
}

/**
 * Registration, as a form POST to `/api/auth/sign-up` — the same shape as sign-in, for the same reasons.
 *
 * Only three fields. A name, an email and a password are everything the database needs to create a person
 * (`app.handle_new_user` writes the profile row from the sign-up metadata); the phone number, the identity
 * document and the company are asked for at the point where they are actually used. A registration form that asks
 * for a national ID has already lost the passenger who wanted one seat on Thursday.
 *
 * `sent` is the state that says "check your email": in a deployment with confirmations on, `signUp` returns no
 * session, and pretending it signed them in would be the lie that produces a support ticket.
 */
export function SignUpForm({ locale, configured, next, sent, error }: SignUpFormProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  const withNext = (path: string) =>
    next ? `${path}${path.includes('?') ? '&' : '?'}next=${encodeURIComponent(next)}` : path;

  const errorMessage =
    error === 'exists'
      ? t('auth.accountExists')
      : error === 'weak'
        ? t('auth.weakPassword')
        : error === 'invalid'
          ? t('auth.fieldsRequired')
          : error === 'not-configured'
            ? t('auth.notConfigured')
            : error === 'origin'
              ? t('auth.originMismatch')
              : error === 'backend'
                ? t('auth.backendDown')
                : null;

  if (sent) {
    return (
      <div className="auth-panel">
        <h1 className="auth-title">{t('auth.sentTitle')}</h1>
        <p className="auth-sub">{t('auth.sentBody')}</p>
        <p className="auth-alt">
          <span>{t('auth.haveAccount')}</span>
          <Link href={withNext(`/${locale}/auth/sign-in`)}>{t('auth.signIn')}</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-panel">
      <h1 className="auth-title">{t('auth.signUpTitle')}</h1>
      <p className="auth-sub">{t('auth.signUpSubtitle')}</p>

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

      <form className="auth-form" method="post" action="/api/auth/sign-up">
        <input type="hidden" name="locale" value={locale} />
        {next ? <input type="hidden" name="next" value={next} /> : null}

        <Field
          label={t('auth.fullName')}
          name="fullName"
          autoComplete="name"
          hint={t('auth.fullNameHint')}
          required
          minLength={2}
          disabled={!configured}
        />
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
          autoComplete="new-password"
          hint={t('auth.passwordHint')}
          required
          minLength={8}
          disabled={!configured}
        />
        <Button type="submit" fullWidth disabled={!configured}>
          {t('auth.signUpAction')}
        </Button>
      </form>

      <p className="auth-alt">
        <span>{t('auth.haveAccount')}</span>
        <Link href={withNext(`/${locale}/auth/sign-in`)}>{t('auth.signIn')}</Link>
      </p>
    </div>
  );
}
