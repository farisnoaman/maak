'use client';

import { useEffect, useRef, useState } from 'react';
import {
  DRIVE_TYPE_KEY,
  FUEL_TYPE_KEY,
  TRANSMISSION_KEY,
  VEHICLE_BODY_TYPE_KEY,
  VEHICLE_WIZARD_STEPS,
  errorKey,
  fleetCommandSpec,
  quotaMetricKey,
  quotaOf,
  translate,
  vehicleFieldErrors,
  vehicleInputSchema,
  type Locale,
  type TranslationKey,
  type VehicleInput,
  type VehicleWizardStep,
} from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { getApiClient, uploadVehicleDocument, uploadVehiclePhoto } from '@/lib/api';
import { navigateWithSession } from '@/lib/session-token';

/**
 * The seven-step vehicle wizard.
 *
 * Two properties matter more than the fields themselves:
 *
 *  1. **It resumes.** The draft is written to `localStorage` on every step change, so a preview tab that
 *     reloads (or a phone that locks) does not cost nineteen filled fields. Nothing here reloads the page
 *     on its own — that rule exists because a self-reloading guard once wiped a half-filled form.
 *  2. **It cannot submit something the command would reject.** The same `vehicleInputSchema` and
 *     `vehicleFieldErrors()` run before the request, so "insurance has already expired" is a message next
 *     to the date field instead of a 422 after the whole wizard.
 */

export interface WizardVehicle {
  readonly id: string;
  readonly make: string;
  readonly model: string;
  readonly modelYear: number;
  readonly trim: string | null;
  readonly plateNumber: string;
  readonly vin: string | null;
  readonly chassisNo: string | null;
  readonly color: string | null;
  readonly bodyType: string;
  readonly driveType: string | null;
  readonly transmission: string | null;
  readonly fuelType: string;
  readonly engineCc: number | null;
  readonly cylinders: number | null;
  readonly fuelTankL: number | null;
  readonly tyreSize: string | null;
  readonly tyreCount: number | null;
  readonly spareTyre: boolean;
  readonly vehicleCondition: string;
  readonly ownershipKind: string;
  readonly seatsPassenger: number;
  readonly seatsTotal: number;
  readonly luggageCapacityL: number | null;
  readonly roofRack: boolean;
  readonly airConditioning: boolean;
  readonly heating: boolean;
  readonly recliningSeats: boolean;
  readonly usbCharging: boolean;
  readonly wifi: boolean;
  readonly entertainment: boolean;
  readonly curtains: boolean;
  readonly readingLights: boolean;
  readonly airbags: number;
  readonly abs: boolean;
  readonly esp: boolean;
  readonly seatbeltsAll: boolean;
  readonly fireExtinguisher: boolean;
  readonly firstAid: boolean;
  readonly emergencyExit: boolean;
  readonly gpsDevice: boolean;
  readonly speedLimiter: boolean;
  readonly childSeat: boolean;
  readonly wheelchairAccessible: boolean;
  readonly stepAssist: boolean;
  readonly insuranceCompany: string | null;
  readonly insurancePolicyNo: string | null;
  readonly insuranceExpiry: string | null;
  readonly inspectionExpiry: string | null;
  readonly registrationExpiry: string | null;
  readonly transportPermitExpiry: string | null;
  readonly exteriorCondition: string;
  readonly interiorCondition: string;
  readonly odometerKm: number;
  readonly notes: string | null;
}

type Draft = Record<string, string | boolean>;

const DRAFT_KEY = 'maak.fleet.vehicleDraft.v1';

const BOOLEAN_FIELDS = [
  'spareTyre',
  'roofRack',
  'airConditioning',
  'heating',
  'recliningSeats',
  'usbCharging',
  'wifi',
  'entertainment',
  'curtains',
  'readingLights',
  'abs',
  'esp',
  'seatbeltsAll',
  'fireExtinguisher',
  'firstAid',
  'emergencyExit',
  'gpsDevice',
  'speedLimiter',
  'childSeat',
  'wheelchairAccessible',
  'stepAssist',
] as const;

const NUMBER_FIELDS = [
  'modelYear',
  'engineCc',
  'cylinders',
  'fuelTankL',
  'tyreCount',
  'seatsPassenger',
  'seatsTotal',
  'luggageCapacityL',
  'airbags',
  'odometerKm',
] as const;

