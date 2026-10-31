'use client';

import { useMemo, useState } from 'react';
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

/** `YYYY-MM-DD` in Aden, matching how the server reads a day. */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Aden' }).format(new Date());
}

function firstOfMonth(): string {
  return `${today().slice(0, 8)}01`;
}

const TONE: Record<MaintenanceState, BadgeTone> = {
  ok: 'success',
  due_soon: 'warning',
  overdue: 'danger',
};

/**
 * The order a fleet manager reads in: what is broken, what is about to break, then the rest. Applied to
 * the rows the server already returned — this is presentation, and the totals above it stay the totals
 * of the whole fleet no matter which tab is open.
 */
const SEVERITY: Record<MaintenanceState, number> = { overdue: 0, due_soon: 1, ok: 2 };

type FilterKey = 'all' | MaintenanceState;

const FILTERS: readonly FilterKey[] = ['all', 'overdue', 'due_soon', 'ok'];

const FILTER_LABEL: Record<FilterKey, TranslationKey> = {
  all: 'fleetOps.filterAll',
  overdue: 'fleetOps.stateOverdue',
  due_soon: 'fleetOps.stateDueSoon',
  ok: 'fleetOps.stateOk',
};

/**
 * The fleet at a glance, and the two things an owner does from it.
 *
 * The rollup is read-only by construction — it is `get_fleet_summary`, the same function the trip gate
 * and the reminder job read — so "reconciles with the logs" is a property of the query, not of this
 * component. What this file adds is the drill-down, the export, the filter, and the thresholds the whole
 * feature behaves according to.
 *
 * Responsive by reflow, not by hiding: above 720px the fleet is a table with aligned numeric columns;
 * below it the same rows become cards with `data-label` naming each value, so a phone never has to
 * scroll sideways to read one vehicle. The markup is a single table element either way.
 */
