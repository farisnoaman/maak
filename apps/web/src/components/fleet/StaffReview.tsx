'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DRIVER_STATUS_KEY,
  FUEL_TYPE_KEY,
  VEHICLE_BODY_TYPE_KEY,
  errorKey,
  fleetCommandSpec,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Badge, EmptyState } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { getApiClient } from '@/lib/api';

interface PendingVehicle {
  readonly id: string;
  readonly make: string;
  readonly model: string;
  readonly modelYear: number;
  readonly plateNumber: string;
  readonly bodyType: string;
  readonly fuelType: string;
  readonly seatsPassenger: number;
  readonly insuranceExpiry: string | null;
  readonly inspectionExpiry: string | null;
  readonly documents: readonly { id: string; kind: string; url: string }[];
}

interface PendingDriver {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly licenceNo: string | null;
  readonly licenceExpiry: string | null;
  /** Authenticated proxy URL of the private object, or null when nothing was uploaded. */
  readonly licencePhotoUrl: string | null;
  readonly status: string;
}

const DOCUMENT_KEY: Record<string, TranslationKey> = {
  insurance: 'fleet.documentInsurance',
  registration: 'fleet.documentRegistration',
  inspection: 'fleet.documentInspection',
  permit: 'fleet.documentPermit',
  other: 'fleet.documentOther',
};

/**
 * The staff review queue: two lists, one decision each, and a reason that is required when refusing.
 *
 * The reason has a 10-character floor in SQL and here — a rejection with no explanation leaves the owner
 * with a red badge and nothing to fix.
 */
