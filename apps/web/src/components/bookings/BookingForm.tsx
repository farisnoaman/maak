'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  bookingsCommandSpec,
  computePrice,
  errorKey,
  formatMinor,
  translate,
  type Locale,
  type PriceBreakdown,
  type TranslationKey,
} from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { getApiClient } from '@/lib/api';

export interface BookableTrip {
  readonly id: string;
  readonly code: string;
  readonly currency: string;
  readonly seatsAvailable: number;
  readonly seatsTotal: number;
  readonly bookingMode: string;
  readonly pricingMode: string;
  readonly pricePerSeatYer: number | null;
  readonly wholeTripPriceYer: number | null;
  readonly discount: { readonly kind: string; readonly value: number; readonly scope: string };
  readonly genderPolicy: string;
}

export interface BookableStop {
  readonly id: string;
  readonly seq: number;
  readonly name: string;
  readonly priceFromOriginYer: number | null;
}

type Failure = {
  readonly code: string;
  readonly detail?: string;
  readonly fields?: Record<string, string>;
};

/**
 * The booking form.
 *
 * It computes the fare with `computePrice()` — the same function the SQL mirrors and the pricing tests
 * pin — so what the passenger reads before tapping "reserve" is the number the command will recompute.
 * The total is still sent as a *claim*: `cmd_create_booking` compares it and answers `PRICE_CHANGED` if
 * the trip moved under them, which is the only way a client can be wrong without overcharging somebody.
 */
