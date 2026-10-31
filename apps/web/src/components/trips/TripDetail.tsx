'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  computePrice,
  departureLabel,
  errorKey,
  formatMinor,
  isTripEditable,
  quotaMetricKey,
  quotaOf,
  translate,
  tripBadges,
  TRIP_BOOKING_KEY,
  TRIP_DISCOUNT_KIND_KEY,
  TRIP_GENDER_KEY,
  TRIP_PAYMENT_KEY,
  tripsCommandSpec,
  tripPriceFrom,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { getApiClient } from '@/lib/api';
import type { TripEventRow, TripOptions, TripRow, TripStopRow } from '@/lib/trips';
import { TripWizard } from './TripWizard';

const TONE: Record<
  'ok' | 'warn' | 'bad' | 'neutral',
  'success' | 'warning' | 'danger' | 'neutral'
> = { ok: 'success', warn: 'warning', bad: 'danger', neutral: 'neutral' };

const EVENT_KEY: Record<string, TranslationKey> = {
  created: 'trips.event.created',
  updated: 'trips.event.updated',
  published: 'trips.event.published',
  'verification.submitted': 'trips.event.verificationSubmitted',
  'verification.approved': 'trips.event.verificationApproved',
  'verification.rejected': 'trips.event.verificationRejected',
  cancelled: 'trips.event.cancelled',
  completed: 'trips.event.completed',
};

/**
 * One trip, from the operator's side: what it is, what it costs, and the four things that can happen to
 * it next.
 *
 * Two promises are kept here:
 *
 *  - **The edit form is the same wizard.** Editing reuses `TripWizard`, so a field that exists in create
 *    cannot be missing from edit (the Phase 3 defect this pattern was introduced to end).
 *  - **A refused publish is not a lost draft.** Publishing and saving are separate commands, so a
 *    `QUOTA_EXCEEDED` from `cmd_publish_trip` leaves the trip saved and reports the reason.
 */