const TEXT_FIELDS = [
  'make',
  'model',
  'trim',
  'plateNumber',
  'vin',
  'chassisNo',
  'color',
  'engineCc',
  'tyreSize',
  'insuranceCompany',
  'insurancePolicyNo',
  'insuranceExpiry',
  'inspectionExpiry',
  'registrationExpiry',
  'transportPermitExpiry',
  'notes',
] as const;

/** Which step owns which field — this is what lets "Next" refuse only the errors of the current step. */
const STEP_FIELDS: Record<VehicleWizardStep, readonly string[]> = {
  identity: ['make', 'model', 'modelYear', 'trim', 'plateNumber', 'vin', 'chassisNo', 'color'],
  mechanical: [
    'bodyType',
    'driveType',
    'transmission',
    'fuelType',
    'engineCc',
    'cylinders',
    'fuelTankL',
    'tyreSize',
    'tyreCount',
    'spareTyre',
    'vehicleCondition',
    'ownershipKind',
  ],
  capacity: ['seatsPassenger', 'seatsTotal', 'luggageCapacityL', 'roofRack'],
  comfort: [
    'airConditioning',
    'heating',
    'recliningSeats',
    'usbCharging',
    'wifi',
    'entertainment',
    'curtains',
    'readingLights',
    'childSeat',
    'wheelchairAccessible',
    'stepAssist',
  ],
  safety: [
    'airbags',
    'abs',
    'esp',
    'seatbeltsAll',
    'fireExtinguisher',
    'firstAid',
    'emergencyExit',
    'gpsDevice',
    'speedLimiter',
    'exteriorCondition',
    'interiorCondition',
  ],
  documents: [
    'insuranceCompany',
    'insurancePolicyNo',
    'insuranceExpiry',
    'inspectionExpiry',
    'registrationExpiry',
    'transportPermitExpiry',
  ],
  review: ['odometerKm', 'notes'],
};

const STEP_TITLE: Record<VehicleWizardStep, TranslationKey> = {
  identity: 'fleet.identity',
  mechanical: 'fleet.mechanical',
  capacity: 'fleet.capacity',
  comfort: 'fleet.comfort',
  safety: 'fleet.safety',
  documents: 'fleet.documents',
  review: 'fleet.review',
};

const BODY_TYPES = Object.keys(VEHICLE_BODY_TYPE_KEY);
const DRIVE_TYPES = Object.keys(DRIVE_TYPE_KEY);
const TRANSMISSIONS = Object.keys(TRANSMISSION_KEY);
const FUEL_TYPES = Object.keys(FUEL_TYPE_KEY);
const CONDITIONS = ['new', 'used', 'refurbished'];
const OWNERSHIP = ['owned', 'leased', 'financed'];
const RATINGS = ['excellent', 'good', 'fair', 'poor'];

const CONDITION_KEY: Record<string, TranslationKey> = {
  new: 'fleet.conditionNew',
  used: 'fleet.conditionUsed',
  refurbished: 'fleet.conditionRefurbished',
};

const OWNERSHIP_KEY: Record<string, TranslationKey> = {
  owned: 'fleet.owned',
  leased: 'fleet.leased',
  financed: 'fleet.financed',
};

const RATING_KEY: Record<string, TranslationKey> = {
  excellent: 'fleet.ratingExcellent',
  good: 'fleet.ratingGood',
  fair: 'fleet.ratingFair',
  poor: 'fleet.ratingPoor',
};

function emptyDraft(): Draft {
  return {
    make: '',
    model: '',
    modelYear: String(new Date().getFullYear()),
    trim: '',
    plateNumber: '',
    vin: '',
    chassisNo: '',
    color: '',
    bodyType: 'van',
    driveType: 'rear_wheel_drive',
    transmission: 'manual',
    fuelType: 'diesel',
    engineCc: '',
    cylinders: '',
    fuelTankL: '',
    tyreSize: '',
    tyreCount: '4',
    spareTyre: true,
    vehicleCondition: 'used',
    ownershipKind: 'owned',
    seatsPassenger: '12',
    seatsTotal: '14',
    luggageCapacityL: '',
    roofRack: false,
    airConditioning: true,
    heating: false,
    recliningSeats: false,
    usbCharging: false,
    wifi: false,
    entertainment: false,
    curtains: false,
    readingLights: false,
    airbags: '0',
    abs: true,
    esp: false,
    seatbeltsAll: true,
    fireExtinguisher: false,
    firstAid: false,
    emergencyExit: false,
    gpsDevice: false,
    speedLimiter: false,
    childSeat: false,
    wheelchairAccessible: false,
    stepAssist: false,
    insuranceCompany: '',
    insurancePolicyNo: '',
    insuranceExpiry: '',
    inspectionExpiry: '',
    registrationExpiry: '',
    transportPermitExpiry: '',
    exteriorCondition: 'good',
    interiorCondition: 'good',
    odometerKm: '0',
    notes: '',
  };
}

