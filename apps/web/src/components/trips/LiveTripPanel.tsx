'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  formatDateTime,
  formatDistanceKm,
  formatEta,
  formatNumber,
  isProgressStale,
  liveEtaSeconds,
  progressPercent,
  stopName,
  translate,
  type Locale,
  type TranslationKey,
  type TripProgressSnapshot,
} from '@maak/core';

import { Badge } from '@/components/ui/Feedback';
import { sessionHeaders } from '@/lib/session-token';

/**
 * The passenger's live screen.
 *
 * It polls every 30 seconds rather than holding a websocket open. The dev backend has no realtime
 * endpoint, and a transport that exists in one environment only is a screen that works in development
 * and lies in production — so polling is the path that ships, and the private `trip:<id>` channel can be
 * laid on top of it later without changing this component's contract.
 *
 * Everything time-dependent is computed against the browser's clock, not trusted from the payload: that
 * is what makes a tab left open for an hour say «الموقع غير محدّث» instead of showing a stale position
 * with a confident green badge.
 */
export function LiveTripPanel({
  locale,
  code,
  initial,
}: {
  readonly locale: Locale;
  readonly code: string;
  readonly initial: TripProgressSnapshot;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [snapshot, setSnapshot] = useState<TripProgressSnapshot>(initial);
  const [now, setNow] = useState(() => new Date());
  const [denied, setDenied] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/data/rest/v1/rpc/get_trip_progress', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sessionHeaders() },
      body: JSON.stringify({ p_code: code }),
      cache: 'no-store',
    }).catch(() => null);

    if (!response) return;
    if (response.status === 401 || response.status === 403) {
      // The booking was cancelled, or the session ended in this tab. Stop polling and say so.
      setDenied(true);
      return;
    }
    if (!response.ok) return;

    const payload = (await response.json().catch(() => null)) as TripProgressSnapshot | null;
    if (payload?.trip?.id) setSnapshot(payload);
  }, [code]);

  useEffect(() => {
    if (denied) return;
    const poll = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(poll);
  }, [denied, refresh]);

  // A minute of resolution is enough for "updated 6 minutes ago" and costs nothing.
  useEffect(() => {
    const beat = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(beat);
  }, []);

  const stale = isProgressStale(snapshot.lastPingAt, now, snapshot.staleAfterSeconds);
  const percent = progressPercent(snapshot.progressPct);
  const running = snapshot.trip.status === 'in_progress';
  const finished = snapshot.trip.status === 'completed';
  const place = snapshot.nextStop
    ? stopName(snapshot.nextStop, locale)
    : snapshot.stops.filter((stop) => stop.reached).at(-1)
      ? stopName(snapshot.stops.filter((stop) => stop.reached).at(-1)!, locale)
      : null;
  const updated = snapshot.lastPingAt ? formatDateTime(snapshot.lastPingAt, { locale }) : null;
  const nextEta = formatEta(liveEtaSeconds(snapshot, 'next', now), locale);
  const destinationEta = formatEta(liveEtaSeconds(snapshot, 'destination', now), locale);

  return (
    <section className="live-panel" aria-live="polite">
      <div className="live-panel__head">
        <Badge tone={stale ? 'warning' : 'success'}>
          {stale ? t('live.stale') : t('live.live')}
        </Badge>
        <span className="live-panel__code">{snapshot.trip.code}</span>
      </div>

      {denied ? (
        <p className="ui-alert ui-alert--warning" role="alert">
          {t('live.notAllowed')}
        </p>
      ) : null}

      {finished ? <p className="trip-form__hint">{t('live.finished')}</p> : null}
      {!running && !finished ? <p className="trip-form__hint">{t('live.notStarted')}</p> : null}
      {running && !snapshot.position ? (
        <p className="trip-form__hint">{t('live.noPosition')}</p>
      ) : null}

      {snapshot.position && place ? (
        <p className="live-panel__now">
          {stale ? t('live.lastSeen', { place }) : t('live.nowAt', { place })}
        </p>
      ) : null}

      <div
        className="live-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={t('live.progress', { percent })}
      >
        <span className="live-bar__fill" style={{ inlineSize: `${percent}%` }} />
      </div>
      <p className="live-panel__meta">{t('live.progress', { percent })}</p>

      <dl className="trip-summary">
        {snapshot.nextStop?.distanceKm != null ? (
          <div className="trip-summary__row">
            <dt>{stopName(snapshot.nextStop, locale)}</dt>
            <dd>
              {t('live.nextStop', {
                distance: formatDistanceKm(snapshot.nextStop.distanceKm, locale),
              })}
            </dd>
          </div>
        ) : null}

        {snapshot.destination?.distanceKm != null ? (
          <div className="trip-summary__row">
            <dt>{stopName(snapshot.destination, locale)}</dt>
            <dd>
              {t('live.destination', {
                distance: formatDistanceKm(snapshot.destination.distanceKm, locale),
                place: stopName(snapshot.destination, locale),
              })}
            </dd>
          </div>
        ) : null}

        {nextEta ? (
          <div className="trip-summary__row">
            <dt>{t('live.eta', { eta: nextEta })}</dt>
            <dd>{destinationEta ? t('live.eta', { eta: destinationEta }) : ''}</dd>
          </div>
        ) : null}

        {snapshot.speedKmh ? (
          <div className="trip-summary__row">
            <dt>{t('live.speed', { speed: formatNumber(snapshot.speedKmh, { locale }) })}</dt>
            <dd>{updated ? t('live.updated', { when: updated }) : ''}</dd>
          </div>
        ) : null}
      </dl>

      {stale && updated ? (
        <p className="ui-alert ui-alert--warning" role="status">
          {t('live.staleBody', { when: updated })}
        </p>
      ) : null}

      <ol className="trip-timeline">
        {snapshot.stops.map((stop) => (
          <li key={stop.seq} className={stop.reached ? 'is-reached' : undefined}>
            <span className="trip-timeline__marker" aria-hidden="true">
              {stop.reached ? '✓' : stop.seq}
            </span>
            <span className="trip-timeline__name">{stopName(stop, locale)}</span>
          </li>
        ))}
      </ol>

      {updated && !stale ? (
        <p className="trip-form__hint">{t('live.updated', { when: updated })}</p>
      ) : null}
    </section>
  );
}
