'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
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
import { Icon } from '@/components/ui/Icon';
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
  /** Clock time the vehicle reaches this stop, so two options can be compared without arithmetic. */
  readonly arrivalTime?: string | null;
}

/**
 * The trip the booking belongs to, so the summary can restate it.
 *
 * A passenger arrives at this page from a link, a search result or a shared message; the form asked them to remember
 * which trip, which day and which vehicle, because all it showed was a code in the heading.
 */
export interface BookingFacts {
  readonly origin: string;
  readonly destination: string;
  readonly date: string | null;
  readonly time: string | null;
  readonly vehicle: string | null;
  readonly seatsTotal: number;
  readonly driver: string | null;
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
  facts,
}: {
  readonly locale: Locale;
  readonly trip: BookableTrip;
  readonly stops: readonly BookableStop[];
  readonly facts: BookingFacts;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const router = useRouter();
  const pathname = usePathname() ?? `/${locale}/trips/${trip.code}/book`;

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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const alertRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    // The submit button sits at the bottom of a long form on a phone. A refusal that renders above the
    // fold looks exactly like a dead button, so the failure scrolls itself into view.
    if (failure) alertRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [failure]);

  /**
   * The same rules the schema enforces, checked before the round trip.
   *
   * The server still validates — this only decides whether there is any point asking it. `validation`
   * is localized and attached to the input it belongs to (`aria-invalid` + `aria-describedby`), because
   * "check the required fields" at the top of a form is a message that makes a person hunt.
   */
  function validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (contactName.trim().length < 2) errors.contactName = t('bookings.nameRequired');
    if (contactPhone.replace(/[^0-9]/g, '').length < 6)
      errors.contactPhone = t('bookings.phoneRequired');
    if (trip.genderPolicy !== 'any' && gender === '') errors.gender = t('bookings.genderRequired');
    return errors;
  }

  async function submit() {
    setFailure(null);
    const local = validate();
    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;

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
      if ((result.error as Failure).code === 'UNAUTHENTICATED') {
        // This page rendered signed in — otherwise it would have redirected already — so an anonymous
        // write means the session did not travel: no cookie sent, no preview token attached. Telling
        // somebody who just signed in to "sign in first" is the least useful sentence in the app.
        // Send them back through sign-in with this page as the destination instead.
        router.push(`/${locale}/auth/sign-in?error=expired&next=${encodeURIComponent(pathname)}`);
        return;
      }
      setFailure(result.error as Failure);
      const fields = (result.error as Failure).fields ?? {};
      const mapped: Record<string, string> = {};
      for (const key of Object.keys(fields)) mapped[key] = t('errors.VALIDATION_FAILED');
      setFieldErrors(mapped);
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
        <span className="booking-done__mark" aria-hidden="true">
          <Icon name="check" size={22} />
        </span>
        <h2>{t('bookings.requested')}</h2>
        {/* The code is the one thing they will be asked for at the desk, so it is the biggest thing on the panel. */}
        <p className="booking-done__code" dir="ltr">
          {done.code}
        </p>
        <p className="booking-done__note">{t('bookings.holdExplain', { minutes: 30 })}</p>
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

  const perSeat =
    trip.pricePerSeatYer == null ? null : formatMinor(trip.pricePerSeatYer, 'YER', { locale });

  return (
    <div className="booking-layout">
      {/* Fields on one side, the ticket on the other. On a phone the summary follows the fields, so the price and
          the button sit exactly where a thumb arrives at the end of the form. */}
      <div className="booking-fields">
        <section className="booking-group" aria-labelledby="booking-travel-title">
          <h2 className="booking-group__title" id="booking-travel-title">
            {t('bookings.groupTravel')}
          </h2>

          {wholeTrip ? (
            <p className="trip-form__hint">{t('bookings.wholeTripHint')}</p>
          ) : (
            <div className="seat-stepper" role="group" aria-labelledby="seat-stepper-label">
              <span className="ui-field__label" id="seat-stepper-label">
                {t('bookings.seats')}
              </span>
              <div className="seat-stepper__controls">
                <button
                  type="button"
                  className="seat-stepper__btn"
                  onClick={() => setSeats((current) => Math.max(1, current - 1))}
                  disabled={seats <= 1}
                  aria-label={t('bookings.seatsDecrease')}
                >
                  <Icon name="minus" size={16} />
                </button>
                <output className="seat-stepper__value num" aria-live="polite">
                  {seats}
                </output>
                <button
                  type="button"
                  className="seat-stepper__btn"
                  onClick={() => setSeats((current) => Math.min(maxSeats, current + 1))}
                  disabled={seats >= maxSeats}
                  aria-label={t('bookings.seatsIncrease')}
                >
                  <Icon name="plus" size={16} />
                </button>
              </div>
              <p className="ui-field__hint">
                {t('bookings.seatsAvailable', { count: trip.seatsAvailable })}
                {perSeat ? ` · ${t('bookings.perSeat')} ${perSeat}` : ''}
              </p>
            </div>
          )}

          {/* Where you get off, as a list of the trip's own stops rather than a dropdown: a dropdown hides the fare
              and the arrival time of every option but the chosen one, which is exactly the comparison being made. */}
          {stops.length > 0 ? (
            <fieldset className="stop-choice">
              <legend className="ui-field__label">{t('bookings.destinationStop')}</legend>
              <div className="stop-choice__list">
                <label className="stop-choice__option">
                  <input
                    type="radio"
                    name="booking-stop"
                    checked={stopSeq === null}
                    onChange={() => setStopSeq(null)}
                  />
                  <span className="stop-choice__body">
                    <span className="stop-choice__name">{t('bookings.finalDestination')}</span>
                    <span className="stop-choice__meta">{facts.destination}</span>
                  </span>
                </label>
                {stops.map((item) => (
                  <label className="stop-choice__option" key={item.id}>
                    <input
                      type="radio"
                      name="booking-stop"
                      checked={stopSeq === item.seq}
                      onChange={() => setStopSeq(item.seq)}
                    />
                    <span className="stop-choice__body">
                      <span className="stop-choice__name">
                        <span className="stop-choice__seq num" aria-hidden="true">
                          {item.seq}
                        </span>
                        {item.name}
                      </span>
                      <span className="stop-choice__meta">
                        {item.arrivalTime ? <bdi className="num">{item.arrivalTime}</bdi> : null}
                        {item.priceFromOriginYer != null
                          ? `${item.arrivalTime ? ' · ' : ''}${formatMinor(item.priceFromOriginYer, 'YER', { locale })}`
                          : ''}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

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
              aria-invalid={fieldErrors.gender ? true : undefined}
              aria-describedby={fieldErrors.gender ? 'booking-gender-error' : undefined}
            >
              <option value="">{t('bookings.genderUnset')}</option>
              <option value="male">{t('bookings.genderMale')}</option>
              <option value="female">{t('bookings.genderFemale')}</option>
            </select>
            {fieldErrors.gender ? (
              <p className="ui-field__error" id="booking-gender-error" role="alert">
                {fieldErrors.gender}
              </p>
            ) : trip.genderPolicy !== 'any' ? (
              <p className="ui-field__hint">{t('bookings.genderRequired')}</p>
            ) : null}
          </div>
        </section>

        <section className="booking-group" aria-labelledby="booking-contact-title">
          <h2 className="booking-group__title" id="booking-contact-title">
            {t('bookings.groupContact')}
          </h2>
          <Field
            label={t('bookings.contactName')}
            error={fieldErrors.contactName}
            value={contactName}
            onChange={(event) => setContactName(event.target.value)}
            autoComplete="name"
            required
          />
          <Field
            label={t('bookings.contactPhone')}
            error={fieldErrors.contactPhone}
            type="tel"
            dir="ltr"
            value={contactPhone}
            onChange={(event) => setContactPhone(event.target.value)}
            autoComplete="tel"
            required
          />
          <Field
            label={t('bookings.note')}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            hint={t('bookings.noteHint')}
            maxLength={500}
          />
        </section>
      </div>

      {/* The ticket: what is being booked, what it costs, and the one button that commits. Sticky from a laptop, so
          the total and the button stay in view while the fields are being filled in. */}
      <aside className="booking-summary" aria-labelledby="booking-summary-title">
        <h2 className="booking-summary__title" id="booking-summary-title">
          {t('bookings.summary')}
        </h2>

        <p className="booking-summary__route">
          <span>{facts.origin}</span>
          <Icon name="arrow" size={15} className="route-arrow" />
          <span>{facts.destination}</span>
        </p>
        {facts.date ? (
          <p className="booking-summary__when">
            {facts.date}
            {facts.time ? (
              <>
                {' · '}
                <bdi className="num">{facts.time}</bdi>
              </>
            ) : null}
          </p>
        ) : null}

        {/* The crew, restated: the passenger agreed to get into a specific vehicle with a specific driver. */}
        {facts.vehicle || facts.driver ? (
          <ul className="booking-summary__facts">
            {facts.vehicle ? (
              <li>
                <Icon name="bus" size={14} />
                {facts.vehicle}
              </li>
            ) : null}
            {facts.driver ? (
              <li>
                <Icon name="users" size={14} />
                {facts.driver}
              </li>
            ) : null}
            <li>
              <Icon name="seat" size={14} />
              {t('trips.detail.seatsOnBoard', { count: facts.seatsTotal })}
            </li>
          </ul>
        ) : null}

        {price ? (
          <dl className="booking-summary__breakdown">
            <div>
              <dt>{t('trips.subtotal')}</dt>
              <dd>{formatMinor(price.subtotalMinor, 'YER', { locale })}</dd>
            </div>
            {price.discountMinor > 0 ? (
              <div>
                <dt>{t('trips.discount')}</dt>
                <dd>− {formatMinor(price.discountMinor, 'YER', { locale })}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {price ? (
          <p className="booking-summary__total">
            <span>{t('bookings.total')}</span>
            <span className="num">{formatMinor(price.totalMinor, 'YER', { locale })}</span>
          </p>
        ) : null}

        {/* Directly above the button, in the block style the rest of the app uses for failures. */}
        {failure ? (
          <div ref={alertRef} className="ui-alert ui-alert--error" role="alert">
            <p>
              {failure.code === 'PRICE_CHANGED'
                ? t('errors.PRICE_CHANGED')
                : failure.fields
                  ? t('errors.VALIDATION_FAILED')
                  : t(errorKey(failure.code as never))}
            </p>
            {failure.code === 'ALREADY_BOOKED' ? (
              <Link
                className="ui-btn ui-btn--ghost ui-btn--sm"
                href={`/${locale}/account/bookings`}
              >
                {t('bookings.myTitle')}
              </Link>
            ) : null}
          </div>
        ) : null}

        <Button loading={busy} onClick={() => void submit()} fullWidth>
          {busy ? t('common.loading') : t('bookings.reserve')}
        </Button>

        <p className="booking-summary__note">{t('bookings.cashHint')}</p>
      </aside>
    </div>
  );
}
