'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  adenLocalToIso,
  errorKey,
  isoToAdenLocal,
  quotaMetricKey,
  quotaOf,
  translate,
  tripFieldErrors,
  tripInputSchema,
  tripsCommandSpec,
  type Locale,
  type TranslationKey,
  type TripInput,
} from '@maak/core';
import { getApiClient } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import type { TripOptions, TripRow, TripStopRow } from '@/lib/trips';

type BookingMode = 'per_seat' | 'whole_trip' | 'both';
type PricingMode = 'flat' | 'per_stop';
type DiscountKind = 'none' | 'fixed' | 'percent';
type DiscountScope = 'all' | 'per_seat' | 'whole_trip';

interface StopDraft {
  readonly key: string;
  name: string;
  offset: string;
  price: string;
}

interface FormState {
  originGovernorateId: string;
  destinationGovernorateId: string;
  departureAt: string;
  arriveEstimateMinutes: string;
  seatsTotal: string;
  bookingMode: BookingMode;
  pricingMode: PricingMode;
  pricePerSeatYer: string;
  wholeTripPriceYer: string;
  discountKind: DiscountKind;
  /** Percent is typed as a percentage (10) and sent as basis points (1000). */
  discountValue: string;
  discountScope: DiscountScope;
  genderPolicy: 'any' | 'women_only' | 'men_only';
  paymentPolicy: 'cash' | 'transfer' | 'deposit';
  luggageAllowanceKg: string;
  notes: string;
  vehicleId: string;
  driverId: string;
}

const STEPS = ['route', 'stops', 'price', 'vehicle', 'review'] as const;
type Step = (typeof STEPS)[number];

const STEP_LABEL: Record<Step, TranslationKey> = {
  route: 'trips.route',
  stops: 'trips.stops',
  price: 'trips.pricePerSeat',
  vehicle: 'trips.vehicle',
  review: 'trips.publish',
};

const STEP_FIELDS: Record<Step, readonly (keyof FormState | 'stops')[]> = {
  route: ['originGovernorateId', 'destinationGovernorateId', 'departureAt'],
  stops: ['stops'],
  price: ['seatsTotal', 'pricePerSeatYer', 'wholeTripPriceYer', 'discountValue'],
  vehicle: ['vehicleId', 'driverId'],
  review: [],
};

const numberOrNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

function emptyForm(): FormState {
  // Two days out, in Aden wall-clock time: a trip created for "tonight" is already un-editable.
  const departure = new Date(Date.now() + 2 * 86_400_000).toISOString();
  return {
    originGovernorateId: '',
    destinationGovernorateId: '',
    departureAt: isoToAdenLocal(departure),
    arriveEstimateMinutes: '',
    seatsTotal: '12',
    bookingMode: 'per_seat',
    pricingMode: 'flat',
    pricePerSeatYer: '',
    wholeTripPriceYer: '',
    discountKind: 'none',
    discountValue: '',
    discountScope: 'all',
    genderPolicy: 'any',
    paymentPolicy: 'cash',
    luggageAllowanceKg: '',
    notes: '',
    vehicleId: '',
    driverId: '',
  };
}

function formFromTrip(trip: TripRow): FormState {
  return {
    originGovernorateId: trip.origin.id,
    destinationGovernorateId: trip.destination.id,
    departureAt: isoToAdenLocal(trip.departureAt),
    arriveEstimateMinutes: trip.arriveEstimateMinutes > 0 ? String(trip.arriveEstimateMinutes) : '',
    seatsTotal: String(trip.seatsTotal),
    bookingMode: trip.bookingMode as BookingMode,
    pricingMode: trip.pricingMode as PricingMode,
    pricePerSeatYer: trip.pricePerSeatYer == null ? '' : String(trip.pricePerSeatYer),
    wholeTripPriceYer: trip.wholeTripPriceYer == null ? '' : String(trip.wholeTripPriceYer),
    discountKind: trip.discountKind as DiscountKind,
    discountValue:
      trip.discountKind === 'none'
        ? ''
        : String(trip.discountKind === 'percent' ? trip.discountValue / 100 : trip.discountValue),
    discountScope: trip.discountScope as DiscountScope,
    genderPolicy: trip.genderPolicy as FormState['genderPolicy'],
    paymentPolicy: trip.paymentPolicy as FormState['paymentPolicy'],
    luggageAllowanceKg: trip.luggageAllowanceKg == null ? '' : String(trip.luggageAllowanceKg),
    notes: trip.notes ?? '',
    vehicleId: trip.vehicleId,
    driverId: trip.driverId ?? '',
  };
}

