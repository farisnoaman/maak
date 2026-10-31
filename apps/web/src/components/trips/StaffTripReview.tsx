'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  errorKey,
  translate,
  tripsCommandSpec,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { getApiClient } from '@/lib/api';
import type { TripRow } from '@/lib/trips';

/**
 * The staff review queue.
 *
 * A decision is a command with an audit trail, not a status the page writes: approving calls
 * `cmd_decide_trip_verification`, which refuses a self-review and requires a reason of at least ten
 * characters on a rejection. The form mirrors those two rules so staff do not learn them by failing.
 */
export function StaffTripReview({
  locale,
  trips,
}: {
  readonly locale: Locale;
  readonly trips: readonly TripRow[];
}) {
  const router = useRouter();
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function decide(trip: TripRow, outcome: 'approve' | 'reject') {
    setError(null);
    setMessage(null);

    if (outcome === 'reject' && reason.trim().length < 10) {
      setError(t('staff.trips.reasonRequired'));
      return;
    }

    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }

    setBusyId(trip.id);
    try {
      const result = await client.call(tripsCommandSpec, {
        action: 'trip.decideVerification',
        tripId: trip.id,
        outcome,
        reason: outcome === 'reject' ? reason.trim() : undefined,
      } as never);
      if (!result.ok) {
        setError(
          result.error.code === 'VALIDATION_FAILED' && result.error.detail
            ? result.error.detail
            : t(errorKey(result.error.code as never)),
        );
        return;
      }
      setMessage(outcome === 'approve' ? t('staff.trips.approved') : t('staff.trips.rejected'));
      setReason('');
      setOpenId(null);
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  if (trips.length === 0) {
    return (
      <p className="trip-form__hint" role="status">
        {t('staff.trips.empty')}
      </p>
    );
  }

  return (
    <div>
      {error ? (
        <p className="fleet-error" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="fleet-success" role="status">
          {message}
        </p>
      ) : null}

      <ul className="trip-queue">
        {trips.map((trip) => (
          <li className="card trip-queue__item" key={trip.id}>
            <h3>
              {trip.origin.nameAr} ← {trip.destination.nameAr}
            </h3>
            <p className="trip-form__hint">
              {trip.code} · {trip.departureAt.slice(0, 16).replace('T', ' ')} · {trip.vehicleLabel}
              {trip.driverName ? ` · ${trip.driverName}` : ''}
            </p>
            <div className="trip-form__actions">
              <Button
                loading={busyId === trip.id}
                onClick={() => {
                  void decide(trip, 'approve');
                }}
              >
                {t('staff.trips.approve')}
              </Button>
              <Button
                variant="danger"
                onClick={() => setOpenId((current) => (current === trip.id ? null : trip.id))}
              >
                {t('staff.trips.reject')}
              </Button>
            </div>
            {openId === trip.id ? (
              <div className="trip-cancel">
                <Field
                  label={t('staff.trips.reason')}
                  value={reason}
                  hint={t('staff.trips.reasonRequired')}
                  onChange={(event) => setReason(event.target.value)}
                />
                <Button
                  variant="danger"
                  loading={busyId === trip.id}
                  disabled={reason.trim().length < 10}
                  onClick={() => {
                    void decide(trip, 'reject');
                  }}
                >
                  {t('staff.trips.reject')}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
