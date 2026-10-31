'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  errorKey,
  formatDateTime,
  stopName,
  translate,
  tripsCommandSpec,
  type Locale,
  type TranslationKey,
  type TripsAction,
} from '@maak/core';

import { Field } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { getApiClient } from '@/lib/api';
import type { DriverTripDetail } from '@/lib/driver-trips';

type Failure = { readonly code: string; readonly detail?: string };
type Busy = null | 'start' | 'end' | 'position' | number;

/**
 * The driver's console for one trip.
 *
 * The four things a driver does — start, say where they are, say which stop they reached, end — are four
 * calls into the same `trips` function the operator console uses. Nothing here decides anything: the
 * odometer floor, the two-hour window, the verification requirement and the monotonic stop sequence are
 * all enforced in `cmd_*`, and this panel's job is to make a refusal readable.
 *
 * The web fallback for location is a button, not a background watcher: a browser tab that reports a
 * position it cannot keep reporting would leave the passenger's screen confidently stale. One tap, one
 * ping, `source: 'web'` — and the native app owns the ten-minute cadence.
 */
export function TripRunPanel({
  locale,
  trip,
}: {
  readonly locale: Locale;
  readonly trip: DriverTripDetail;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const router = useRouter();

  const [odo, setOdo] = useState(trip.lastOdoKm == null ? '' : String(trip.lastOdoKm));
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const running = trip.status === 'in_progress';
  const finished = trip.status === 'completed';
  const cancelled = trip.status === 'cancelled';
  const nextStop = trip.stops.find((stop) => stop.seq > (trip.lastStopSeq ?? 0)) ?? null;
  const label = (stop: { nameAr: string | null; nameEn: string | null }) =>
    stopName(stop, locale) || '—';

  async function call(action: TripsAction) {
    const client = getApiClient();
    if (!client) {
      setFailure({ code: 'INTERNAL' });
      return;
    }
    setFailure(null);
    setNotice(null);
    const result = await client.call(tripsCommandSpec, action);
    if (!result.ok) {
      setFailure(result.error as Failure);
      return;
    }
    router.refresh();
    return result.data;
  }

  async function start() {
    const km = Number(odo);
    setBusy('start');
    await call({ action: 'trip.start', tripId: trip.id, odoKm: Number.isFinite(km) ? km : 0 });
    setBusy(null);
  }

  async function end() {
    const km = Number(odo);
    setBusy('end');
    const data = await call({
      action: 'trip.end',
      tripId: trip.id,
      odoKm: Number.isFinite(km) ? km : 0,
    });
    setBusy(null);
    if (data) setNotice(t('driver.ended'));
  }

  async function reached(seq: number) {
    setBusy(seq);
    await call({ action: 'trip.stopReached', tripId: trip.id, seq });
    setBusy(null);
    setNotice(t('driver.stopDone', { name: nextStop ? label(nextStop) : String(seq) }));
  }

  /**
   * One position report from the browser.
   *
   * `source: 'web'` is not cosmetic: it is how an operator later tells a background queue flush from
   * somebody tapping a button in a tab.
   */
  async function sharePosition() {
    setBusy('position');
    setFailure(null);
    setNotice(null);

    if (!('geolocation' in navigator)) {
      setBusy(null);
      setFailure({ code: 'POSITION_DENIED' });
      return;
    }

    const position = await new Promise<GeolocationPosition | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (found) => resolve(found),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
      );
    });

    if (!position) {
      setBusy(null);
      setFailure({ code: 'POSITION_DENIED' });
      return;
    }

    await call({
      action: 'trip.recordPing',
      tripId: trip.id,
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
      speedKmh:
        position.coords.speed != null && Number.isFinite(position.coords.speed)
          ? Math.max(0, position.coords.speed * 3.6)
          : null,
      recordedAt: new Date(position.timestamp).toISOString(),
      source: 'web',
    });
    setBusy(null);
    setNotice(t('driver.positionSent'));
  }

  return (
    <div className="card trip-run">
      {failure ? (
        <p className="ui-alert ui-alert--error" role="alert">
          {failure.code === 'POSITION_DENIED'
            ? t('driver.positionDenied')
            : t(errorKey(failure.code as Parameters<typeof errorKey>[0]))}
        </p>
      ) : null}
      {notice ? (
        <p className="form-success" role="status">
          {notice}
        </p>
      ) : null}

      <dl className="trip-summary">
        <div className="trip-summary__row">
          <dt>{t('driver.status')}</dt>
          <dd>{trip.status}</dd>
        </div>
        <div className="trip-summary__row">
          <dt>{t('driver.departure')}</dt>
          <dd>{formatDateTime(trip.departureAt, { locale })}</dd>
        </div>
        <div className="trip-summary__row">
          <dt>{t('driver.vehicle')}</dt>
          <dd>{trip.vehicleLabel}</dd>
        </div>
        <div className="trip-summary__row">
          <dt>{t('driver.passengers')}</dt>
          <dd>{t('driver.passengerCount', { count: trip.bookedSeats })}</dd>
        </div>
      </dl>

      {cancelled ? <p className="trip-form__hint">{t('driver.cancelled')}</p> : null}
      {finished ? <p className="trip-form__hint">{t('driver.completed')}</p> : null}

      {!running && !finished && !cancelled ? (
        <section aria-labelledby="start-heading">
          <h2 id="start-heading">{t('driver.startTitle')}</h2>
          <p className="trip-form__hint">{t('driver.startBody')}</p>
          <Field
            label={t('driver.odoLabel')}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={odo}
            onChange={(event) => setOdo(event.target.value)}
          />
          <Button variant="primary" onClick={start} disabled={busy !== null}>
            {t('driver.start')}
          </Button>
        </section>
      ) : null}

      {running ? (
        <section aria-labelledby="running-heading">
          <h2 id="running-heading">{t('driver.running')}</h2>
          <p className="trip-form__hint">{t('driver.runningBody')}</p>

          <div className="form-actions">
            <Button variant="ghost" onClick={sharePosition} disabled={busy !== null}>
              {t('driver.sharePosition')}
            </Button>
            {nextStop ? (
              <Button
                variant="primary"
                onClick={() => reached(nextStop.seq)}
                disabled={busy !== null}
              >
                {t('driver.stopReached', { name: label(nextStop) })}
              </Button>
            ) : null}
          </div>

          <h3>{t('driver.stops')}</h3>
          <ol className="trip-timeline">
            {trip.stops.map((stop) => (
              <li
                key={stop.seq}
                className={stop.seq <= (trip.lastStopSeq ?? 0) ? 'is-reached' : undefined}
              >
                <span className="trip-timeline__marker" aria-hidden="true">
                  {stop.seq <= (trip.lastStopSeq ?? 0) ? '✓' : stop.seq}
                </span>
                <span className="trip-timeline__name">{label(stop)}</span>
              </li>
            ))}
          </ol>

          <h3>{t('driver.endTitle')}</h3>
          <p className="trip-form__hint">{t('driver.endBody')}</p>
          <Field
            label={t('driver.odoLabel')}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={odo}
            onChange={(event) => setOdo(event.target.value)}
          />
          <Button variant="primary" onClick={end} disabled={busy !== null}>
            {t('driver.end')}
          </Button>
        </section>
      ) : null}
    </div>
  );
}