/**
 * The trip wizard: five short steps, one column, thumb-sized controls.
 *
 * Three rules, in order of importance:
 *
 *  1. **The server decides.** The two-hour lock, the quota and the verification state are database
 *     rules; this form only *explains* them (`EDIT_WINDOW_CLOSED` is a sentence, not a stack trace).
 *  2. **Nothing is invented.** `tripInputSchema` and `tripFieldErrors()` are the same functions the edge
 *     function validates with, so "you cannot leave from where you are going" is a message under the
 *     field rather than a 422 after five screens.
 *  3. **Saving and publishing are separate acts.** A draft that is saved stays saved even if the
 *     publication is refused by a quota — which is exactly when an operator needs it kept.
 */
export function TripWizard({
  locale,
  orgId,
  options,
  initial,
  onSaved,
}: {
  readonly locale: Locale;
  readonly orgId: string | null;
  readonly options: TripOptions;
  readonly initial?: { trip: TripRow; stops: readonly TripStopRow[] } | null;
  readonly onSaved?: (tripId: string) => void;
}) {
  const router = useRouter();
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const editing = Boolean(initial);

  const [form, setForm] = useState<FormState>(initial ? formFromTrip(initial.trip) : emptyForm);
  const [stops, setStops] = useState<StopDraft[]>(() =>
    (initial?.stops ?? []).map((stop, index) => ({
      key: `stop-${index}-${stop.id}`,
      name:
        locale === 'ar' ? (stop.nameAr ?? stop.nameEn ?? '') : (stop.nameEn ?? stop.nameAr ?? ''),
      offset: String(stop.arriveOffsetMinutes),
      price: stop.priceFromOriginYer == null ? '' : String(stop.priceFromOriginYer),
    })),
  );
  const [step, setStep] = useState<Step>('route');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  /** The exact object that goes over the wire — built once, so the preview and the request agree. */
  const payload = useMemo<Record<string, unknown>>(() => {
    const percent = form.discountKind === 'percent';
    const discountValue = percent
      ? Math.round((numberOrNull(form.discountValue) ?? 0) * 100)
      : (numberOrNull(form.discountValue) ?? 0);
    const departureAt = adenLocalToIso(form.departureAt);

    return {
      vehicleId: form.vehicleId,
      driverId: form.driverId === '' ? null : form.driverId,
      originGovernorateId: form.originGovernorateId,
      destinationGovernorateId: form.destinationGovernorateId,
      // An unparseable local time stays raw: the schema then reports the field instead of the form
      // silently shifting the departure by three hours.
      departureAt: departureAt ?? form.departureAt,
      arriveEstimateMinutes: numberOrNull(form.arriveEstimateMinutes) ?? 0,
      seatsTotal: numberOrNull(form.seatsTotal) ?? 0,
      bookingMode: form.bookingMode,
      pricingMode: form.pricingMode,
      pricePerSeatYer: numberOrNull(form.pricePerSeatYer),
      wholeTripPriceYer: numberOrNull(form.wholeTripPriceYer),
      discountKind: form.discountKind,
      discountValue,
      discountScope: form.discountScope,
      genderPolicy: form.genderPolicy,
      paymentPolicy: form.paymentPolicy,
      luggageAllowanceKg: numberOrNull(form.luggageAllowanceKg),
      notes: form.notes.trim() === '' ? null : form.notes.trim(),
      stops: stops
        .filter((stop) => stop.name.trim() !== '')
        .map((stop) => ({
          nameAr: stop.name.trim(),
          arriveOffsetMinutes: numberOrNull(stop.offset) ?? 0,
          priceFromOriginYer: numberOrNull(stop.price),
        })),
    };
  }, [form, stops]);

  const errors = useMemo(() => {
    const parsed = tripInputSchema.safeParse(payload);
    const collected: Record<string, string> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (collected[key] === undefined) collected[key] = t('fleet.requiredFields');
      }
    }
    const cross = tripFieldErrors((parsed.success ? parsed.data : payload) as TripInput, locale);
    return { ...collected, ...cross };
  }, [payload, locale]);

  const shownError = (field: string) => (touched ? errors[field] : undefined);

  function firstBadStep(): Step | null {
    for (const name of STEPS) {
      if (STEP_FIELDS[name].some((field) => errors[field] !== undefined)) return name;
    }
    return null;
  }

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

  async function save(intent: 'draft' | 'review' | 'publish') {
    setTouched(true);
    setError(null);
    setMessage(null);

    const badStep = firstBadStep();
    if (badStep) {
      setStep(badStep);
      setError(t('fleet.requiredFields'));
      return;
    }

    const parsed = tripInputSchema.safeParse(payload);
    if (!parsed.success) {
      setError(t('fleet.requiredFields'));
      return;
    }

    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }

    setBusy(true);
    try {
      let tripId = initial?.trip.id ?? '';

      if (editing) {
        const updated = await client.call(tripsCommandSpec, {
          action: 'trip.update',
          tripId,
          trip: parsed.data,
        } as never);
        if (!updated.ok) {
          reportFailure(updated.error);
          return;
        }
      } else {
        const created = await client.call(tripsCommandSpec, {
          action: 'trip.create',
          orgId,
          trip: parsed.data,
        } as never);
        if (!created.ok) {
          reportFailure(created.error);
          return;
        }
        tripId = String((created.data as { trip?: { id?: string } }).trip?.id ?? '');
        if (tripId === '') {
          setError(t('errors.INTERNAL'));
          return;
        }
      }

      // Stops are a separate command and are *replaced*, never patched: the whole ordered list is the
      // unit of truth, so re-sending it is also what makes the two-hour lock meaningful for stops.
      const stopsResult = await client.call(tripsCommandSpec, {
        action: 'trip.setStops',
        tripId,
        stops: parsed.data.stops ?? [],
      } as never);
      if (!stopsResult.ok) {
        reportFailure(stopsResult.error);
        router.push(`/${locale}/operator/trips/${tripId}`);
        return;
      }

      if (intent === 'publish') {
        const published = await client.call(tripsCommandSpec, {
          action: 'trip.publish',
          tripId,
        } as never);
        if (!published.ok) {
          reportFailure(published.error);
          router.push(`/${locale}/operator/trips/${tripId}`);
          return;
        }
        setMessage(t('trips.published'));
      } else if (intent === 'review') {
        const submitted = await client.call(tripsCommandSpec, {
          action: 'trip.submitVerification',
          tripId,
        } as never);
        if (!submitted.ok) {
          reportFailure(submitted.error);
          router.push(`/${locale}/operator/trips/${tripId}`);
          return;
        }
        setMessage(t('trips.reviewSubmitted'));
      } else {
        setMessage(t('trips.saved'));
      }

      if (onSaved) onSaved(tripId);
      else router.push(`/${locale}/operator/trips/${tripId}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const governorateOptions = [
    { value: '', label: t('fleet.selectPlaceholder') },
    ...options.governorates.map((governorate) => ({
      value: governorate.id,
      label: locale === 'ar' ? governorate.nameAr : (governorate.nameEn ?? governorate.nameAr),
    })),
  ];

  return (
    <form
      className="trip-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (step === 'review') {
          void save('draft');
          return;
        }
        setTouched(true);
        if (STEP_FIELDS[step].some((field) => errors[field] !== undefined)) return;
        setTouched(false);
        setStep(STEPS[Math.min(STEPS.indexOf(step) + 1, STEPS.length - 1)] ?? 'review');
      }}
    >
      <ol className="trip-steps" aria-label={t('trips.title')}>
        {STEPS.map((name, index) => (
          <li key={name} aria-current={name === step ? 'step' : undefined}>
            <button
              type="button"
              className="trip-step"
              onClick={() => {
                setStep(name);
                setTouched(false);
              }}
              aria-label={`${index + 1}. ${t(STEP_LABEL[name])}`}
            >
              <span aria-hidden="true">{index + 1}</span>
              <span className="trip-step__label">{t(STEP_LABEL[name])}</span>
            </button>
          </li>
        ))}
      </ol>

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

      {step === 'route' ? (
        <div className="trip-form__row trip-form__row--2">
          <Select
            label={t('trips.origin')}
            value={form.originGovernorateId}
            error={shownError('originGovernorateId')}
            options={governorateOptions}
            onChange={(event) => set('originGovernorateId', event.target.value)}
            required
          />
          <Select
            label={t('trips.destination')}
            value={form.destinationGovernorateId}
            error={shownError('destinationGovernorateId')}
            options={governorateOptions}
            onChange={(event) => set('destinationGovernorateId', event.target.value)}
            required
          />
          <Field
            label={t('trips.departureLocal')}
            type="datetime-local"
            value={form.departureAt}
            hint={t('trips.entryLocked')}
            error={shownError('departureAt')}
            onChange={(event) => set('departureAt', event.target.value)}
            required
          />
          <Field
            label={t('trips.arriveEstimate')}
            type="number"
            inputMode="numeric"
            min={0}
            max={4320}
            value={form.arriveEstimateMinutes}
            error={shownError('arriveEstimateMinutes')}
            onChange={(event) => set('arriveEstimateMinutes', event.target.value)}
          />
        </div>
      ) : null}

      {step === 'stops' ? (
        <section aria-labelledby="trip-stops-title">
          <h3 id="trip-stops-title">{t('trips.stops')}</h3>
          <p className="trip-form__hint">{t('trips.stopsHint')}</p>
          <div className="trip-stop-list">
            {stops.map((stop, index) => (
              <div className="trip-stop" key={stop.key}>
                <Field
                  label={`${index + 1}. ${t('trips.stopName')}`}
                  value={stop.name}
                  error={shownError('stops')}
                  onChange={(event) =>
                    setStops((current) =>
                      current.map((row) =>
                        row.key === stop.key ? { ...row, name: event.target.value } : row,
                      ),
                    )
                  }
                />
                <Field
                  label={t('trips.stopOffset')}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={4320}
                  value={stop.offset}
                  onChange={(event) =>
                    setStops((current) =>
                      current.map((row) =>
                        row.key === stop.key ? { ...row, offset: event.target.value } : row,
                      ),
                    )
                  }
                />
                <Field
                  label={t('trips.stopPrice')}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={stop.price}
                  onChange={(event) =>
                    setStops((current) =>
                      current.map((row) =>
                        row.key === stop.key ? { ...row, price: event.target.value } : row,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setStops((current) => current.filter((row) => row.key !== stop.key))
                  }
                >
                  {t('trips.removeStop')}
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="subtle"
            size="sm"
            // The database caps a replacement at ten stops; the button stopping at ten is the honest
            // version of that rule, rather than a refused submission.
            disabled={stops.length >= 10}
            onClick={() =>
              setStops((current) => [
                ...current,
                {
                  key: `stop-${Date.now()}-${current.length}`,
                  name: '',
                  offset: String((numberOrNull(current.at(-1)?.offset ?? '') ?? 0) + 60),
                  price: '',
                },
              ])
            }
          >
            {t('trips.addStop')}
          </Button>
        </section>
      ) : null}

      {step === 'price' ? (
        <div className="trip-form__row trip-form__row--2">
          <Field
            label={t('trips.seats')}
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            value={form.seatsTotal}
            error={shownError('seatsTotal')}
            onChange={(event) => set('seatsTotal', event.target.value)}
            required
          />
          <Select
            label={t('trips.bookingMode')}
            value={form.bookingMode}
            options={[
              { value: 'per_seat', label: t('trips.booking.per_seat') },
              { value: 'whole_trip', label: t('trips.booking.whole_trip') },
              { value: 'both', label: t('trips.booking.both') },
            ]}
            onChange={(event) => set('bookingMode', event.target.value as BookingMode)}
          />
          <Select
            label={t('trips.pricingMode')}
            value={form.pricingMode}
            options={[
              { value: 'flat', label: t('trips.pricing.flat') },
              { value: 'per_stop', label: t('trips.pricing.per_stop') },
            ]}
            onChange={(event) => set('pricingMode', event.target.value as PricingMode)}
          />
          <Field
            label={t('trips.pricePerSeat')}
            type="number"
            inputMode="numeric"
            min={0}
            value={form.pricePerSeatYer}
            hint={t('trips.currencyHint')}
            error={shownError('pricePerSeatYer')}
            onChange={(event) => set('pricePerSeatYer', event.target.value)}
          />
          {form.bookingMode !== 'per_seat' ? (
            <Field
              label={t('trips.wholePrice')}
              type="number"
              inputMode="numeric"
              min={0}
              value={form.wholeTripPriceYer}
              error={shownError('wholeTripPriceYer')}
              onChange={(event) => set('wholeTripPriceYer', event.target.value)}
            />
          ) : null}
          <Select
            label={t('trips.discount')}
            value={form.discountKind}
            options={[
              { value: 'none', label: t('trips.discountKind.none') },
              { value: 'fixed', label: t('trips.discountKind.fixed') },
              { value: 'percent', label: t('trips.discountKind.percent') },
            ]}
            onChange={(event) => set('discountKind', event.target.value as DiscountKind)}
          />
          {form.discountKind !== 'none' ? (
            <>
              <Field
                label={
                  form.discountKind === 'percent'
                    ? t('trips.discountPercent')
                    : t('trips.discountValue')
                }
                type="number"
                inputMode="numeric"
                min={0}
                max={form.discountKind === 'percent' ? 100 : undefined}
                value={form.discountValue}
                error={shownError('discountValue')}
                onChange={(event) => set('discountValue', event.target.value)}
              />
              <Select
                label={t('trips.discountScopeLabel')}
                value={form.discountScope}
                options={[
                  { value: 'all', label: t('trips.discountScope.all') },
                  { value: 'per_seat', label: t('trips.discountScope.per_seat') },
                  { value: 'whole_trip', label: t('trips.discountScope.whole_trip') },
                ]}
                onChange={(event) => set('discountScope', event.target.value as DiscountScope)}
              />
            </>
          ) : null}
        </div>
      ) : null}

      {step === 'vehicle' ? (
        <div className="trip-form__row trip-form__row--2">
          <Select
            label={t('trips.vehicle')}
            value={form.vehicleId}
            error={shownError('vehicleId')}
            hint={
              options.vehicles.length === 0 ? t('trips.noVerifiedVehicle') : t('trips.vehicleHint')
            }
            options={[
              { value: '', label: t('fleet.selectPlaceholder') },
              ...options.vehicles.map((vehicle) => ({
                value: vehicle.id,
                label: `${vehicle.label} · ${vehicle.plateNumber}`,
              })),
            ]}
            onChange={(event) => set('vehicleId', event.target.value)}
            required
          />
          <Select
            label={t('trips.driver')}
            value={form.driverId}
            error={shownError('driverId')}
            options={[
              { value: '', label: t('trips.noDriver') },
              ...options.drivers.map((driver) => ({ value: driver.id, label: driver.name })),
            ]}
            onChange={(event) => set('driverId', event.target.value)}
          />
          <Select
            label={t('trips.genderPolicy')}
            value={form.genderPolicy}
            options={[
              { value: 'any', label: t('trips.gender.any') },
              { value: 'women_only', label: t('trips.gender.women_only') },
              { value: 'men_only', label: t('trips.gender.men_only') },
            ]}
            onChange={(event) =>
              set('genderPolicy', event.target.value as FormState['genderPolicy'])
            }
          />
          <Select
            label={t('trips.paymentPolicy')}
            value={form.paymentPolicy}
            options={[
              { value: 'cash', label: t('trips.payment.cash') },
              { value: 'transfer', label: t('trips.payment.transfer') },
              { value: 'deposit', label: t('trips.payment.deposit') },
            ]}
            onChange={(event) =>
              set('paymentPolicy', event.target.value as FormState['paymentPolicy'])
            }
          />
          <Field
            label={t('trips.luggage')}
            type="number"
            inputMode="numeric"
            min={0}
            max={500}
            value={form.luggageAllowanceKg}
            onChange={(event) => set('luggageAllowanceKg', event.target.value)}
          />
          <div className="ui-field trip-form__wide">
            <label className="ui-field__label" htmlFor="trip-notes">
              {t('trips.notes')}
            </label>
            <textarea
              id="trip-notes"
              className="ui-input"
              rows={3}
              maxLength={2000}
              value={form.notes}
              onChange={(event) => set('notes', event.target.value)}
            />
          </div>
        </div>
      ) : null}

      {step === 'review' ? (
        <section aria-labelledby="trip-review-title">
          <h3 id="trip-review-title">{t('trips.publish')}</h3>
          <dl className="trip-summary">
            <div className="trip-summary__row">
              <dt>{t('trips.route')}</dt>
              <dd>
                {governorateOptions.find((option) => option.value === form.originGovernorateId)
                  ?.label ?? '—'}{' '}
                →{' '}
                {governorateOptions.find((option) => option.value === form.destinationGovernorateId)
                  ?.label ?? '—'}
              </dd>
            </div>
            <div className="trip-summary__row">
              <dt>{t('trips.departureLocal')}</dt>
              <dd>
                <bdi>{form.departureAt.replace('T', ' ')}</bdi>
              </dd>
            </div>
            <div className="trip-summary__row">
              <dt>{t('trips.seats')}</dt>
              <dd>{form.seatsTotal}</dd>
            </div>
            <div className="trip-summary__row">
              <dt>{t('trips.pricePerSeat')}</dt>
              <dd>{form.pricePerSeatYer === '' ? '—' : `${form.pricePerSeatYer} ر.ي`}</dd>
            </div>
            <div className="trip-summary__row">
              <dt>{t('trips.stops')}</dt>
              <dd>{stops.filter((stop) => stop.name.trim() !== '').length}</dd>
            </div>
          </dl>
          <p className="trip-form__hint">{t('trips.publishHint')}</p>
        </section>
      ) : null}

      <div className="trip-form__actions">
        <Button type="submit" loading={busy}>
          {step === 'review'
            ? editing
              ? t('common.save')
              : t('trips.saveDraft')
            : t('common.continue')}
        </Button>
        <Button
          variant="ghost"
          loading={busy}
          onClick={() => {
            void save('review');
          }}
        >
          {t('trips.submitReview')}
        </Button>
        <Button
          variant="ghost"
          loading={busy}
          onClick={() => {
            void save('publish');
          }}
        >
          {t('trips.publish')}
        </Button>
      </div>
    </form>
  );
}
