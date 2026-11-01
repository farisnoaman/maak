'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { translate } from '@maak/core';
import { usePathLocale } from '@/lib/use-path-locale';

/**
 * The inbox failed to load.
 *
 * A notification centre that shows a stack trace is worse than one that says "try again": the person came to
 * find out what they missed, and the answer must never be a blank page. The retry re-renders the segment; the
 * link goes to the account page, which is always reachable.
 */
export default function NotificationsError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  // `error.tsx` is handed the error, not the route: the locale comes from the path like the loaders above.
  const locale = usePathLocale();

  useEffect(() => {
    // The server already logged it; this keeps the browser console honest for support screenshots.
    console.error('notifications failed to render', error.digest ?? error.message);
  }, [error]);

  return (
    <main id="main" className="shell section">
      <h1>{translate(locale, 'notifications.inboxTitle')}</h1>
      <p className="form-error" role="alert">
        {translate(locale, 'notifications.loadFailed')}
      </p>
      <div className="form-actions">
        <button type="button" className="btn btn--subtle" onClick={reset}>
          {translate(locale, 'common.retry')}
        </button>
        <Link className="btn" href={`/${locale}/account`}>
          {translate(locale, 'account.title')}
        </Link>
      </div>
    </main>
  );
}
