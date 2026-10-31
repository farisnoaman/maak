import Link from 'next/link';
import {
  FUEL_TYPE_KEY,
  VEHICLE_BODY_TYPE_KEY,
  VEHICLE_STATUS_KEY,
  translate,
  type Locale,
} from '@maak/core';
import { VehicleBadges } from './VehicleBadges';

export interface VehicleCardVehicle {
  readonly id: string;
  readonly make: string;
  readonly model: string;
  readonly modelYear: number;
  readonly plateNumber: string;
  readonly bodyType: string;
  readonly fuelType: string;
  readonly seatsPassenger: number;
  readonly status: string;
  readonly verificationStatus: string;
  readonly insuranceExpiry: string | null;
  readonly inspectionExpiry: string | null;
  readonly registrationExpiry: string | null;
  readonly transportPermitExpiry: string | null;
}

/**
 * One vehicle, as a card.
 *
 * The picture is the primary photo when there is one and a labelled placeholder when there is not —
 * a card with an empty grey box looks broken, and "no photo yet" is actionable information.
 */
export function VehicleCard({
  locale,
  vehicle,
  photoUrl,
  driverName,
}: {
  readonly locale: Locale;
  readonly vehicle: VehicleCardVehicle;
  readonly photoUrl: string | null;
  readonly driverName?: string | null;
}) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

  return (
    <article className="fleet-card">
      <div className="fleet-card__media">
        {photoUrl ? (
          <img src={photoUrl} alt={`${vehicle.make} ${vehicle.model}`} loading="lazy" />
        ) : (
          <span className="fleet-card__placeholder" aria-hidden="true">
            🚐
          </span>
        )}
      </div>

      <div className="fleet-card__body">
        <div className="fleet-card__head">
          <h2>
            {vehicle.make} {vehicle.model}{' '}
            <span className="fleet-card__year num">{vehicle.modelYear}</span>
          </h2>
          <span className="fleet-plate" dir="ltr">
            {vehicle.plateNumber}
          </span>
        </div>

        <VehicleBadges locale={locale} vehicle={vehicle} />

        <p className="fleet-card__meta">
          {t(VEHICLE_BODY_TYPE_KEY[vehicle.bodyType] ?? 'fleet.bodyOther')} ·{' '}
          {t(FUEL_TYPE_KEY[vehicle.fuelType] ?? 'fleet.fuelOther')} · {t('fleet.seatsPassenger')}:{' '}
          <span className="num">{vehicle.seatsPassenger}</span>
        </p>
        <p className="fleet-card__meta">
          {t('common.status')}: {t(VEHICLE_STATUS_KEY[vehicle.status] ?? 'fleet.statusDraft')}
          {driverName
            ? ` · ${t('fleet.currentDriver')}: ${driverName}`
            : ` · ${t('fleet.noDriver')}`}
        </p>

        <Link className="btn btn--ghost" href={`/${locale}/operator/vehicles/${vehicle.id}`}>
          {t('fleet.viewVehicle')}
        </Link>
      </div>
    </article>
  );
}

/** `/storage/v1/object/public/<bucket>/<path>` behind the same-origin proxy. */
export function publicPhotoUrl(path: string): string {
  return `/api/data/storage/v1/object/public/vehicle-photos/${path}`;
}

/** Private bucket: Supabase honours the storage RLS for an authenticated read. */
export function privateDocumentUrl(path: string): string {
  return `/api/data/storage/v1/object/authenticated/vehicle-documents/${path}`;
}
