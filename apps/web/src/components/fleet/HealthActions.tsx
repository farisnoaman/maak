'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  MAINTENANCE_KIND_KEY,
  errorKey,
  fleetCommandSpec,
  formatNumber,
  nextDueKm,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Badge, type BadgeTone } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { getApiClient, uploadVehicleOpsFile } from '@/lib/api';
import type { MaintenanceState, StationOption, VehicleHealth } from '@/lib/fleet-ops';

const TONE: Record<MaintenanceState, BadgeTone> = {
  ok: 'success',
  due_soon: 'warning',
  overdue: 'danger',
};

const KINDS = Object.keys(MAINTENANCE_KIND_KEY);

/**
 * Everything a person does to a vehicle's numbers: a fill, a reading, a rule, and "the work is done".
 *
 * Four separate forms rather than one clever panel, because they have four different audiences and four
 * different failure modes. The fill is what a driver does weekly; the schedule is what an owner configures
 * once; "done" is what closes it. Mixing them is how a tyre rotation ends up resetting the oil interval.
 */
export function HealthActions({
  locale,
  configured,
  vehicleId,
  health,
  canManage,
  stations,
}: {
  readonly locale: Locale;
  readonly configured: boolean;
  readonly vehicleId: string;
  readonly health: VehicleHealth;
  readonly canManage: boolean;
  readonly stations: readonly StationOption[];
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const router = useRouter();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [anomaly, setAnomaly] = useState(false);

  const [odometer, setOdometer] = useState(String(health.vehicle.odometerKm));
  const [litres, setLitres] = useState('');
  const [price, setPrice] = useState('');
  const [fullTank, setFullTank] = useState(true);
  const [station, setStation] = useState('');
  const [stationPlaceId, setStationPlaceId] = useState('');

  const [readingKm, setReadingKm] = useState('');
  const [readingNote, setReadingNote] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);

  const [kind, setKind] = useState('oil_change');
  const [intervalKm, setIntervalKm] = useState('');
  const [intervalDays, setIntervalDays] = useState('');
  const [lastDoneKm, setLastDoneKm] = useState('');
  const [lastDoneOn, setLastDoneOn] = useState('');
  const [dueId, setDueId] = useState<string | null>(null);
  const [doneKm, setDoneKm] = useState('');
  const [doneCost, setDoneCost] = useState('');
  const [doneVendor, setDoneVendor] = useState('');
  const [doneFile, setDoneFile] = useState<File | null>(null);
  const [doneNote, setDoneNote] = useState('');

  function fail(code: string) {
    setError(t(errorKey(code as never)));
  }

  function client() {
    const api = getApiClient();
    if (!api || !configured) {
      setError(t('verification.notConfigured'));
      return null;
    }
    return api;
  }

  async function logFuel() {
    const api = client();
    if (!api) return;
    setBusy('fuel');
    setError(null);
    setMessage(null);
    setAnomaly(false);
    const result = await api.call(fleetCommandSpec, {
      action: 'fuel.log',
      vehicleId,
      odometerKm: Number(odometer),
      litres: Number(litres),
      pricePerLitreYer: Number(price),
      isFullTank: fullTank,
      stationName: station.trim() || null,
      stationPlaceId: stationPlaceId || null,
    } as never);
    setBusy(null);
    if (!result.ok) {
      fail(result.error.code);
      return;
    }
    const payload = result.data as { anomaly?: boolean };
    setAnomaly(payload.anomaly === true);
    setMessage(t('fleetOps.fuelSaved'));
    setLitres('');
    setPrice('');
    setStation('');
    setStationPlaceId('');
    router.refresh();
  }

  async function recordReading() {
    const api = client();
    if (!api) return;
    setBusy('reading');
    setError(null);
    setMessage(null);
    // The photo is uploaded first: the command stores the object path it is given, and it refuses a path
    // that does not exist, so a failed upload must stop the reading rather than produce a dangling note.
    let photoPath: string | null = null;
    if (photo) {
      const uploaded = await uploadVehicleOpsFile(photo, vehicleId, 'odometer');
      if (!uploaded.ok) {
        setBusy(null);
        setError(t('fleet.licenceUploadFailed'));
        return;
      }
      photoPath = uploaded.path;
    }
    const result = await api.call(fleetCommandSpec, {
      action: 'odometer.record',
      vehicleId,
      odometerKm: Number(readingKm),
      photoPath,
      overrideReason: overrideReason.trim() || null,
      note: readingNote.trim() || null,
    } as never);
    setBusy(null);
    if (!result.ok) {
      fail(result.error.code);
      return;
    }
    const payload = result.data as { override?: boolean };
    setMessage(payload.override ? t('fleetOps.overrideSaved') : t('fleetOps.readingSaved'));
    setReadingKm('');
    setReadingNote('');
    setOverrideReason('');
    setPhoto(null);
    router.refresh();
  }

  async function saveSchedule() {
    const api = client();
    if (!api) return;
    setBusy('schedule');
    setError(null);
    setMessage(null);
    const result = await api.call(fleetCommandSpec, {
      action: 'maintenance.schedule',
      vehicleId,
      kind,
      intervalKm: intervalKm ? Number(intervalKm) : null,
      intervalDays: intervalDays ? Number(intervalDays) : null,
      lastDoneKm: lastDoneKm ? Number(lastDoneKm) : null,
      lastDoneOn: lastDoneOn || null,
    } as never);
    setBusy(null);
    if (!result.ok) {
      fail(result.error.code);
      return;
    }
    setMessage(t('fleetOps.scheduleSaved'));
    setIntervalKm('');
    setIntervalDays('');
    setLastDoneKm('');
    setLastDoneOn('');
    router.refresh();
  }

  async function markDone(scheduleId: string) {
    const api = client();
    if (!api) return;
    setBusy(scheduleId);
    setError(null);
    setMessage(null);
    // The invoice goes up first, for the same reason as the odometer photo: the command refuses a path
    // that does not exist, and a half-recorded service is worse than none.
    let attachmentPath: string | null = null;
    if (doneFile) {
      const uploaded = await uploadVehicleOpsFile(doneFile, vehicleId, 'maintenance');
      if (!uploaded.ok) {
        setBusy(null);
        setError(t('fleetOps.photoUploadFailed'));
        return;
      }
      attachmentPath = uploaded.path;
    }
    const result = await api.call(fleetCommandSpec, {
      action: 'maintenance.done',
      scheduleId,
      odometerKm: doneKm ? Number(doneKm) : null,
      costYer: doneCost ? Number(doneCost) : 0,
      vendor: doneVendor.trim() || null,
      note: doneNote.trim() || null,
      attachmentPath,
    } as never);
    setBusy(null);
    if (!result.ok) {
      fail(result.error.code);
      return;
    }
    setMessage(t('fleetOps.doneSaved'));
    setDueId(null);
    setDoneKm('');
    setDoneCost('');
    setDoneVendor('');
    setDoneNote('');
    setDoneFile(null);
    if (attachmentPath)
      setMessage(`${t('fleetOps.doneSaved')} ${t('fleetOps.attachmentUploaded')}`);
    router.refresh();
  }

  const lowerReading = readingKm !== '' && Number(readingKm) < health.vehicle.odometerKm;
  const previewDue = nextDueKm(
    lastDoneKm ? Number(lastDoneKm) : null,
    intervalKm ? Number(intervalKm) : null,
  );

  return (
    <div className="fleet-ops">
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
      {anomaly ? (
        <p className="fleet-warning" role="alert">
          {t('fleetOps.anomaly')}
        </p>
      ) : null}

      <section className="fleet-section" aria-labelledby="health-fuel-heading">
        <h2 id="health-fuel-heading">{t('fleetOps.logFuel')}</h2>
        <div className="fleet-fields">
          <Field
            label={t('fleet.odometerKm')}
            type="number"
            min={0}
            required
            value={odometer}
            hint={t('fleetOps.odometerHint')}
            onChange={(event) => setOdometer(event.target.value)}
          />
          <Field
            label={t('fleetOps.litres')}
            type="number"
            min={0}
            step="0.01"
            required
            value={litres}
            onChange={(event) => setLitres(event.target.value)}
          />
          <Field
            label={t('fleetOps.pricePerLitre')}
            type="number"
            min={0}
            required
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
          <Field
            label={t('fleetOps.station')}
            value={station}
            onChange={(event) => setStation(event.target.value)}
          />
          {/* Linking is optional; a driver who cannot find the station types the name and moves on. When
              they do pick one, the name is filled in from the directory so the two agree. */}
          <label className="fleet-check">
            <span>{t('fleetOps.stationLink')}</span>
            <select
              className="ui-input"
              value={stationPlaceId}
              onChange={(event) => {
                const value = event.target.value;
                setStationPlaceId(value);
                const match = stations.find((option) => option.id === value);
                if (match)
                  setStation(locale === 'ar' ? match.nameAr : (match.nameEn ?? match.nameAr));
              }}
            >
              <option value="">{t('fleetOps.stationNone')}</option>
              {stations.map((option) => (
                <option key={option.id} value={option.id}>
                  {locale === 'ar' ? option.nameAr : (option.nameEn ?? option.nameAr)}
                </option>
              ))}
            </select>
          </label>
          <label className="fleet-check">
            <input
              type="checkbox"
              checked={fullTank}
              onChange={(event) => setFullTank(event.target.checked)}
            />
            <span>{t('fleetOps.fullTank')}</span>
          </label>
        </div>
        {litres && price ? (
          <p className="fleet-hint">
            {t('fleetOps.cost')}:{' '}
            {formatNumber(Math.round(Number(litres) * Number(price)), { locale })}
          </p>
        ) : null}
        <Button
          loading={busy === 'fuel'}
          disabled={busy !== null || !litres || !price || !odometer}
          onClick={() => void logFuel()}
        >
          {t('fleetOps.saveFuel')}
        </Button>
      </section>

      <section className="fleet-section" aria-labelledby="health-odo-heading">
        <h2 id="health-odo-heading">{t('fleetOps.odometerTitle')}</h2>
        <div className="fleet-fields">
          <Field
            label={t('fleet.odometerKm')}
            type="number"
            min={0}
            required
            value={readingKm}
            placeholder={String(health.vehicle.odometerKm)}
            onChange={(event) => setReadingKm(event.target.value)}
          />
          <Field
            label={t('fleetOps.note')}
            value={readingNote}
            onChange={(event) => setReadingNote(event.target.value)}
          />
          <label className="fleet-check">
            <span>{t('fleetOps.photo')}</span>
            <input
              type="file"
              accept="image/*"
              onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
            />
          </label>
          {lowerReading ? (
            <Field
              label={t('fleetOps.overrideReason')}
              required
              value={overrideReason}
              hint={t('fleetOps.overrideHint')}
              onChange={(event) => setOverrideReason(event.target.value)}
            />
          ) : null}
        </div>
        {!lowerReading ? <p className="fleet-hint">{t('fleetOps.overrideHint')}</p> : null}
        <Button
          loading={busy === 'reading'}
          disabled={
            busy !== null || !readingKm || (lowerReading && overrideReason.trim().length < 3)
          }
          onClick={() => void recordReading()}
        >
          {t('fleetOps.saveReading')}
        </Button>
      </section>

      <section className="fleet-section" aria-labelledby="health-schedules-heading">
        <h2 id="health-schedules-heading">{t('fleetOps.schedules')}</h2>
        <p className="fleet-hint">{t('fleetOps.scheduleHint')}</p>

        {health.maintenance.schedules.length === 0 ? (
          <p className="fleet-hint">{t('fleetOps.noSchedules')}</p>
        ) : (
          <ul className="fleet-list">
            {health.maintenance.schedules.map((schedule) => (
              <li key={schedule.id} className="fleet-list__row">
                <div>
                  <strong>{t(MAINTENANCE_KIND_KEY[schedule.kind] ?? 'fleetOps.kind.other')}</strong>{' '}
                  <Badge tone={TONE[schedule.state]}>
                    {t(
                      schedule.state === 'ok'
                        ? 'fleetOps.stateOk'
                        : schedule.state === 'due_soon'
                          ? 'fleetOps.stateDueSoon'
                          : 'fleetOps.stateOverdue',
                    )}
                  </Badge>
                  <p className="fleet-hint">
                    {schedule.dueKm != null
                      ? `${t('fleetOps.dueKm')}: ${formatNumber(schedule.dueKm, { locale })}`
                      : null}
                    {schedule.dueOn != null ? ` · ${t('fleetOps.dueOn')}: ${schedule.dueOn}` : null}
                  </p>
                </div>
                {canManage ? (
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => setDueId(dueId === schedule.id ? null : schedule.id)}
                  >
                    {t('fleetOps.markDone')}
                  </Button>
                ) : null}
                {dueId === schedule.id ? (
                  <div className="fleet-done-form">
                    <Field
                      label={t('fleetOps.lastDoneKm')}
                      type="number"
                      value={doneKm}
                      hint={t('fleetOps.markDoneHint')}
                      onChange={(event) => setDoneKm(event.target.value)}
                    />
                    <Field
                      label={t('fleetOps.cost')}
                      type="number"
                      min={0}
                      value={doneCost}
                      onChange={(event) => setDoneCost(event.target.value)}
                    />
                    <Field
                      label={t('fleetOps.vendor')}
                      value={doneVendor}
                      onChange={(event) => setDoneVendor(event.target.value)}
                    />
                    <Field
                      label={t('fleetOps.note')}
                      value={doneNote}
                      onChange={(event) => setDoneNote(event.target.value)}
                    />
                    <label className="fleet-check">
                      <span>{t('fleetOps.attachment')}</span>
                      <input
                        type="file"
                        accept="image/*,application/pdf"
                        onChange={(event) => setDoneFile(event.target.files?.[0] ?? null)}
                      />
                    </label>
                    <Button
                      size="sm"
                      loading={busy === schedule.id}
                      disabled={busy !== null}
                      onClick={() => void markDone(schedule.id)}
                    >
                      {t('fleetOps.markDone')}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canManage ? (
          <>
            <h3>{t('fleetOps.newSchedule')}</h3>
            <div className="fleet-fields">
              <label className="fleet-check">
                <span>{t('fleetOps.kind')}</span>
                <select
                  className="ui-input"
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                >
                  {KINDS.map((value) => (
                    <option key={value} value={value}>
                      {t(MAINTENANCE_KIND_KEY[value] ?? 'fleetOps.kind.other')}
                    </option>
                  ))}
                </select>
              </label>
              <Field
                label={t('fleetOps.intervalKm')}
                type="number"
                min={100}
                max={500000}
                value={intervalKm}
                onChange={(event) => setIntervalKm(event.target.value)}
              />
              <Field
                label={t('fleetOps.intervalDays')}
                type="number"
                min={1}
                max={3650}
                value={intervalDays}
                onChange={(event) => setIntervalDays(event.target.value)}
              />
              <Field
                label={t('fleetOps.lastDoneKm')}
                type="number"
                min={0}
                value={lastDoneKm}
                onChange={(event) => setLastDoneKm(event.target.value)}
              />
              <Field
                label={t('fleetOps.lastDoneOn')}
                type="date"
                value={lastDoneOn}
                onChange={(event) => setLastDoneOn(event.target.value)}
              />
            </div>
            {previewDue != null ? (
              <p className="fleet-hint">
                {t('fleetOps.nextDue', { due: t('fleetOps.dueAtKm', { km: previewDue }) })}
              </p>
            ) : null}
            <Button
              loading={busy === 'schedule'}
              disabled={busy !== null || (!intervalKm && !intervalDays)}
              onClick={() => void saveSchedule()}
            >
              {t('fleetOps.saveSchedule')}
            </Button>
          </>
        ) : null}
      </section>
    </div>
  );
}