export function TripDetail({
  locale,
  trip,
  stops,
  events,
  options,
  canManage,
}: {
  readonly locale: Locale;
  readonly trip: TripRow;
  readonly stops: readonly TripStopRow[];
  readonly events: readonly TripEventRow[];
  readonly options: TripOptions;
  readonly canManage: boolean;
}) {
  const router = useRouter();
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const editable = isTripEditable(trip);
  const badges = tripBadges(trip);
  const when = departureLabel(trip.departureAt, locale);

  /** A one-seat quote, which is what the card advertises; the full breakdown is per booking. */
  const quote = (() => {
    const pricePerSeatMinor = tripPriceFrom(trip, stops) ?? 0;
    try {
      return computePrice({
        bookingMode: trip.bookingMode as 'per_seat' | 'whole_trip' | 'both',
        pricingMode: trip.pricingMode as 'flat' | 'per_stop',
        seats: trip.bookingMode === 'whole_trip' ? trip.seatsTotal : 1,
        pricePerSeatMinor,
        wholeTripPriceMinor: trip.wholeTripPriceYer,
        discount:
          trip.discountKind === 'none'
            ? null
            : {
                kind: trip.discountKind as 'fixed' | 'percent',
                value: trip.discountValue,
                scope: trip.discountScope as 'all' | 'per_seat' | 'whole_trip',
              },
      });
    } catch {
      // A trip whose fare is not yet configured is a draft, not an error page.
      return null;
    }
  })();

  function reportFailure(failure: { code: string; detail?: string }) {
    const quota = quotaOf({ code: failure.code as never, detail: failure.detail });
    if (quota) {
      setError(
        t('fleet.quotaReached', {
          metric: t(quotaMetricKey(quota.metric)),
          limit: quota.limit === null ? t('fleet.unlimited') : quota.limit,
        }),
      );
      return;
    }
    if (failure.code === 'VALIDATION_FAILED' && failure.detail) {
      setError(failure.detail);
      return;
    }
    setError(t(errorKey(failure.code as never)));
  }

  async function run(
    action: 'trip.publish' | 'trip.submitVerification' | 'trip.cancel',
    payload: Record<string, unknown> = {},
  ) {
    setError(null);
    setMessage(null);
    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    try {
      const result = await client.call(tripsCommandSpec, {
        action,
        tripId: trip.id,
        ...payload,
      } as never);
      if (!result.ok) {
        reportFailure(result.error);
        return;
      }
      setMessage(
        action === 'trip.publish'
          ? t('trips.published')
          : action === 'trip.cancel'
            ? t('trips.cancelled', { reason })
            : t('trips.reviewSubmitted'),
      );
      setCancelling(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <section aria-labelledby="trip-edit-title">
        <h2 id="trip-edit-title">{t('trips.edit')}</h2>
        <Button variant="ghost" onClick={() => setEditing(false)}>
          {t('common.cancel')}
        </Button>
        <TripWizard
          locale={locale}
          orgId={trip.ownerOrgId}
          options={options}
          initial={{ trip, stops }}
          onSaved={() => setEditing(false)}
        />
      </section>
    );
  }

  return (
    <section aria-labelledby="trip-detail-title">
      <div className="trip-detail__head">
        <div>
          <h2 id="trip-detail-title">
            {trip.origin.nameAr}
            <span aria-hidden="true"> ← </span>
            {trip.destination.nameAr}
          </h2>
          <p className="trip-form__hint">
            {trip.code} · {when.date} · <bdi>{when.time}</bdi>
          </p>
        </div>
        <div className="trip-badges">
          {badges.map((badge) => (
            <Badge key={badge.code} tone={TONE[badge.tone]}>
              {t(badge.labelKey)}
            </Badge>
          ))}
        </div>
      </div>

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

      <dl className="trip-summary">
        <div className="trip-summary__row">
          <dt>{t('trips.vehicle')}</dt>
          <dd>{trip.vehicleLabel}</dd>
        </div>
        <div className="trip-summary__row">
          <dt>{t('trips.driver')}</dt>
          <dd>{trip.driverName ?? t('trips.noDriver')}</dd>
        </div>
        <div className="trip-summary__row">
          <dt>{t('trips.seats')}</dt>
          <dd>
            {t('trips.seatsAvailable', { count: trip.seatsAvailable })} / {trip.seatsTotal}
          </dd>
        </div>
        <div className="trip-summary__row">
          <dt>{t('trips.bookingMode')}</dt>
          <dd>{t(TRIP_BOOKING_KEY[trip.bookingMode] ?? 'trips.booking.per_seat')}</dd>
        </div>
        <div className="trip-summary__row">
          <dt>{t('trips.genderPolicy')}</dt>
          <dd>{t(TRIP_GENDER_KEY[trip.genderPolicy] ?? 'trips.gender.any')}</dd>
        </div>
        <div className="trip-summary__row">
          <dt>{t('trips.paymentPolicy')}</dt>
          <dd>{t(TRIP_PAYMENT_KEY[trip.paymentPolicy] ?? 'trips.payment.cash')}</dd>
        </div>
        <div className="trip-summary__row">
          <dt>{t('trips.discount')}</dt>
          <dd>
            {t(TRIP_DISCOUNT_KIND_KEY[trip.discountKind] ?? 'trips.discountKind.none')}
            {trip.discountKind === 'percent'
              ? ` · ${trip.discountValue / 100}%`
              : trip.discountKind === 'fixed'
                ? ` · ${formatMinor(trip.discountValue, 'YER', { locale })}`
                : ''}
          </dd>
        </div>
        {quote ? (
          <>
            <div className="trip-summary__row">
              <dt>{t('trips.pricePerSeat')}</dt>
              <dd>{formatMinor(quote.subtotalMinor, 'YER', { locale })}</dd>
            </div>
            {quote.discountMinor > 0 ? (
              <div className="trip-summary__row">
                <dt>{t('trips.discount')}</dt>
                <dd>− {formatMinor(quote.discountMinor, 'YER', { locale })}</dd>
              </div>
            ) : null}
            <div className="trip-summary__row trip-summary__row--total">
              <dt>{t('trips.total')}</dt>
              <dd>{formatMinor(quote.totalMinor, 'YER', { locale })}</dd>
            </div>
          </>
        ) : null}
      </dl>

      {trip.cancelReason ? (
        <p className="fleet-warning" role="status">
          {t('trips.cancelled', { reason: trip.cancelReason })}
        </p>
      ) : null}

      <h3>{t('trips.stops')}</h3>
      {stops.length === 0 ? (
        <p className="trip-form__hint">{t('trips.search.direct')}</p>
      ) : (
        <ol className="trip-timeline">
          {stops.map((stop) => (
            <li key={stop.id}>
              <span className="trip-timeline__marker" aria-hidden="true">
                {stop.seq}
              </span>
              <span className="trip-timeline__name">
                {locale === 'ar'
                  ? (stop.nameAr ?? stop.nameEn ?? '—')
                  : (stop.nameEn ?? stop.nameAr ?? '—')}
              </span>
              <span className="trip-timeline__meta">
                {t('trips.stopOffsetValue', { minutes: stop.arriveOffsetMinutes })}
                {stop.priceFromOriginYer != null
                  ? ` · ${formatMinor(stop.priceFromOriginYer, 'YER', { locale })}`
                  : ''}
              </span>
            </li>
          ))}
        </ol>
      )}

      <h3>{t('trips.timeline')}</h3>
      {events.length === 0 ? (
        <p className="trip-form__hint">—</p>
      ) : (
        <ol className="trip-timeline">
          {events.map((event) => (
            <li key={event.id}>
              <span className="trip-timeline__marker" aria-hidden="true">
                •
              </span>
              <span className="trip-timeline__name">
                {t(EVENT_KEY[event.kind] ?? 'trips.event.updated')}
              </span>
              <span className="trip-timeline__meta">
                {departureLabel(event.createdAt, locale).date}
              </span>
            </li>
          ))}
        </ol>
      )}

      {canManage ? (
        <div className="trip-form__actions">
          {editable ? (
            <Button variant="ghost" onClick={() => setEditing(true)}>
              {t('trips.edit')}
            </Button>
          ) : (
            <p className="trip-form__hint">{t('trips.editLocked')}</p>
          )}

          {trip.status === 'draft' && editable ? (
            <Button loading={busy} onClick={() => void run('trip.publish')}>
              {t('trips.publish')}
            </Button>
          ) : null}

          {trip.verificationStatus !== 'pending' && trip.status !== 'cancelled' ? (
            <Button
              variant="ghost"
              loading={busy}
              onClick={() => void run('trip.submitVerification')}
            >
              {t('trips.submitReview')}
            </Button>
          ) : null}

          {trip.status !== 'cancelled' && trip.status !== 'completed' ? (
            <Button variant="danger" onClick={() => setCancelling((open) => !open)}>
              {t('trips.cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {cancelling ? (
        <div className="trip-cancel">
          <Field
            label={t('trips.cancelReason')}
            value={reason}
            hint={t('trips.cancelReasonHint')}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            variant="danger"
            loading={busy}
            disabled={reason.trim().length < 5}
            onClick={() => void run('trip.cancel', { reason: reason.trim() })}
          >
            {t('trips.cancel')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
