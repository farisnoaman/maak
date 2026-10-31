'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DRIVE_TYPE_KEY,
  FUEL_TYPE_KEY,
  TRANSMISSION_KEY,
  VEHICLE_BODY_TYPE_KEY,
  errorKey,
  fleetCommandSpec,
  quotaMetricKey,
  quotaOf,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { getApiClient, uploadVehicleDocument, uploadVehiclePhoto } from '@/lib/api';
import { VehicleBadges } from './VehicleBadges';
import { privateDocumentUrl, publicPhotoUrl } from './VehicleCard';
import { VehicleWizard, type WizardVehicle } from './VehicleWizard';

const CONDITION_KEY: Record<string, TranslationKey> = {
  new: 'fleet.conditionNew',
  used: 'fleet.conditionUsed',
  refurbished: 'fleet.conditionRefurbished',
  excellent: 'fleet.ratingExcellent',
  good: 'fleet.ratingGood',
  fair: 'fleet.ratingFair',
  poor: 'fleet.ratingPoor',
};

const OWNERSHIP_KEY: Record<string, TranslationKey> = {
  owned: 'fleet.owned',
  leased: 'fleet.leased',
  financed: 'fleet.financed',
};

const DOCUMENT_KEY: Record<string, TranslationKey> = {
  insurance: 'fleet.documentInsurance',
  registration: 'fleet.documentRegistration',
  inspection: 'fleet.documentInspection',
  permit: 'fleet.documentPermit',
  other: 'fleet.documentOther',
};

function yesNo(locale: Locale, value: boolean): string {
  return translate(locale, value ? 'fleet.yes' : 'fleet.no');
}

/**
 * One vehicle: the specification, the photos, the documents, the driver — and the actions an owner can
 * take on it. Editing reuses the wizard so the two screens cannot disagree about which fields exist.
 */
