'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { isLocale, translate, DEFAULT_LOCALE, type Locale, type TranslationKey } from '@maak/core';
import { reportError } from '@/lib/monitoring';
import { Icon } from '@/components/ui/Icon';

/**
 * Route-level error boundary.
 *
 * It shows a localized, actionable message and a request id — never a stack trace: exceptions are for logs, not
 * for users. What it also does now is give the person somewhere to go: retry *and* the way back to the home page,
 * because a boundary that offers only "retry" traps anyone whose failure is deterministic in a loop.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams<{ locale?: string }>();
  const locale: Locale = isLocale(params?.locale) ? params.locale : DEFAULT_LOCALE;
  const t = (key: TranslationKey) => translate(locale, key);

  useEffect(() => {
    reportError(error, { boundary: 'route', digest: error.digest });
  }, [error]);

  return (
    <main id="main" className="shell state-screen" role="alert">
      <div className="state-screen__panel">
        <span className="state-screen__mark state-screen__mark--alert" aria-hidden="true">
          <Icon name="shield" size={24} />
        </span>
        <h1>{t('errors.INTERNAL')}</h1>
        <p className="state-screen__body">{t('page.errorBody')}</p>
        <div className="state-screen__actions">
          <button type="button" className="btn btn--primary" onClick={reset}>
            {t('common.retry')}
          </button>
          <a className="btn btn--ghost" href={`/${locale}`}>
            {t('nav.home')}
          </a>
        </div>
        {error.digest ? (
          <p className="state-screen__code num">
            <bdi>{error.digest}</bdi>
          </p>
        ) : null}
      </div>
    </main>
  );
}