export function BookingForm({
  locale,
  trip,
  stops,
}: {
  readonly locale: Locale;
  readonly trip: BookableTrip;
  readonly stops: readonly BookableStop[];
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const router = useRouter();

  const wholeTrip = trip.bookingMode === 'whole_trip';
  const maxSeats = wholeTrip ? 1 : Math.min(8, Math.max(trip.seatsAvailable, 0));
  const [seats, setSeats] = useState(1);
  const [stopSeq, setStopSeq] = useState<number | null>(null);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [gender, setGender] = useState<'' | 'male' | 'female'>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<{ code: string; holdExpiresAt: string | null } | null>(null);

  const stop = stops.find((item) => item.seq === stopSeq) ?? null;

  const price = useMemo<PriceBreakdown | null>(() => {
    try {
      return computePrice({
        bookingMode: trip.bookingMode as never,
        pricingMode: trip.pricingMode as never,
        seats,
        pricePerSeatMinor: trip.pricePerSeatYer ?? 0,
        wholeTripPriceMinor: trip.wholeTripPriceYer,
        boardingStop: stop
          ? { stopId: stop.id, priceFromOriginMinor: stop.priceFromOriginYer }
          : null,
        discount: {
          kind: trip.discount.kind as never,
          value: trip.discount.value,
          scope: trip.discount.scope as never,
        },
        currency: 'YER',
      });
    } catch {
      return null;
    }
  }, [trip, stop, seats]);

  async function submit() {
    setFailure(null);
    const client = getApiClient();
    if (!client) {
      setFailure({ code: 'INTERNAL', detail: t('verification.notConfigured') });
      return;
    }

    setBusy(true);
    const result = await client.call(bookingsCommandSpec, {
      action: 'booking.create',
      tripId: trip.id,
      seats,
      destinationStopId: stop?.id ?? null,
      claimedTotalMinor: price?.totalMinor ?? null,
      contactName,
      contactPhone,
      gender: gender === '' ? null : gender,
      note: note.trim() === '' ? null : note.trim(),
    } as never);
    setBusy(false);

    if (!result.ok) {
      setFailure(result.error as Failure);
      return;
    }

    const booking = (result.data as { booking?: Record<string, unknown> }).booking ?? {};
    setDone({
      code: String(booking.code ?? ''),
      holdExpiresAt: booking.hold_expires_at ? String(booking.hold_expires_at) : null,
    });
    router.refresh();
  }

  if (done) {
    return (
      <div className="booking-done" role="status">
        <h2>{t('bookings.requested')}</h2>
        <p className="booking-done__code" dir="ltr">
          {done.code}
        </p>
        <p>{t('bookings.holdExplain', { minutes: 30 })}</p>
        <div className="form-actions">
          <Link className="ui-btn ui-btn--primary ui-btn--md" href={`/${locale}/account/bookings`}>
            {t('bookings.myTitle')}
          </Link>
          <Link className="ui-btn ui-btn--ghost ui-btn--md" href={`/${locale}/trips/${trip.code}`}>
            {t('common.back')}
          </Link>
        </div>
      </div>
    );
  }

  if (trip.seatsAvailable < 1) {
    return (
      <p className="fleet-warning" role="status">
        {t('bookings.noSeatsLeft')}
      </p>
    );
  }

  return (
    <div className="booking-form">
      {failure ? (
        <p className="ui-alert ui-alert--error" role="alert">
          {failure.code === 'PRICE_CHANGED'
            ? t('errors.PRICE_CHANGED')
            : failure.fields
              ? t('errors.VALIDATION_FAILED')
              : t(errorKey(failure.code as never))}
        </p>
      ) : null}

      {wholeTrip ? (
        <p className="trip-form__hint">{t('bookings.wholeTripHint')}</p>
      ) : (
        <Field
          label={t('bookings.seats')}
          type="number"
          min={1}
          max={maxSeats}
          value={seats}
          onChange={(event) =>
            setSeats(Math.min(maxSeats, Math.max(1, Number(event.target.value) || 1)))
          }
          hint={t('bookings.seatsAvailable', { count: trip.seatsAvailable })}
        />
      )}

      {stops.length > 0 ? (
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="booking-stop">
            {t('bookings.destinationStop')}
          </label>
          <select
            id="booking-stop"
            className="ui-input"
            value={stopSeq ?? ''}
            onChange={(event) =>
              setStopSeq(event.target.value === '' ? null : Number(event.target.value))
            }
          >
            <option value="">{t('bookings.finalDestination')}</option>
            {stops.map((item) => (
              <option key={item.id} value={item.seq}>
                {item.seq}. {item.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <Field
        label={t('bookings.contactName')}
        value={contactName}
        onChange={(event) => setContactName(event.target.value)}
        autoComplete="name"
        required
      />
      <Field
        label={t('bookings.contactPhone')}
        type="tel"
        dir="ltr"
        value={contactPhone}
        onChange={(event) => setContactPhone(event.target.value)}
        autoComplete="tel"
        required
      />
      <div className="ui-field">
        <label className="ui-field__label" htmlFor="booking-gender">
          {t('bookings.gender')}
        </label>
        <select
          id="booking-gender"
          className="ui-input"
          value={gender}
          onChange={(event) => setGender(event.target.value as '' | 'male' | 'female')}
          required={trip.genderPolicy !== 'any'}
        >
          <option value="">{t('bookings.genderUnset')}</option>
          <option value="male">{t('bookings.genderMale')}</option>
          <option value="female">{t('bookings.genderFemale')}</option>
        </select>
        {trip.genderPolicy !== 'any' ? (
          <p className="ui-field__hint">{t('bookings.genderRequired')}</p>
        ) : null}
      </div>
      <Field
        label={t('bookings.note')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        hint={t('bookings.noteHint')}
        maxLength={500}
      />

      {price ? (
        <dl className="trip-summary booking-total">
          <div className="trip-summary__row">
            <dt>{t('trips.subtotal')}</dt>
            <dd>{formatMinor(price.subtotalMinor, 'YER', { locale })}</dd>
          </div>
          {price.discountMinor > 0 ? (
            <div className="trip-summary__row">
              <dt>{t('trips.discount')}</dt>
              <dd>− {formatMinor(price.discountMinor, 'YER', { locale })}</dd>
            </div>
          ) : null}
          <div className="trip-summary__row trip-summary__row--total">
            <dt>{t('bookings.total')}</dt>
            <dd>{formatMinor(price.totalMinor, 'YER', { locale })}</dd>
          </div>
        </dl>
      ) : null}

      <p className="trip-form__hint">{t('bookings.cashHint')}</p>

      <Button loading={busy} onClick={() => void submit()} fullWidth>
        {t('bookings.reserve')}
      </Button>
    </div>
  );
}
