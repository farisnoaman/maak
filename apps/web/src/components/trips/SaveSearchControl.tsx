'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  errorKey,
  notificationCommandSpec,
  translate,
  type Locale,
  type SavedSearchFilters,
  type TranslationKey,
} from '@maak/core';
import { Button } from '@/components/ui/Button';
import { getApiClient } from '@/lib/api';

/**
 * "Tell me when something matches this."
 *
 * The saved search is the marketplace's own predicate — the same object the server just searched with — so an
 * alert can never be for a slightly different search than the one on screen. Saving is a write, so it goes
 * through the gateway; the confirmation links to the notification centre rather than shouting, because the
 * alert arrives later and the user needs to know where it will be.
 */
export function SaveSearchControl({
  locale,
  filters,
}: {
  readonly locale: Locale;
  readonly filters: SavedSearchFilters;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [digest, setDigest] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasPredicate =
    Boolean(filters.q) ||
    (filters.origin?.length ?? 0) > 0 ||
    (filters.destination?.length ?? 0) > 0 ||
    filters.priceMax != null ||
    filters.dateFrom != null ||
    filters.dateTo != null ||
    filters.direct != null;

  async function save() {
    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);

    const result = await client.call(notificationCommandSpec, {
      action: 'search.save',
      filters,
      notify: true,
      digest,
    });

    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setSaved(true);
  }

  if (!hasPredicate) return null;

  return (
    <div className="save-search">
      {saved ? (
        <p className="form-success" role="status">
          {t('search.saved')}{' '}
          <Link href={`/${locale}/account/notifications`}>{t('search.savedTitle')}</Link>
        </p>
      ) : (
        <>
          <Button variant="subtle" size="sm" onClick={save} loading={busy}>
            {t('search.saveCurrent')}
          </Button>
          {/* The choice between one message per trip and one a day belongs at the moment of saving, not in a
              settings page the person has to find later. */}
          <label className="save-search__digest">
            <input
              type="checkbox"
              checked={digest}
              onChange={(event) => setDigest(event.target.checked)}
            />
            {t('search.digestOption')}
          </label>
        </>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
