'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  errorKey,
  formatDateTime,
  translate,
  tripsCommandSpec,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Button } from '@/components/ui/Button';
import { getApiClient } from '@/lib/api';
import type { StaffTripRow } from '@/lib/trips';

type BulkRow = {
  readonly tripId: string;
  readonly code?: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly detail?: string;
};

/**
 * Bulk verification, with the results it actually produced.
 *
 * The point of the screen is the failure list: nine trips verified and one refused must leave a trace
 * on the page naming the one and saying why. A toast that says "done" over a partial success is how a
 * supervisor learns to distrust the tool.
 */
export function BulkVerifyPanel({
  locale,
  trips,
}: {
  readonly locale: Locale;
  readonly trips: readonly StaffTripRow[];
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const router = useRouter();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<readonly BulkRow[] | null>(null);
  const [summary, setSummary] = useState<{ verified: number; failed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  async function submit(outcome: 'approve' | 'reject') {
    if (selected.size === 0) {
      setError(t('ops.bulkNone'));
      return;
    }
    const client = getApiClient();
    if (!client) {
      setError(t('errors.INTERNAL'));
      return;
    }

    setBusy(true);
    setError(null);
    setResults(null);
    setSummary(null);

    const result = await client.call(tripsCommandSpec, {
      action: 'trip.bulkVerify',
      tripIds: [...selected],
      outcome,
      reason: reason.trim() === '' ? undefined : reason.trim(),
    } as never);

    setBusy(false);

    if (!result.ok) {
      setError(
        t(errorKey((result.error as { code: string }).code as Parameters<typeof errorKey>[0])),
      );
      return;
    }

    const data = result.data as {
      results?: BulkRow[];
      verified?: number;
      failed?: number;
    };
    setResults(data.results ?? []);
    setSummary({ verified: data.verified ?? 0, failed: data.failed ?? 0 });
    setSelected(new Set());
    router.refresh();
  }

  if (trips.length === 0) {
    return (
      <section className="card ops-bulk">
        <h2>{t('ops.bulkTitle')}</h2>
        {/* "No requests in this list" told a supervisor nothing: not which list, not whether that is good news,
            not what would put a trip in it. */}
        <p className="ops-clear" role="status">
          <span className="ops-clear__tick" aria-hidden="true">
            ✓
          </span>
          {t('ops.bulkClear')}
        </p>
        <Link className="link-more" href={`/${locale}/staff/trips`}>
          {t('ops.bulkClearAction')}
        </Link>
      </section>
    );
  }

  return (
    <section className="card ops-bulk">
      <h2>{t('ops.bulkTitle')}</h2>
      <p className="form-hint">{t('ops.bulkHint')}</p>

      {error ? (
        <p className="ui-alert ui-alert--error" role="alert">
          {error}
        </p>
      ) : null}

      {summary ? (
        <p className="ui-alert ui-alert--warning" role="status">
          {t('ops.bulkResult', { verified: summary.verified, failed: summary.failed })}
        </p>
      ) : null}

      {results && results.length > 0 ? (
        <ul className="ops-results">
          {results.map((row) => (
            <li key={row.tripId} className={row.ok ? 'ops-ok' : 'ops-deny'}>
              <strong>{row.code ?? row.tripId}</strong>{' '}
              {row.ok
                ? t('ops.rowOk')
                : `${row.error ?? ''}${row.detail ? ` — ${row.detail}` : ''}`}
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="ops-picklist">
        {trips.map((trip) => (
          <li key={trip.id}>
            <label className="ops-pick">
              <input
                type="checkbox"
                checked={selected.has(trip.id)}
                onChange={() => toggle(trip.id)}
                aria-label={`${t('ops.bulkSelect')} ${trip.code}`}
              />
              <span>
                <strong>{trip.code}</strong>{' '}
                <span className="form-hint">
                  {trip.origin} → {trip.destination} ·{' '}
                  {formatDateTime(trip.departureAt, { locale })}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="form-actions">
        <Button variant="primary" onClick={() => submit('approve')} disabled={busy}>
          {t('ops.bulkApprove')}
        </Button>
        <Button variant="ghost" onClick={() => submit('reject')} disabled={busy}>
          {t('ops.bulkReject')}
        </Button>
      </div>

      <label className="ui-field__label" htmlFor="bulk-reason">
        {t('ops.bulkReason')}
      </label>
      <input
        id="bulk-reason"
        className="ui-input"
        type="text"
        maxLength={500}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
    </section>
  );
}
