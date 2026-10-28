'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { isLocale, translate, DEFAULT_LOCALE, type Locale, type TranslationKey } from '@maak/core';
import { reportError } from '@/lib/monitoring';
import { Button } from '@/components/ui/Button';

/**
 * Route-level error boundary. It shows a localized, actionable message and a request id,
 * never a stack trace — exceptions are for logs, not for users.
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
    <main id="main" className="shell section" role="alert">
      <h1>{t('errors.INTERNAL')}</h1>
      {error.digest ? (
        <p className="num" style={{ marginBlockStart: 'var(--space-3)', color: 'var(--ink-500)' }}>
          {error.digest}
        </p>
      ) : null}
      <div style={{ marginBlockStart: 'var(--space-6)' }}>
        <Button onClick={reset}>{t('common.retry')}</Button>
      </div>
    </main>
  );
}
