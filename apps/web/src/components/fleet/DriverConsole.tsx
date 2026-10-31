'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DRIVER_STATUS_KEY,
  VERIFICATION_KEY,
  errorKey,
  fleetCommandSpec,
  quotaMetricKey,
  quotaOf,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Badge, EmptyState } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { getApiClient } from '@/lib/api';

export interface ConsoleDriver {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly licenceNo: string | null;
  readonly licenceExpiry: string | null;
  readonly licencePhotoPath: string | null;
  readonly status: string;
  readonly verificationStatus: string;
  readonly vehicleName: string | null;
}

/**
 * Drivers: invite by phone, see who is verified, and assign a vehicle.
 *
 * The invite deliberately works by phone number: a driver usually has no email, and the invitation must
 * survive them signing up *after* the owner invited them. The command links the invitation immediately
 * when the phone already belongs to an account and leaves it pending otherwise.
 */
export function DriverConsole({
  locale,
  configured,
  orgId,
  orgName,
  canInvite,
  drivers,
  vehicles,
}: {
  readonly locale: Locale;
  readonly configured: boolean;
  readonly orgId: string | null;
  readonly orgName: string | null;
  readonly canInvite: boolean;
  readonly drivers: readonly ConsoleDriver[];
  readonly vehicles: readonly { id: string; name: string }[];
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const router = useRouter();

  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [licenceNo, setLicenceNo] = useState('');
  const [licenceExpiry, setLicenceExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [assignFor, setAssignFor] = useState<Record<string, string>>({});

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

  async function invite() {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await client.call(fleetCommandSpec, {
      action: 'driver.invite',
      orgId,
      phone: phone.trim(),
      fullName: fullName.trim(),
      licenceNo: licenceNo.trim() || undefined,
      licenceExpiry: licenceExpiry || null,
    } as never);
    setBusy(false);
    if (!result.ok) {
      fail(result.error.code, result.error.detail);
      return;
    }
    const linked = Boolean((result.data as { linkedImmediately?: boolean }).linkedImmediately);
    setMessage(
      linked ? `${t('fleet.inviteSent')} ${t('fleet.driverLinked')}` : t('fleet.inviteSent'),
    );
    setPhone('');
    setFullName('');
    setLicenceNo('');
    setLicenceExpiry('');
    router.refresh();
  }

  async function assign(driverId: string) {
    const vehicleId = assignFor[driverId];
    if (!vehicleId) return;
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await client.call(fleetCommandSpec, {
      action: 'driver.assign',
      vehicleId,
      driverId,
    } as never);
    setBusy(false);
    if (!result.ok) {
      fail(result.error.code, result.error.detail);
      return;
    }
    setMessage(t('fleet.assigned'));
    router.refresh();
  }

  return (
    <div className="fleet-drivers">
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

      {canInvite ? (
        <section className="fleet-section" aria-labelledby="fleet-invite-heading">
          <h2 id="fleet-invite-heading">{t('fleet.inviteDriver')}</h2>
          <p className="fleet-hint">{t('fleet.inviteHint')}</p>
          <div className="fleet-fields">
            <Field
              label={t('fleet.driverPhone')}
              type="tel"
              required
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder={t('fleet.phonePlaceholder')}
            />
            <Field
              label={t('fleet.driverName')}
              required
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
            />
            <Field
              label={t('fleet.licenceNo')}
              value={licenceNo}
              onChange={(event) => setLicenceNo(event.target.value)}
            />
            <Field
              label={t('fleet.licenceExpiry')}
              type="date"
              value={licenceExpiry}
              onChange={(event) => setLicenceExpiry(event.target.value)}
            />
          </div>
          <Button
            loading={busy}
            disabled={busy || phone.trim().length < 6 || fullName.trim().length < 2}
            onClick={() => void invite()}
          >
            {t('fleet.inviteDriver')}
          </Button>
        </section>
      ) : null}

      <section className="fleet-section" aria-labelledby="fleet-driver-list">
        <h2 id="fleet-driver-list">
          {orgName ? t('fleet.driversOf', { org: orgName }) : t('fleet.myDrivers')}
        </h2>
        {drivers.length === 0 ? (
          <EmptyState title={t('fleet.noDrivers')} description={t('fleet.inviteHint')} />
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
                    {t('fleet.driverLicence')}: {driver.licenceNo ?? t('fleet.unknown')}
                    {driver.licenceExpiry ? ` · ${driver.licenceExpiry}` : ''}
                  </p>
                  <p className="fleet-row__meta">
                    {t('fleet.licencePhoto')}:{' '}
                    {driver.licencePhotoPath ? (
                      <a
                        href={`/api/data/storage/v1/object/authenticated/driver-documents/${driver.licencePhotoPath}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('fleet.viewPhoto')}
                      </a>
                    ) : (
                      t('fleet.licencePhotoMissing')
                    )}
                  </p>
                  <p className="fleet-row__meta">
                    {t('fleet.currentDriver')}: {driver.vehicleName ?? t('fleet.notAssigned')}
                  </p>
                </div>
                <div className="fleet-row__side">
                  <Badge>{t(DRIVER_STATUS_KEY[driver.status] ?? 'fleet.driverInvited')}</Badge>
                  <Badge tone={driver.verificationStatus === 'verified' ? 'success' : 'neutral'}>
                    {t(VERIFICATION_KEY[driver.verificationStatus] ?? 'fleet.badgeUnverified')}
                  </Badge>
                  {driver.verificationStatus === 'verified' && vehicles.length > 0 ? (
                    <div className="fleet-inline">
                      <select
                        className="ui-select"
                        aria-label={t('fleet.selectVehicle')}
                        value={assignFor[driver.id] ?? ''}
                        onChange={(event) =>
                          setAssignFor((current) => ({
                            ...current,
                            [driver.id]: event.target.value,
                          }))
                        }
                      >
                        <option value="">{t('fleet.selectVehicle')}</option>
                        {vehicles.map((vehicle) => (
                          <option key={vehicle.id} value={vehicle.id}>
                            {vehicle.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        loading={busy}
                        disabled={busy || !assignFor[driver.id]}
                        onClick={() => void assign(driver.id)}
                      >
                        {t('fleet.assign')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