export function VehicleDetail({
  locale,
  configured,
  verified,
  orgId,
  orgName,
  vehicle,
  photos,
  documents,
  driver,
  drivers,
}: {
  readonly locale: Locale;
  readonly configured: boolean;
  readonly verified: boolean;
  readonly orgId: string | null;
  readonly orgName: string | null;
  readonly vehicle: WizardVehicle & {
    readonly status: string;
    readonly verificationStatus: string;
    readonly verificationNote: string | null;
    readonly bodyType: string;
    readonly fuelType: string;
    readonly driveType: string | null;
    readonly transmission: string | null;
    readonly vehicleCondition: string;
    readonly ownershipKind: string;
    readonly exteriorCondition: string;
    readonly interiorCondition: string;
  };
  readonly photos: readonly { id: string; storagePath: string; isPrimary: boolean }[];
  readonly documents: readonly { id: string; kind: string; storagePath: string }[];
  readonly driver: { id: string; name: string; verificationStatus: string } | null;
  readonly drivers: readonly { id: string; name: string; verificationStatus: string }[];
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [driverId, setDriverId] = useState(driver?.id ?? '');

  const canEdit = configured && vehicle.status !== 'retired';

  function fail(code: string, detail?: string) {
    const quota = quotaOf({ code: code as never, detail });
    if (quota) {
      setError(
        t('fleet.quotaReached', {
          metric: t(quotaMetricKey(quota.metric)),
          limit: quota.limit === null ? t('fleet.unlimited') : quota.limit,
        }),
      );
      return;
    }
    setError(t(errorKey(code as never)));
  }

  async function run(action: Record<string, unknown>, done: string) {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return null;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    // The action shape is validated by `fleetActionSchema` inside ApiClient.
    const result = await client.call(fleetCommandSpec, action as never);
    setBusy(false);
    if (!result.ok) {
      fail(result.error.code, result.error.detail);
      return null;
    }
    setMessage(t(done as TranslationKey));
    // A fresh server render reflects verification badges, driver changes and photo sets. `refresh()`
    // re-renders in place — it is not a reload, so nothing the user typed is thrown away.
    router.refresh();
    return result.data;
  }

  async function addPhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);
    const paths = photos.map((photo) => ({
      path: photo.storagePath,
      isPrimary: photo.isPrimary,
    }));
    for (const file of Array.from(files).slice(0, 12 - photos.length)) {
      const uploaded = await uploadVehiclePhoto(file, vehicle.id);
      if (!uploaded.ok) {
        setBusy(false);
        setError(uploaded.error);
        return;
      }
      paths.push({ path: uploaded.path, isPrimary: paths.length === 0 });
    }
    const result = await client.call(fleetCommandSpec, {
      action: 'vehicle.setPhotos',
      vehicleId: vehicle.id,
      photos: paths,
    } as never);
    setBusy(false);
    if (!result.ok) {
      fail(result.error.code, result.error.detail);
      return;
    }
    setMessage(t('fleet.photosSaved'));
    router.refresh();
  }

  async function submitForReview(files: { insurance: File | null; registration: File | null }) {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);
    const docs: { kind: string; path: string }[] = [];
    for (const [kind, file] of Object.entries(files)) {
      if (!file) continue;
      const uploaded = await uploadVehicleDocument(file, vehicle.id);
      if (!uploaded.ok) {
        setBusy(false);
        setError(uploaded.error);
        return;
      }
      docs.push({ kind, path: uploaded.path });
    }
    if (docs.length < 2) {
      setBusy(false);
      setError(t('fleet.documentHint'));
      return;
    }
    const result = await client.call(fleetCommandSpec, {
      action: 'vehicle.submitVerification',
      vehicleId: vehicle.id,
      documents: docs,
    } as never);
    setBusy(false);
    if (!result.ok) {
      fail(result.error.code, result.error.detail);
      return;
    }
    setMessage(t('fleet.submittedForReview'));
    router.refresh();
  }

  if (editing) {
    return (
      <div>
        <Button variant="ghost" onClick={() => setEditing(false)}>
          {t('fleet.details')}
        </Button>
        <VehicleWizard
          locale={locale}
          configured={configured}
          verified={verified}
          orgId={orgId}
          orgName={orgName}
          initial={vehicle}
          canSubmitForReview={false}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      </div>
    );
  }

  const spec: [TranslationKey, string][] = [
    ['fleet.modelYear', String(vehicle.modelYear)],
    ['fleet.trim', vehicle.trim ?? t('fleet.unknown')],
    ['fleet.plateNumber', vehicle.plateNumber],
    ['fleet.vin', vehicle.vin ?? t('fleet.unknown')],
    ['fleet.chassisNo', vehicle.chassisNo ?? t('fleet.unknown')],
    ['fleet.color', vehicle.color ?? t('fleet.unknown')],
    ['fleet.bodyType', t(VEHICLE_BODY_TYPE_KEY[vehicle.bodyType] ?? 'fleet.bodyOther')],
    [
      'fleet.driveType',
      vehicle.driveType
        ? t(DRIVE_TYPE_KEY[vehicle.driveType] ?? 'fleet.unknown')
        : t('fleet.unknown'),
    ],
    [
      'fleet.transmission',
      vehicle.transmission
        ? t(TRANSMISSION_KEY[vehicle.transmission] ?? 'fleet.unknown')
        : t('fleet.unknown'),
    ],
    ['fleet.fuelType', t(FUEL_TYPE_KEY[vehicle.fuelType] ?? 'fleet.fuelOther')],
    ['fleet.engineCc', vehicle.engineCc === null ? t('fleet.unknown') : String(vehicle.engineCc)],
    [
      'fleet.cylinders',
      vehicle.cylinders === null ? t('fleet.unknown') : String(vehicle.cylinders),
    ],
    [
      'fleet.fuelTankL',
      vehicle.fuelTankL === null ? t('fleet.unknown') : String(vehicle.fuelTankL),
    ],
    ['fleet.tyreSize', vehicle.tyreSize ?? t('fleet.unknown')],
    [
      'fleet.tyreCount',
      vehicle.tyreCount === null ? t('fleet.unknown') : String(vehicle.tyreCount),
    ],
    ['fleet.spareTyre', yesNo(locale, vehicle.spareTyre)],
    ['fleet.vehicleCondition', t(CONDITION_KEY[vehicle.vehicleCondition] ?? 'fleet.conditionUsed')],
    ['fleet.ownershipKind', t(OWNERSHIP_KEY[vehicle.ownershipKind] ?? 'fleet.owned')],
    ['fleet.seatsPassenger', String(vehicle.seatsPassenger)],
    ['fleet.seatsTotal', String(vehicle.seatsTotal)],
    [
      'fleet.luggageCapacityL',
      vehicle.luggageCapacityL === null ? t('fleet.unknown') : String(vehicle.luggageCapacityL),
    ],
    ['fleet.roofRack', yesNo(locale, vehicle.roofRack)],
    ['fleet.airConditioning', yesNo(locale, vehicle.airConditioning)],
    ['fleet.heating', yesNo(locale, vehicle.heating)],
    ['fleet.recliningSeats', yesNo(locale, vehicle.recliningSeats)],
    ['fleet.usbCharging', yesNo(locale, vehicle.usbCharging)],
    ['fleet.wifi', yesNo(locale, vehicle.wifi)],
    ['fleet.entertainment', yesNo(locale, vehicle.entertainment)],
    ['fleet.curtains', yesNo(locale, vehicle.curtains)],
    ['fleet.readingLights', yesNo(locale, vehicle.readingLights)],
    ['fleet.airbags', String(vehicle.airbags)],
    ['fleet.abs', yesNo(locale, vehicle.abs)],
    ['fleet.esp', yesNo(locale, vehicle.esp)],
    ['fleet.seatbeltsAll', yesNo(locale, vehicle.seatbeltsAll)],
    ['fleet.fireExtinguisher', yesNo(locale, vehicle.fireExtinguisher)],
    ['fleet.firstAid', yesNo(locale, vehicle.firstAid)],
    ['fleet.emergencyExit', yesNo(locale, vehicle.emergencyExit)],
    ['fleet.gpsDevice', yesNo(locale, vehicle.gpsDevice)],
    ['fleet.speedLimiter', yesNo(locale, vehicle.speedLimiter)],
    ['fleet.childSeat', yesNo(locale, vehicle.childSeat)],
    ['fleet.wheelchairAccessible', yesNo(locale, vehicle.wheelchairAccessible)],
    ['fleet.stepAssist', yesNo(locale, vehicle.stepAssist)],
    ['fleet.exteriorCondition', t(CONDITION_KEY[vehicle.exteriorCondition] ?? 'fleet.ratingGood')],
    ['fleet.interiorCondition', t(CONDITION_KEY[vehicle.interiorCondition] ?? 'fleet.ratingGood')],
    ['fleet.insuranceCompany', vehicle.insuranceCompany ?? t('fleet.unknown')],
    ['fleet.insurancePolicyNo', vehicle.insurancePolicyNo ?? t('fleet.unknown')],
    ['fleet.insuranceExpiry', vehicle.insuranceExpiry ?? t('fleet.unknown')],
    ['fleet.inspectionExpiry', vehicle.inspectionExpiry ?? t('fleet.unknown')],
    ['fleet.registrationExpiry', vehicle.registrationExpiry ?? t('fleet.unknown')],
    ['fleet.transportPermitExpiry', vehicle.transportPermitExpiry ?? t('fleet.unknown')],
    ['fleet.odometerKm', String(vehicle.odometerKm)],
    ['fleet.notes', vehicle.notes ?? t('fleet.unknown')],
  ];

  return (
    <div className="fleet-detail">
      <header className="fleet-detail__head">
        <div>
          <h2>
            {vehicle.make} {vehicle.model} <span className="num">{vehicle.modelYear}</span>
          </h2>
          <p className="fleet-plate" dir="ltr">
            {vehicle.plateNumber}
          </p>
        </div>
        <VehicleBadges locale={locale} vehicle={vehicle} />
      </header>

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
      {vehicle.verificationNote ? (
        <p className="fleet-note">
          {t('fleet.rejectReason')}: {vehicle.verificationNote}
        </p>
      ) : null}

      <section className="fleet-section" aria-labelledby="fleet-photos-heading">
        <h3 id="fleet-photos-heading">{t('fleet.photos')}</h3>
        {photos.length === 0 ? <p className="fleet-hint">{t('fleet.noPhotos')}</p> : null}
        <ul className="fleet-photo-grid">
          {photos.map((photo) => (
            <li key={photo.id}>
              {/* Not next/image: the source is a storage path behind the session proxy, not a build asset. */}
              <img src={publicPhotoUrl(photo.storagePath)} alt="" loading="lazy" />
              {photo.isPrimary ? <Badge tone="info">{t('fleet.primaryPhoto')}</Badge> : null}
            </li>
          ))}
        </ul>
        {canEdit ? (
          <label className="ui-field">
            <span className="ui-field__label">{t('fleet.addPhotos')}</span>
            <input
              className="ui-input"
              type="file"
              accept="image/*"
              multiple
              disabled={busy || photos.length >= 12}
              onChange={(event) => void addPhotos(event.target.files)}
            />
            <span className="ui-field__hint">{t('fleet.photoHint')}</span>
          </label>
        ) : null}
      </section>

      <section className="fleet-section" aria-labelledby="fleet-docs-heading">
        <h3 id="fleet-docs-heading">{t('fleet.documents')}</h3>
        {documents.length === 0 ? <p className="fleet-hint">{t('fleet.documentHint')}</p> : null}
        <ul className="fleet-doc-list">
          {documents.map((document) => (
            <li key={document.id}>
              <a href={privateDocumentUrl(document.storagePath)} target="_blank" rel="noreferrer">
                {t(DOCUMENT_KEY[document.kind] ?? 'fleet.documentOther')}
              </a>
            </li>
          ))}
        </ul>
        {canEdit && vehicle.verificationStatus !== 'verified' ? (
          <SubmitForReview busy={busy} onSubmit={submitForReview} locale={locale} />
        ) : null}
      </section>

      <section className="fleet-section" aria-labelledby="fleet-driver-heading">
        <h3 id="fleet-driver-heading">{t('fleet.currentDriver')}</h3>
        <p>
          {driver
            ? `${driver.name} · ${translate(locale, driver.verificationStatus === 'verified' ? 'fleet.badgeVerified' : 'fleet.badgeUnverified')}`
            : t('fleet.noDriver')}
        </p>
        {canEdit ? (
          <div className="fleet-inline">
            {drivers.length > 0 ? (
              <select
                className="ui-select"
                aria-label={t('fleet.assignDriver')}
                value={driverId}
                onChange={(event) => setDriverId(event.target.value)}
              >
                <option value="">{t('fleet.selectPlaceholder')}</option>
                {drivers.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                    {option.verificationStatus === 'verified' ? ' ✓' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <p className="fleet-hint">{t('fleet.noEligibleDriver')}</p>
            )}
            <Button
              loading={busy}
              disabled={busy || !driverId || driverId === driver?.id}
              onClick={() =>
                void run(
                  { action: 'driver.assign', vehicleId: vehicle.id, driverId },
                  'fleet.assigned',
                )
              }
            >
              {t('fleet.assign')}
            </Button>
            <Button
              variant="ghost"
              loading={busy}
              disabled={busy || !driver}
              onClick={() =>
                void run({ action: 'driver.unassign', vehicleId: vehicle.id }, 'fleet.unassigned')
              }
            >
              {t('fleet.unassignDriver')}
            </Button>
          </div>
        ) : null}
      </section>

      <section className="fleet-section" aria-labelledby="fleet-spec-heading">
        <h3 id="fleet-spec-heading">{t('fleet.specs')}</h3>
        <dl className="fleet-table">
          {spec.map(([key, value]) => (
            <div key={key} className="fleet-table__row">
              <dt>{t(key)}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {canEdit ? (
        <div className="fleet-actions">
          <Button variant="ghost" onClick={() => setEditing(true)}>
            {t('fleet.editVehicle')}
          </Button>
          {vehicle.status !== 'retired' ? (
            <Button
              variant="danger"
              loading={busy}
              disabled={busy}
              onClick={() =>
                void run(
                  {
                    action: 'vehicle.setStatus',
                    vehicleId: vehicle.id,
                    status: 'retired',
                    reason: 'retired by owner',
                  },
                  'fleet.retired',
                )
              }
            >
              {t('fleet.retire')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The two files the review needs, kept local to the section that submits them. */
function SubmitForReview({
  locale,
  busy,
  onSubmit,
}: {
  readonly locale: Locale;
  readonly busy: boolean;
  readonly onSubmit: (files: {
    insurance: File | null;
    registration: File | null;
  }) => Promise<void>;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [insurance, setInsurance] = useState<File | null>(null);
  const [registration, setRegistration] = useState<File | null>(null);

  return (
    <div className="fleet-submit">
      <label className="ui-field">
        <span className="ui-field__label">{t('fleet.documentInsurance')}</span>
        <input
          className="ui-input"
          type="file"
          accept="image/*,application/pdf"
          onChange={(event) => setInsurance(event.target.files?.[0] ?? null)}
        />
      </label>
      <label className="ui-field">
        <span className="ui-field__label">{t('fleet.documentRegistration')}</span>
        <input
          className="ui-input"
          type="file"
          accept="image/*,application/pdf"
          onChange={(event) => setRegistration(event.target.files?.[0] ?? null)}
        />
      </label>
      <Button
        loading={busy}
        disabled={busy || !insurance || !registration}
        onClick={() => void onSubmit({ insurance, registration })}
      >
        {t('fleet.submitForReview')}
      </Button>
    </div>
  );
}
