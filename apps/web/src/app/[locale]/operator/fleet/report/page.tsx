import { notFound, redirect } from 'next/navigation';
import {
  formatDateTime,
  formatMinor,
  formatNumber,
  isLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { PrintButton } from '@/components/staff/PrintButton';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import { loadFleetSummary, loadReportAccess } from '@/lib/fleet-ops';

const STATE_LABEL: Record<string, TranslationKey> = {
  ok: 'fleetOps.stateOk',
  due_soon: 'fleetOps.stateDueSoon',
  overdue: 'fleetOps.stateOverdue',
};

/**
 * `/operator/fleet/report` — the fleet on one A4 sheet.
 *
 * Print CSS rather than a PDF binary, the same trade-off Phase 7 argued for the manifest: one layout, no
 * font pipeline, and the browser embeds the Arabic face it already rendered. The numbers come from
 * `fleet_summary` — the same read the dashboard uses — so a printed sheet cannot disagree with the screen
 * it was printed from.
 *
 * The plan check is *here*, before a single row is rendered, and again inside `fleet_summary` for the
 * `reportsAllowed` flags: a feature that is only hidden in the UI is not gated.
 */
export default async function FleetReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const money = (amount: number) => formatMinor(amount, 'YER', { locale, numerals: 'western' });

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/fleet/report`);
  }

  const query = await searchParams;
  const org = loaded.configured
    ? activeOrganization(loaded, typeof query.org === 'string' ? query.org : undefined)
    : null;

  const [access, summary] = await Promise.all([
    loadReportAccess(loaded, org?.id ?? null),
    loadFleetSummary(loaded, org?.id ?? null),
  ]);

  const nav = [
    { key: 'console.navOverview' as TranslationKey, href: `/${locale}/operator` },
    { key: 'console.navVehicles' as TranslationKey, href: `/${locale}/operator/vehicles` },
    { key: 'console.navFleet' as TranslationKey, href: `/${locale}/operator/fleet` },
    { key: 'console.navDrivers' as TranslationKey, href: `/${locale}/operator/drivers` },
  ];

  if (!access.allowed) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/operator/fleet" />
        <ConsoleShell
          consoleTitle="console.operator"
          pathname="/operator/fleet"
          locale={locale}
          title="fleetOps.report"
          subtitle="fleetOps.fleetSubtitle"
          items={nav}
        >
          <EmptyState
            title={t('fleetOps.reportLocked')}
            description={t('fleetOps.reportHint')}
            action={
              <a className="ui-btn ui-btn--subtle" href={`/${locale}/operator/fleet`}>
                {t('fleetOps.backToFleet')}
              </a>
            }
          />
        </ConsoleShell>
      </>
    );
  }

  const { totals, vehicles } = summary;

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/fleet" />
      <ConsoleShell
        locale={locale}
        title="fleetOps.report"
        subtitle="fleetOps.reportHint"
        items={nav}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        <div className="fleet-toolbar no-print">
          <p>
            <a href={`/${locale}/operator/fleet`}>← {t('fleetOps.backToFleet')}</a>
          </p>
          <PrintButton label={t('fleetOps.print')} />
        </div>

        <article className="manifest__sheet fleet-report" aria-labelledby="report-title">
          <header className="manifest__head">
            <div>
              <p className="manifest__eyebrow">
                {org ? org.name : t('fleet.personalOwner')} · {access.plan.toUpperCase()}
              </p>
              {/* An `h2`: the shell already owns the page's h1, and a printed sheet does not care about
                  the level — the guard is right that two h1s means two documents. */}
              <h2 id="report-title">{t('fleetOps.reportTitle')}</h2>
              <p className="manifest__route">
                {t('fleetOps.vehiclesCount', { count: vehicles.length })}
              </p>
            </div>
            <p className="manifest__meta">
              {t('fleetOps.reportGenerated', {
                when: formatDateTime(new Date().toISOString(), { locale }),
              })}
            </p>
          </header>

          <dl className="fleet-report__totals">
            <div>
              <dt>{t('fleetOps.activeVehicles')}</dt>
              <dd>
                {formatNumber(totals.active, { locale })} /{' '}
                {formatNumber(totals.vehicles, { locale })}
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

          {/* Wrapped for the guard and for a narrow preview window; print CSS drops the wrapper. */}
          <div className="table-scroll">
            <table className="manifest__table">
              <thead>
                <tr>
                  <th scope="col">{t('ops.vehicle')}</th>
                  <th scope="col">{t('fleet.odometerKm')}</th>
                  <th scope="col">{t('fleetOps.consumption')}</th>
                  <th scope="col">{t('fleetOps.stateOk')}</th>
                  <th scope="col">{t('fleetOps.dueKm')}</th>
                  <th scope="col">{t('fleetOps.monthFuel')}</th>
                  <th scope="col">{t('fleetOps.monthMaintenance')}</th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.plateNumber} · {row.make} {row.model}
                    </td>
                    <td>{formatNumber(row.odometerKm, { locale })}</td>
                    <td>
                      {row.recentLPer100Km == null
                        ? t('fleetOps.noData')
                        : t('fleetOps.per100', {
                            value: formatNumber(row.recentLPer100Km, { locale }),
                          })}
                    </td>
                    <td>{t(STATE_LABEL[row.maintenanceState] ?? 'fleetOps.stateOk')}</td>
                    <td>
                      {row.nextDueKm != null
                        ? t('fleetOps.dueAtKm', { km: formatNumber(row.nextDueKm, { locale }) })
                        : (row.nextDueOn ?? t('fleetOps.noData'))}
                    </td>
                    <td>{money(row.monthFuelYer)}</td>
                    <td>{money(row.monthMaintenanceYer)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <footer className="manifest__foot">
            <span>{t('fleetOps.totalsHint')}</span>
            <span>{t('common.appName')}</span>
          </footer>
        </article>
      </ConsoleShell>
    </>
  );
}