export function StaffReview({
  locale,
  configured,
  vehicles,
  drivers,
}: {
  readonly locale: Locale;
  readonly configured: boolean;
  readonly vehicles: readonly PendingVehicle[];
  readonly drivers: readonly PendingDriver[];
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const router = useRouter();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function decideVehicle(id: string, outcome: 'approve' | 'reject') {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    if (outcome === 'reject' && (reasons[id] ?? '').trim().length < 10) {
      setError(t('fleet.rejectReason'));
      return;
    }
    setBusyId(id);
    setError(null);
    const result = await client.call(fleetCommandSpec, {
      action: 'vehicle.decide',
      vehicleId: id,
      outcome,
      reason: outcome === 'reject' ? (reasons[id] ?? '').trim() : undefined,
    } as never);
    setBusyId(null);
    if (!result.ok) {
      setError(t(errorKey(result.error.code as never)));
      return;
    }
    setMessage(t('fleet.decided'));
    router.refresh();
  }

  async function decideDriver(id: string, outcome: 'approve' | 'reject') {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    if (outcome === 'reject' && (reasons[id] ?? '').trim().length < 10) {
      setError(t('fleet.rejectReason'));
      return;
    }
    setBusyId(id);
    setError(null);
    const result = await client.call(fleetCommandSpec, {
      action: 'driver.verify',
      driverId: id,
      outcome,
      reason: outcome === 'reject' ? (reasons[id] ?? '').trim() : undefined,
    } as never);
    setBusyId(null);
    if (!result.ok) {
      setError(t(errorKey(result.error.code as never)));
      return;
    }
    setMessage(t('fleet.decided'));
    router.refresh();
  }

  return (
    <div className="fleet-review">
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

      <section className="fleet-section" aria-labelledby="fleet-review-vehicles">
        <h2 id="fleet-review-vehicles">{t('fleet.staffQueue')}</h2>
        {vehicles.length === 0 ? (
          <EmptyState title={t('fleet.staffQueueEmpty')} />
        ) : (
          <ul className="fleet-list">
            {vehicles.map((vehicle) => (
              <li key={vehicle.id} className="fleet-row fleet-row--stacked">
                <div>
                  <p className="fleet-row__title">
                    {vehicle.make} {vehicle.model} ·{' '}
                    <span className="num">{vehicle.modelYear}</span>
                  </p>
                  <p className="fleet-row__meta">
                    <span className="fleet-plate" dir="ltr">
                      {vehicle.plateNumber}
                    </span>{' '}
                    · {t(VEHICLE_BODY_TYPE_KEY[vehicle.bodyType] ?? 'fleet.bodyOther')} ·{' '}
                    {t(FUEL_TYPE_KEY[vehicle.fuelType] ?? 'fleet.fuelOther')} ·{' '}
                    {vehicle.seatsPassenger} {t('fleet.seatsPassenger')}
                  </p>
                  <p className="fleet-row__meta">
                    {t('fleet.insuranceExpiry')}: {vehicle.insuranceExpiry ?? t('fleet.unknown')} ·{' '}
                    {t('fleet.inspectionExpiry')}: {vehicle.inspectionExpiry ?? t('fleet.unknown')}
                  </p>
                  <ul className="fleet-doc-list">
                    {vehicle.documents.map((document) => (
                      <li key={document.id}>
                        <a href={document.url} target="_blank" rel="noreferrer">
                          {t(DOCUMENT_KEY[document.kind] ?? 'fleet.documentOther')}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="fleet-row__side">
                  <label className="ui-field">
                    <span className="ui-field__label">{t('fleet.rejectReason')}</span>
                    <input
                      className="ui-input"
                      value={reasons[vehicle.id] ?? ''}
                      onChange={(event) =>
                        setReasons((current) => ({ ...current, [vehicle.id]: event.target.value }))
                      }
                    />
                  </label>
                  <div className="fleet-inline">
                    <Button
                      size="sm"
                      loading={busyId === vehicle.id}
                      disabled={busyId === vehicle.id}
                      onClick={() => void decideVehicle(vehicle.id, 'approve')}
                    >
                      {t('fleet.approve')}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busyId === vehicle.id}
                      disabled={busyId === vehicle.id}
                      onClick={() => void decideVehicle(vehicle.id, 'reject')}
                    >
                      {t('fleet.reject')}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="fleet-section" aria-labelledby="fleet-review-drivers">
        <h2 id="fleet-review-drivers">{t('fleet.staffDriversQueue')}</h2>
        {drivers.length === 0 ? (
          <EmptyState title={t('fleet.staffQueueEmpty')} />
        ) : (
          <ul className="fleet-list">
            {drivers.map((driver) => (
              <li key={driver.id} className="fleet-row">
                <div>
                  <p className="fleet-row__title">{driver.fullName}</p>
                  <p className="fleet-row__meta" dir="ltr">
                    {driver.phone}
                  </p>
                  <p className="fleet-row__meta">
                    {t('fleet.driverLicence')}: {driver.licenceNo ?? t('fleet.unknown')} ·{' '}
                    {driver.licenceExpiry ?? t('fleet.unknown')}
                  </p>
                  {driver.licencePhotoUrl ? (
                    <a href={driver.licencePhotoUrl} target="_blank" rel="noreferrer">
                      {t('fleet.licencePhoto')}
                    </a>
                  ) : (
                    <p className="fleet-row__meta">{t('fleet.licencePhotoMissing')}</p>
                  )}
                  <Badge>{t(DRIVER_STATUS_KEY[driver.status] ?? 'fleet.driverInvited')}</Badge>
                </div>
                <div className="fleet-row__side">
                  <label className="ui-field">
                    <span className="ui-field__label">{t('fleet.rejectReason')}</span>
                    <input
                      className="ui-input"
                      value={reasons[driver.id] ?? ''}
                      onChange={(event) =>
                        setReasons((current) => ({ ...current, [driver.id]: event.target.value }))
                      }
                    />
                  </label>
                  <div className="fleet-inline">
                    <Button
                      size="sm"
                      loading={busyId === driver.id}
                      disabled={busyId === driver.id}
                      onClick={() => void decideDriver(driver.id, 'approve')}
                    >
                      {t('fleet.approve')}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busyId === driver.id}
                      disabled={busyId === driver.id}
                      onClick={() => void decideDriver(driver.id, 'reject')}
                    >
                      {t('fleet.reject')}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
