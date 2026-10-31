'use client';

import { translate } from '@maak/core';

/**
 * Last-resort boundary: renders when the root layout itself fails, so it cannot use providers,
 * fonts or the normal stylesheet. It still uses the shared dictionaries (plain functions, no
 * React context) and shows both languages, because at this point we cannot know which one the
 * user reads — but we can guarantee they are not stranded.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const arTitle = translate('ar', 'errors.INTERNAL');
  const enTitle = translate('en', 'errors.INTERNAL');
  const arRetry = translate('ar', 'common.retry');
  const enRetry = translate('en', 'common.retry');

  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'grid',
          placeItems: 'center',
          minHeight: '100vh',
          margin: 0,
          background: '#ffffff',
          color: '#0b1220',
        }}
      >
        <div style={{ textAlign: 'center', padding: 24, maxWidth: 480 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800 }}>{arTitle}</h1>
          <p style={{ color: '#5b6b80', fontSize: 14 }} dir="ltr">
            {enTitle}
          </p>
          {error.digest ? (
            <p style={{ color: '#8592a5', fontSize: 12, direction: 'ltr' }}>{error.digest}</p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 20,
              minHeight: 44,
              padding: '0 24px',
              borderRadius: 12,
              border: 0,
              background: '#0b7f60',
              color: '#fff',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {arRetry} / {enRetry}
          </button>
        </div>
      </body>
    </html>
  );
}
