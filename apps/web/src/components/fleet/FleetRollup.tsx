'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  MAINTENANCE_STATE_KEY,
  errorKey,
  fleetCommandSpec,
  formatMinor,
  formatNumber,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Badge, EmptyState, type BadgeTone } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { getApiClient } from '@/lib/api';
import type { FleetSummary, FleetThresholds, MaintenanceState } from '@/lib/fleet-ops';

const TONE: Record<MaintenanceState, BadgeTone> = {
  ok: 'success',
  due_soon: 'warning',
  overdue: 'danger',
};

/**
 * The fleet at a glance, and the two things an owner does from it.
 *
 * The rollup is read-only by construction — it is `get_fleet_summary`, the same function the trip gate
 * and the reminder job read — so "reconciles with the logs" is a property of the query, not of this
 * component. What this file adds is the drill-down, the export, and the thresholds the whole feature
 * behaves according to.
 */
export function FleetRollup({
  locale,
  configured,
  orgId,
  summary,
  settings,
  canManage,
  basePath,
}: {
  readonly locale: Locale;
  readonly configured: boolean;
  readonly orgId: string | null;
  readonly summary: FleetSummary;
  readonly settings: FleetThresholds;
  readonly canManage: boolean;
  readonly basePath: string;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const money = (amount: number) => formatMinor(amount, 'YER', { locale });
  const router = useRouter();

  const [remindKm, setRemindKm] = useState(String(settings.remindKm));
  const [remindDays, setRemindDays] = useState(String(settings.remindDays));
  const [anomaly, setAnomaly] = useState(String(settings.fuelAnomalyPercent));
  const [blockOverdue, setBlockOverdue] = useState(settings.blockOverdueAssignment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const exportHref = `/api/fleet/export?locale=${locale}${orgId ? `&org=${orgId}` : ''}`;

  async function saveSettings() {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await client.call(fleetCommandSpec, {
      action: 'fleet.settings',
      orgId,
      remindKm: Number(remindKm) || 0,
      remindDays: Number(remindDays) || 0,
      blockOverdueAssignment: blockOverdue,
      fuelAnomalyPercent: Number(anomaly) || 0,
    } as never);
    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code as never)));
      return;
    }
    setMessage(t('fleetOps.settingsSaved'));
    router.refresh();
  }

  const { totals } = summary;

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

      <section className="fleet-section" aria-labelledby="fleet-rollup-heading">
        <div className="fleet-toolbar">
          <h2 id="fleet-rollup-heading">{t('fleetOps.rollup')}</h2>
          <a className="ui-btn ui-btn--subtle ui-btn--sm" href={exportHref}>
            {t('fleetOps.exportFleet')}
          </a>
        </div>

        <dl className="fleet-stats">
          <div>
            <dt>{t('fleetOps.activeVehicles')}</dt>
            <dd>
              {formatNumber(totals.active, { locale })}
              <span className="fleet-stat-suffix">
                {' '}
                / {formatNumber(totals.vehicles, { locale })}
              </span>
            </dd>
          </div>
          <div>
            <dt>{t('fleetOps.dueSoonVehicles')}</dt>
            <dd>{formatNumber(totals.dueSoon, { locale })}</dd>
          </div>
          <div>
            <dt>{t('fleetOps.overdueVehicles')}</dt>
            <dd>{formatNumber(totals.overdue, { locale })}</dd>
          </div>
          <div>
            <dt>{t('fleetOps.monthFuel')}</dt>
            <dd>{money(totals.monthFuelYer)}</dd>
          </div>
          <div>
            <dt>{t('fleetOps.monthMaintenance')}</dt>
            <dd>{money(totals.monthMaintenanceYer)}</dd>
          </div>
        </dl>
        <p className="fleet-hint">{t('fleetOps.totalsHint')}</p>

        {summary.vehicles.length === 0 ? (
          <EmptyState title={t('fleetOps.noVehicles')} description={t('fleetOps.odometerHint')} />
        ) : (
          <div className="table-scroll">
            <table className="fleet-grid">
              <thead>
                <tr>
                  <th scope="col">{t('ops.vehicle')}</th>
                  <th scope="col">{t('fleet.odometerKm')}</th>
                  <th scope="col">{t('fleetOps.consumption')}</th>
                  <th scope="col">{t('ops.verification')}</th>
                  <th scope="col">{t('fleetOps.monthFuel')}</th>
                  <th scope="col">{t('fleetOps.monthMaintenance')}</th>
                  <th scope="col">{t('ops.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {summary.vehicles.map((row) => {
                  return (
                    <tr key={row.id}>
                      <th scope="row">
                        <span className="fleet-plate">{row.plateNumber}</span>
                        <span className="fleet-model">
                          {row.make} {row.model}
                        </span>
                        <Badge tone={TONE[row.maintenanceState]}>
                          {t(MAINTENANCE_STATE_KEY[row.maintenanceState] ?? 'fleetOps.stateOk')}
                        </Badge>
                      </th>
                      <td>{formatNumber(row.odometerKm, { locale })}</td>
                      <td>
                        {row.recentLPer100Km == null
                          ? t('fleetOps.noData')
                          : t('fleetOps.per100', {
                              value: formatNumber(row.recentLPer100Km, { locale }),
                            })}
                      </td>
                      <td>
                        {row.nextDueKm != null
                          ? t('fleetOps.nextDue', {
                              due: t('fleetOps.dueAtKm', {
                                km: formatNumber(row.nextDueKm, { locale }),
                              }),
                            })
                          : row.nextDueOn
                            ? t('fleetOps.nextDue', { due: row.nextDueOn })
                            : t('fleetOps.noData')}
                      </td>
                      <td>{money(row.monthFuelYer)}</td>
                      <td>{money(row.monthMaintenanceYer)}</td>
                      <td>
                        <a
                          className="ui-btn ui-btn--ghost ui-btn--sm"
                          href={`${basePath}/vehicles/${row.id}/health`}
                        >
                          {t('fleetOps.openHealth')}
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canManage ? (
        <section className="fleet-section" aria-labelledby="fleet-settings-heading">
          <h2 id="fleet-settings-heading">{t('fleetOps.settings')}</h2>
          <p className="fleet-hint">{t('fleetOps.settingsHint')}</p>
          <div className="fleet-fields">
            <Field
              label={t('fleetOps.remindKm')}
              type="number"
              min={0}
              max={50000}
              value={remindKm}
              onChange={(event) => setRemindKm(event.target.value)}
            />
            <Field
              label={t('fleetOps.remindDays')}
              type="number"
              min={0}
              max={365}
              value={remindDays}
              onChange={(event) => setRemindDays(event.target.value)}
            />
            <Field
              label={t('fleetOps.fuelAnomaly')}
              type="number"
              min={0}
              max={200}
              value={anomaly}
              onChange={(event) => setAnomaly(event.target.value)}
            />
            <label className="fleet-check">
              <input
                type="checkbox"
                checked={blockOverdue}
                onChange={(event) => setBlockOverdue(event.target.checked)}
              />
              <span>{t('fleetOps.blockOverdue')}</span>
            </label>
          </div>
          <p className="fleet-hint">{t('fleetOps.blockOverdueHint')}</p>
          <Button loading={busy} disabled={busy} onClick={() => void saveSettings()}>
            {t('fleetOps.saveSettings')}
          </Button>
        </section>
      ) : null}
    </div>
  );
}