function fromVehicle(vehicle: WizardVehicle): Draft {
  const draft = emptyDraft();
  for (const key of TEXT_FIELDS) {
    const value = (vehicle as unknown as Record<string, unknown>)[key];
    draft[key] = value === null || value === undefined ? '' : String(value);
  }
  for (const key of NUMBER_FIELDS) {
    const value = (vehicle as unknown as Record<string, unknown>)[key];
    draft[key] = value === null || value === undefined ? '' : String(value);
  }
  for (const key of BOOLEAN_FIELDS) {
    draft[key] = (vehicle as unknown as Record<string, unknown>)[key] === true;
  }
  for (const key of ['bodyType', 'driveType', 'transmission', 'fuelType']) {
    const value = (vehicle as unknown as Record<string, unknown>)[key];
    draft[key] = value === null || value === undefined ? '' : String(value);
  }
  for (const key of [
    'vehicleCondition',
    'ownershipKind',
    'exteriorCondition',
    'interiorCondition',
  ]) {
    draft[key] = String((vehicle as unknown as Record<string, unknown>)[key] ?? 'good');
  }
  return draft;
}

/** Draft → the exact payload the command validates. Empty optional numbers stay `null`, not `NaN`. */
export function draftToInput(draft: Draft): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const key of [...TEXT_FIELDS, ...NUMBER_FIELDS]) {
    const raw = draft[key];
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (key in { make: 1, model: 1, plateNumber: 1 }) {
      value[key] = text;
      continue;
    }
    if (text === '') {
      value[key] = NUMBER_FIELDS.includes(key as (typeof NUMBER_FIELDS)[number]) ? null : null;
      continue;
    }
    value[key] = NUMBER_FIELDS.includes(key as (typeof NUMBER_FIELDS)[number])
      ? Number(text)
      : text;
  }
  for (const key of BOOLEAN_FIELDS) value[key] = draft[key] === true;
  for (const key of ['bodyType', 'fuelType', 'vehicleCondition', 'ownershipKind']) {
    value[key] = draft[key];
  }
  for (const key of ['driveType', 'transmission']) {
    value[key] = draft[key] || null;
  }
  for (const key of ['exteriorCondition', 'interiorCondition']) value[key] = draft[key];
  return value;
}

/** Field name → message, from the shared schema plus the cross-field rules. */
export function draftErrors(draft: Draft): Record<string, string> {
  const parsed = vehicleInputSchema.safeParse(draftToInput(draft));
  const errors: Record<string, string> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '_');
      if (!errors[key]) errors[key] = issue.message;
    }
    return errors;
  }
  const cross = vehicleFieldErrors(parsed.data as VehicleInput);
  for (const [key, message] of Object.entries(cross)) errors[key] = message;
  return errors;
}