export function FleetRollup({
  locale,
  configured,
  orgId,
  summary,
  settings,
  canManage,
  basePath,
  reportAllowed,
}: {
  readonly locale: Locale;
  readonly configured: boolean;
  readonly orgId: string | null;
  readonly summary: FleetSummary;
  readonly settings: FleetThresholds;
  readonly canManage: boolean;
  readonly basePath: string;
  readonly reportAllowed: boolean;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const money = (amount: number) => formatMinor(amount, 'YER', { locale });
  const router = useRouter();

  const [rangeFrom, setRangeFrom] = useState(firstOfMonth());
  const [rangeTo, setRangeTo] = useState(today());
  const [remindKm, setRemindKm] = useState(String(settings.remindKm));
  const [remindDays, setRemindDays] = useState(String(settings.remindDays));
  const [anomaly, setAnomaly] = useState(String(settings.fuelAnomalyPercent));
  const [blockOverdue, setBlockOverdue] = useState(settings.blockOverdueAssignment);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const exportHref = `/api/fleet/export?locale=${locale}${orgId ? `&org=${orgId}` : ''}`;
  const reportHref = `/${locale}/operator/fleet/report${orgId ? `?org=${orgId}` : ''}`;

  const { totals } = summary;

  const counts = useMemo(() => {
    const row: Record<FilterKey, number> = {
      all: summary.vehicles.length,
      overdue: 0,
      due_soon: 0,
      ok: 0,
    };
    for (const vehicle of summary.vehicles) row[vehicle.maintenanceState] += 1;
    return row;
  }, [summary.vehicles]);

  const rows = useMemo(() => {
    const sorted = [...summary.vehicles].sort(
      (a, b) =>
        SEVERITY[a.maintenanceState] - SEVERITY[b.maintenanceState] ||
        a.plateNumber.localeCompare(b.plateNumber, locale),
    );
    return filter === 'all' ? sorted : sorted.filter((row) => row.maintenanceState === filter);
  }, [summary.vehicles, filter, locale]);

  const needsAttention = totals.overdue + totals.dueSoon;

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
        <div className="fleet-head">
          <div className="fleet-head__text">
            <h2 id="fleet-rollup-heading">{t('fleetOps.rollup')}</h2>
            <p className="fleet-hint">{t('fleetOps.totalsHint')}</p>
          </div>
          <div className="fleet-head__actions">
            <a className="ui-btn ui-btn--subtle ui-btn--sm" href={exportHref}>
              {t('fleetOps.exportFleet')}
            </a>
            {/* Shown either way: a Pro feature you cannot see is a feature nobody buys. The route is what
                actually refuses, and the hint below says why — a disabled button explains nothing. */}
            <a
              className="ui-btn ui-btn--ghost ui-btn--sm"
              href={reportHref}
              aria-describedby={reportAllowed ? undefined : 'fleet-report-locked'}
            >
              {t('fleetOps.report')}
            </a>
          </div>
        </div>

        {reportAllowed ? null : (
          <p className="fleet-hint" id="fleet-report-locked">
            {t('fleetOps.reportLocked')}
          </p>
        )}

        <dl className="fleet-stats">
          <div className="fleet-stat" data-tone="brand">
            <dt>{t('fleetOps.activeVehicles')}</dt>
            <dd>
              {formatNumber(totals.active, { locale })}
              <span className="fleet-stat-suffix">
                {' '}
                / {formatNumber(totals.vehicles, { locale })}
              </span>
            </dd>
          </div>
          <div className="fleet-stat" data-tone={totals.overdue > 0 ? 'danger' : 'ok'}>
            <dt>{t('fleetOps.overdueVehicles')}</dt>
            <dd>{formatNumber(totals.overdue, { locale })}</dd>
          </div>
          <div className="fleet-stat" data-tone={totals.dueSoon > 0 ? 'warning' : 'ok'}>
            <dt>{t('fleetOps.dueSoonVehicles')}</dt>
            <dd>{formatNumber(totals.dueSoon, { locale })}</dd>
          </div>
          {/* Money gets the widest cards: it is the number an owner reads twice. */}
          <div className="fleet-stat fleet-stat--money">
            <dt>{t('fleetOps.monthFuel')}</dt>
            <dd>{money(totals.monthFuelYer)}</dd>
          </div>
          <div className="fleet-stat fleet-stat--money">
            <dt>{t('fleetOps.monthMaintenance')}</dt>
            <dd>{money(totals.monthMaintenanceYer)}</dd>
          </div>
        </dl>

        <p className="fleet-callout" data-tone={totals.overdue > 0 ? 'danger' : 'warning'}>
          {needsAttention > 0
            ? t('fleetOps.attention', { count: formatNumber(needsAttention, { locale }) })
            : t('fleetOps.allClear')}
        </p>
      </section>

      <section className="fleet-section" aria-labelledby="fleet-list-heading">
        <div className="fleet-list__head">
          <h2 id="fleet-list-heading">{t('fleetOps.listTitle')}</h2>
          {summary.vehicles.length > 0 ? (
            <div className="fleet-filters" role="group" aria-label={t('fleetOps.filterLabel')}>
              {FILTERS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className="fleet-filter"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                >
                  {t(FILTER_LABEL[key])}
                  <span className="fleet-filter__count">
                    {formatNumber(counts[key], { locale })}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {summary.vehicles.length === 0 ? (
          <EmptyState title={t('fleetOps.noVehicles')} description={t('fleetOps.odometerHint')} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t('fleetOps.filterEmptyTitle')}
            description={t('fleetOps.filterEmptyBody')}
            action={
              <Button variant="subtle" onClick={() => setFilter('all')}>
                {t('fleetOps.filterAll')}
              </Button>
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="fleet-ledger fleet-ledger--cards">
              <thead>
                <tr>
                  <th scope="col">{t('ops.vehicle')}</th>
                  <th scope="col">{t('fleet.odometerKm')}</th>
                  <th scope="col">{t('fleetOps.consumption')}</th>
                  <th scope="col">{t('fleetOps.dueKm')}</th>
                  <th scope="col">{t('fleetOps.monthCost')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('ops.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      <span className="fleet-ledger__plate" dir="ltr">
                        {row.plateNumber}
                      </span>
                      <span className="fleet-model">
                        {row.make} {row.model}
                      </span>
                      <Badge tone={TONE[row.maintenanceState]}>
                        {t(MAINTENANCE_STATE_KEY[row.maintenanceState] ?? 'fleetOps.stateOk')}
                      </Badge>
                    </th>
                    {/* One wrapper per cell: the label is drawn by `::before`, so the value has to be a
                        single grid item or its second line drifts under the label on a phone. */}
                    <td data-label={t('fleet.odometerKm')}>
                      <span className="fleet-cell">{formatNumber(row.odometerKm, { locale })}</span>
                    </td>
                    <td data-label={t('fleetOps.consumption')}>
                      <span className="fleet-cell">
                        {row.recentLPer100Km == null
                          ? t('fleetOps.noData')
                          : t('fleetOps.per100', {
                              value: formatNumber(row.recentLPer100Km, { locale }),
                            })}
                        {row.recentKmPerLitre == null ? null : (
                          <span className="fleet-model">
                            {t('fleetOps.kmPerLitre', {
                              value: formatNumber(row.recentKmPerLitre, { locale }),
                            })}
                          </span>
                        )}
                      </span>
                    </td>
                    <td data-label={t('fleetOps.dueKm')}>
                      <span className="fleet-cell">
                        {row.nextDueKm != null
                          ? t('fleetOps.dueAtKm', { km: formatNumber(row.nextDueKm, { locale }) })
                          : row.nextDueOn
                            ? row.nextDueOn
                            : t('fleetOps.noData')}
                      </span>
                    </td>
                    <td data-label={t('fleetOps.monthCost')}>
                      <span className="fleet-cell">
                        <span className="fleet-cost">
                          <span className="fleet-cost__label">{t('fleetOps.monthFuel')}</span>
                          {money(row.monthFuelYer)}
                        </span>
                        <span className="fleet-cost">
                          <span className="fleet-cost__label">
                            {t('fleetOps.monthMaintenance')}
                          </span>
                          {money(row.monthMaintenanceYer)}
                        </span>
                      </span>
                    </td>
                    <td className="fleet-ledger__actions">
                      <a
                        className="ui-btn ui-btn--ghost ui-btn--sm"
                        href={`${basePath}/vehicles/${row.id}/health`}
                      >
                        {t('fleetOps.openHealth')}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="fleet-section" aria-labelledby="fleet-costs-heading">
        <h2 id="fleet-costs-heading">{t('fleetOps.exportRange')}</h2>
        <p className="fleet-hint">{t('fleetOps.exportRangeHint')}</p>
        {/* A plain GET form: the export is a URL, and a URL an auditor can paste into an email is worth
            more than a client-side download that only works while the tab is open. */}
        <form className="fleet-range" method="get" action="/api/fleet/export">
          <input type="hidden" name="kind" value="detail" />
          <input type="hidden" name="locale" value={locale} />
          {orgId ? <input type="hidden" name="org" value={orgId} /> : null}
          <div className="fleet-range__fields">
            <Field
              label={t('fleetOps.from')}
              type="date"
              value={rangeFrom}
              onChange={(event) => setRangeFrom(event.target.value)}
              name="from"
            />
            <Field
              label={t('fleetOps.to')}
              type="date"
              value={rangeTo}
              onChange={(event) => setRangeTo(event.target.value)}
              name="to"
            />
          </div>
          <Button type="submit" variant="subtle">
            {t('fleetOps.exportFleet')}
          </Button>
        </form>
      </section>

      {canManage ? (
        <section className="fleet-section" aria-labelledby="fleet-settings-heading">
          <h2 id="fleet-settings-heading">{t('fleetOps.settings')}</h2>
          <p className="fleet-hint">{t('fleetOps.settingsHint')}</p>
          <div className="fleet-settings">
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
            <label className="fleet-check fleet-check--card">
              <input
                type="checkbox"
                checked={blockOverdue}
                onChange={(event) => setBlockOverdue(event.target.checked)}
              />
              <span>
                <strong>{t('fleetOps.blockOverdue')}</strong>
                <span className="fleet-hint">{t('fleetOps.blockOverdueHint')}</span>
              </span>
            </label>
          </div>
          <div className="fleet-settings__foot">
            <Button loading={busy} disabled={busy} onClick={() => void saveSettings()}>
              {t('fleetOps.saveSettings')}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