export function VehicleWizard({
  locale,
  configured,
  verified,
  orgId,
  orgName,
  initial,
  canSubmitForReview,
  onSaved,
}: {
  readonly locale: Locale;
  readonly configured: boolean;
  readonly verified: boolean;
  readonly orgId: string | null;
  readonly orgName: string | null;
  readonly initial?: WizardVehicle | null;
  readonly canSubmitForReview?: boolean;
  readonly onSaved?: (vehicleId: string) => void;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [draft, setDraft] = useState<Draft>(() => (initial ? fromVehicle(initial) : emptyDraft()));
  const [step, setStep] = useState(0);
  const [resumed, setResumed] = useState(false);
  const [photos, setPhotos] = useState<File[]>([]);
  const [documents, setDocuments] = useState<{ insurance?: File; registration?: File }>({});
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // A duplicate plate does not block the save (a genuinely re-registered vehicle exists), so the
  // wizard stays on the page long enough to say it out loud instead of navigating past the warning.
  const [duplicate, setDuplicate] = useState<{ href: string; text: string } | null>(null);
  const hydrated = useRef(false);

  const editing = Boolean(initial);

  // Restore a draft once, on mount. Only for a new vehicle: an edit form must show the row it edits.
  useEffect(() => {
    if (editing || hydrated.current) return;
    hydrated.current = true;
    try {
      const stored = window.localStorage.getItem(DRAFT_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as { draft?: Draft; step?: number };
      if (!parsed.draft) return;
      setDraft((current) => ({ ...current, ...parsed.draft }));
      setStep(Math.min(Math.max(parsed.step ?? 0, 0), VEHICLE_WIZARD_STEPS.length - 1));
      setResumed(true);
    } catch {
      // A corrupted draft is not worth a crash: start clean and let it be overwritten.
    }
  }, [editing]);

  function persist(next: Draft, nextStep: number) {
    if (editing) return;
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ draft: next, step: nextStep }));
    } catch {
      // Private browsing can refuse storage. The wizard still works; it just stops resuming.
    }
  }

  function update(key: string, value: string | boolean) {
    setDraft((current) => {
      const next = { ...current, [key]: value };
      persist(next, step);
      return next;
    });
    setMessage(null);
  }

  const errors = draftErrors(draft);
  const stepErrors = STEP_FIELDS[VEHICLE_WIZARD_STEPS[step]!] ?? [];
  const currentStepError = touched
    ? stepErrors.find((field) => errors[field] !== undefined)
    : undefined;

  function goTo(index: number) {
    setTouched(false);
    setError(null);
    setStep(index);
    persist(draft, index);
  }

  function next() {
    setTouched(true);
    if (currentStepError) return;
    goTo(Math.min(step + 1, VEHICLE_WIZARD_STEPS.length - 1));
  }

  /**
   * One call site for the fleet command.
   *
   * `ApiClient` types the input as the *parsed* action; the wizard passes a draft-shaped object that the
   * schema validates on the way out. The cast keeps that single runtime check rather than a second,
   * hand-written type that would drift from `fleetActionSchema`.
   */
  function callFleet(client: ReturnType<typeof getApiClient>, action: Record<string, unknown>) {
    if (!client) return null;
    return client.call(fleetCommandSpec, action as never);
  }

  async function save(submitForReview: boolean) {
    setTouched(true);
    setError(null);
    setMessage(null);

    const all = draftErrors(draft);
    const firstBadStep = VEHICLE_WIZARD_STEPS.findIndex((name) =>
      (STEP_FIELDS[name] ?? []).some((field) => all[field] !== undefined),
    );
    if (firstBadStep >= 0) {
      setStep(firstBadStep);
      setError(t('fleet.requiredFields'));
      return;
    }

    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }

    setBusy(true);
    const input = draftToInput(draft);

    try {
      let vehicleId = initial?.id ?? '';
      let reverificationRequired = false;
      let duplicateNotice: { href: string; text: string } | null = null;

      if (editing) {
        const result = await callFleet(client, {
          action: 'vehicle.update',
          vehicleId,
          vehicle: input,
        });
        if (!result) return;
        if (!result.ok) {
          reportFailure(result.error);
          return;
        }
        reverificationRequired = Boolean(
          (result.data as { reverificationRequired?: boolean }).reverificationRequired,
        );
      } else {
        const result = await callFleet(client, {
          action: 'vehicle.create',
          orgId,
          vehicle: input,
        });
        if (!result) return;
        if (!result.ok) {
          reportFailure(result.error);
          return;
        }
        const created = result.data as {
          vehicle?: { id?: string };
          warnings?: { code: string; make?: string; model?: string }[];
        };
        vehicleId = String(created.vehicle?.id ?? '');
        if (!vehicleId) {
          setError(t('errors.INTERNAL'));
          return;
        }
        const plateDuplicate = created.warnings?.find(
          (warning) => warning.code === 'PLATE_DUPLICATE',
        );
        if (plateDuplicate) {
          duplicateNotice = {
            href: `/${locale}/operator/vehicles/${vehicleId}`,
            text: t('fleet.plateDuplicate', {
              make: plateDuplicate.make ?? '',
              model: plateDuplicate.model ?? '',
            }),
          };
        }
      }

      // Photos: uploaded after the row exists, because the storage policy authorises `<vehicleId>/…`.
      if (photos.length > 0 && vehicleId) {
        const paths: { path: string; isPrimary: boolean }[] = [];
        for (const [index, photo] of photos.entries()) {
          const uploaded = await uploadVehiclePhoto(photo, vehicleId);
          if (!uploaded.ok) {
            setError(uploaded.error);
            return;
          }
          paths.push({ path: uploaded.path, isPrimary: index === 0 });
        }
        const photoResult = await callFleet(client, {
          action: 'vehicle.setPhotos',
          vehicleId,
          photos: paths,
        });
        if (!photoResult) return;
        if (!photoResult.ok) {
          reportFailure(photoResult.error);
          return;
        }
      }

      if (submitForReview && vehicleId) {
        const docs: { kind: string; path: string }[] = [];
        for (const [kind, file] of Object.entries(documents)) {
          if (!file) continue;
          const uploaded = await uploadVehicleDocument(file, vehicleId);
          if (!uploaded.ok) {
            setError(uploaded.error);
            return;
          }
          docs.push({ kind, path: uploaded.path });
        }
        if (docs.length < 2) {
          setError(t('fleet.documentHint'));
          return;
        }
        const submitted = await callFleet(client, {
          action: 'vehicle.submitVerification',
          vehicleId,
          documents: docs,
        });
        if (!submitted) return;
        if (!submitted.ok) {
          reportFailure(submitted.error);
          return;
        }
      }

      if (!editing) {
        try {
          window.localStorage.removeItem(DRAFT_KEY);
        } catch {
          // Nothing to clean up if storage is unavailable.
        }
      }

      setMessage(
        submitForReview
          ? t('fleet.submittedForReview')
          : editing
            ? t('fleet.vehicleUpdated')
            : t('fleet.vehicleAdded'),
      );
      if (reverificationRequired)
        setMessage(`${t('fleet.vehicleUpdated')} ${t('fleet.reverificationRequired')}`);

      if (onSaved) onSaved(vehicleId);
      else if (duplicateNotice) setDuplicate(duplicateNotice);
      else navigateWithSession(`/${locale}/operator/vehicles/${vehicleId}`);
    } finally {
      setBusy(false);
    }
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

  const text = (
    key: string,
    label: TranslationKey,
    extra: { type?: string; hint?: string; required?: boolean } = {},
  ) => (
    <Field
      label={t(label)}
      type={extra.type ?? 'text'}
      hint={extra.hint}
      required={extra.required}
      value={String(draft[key] ?? '')}
      error={errors[key]}
      onChange={(event) => update(key, event.target.value)}
    />
  );

  const toggle = (key: string, label: TranslationKey) => (
    <label className="fleet-toggle" key={key}>
      <input
        type="checkbox"
        checked={draft[key] === true}
        onChange={(event) => update(key, event.target.checked)}
      />
      <span>{t(label)}</span>
    </label>
  );

  const choice = (
    key: string,
    label: TranslationKey,
    values: readonly string[],
    keys: Record<string, TranslationKey>,
  ) => (
    <Select
      label={t(label)}
      value={String(draft[key] ?? '')}
      error={errors[key]}
      options={[
        ...(key === 'driveType' || key === 'transmission'
          ? [{ value: '', label: t('fleet.selectPlaceholder') }]
          : []),
        ...values.map((value) => ({ value, label: t(keys[value] ?? 'fleet.unknown') })),
      ]}
      onChange={(event) => update(key, event.target.value)}
    />
  );

  if (!verified) {
    return (
      <div className="fleet-locked" role="note">
        <p>{t('fleet.requiresVerification')}</p>
        <a className="btn btn--primary" href={`/${locale}/account/verification`}>
          {t('verification.title')}
        </a>
      </div>
    );
  }

  const stepName = VEHICLE_WIZARD_STEPS[step]!;

  return (
    <div className="fleet-wizard">
      <ol className="fleet-steps" aria-label={t('fleet.spec')}>
        {VEHICLE_WIZARD_STEPS.map((name, index) => (
          <li key={name} aria-current={index === step ? 'step' : undefined}>
            <button
              type="button"
              className="fleet-step"
              onClick={() => goTo(index)}
              aria-label={`${index + 1}. ${t(STEP_TITLE[name])}`}
            >
              <span aria-hidden="true">{index + 1}</span>
              <span className="fleet-step__label">{t(STEP_TITLE[name])}</span>
            </button>
          </li>
        ))}
      </ol>

      <p className="fleet-progress">
        {t('fleet.stepOf', { step: step + 1, total: VEHICLE_WIZARD_STEPS.length })} ·{' '}
        {t(STEP_TITLE[stepName])}
      </p>

      {resumed ? <p className="fleet-note">{t('fleet.draftRestored')}</p> : null}
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
      {duplicate ? (
        <p className="fleet-warning" role="status">
          {duplicate.text}{' '}
          <a className="btn btn--ghost" href={duplicate.href}>
            {t('fleet.plateDuplicateContinue')}
          </a>
        </p>
      ) : null}

      <fieldset className="fleet-fields">
        <legend className="fleet-legend">{t(STEP_TITLE[stepName])}</legend>

        {stepName === 'identity' ? (
          <>
            {text('make', 'fleet.make', { required: true })}
            {text('model', 'fleet.model', { required: true })}
            {text('modelYear', 'fleet.modelYear', { type: 'number', required: true })}
            {text('trim', 'fleet.trim')}
            {text('plateNumber', 'fleet.plateNumber', {
              required: true,
              hint: t('fleet.plateHint'),
            })}
            {text('vin', 'fleet.vin', { hint: t('fleet.vinHint') })}
            {text('chassisNo', 'fleet.chassisNo')}
            {text('color', 'fleet.color')}
          </>
        ) : null}

        {stepName === 'mechanical' ? (
          <>
            {choice('bodyType', 'fleet.bodyType', BODY_TYPES, VEHICLE_BODY_TYPE_KEY)}
            {choice('driveType', 'fleet.driveType', DRIVE_TYPES, DRIVE_TYPE_KEY)}
            {choice('transmission', 'fleet.transmission', TRANSMISSIONS, TRANSMISSION_KEY)}
            {choice('fuelType', 'fleet.fuelType', FUEL_TYPES, FUEL_TYPE_KEY)}
            {text('engineCc', 'fleet.engineCc', { type: 'number' })}
            {text('cylinders', 'fleet.cylinders', { type: 'number' })}
            {text('fuelTankL', 'fleet.fuelTankL', { type: 'number' })}
            {text('tyreSize', 'fleet.tyreSize')}
            {text('tyreCount', 'fleet.tyreCount', { type: 'number' })}
            {choice('vehicleCondition', 'fleet.vehicleCondition', CONDITIONS, CONDITION_KEY)}
            {choice('ownershipKind', 'fleet.ownershipKind', OWNERSHIP, OWNERSHIP_KEY)}
            {toggle('spareTyre', 'fleet.spareTyre')}
          </>
        ) : null}

        {stepName === 'capacity' ? (
          <>
            {text('seatsPassenger', 'fleet.seatsPassenger', { type: 'number', required: true })}
            {text('seatsTotal', 'fleet.seatsTotal', { type: 'number', required: true })}
            {text('luggageCapacityL', 'fleet.luggageCapacityL', { type: 'number' })}
            {toggle('roofRack', 'fleet.roofRack')}
          </>
        ) : null}

        {stepName === 'comfort' ? (
          <>
            {toggle('airConditioning', 'fleet.airConditioning')}
            {toggle('heating', 'fleet.heating')}
            {toggle('recliningSeats', 'fleet.recliningSeats')}
            {toggle('usbCharging', 'fleet.usbCharging')}
            {toggle('wifi', 'fleet.wifi')}
            {toggle('entertainment', 'fleet.entertainment')}
            {toggle('curtains', 'fleet.curtains')}
            {toggle('readingLights', 'fleet.readingLights')}
            <p className="fleet-subhead">{t('fleet.accessibility')}</p>
            {toggle('childSeat', 'fleet.childSeat')}
            {toggle('wheelchairAccessible', 'fleet.wheelchairAccessible')}
            {toggle('stepAssist', 'fleet.stepAssist')}
          </>
        ) : null}

        {stepName === 'safety' ? (
          <>
            {text('airbags', 'fleet.airbags', { type: 'number' })}
            {toggle('abs', 'fleet.abs')}
            {toggle('esp', 'fleet.esp')}
            {toggle('seatbeltsAll', 'fleet.seatbeltsAll')}
            {toggle('fireExtinguisher', 'fleet.fireExtinguisher')}
            {toggle('firstAid', 'fleet.firstAid')}
            {toggle('emergencyExit', 'fleet.emergencyExit')}
            {toggle('gpsDevice', 'fleet.gpsDevice')}
            {toggle('speedLimiter', 'fleet.speedLimiter')}
            <p className="fleet-subhead">{t('fleet.appearance')}</p>
            {choice('exteriorCondition', 'fleet.exteriorCondition', RATINGS, RATING_KEY)}
            {choice('interiorCondition', 'fleet.interiorCondition', RATINGS, RATING_KEY)}
          </>
        ) : null}

        {stepName === 'documents' ? (
          <>
            {text('insuranceCompany', 'fleet.insuranceCompany')}
            {text('insurancePolicyNo', 'fleet.insurancePolicyNo')}
            {text('insuranceExpiry', 'fleet.insuranceExpiry', { type: 'date', required: true })}
            {text('inspectionExpiry', 'fleet.inspectionExpiry', { type: 'date', required: true })}
            {text('registrationExpiry', 'fleet.registrationExpiry', { type: 'date' })}
            {text('transportPermitExpiry', 'fleet.transportPermitExpiry', { type: 'date' })}
            <p className="fleet-hint">{t('fleet.documentHint')}</p>
            <label className="ui-field">
              <span className="ui-field__label">{t('fleet.documentInsurance')}</span>
              <input
                className="ui-input"
                type="file"
                accept="image/*,application/pdf"
                onChange={(event) =>
                  setDocuments((current) => ({ ...current, insurance: event.target.files?.[0] }))
                }
              />
            </label>
            <label className="ui-field">
              <span className="ui-field__label">{t('fleet.documentRegistration')}</span>
              <input
                className="ui-input"
                type="file"
                accept="image/*,application/pdf"
                onChange={(event) =>
                  setDocuments((current) => ({ ...current, registration: event.target.files?.[0] }))
                }
              />
            </label>
            {documents.insurance ? (
              <p className="fleet-hint">✓ {documents.insurance.name}</p>
            ) : null}
            {documents.registration ? (
              <p className="fleet-hint">✓ {documents.registration.name}</p>
            ) : null}
          </>
        ) : null}

        {stepName === 'review' ? (
          <>
            {text('odometerKm', 'fleet.odometerKm', { type: 'number' })}
            {text('notes', 'fleet.notes')}
            <label className="ui-field">
              <span className="ui-field__label">{t('fleet.photos')}</span>
              <input
                className="ui-input"
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => setPhotos(Array.from(event.target.files ?? []).slice(0, 12))}
              />
              <span className="ui-field__hint">{t('fleet.photoHint')}</span>
            </label>
            {photos.length > 0 ? (
              <ul className="fleet-filelist">
                {photos.map((photo) => (
                  <li key={`${photo.name}-${photo.size}`}>{photo.name}</li>
                ))}
              </ul>
            ) : null}
            <dl className="fleet-summary">
              <dt>{t('fleet.make')}</dt>
              <dd>
                {String(draft.make)} {String(draft.model)} · {String(draft.modelYear)}
              </dd>
              <dt>{t('fleet.plateNumber')}</dt>
              <dd>{String(draft.plateNumber)}</dd>
              <dt>{t('fleet.seatsPassenger')}</dt>
              <dd>
                {String(draft.seatsPassenger)} / {String(draft.seatsTotal)}
              </dd>
              <dt>{t('fleet.insuranceExpiry')}</dt>
              <dd>{String(draft.insuranceExpiry) || t('fleet.unknown')}</dd>
              <dt>{t('fleet.owner')}</dt>
              <dd>{orgName ?? t('fleet.personalOwner')}</dd>
            </dl>
            {Object.keys(errors).length > 0 ? (
              <p className="fleet-hint">{t('fleet.requiredFields')}</p>
            ) : null}
          </>
        ) : null}

        {currentStepError ? (
          <p className="fleet-error" role="alert">
            {errors[currentStepError]}
          </p>
        ) : null}
      </fieldset>

      <div className="fleet-actions">
        <Button variant="ghost" onClick={() => goTo(Math.max(step - 1, 0))} disabled={step === 0}>
          {t('fleet.back')}
        </Button>
        {step < VEHICLE_WIZARD_STEPS.length - 1 ? (
          <Button onClick={next}>{t('fleet.next')}</Button>
        ) : (
          <>
            <Button
              variant="subtle"
              onClick={() => void save(false)}
              loading={busy}
              disabled={busy}
            >
              {editing ? t('fleet.save') : t('fleet.saveDraft')}
            </Button>
            {canSubmitForReview !== false ? (
              <Button onClick={() => void save(true)} loading={busy} disabled={busy}>
                {t('fleet.submitForReview')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
