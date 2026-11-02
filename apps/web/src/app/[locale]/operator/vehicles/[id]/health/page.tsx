import { notFound } from 'next/navigation';
import {
  MAINTENANCE_KIND_KEY,
  formatDate,
  formatMoney,
  formatNumber,
  isLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { Badge, EmptyState, type BadgeTone } from '@/components/ui/Feedback';
import { HealthActions } from '@/components/fleet/HealthActions';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import {
  loadStations,
  loadVehicleHealth,
  type MaintenanceState,
  type VehicleHealth,
} from '@/lib/fleet-ops';

const TONE: Record<MaintenanceState, BadgeTone> = {
  ok: 'success',
  due_soon: 'warning',
  overdue: 'danger',
};

const STATE_KEY: Record<MaintenanceState, TranslationKey> = {
  ok: 'fleetOps.stateOk',
  due_soon: 'fleetOps.stateDueSoon',
  overdue: 'fleetOps.stateOverdue',
};

/**
 * `/operator/vehicles/[id]/health` — one vehicle, everything Phase 8 knows about it.
 *
 * Server-rendered down to the tables and the badges, with only the four write forms in a client island.
 * The distinction matters for what the page promises: the state a driver sees here is the one
 * `recompute_maintenance_status` stored, which is the same row the trip gate reads before it lets the van
 * out — the page cannot show "OK" while the gate refuses.
 */
export default async function VehicleHealthPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: raw, id } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const money = (amount: number) =>
    formatMoney({ amountMinor: amount, currency: 'YER' }, { locale });

  const loaded = await loadAccountContext();
  const query = await searchParams;
  const org = loaded.configured
    ? activeOrganization(loaded, typeof query.org === 'string' ? query.org : undefined)
    : null;

  const health = await loadVehicleHealth(id);
  if (loaded.configured && !health) notFound();
  const stations = await loadStations();

  // A preview visitor gets a shape, not a 404: the preview environment exists to show the screen.
  const preview: VehicleHealth = health ?? {
    vehicle: {
      id,
      ownerUserId: null,
      ownerOrgId: null,
      make: 'Toyota',
      model: 'Hiace',
      plateNumber: '5-9001',
      fuelType: 'diesel',
      tankLitres: 70,
      odometerKm: 125_300,
      status: 'active',
      verificationStatus: 'verified',
    },
    maintenance: {
      state: 'overdue' as MaintenanceState,
      nextDueKm: 125_000,
      nextDueOn: null,
      dueCount: 0,
      overdueCount: 1,
      computedAt: null,
      schedules: [],
      recentRecords: [],
    },
    fuel: {
      lastLog: null,
      recentLPer100Km: 8.44,
      recentKmPerLitre: 11.84,
      lifetimeLPer100Km: 8.44,
      lifetimeKmPerLitre: 11.84,
      lifetimeCostYer: 57_000,
      lifetimeDistanceKm: 675_000,
      costPerKmYer: 42.22,
      segments: [],
      monthly: [],
      byTrip: [],
    },
    expenses: { monthTotalYer: 42_500, byCategory: {} },
    reports: { plan: 'pro', allowed: true, csv: true },
    thresholds: {
      remindKm: 500,
      remindDays: 14,
      blockOverdueAssignment: false,
      fuelAnomalyPercent: 25,
    },
  };

  // Closing a schedule is the owner's decision (the SQL refuses anybody else), so the buttons appear
  // only for the people the command would actually accept: staff, or the owner of this vehicle.
  const isStaff =
    loaded.roles.includes('platform_staff') || loaded.roles.includes('platform_admin');
  const canManage =
    isStaff ||
    (preview.vehicle.ownerUserId != null && preview.vehicle.ownerUserId === loaded.user?.id) ||
    (org != null &&
      preview.vehicle.ownerOrgId === org.id &&
      (org.role === 'owner' || org.role === 'manager'));

  const nav = [
    { key: 'console.navOverview' as TranslationKey, href: `/${locale}/operator` },
    { key: 'console.navVehicles' as TranslationKey, href: `/${locale}/operator/vehicles` },
    { key: 'console.navFleet' as TranslationKey, href: `/${locale}/operator/fleet` },
    { key: 'console.navDrivers' as TranslationKey, href: `/${locale}/operator/drivers` },
  ];

  const { vehicle, maintenance, fuel, expenses } = preview;
  const state = maintenance.state;

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/fleet" />
      <ConsoleShell
        consoleTitle="console.operator"
        pathname="/operator/fleet"
        locale={locale}
        title="fleetOps.healthTitle"
        subtitle="fleetOps.healthSubtitle"
        items={nav}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        <div className="fleet-toolbar">
          <p>
            <a href={`/${locale}/operator/fleet`}>← {t('fleetOps.backToFleet')}</a>
          </p>
          {/* The CSV is everybody's; the A4 report is Pro/Business. The route re-checks with the same
              function, so hiding this link is a courtesy, not the gate. */}
          {preview.reports.allowed ? (
            <a
              className="ui-btn ui-btn--subtle ui-btn--sm"
              href={`/${locale}/operator/fleet/report${org ? `?org=${org.id}` : ''}`}
            >
              {t('fleetOps.reportOpen')}
            </a>
          ) : (
            <p className="fleet-hint">{t('fleetOps.reportLocked')}</p>
          )}
        </div>

        <section className="fleet-section" aria-labelledby="health-heading">
          <h2 id="health-heading">
            {vehicle.make} {vehicle.model} ·{' '}
            <span className="fleet-plate">{vehicle.plateNumber}</span>{' '}
            <Badge tone={TONE[state]}>{t(STATE_KEY[state])}</Badge>
          </h2>
          <dl className="fleet-stats">
            <div>
              <dt>{t('fleetOps.odometerNow')}</dt>
              <dd>{formatNumber(vehicle.odometerKm, { locale })}</dd>
            </div>
            <div>
              <dt>{t('fleetOps.consumption')}</dt>
              <dd>
                {fuel.recentLPer100Km == null
                  ? t('fleetOps.noData')
                  : t('fleetOps.per100', {
                      value: formatNumber(fuel.recentLPer100Km, { locale }),
                    })}
              </dd>
            </div>
            <div>
              <dt>{t('fleetOps.kmPerLitreShort')}</dt>
              <dd>
                {fuel.recentKmPerLitre == null
                  ? t('fleetOps.noData')
                  : t('fleetOps.kmPerLitre', {
                      value: formatNumber(fuel.recentKmPerLitre, { locale }),
                    })}
              </dd>
            </div>
            <div>
              <dt>{t('fleetOps.costPerKm')}</dt>
              <dd>{fuel.costPerKmYer == null ? t('fleetOps.noData') : money(fuel.costPerKmYer)}</dd>
            </div>
            <div>
              <dt>{t('fleetOps.monthCost')}</dt>
              <dd>{money(expenses.monthTotalYer)}</dd>
            </div>
            <div>
              <dt>{t('fleetOps.lifetime')}</dt>
              <dd>
                {fuel.lifetimeLPer100Km == null
                  ? t('fleetOps.noData')
                  : t('fleetOps.lifetimeValue', {
                      value: formatNumber(fuel.lifetimeLPer100Km, { locale }),
                      km: formatNumber(fuel.lifetimeDistanceKm, { locale }),
                    })}
              </dd>
            </div>
          </dl>
          <p className="fleet-hint">
            {maintenance.nextDueKm != null
              ? t('fleetOps.nextDue', {
                  due: t('fleetOps.dueAtKm', {
                    km: formatNumber(maintenance.nextDueKm, { locale }),
                  }),
                })
              : maintenance.nextDueOn
                ? t('fleetOps.nextDue', { due: maintenance.nextDueOn })
                : t('fleetOps.noSchedules')}
          </p>
        </section>

        <HealthActions
          locale={locale}
          configured={loaded.configured}
          vehicleId={vehicle.id}
          health={preview}
          canManage={canManage}
          stations={stations}
        />

        <section className="fleet-section" aria-labelledby="health-monthly-heading">
          <h2 id="health-monthly-heading">{t('fleetOps.monthlyTrend')}</h2>
          <p className="fleet-hint">{t('fleetOps.monthlyHint')}</p>
          <div className="table-scroll">
            <table className="fleet-ledger">
              <thead>
                <tr>
                  <th scope="col">{t('fleetOps.month')}</th>
                  <th scope="col">{t('fleetOps.fills')}</th>
                  <th scope="col">{t('fleetOps.litres')}</th>
                  <th scope="col">{t('fleetOps.distance')}</th>
                  <th scope="col">{t('fleetOps.consumption')}</th>
                  <th scope="col">{t('fleetOps.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {fuel.monthly.map((month) => (
                  <tr key={month.monthStart}>
                    <th scope="row">{formatDate(month.monthStart, { locale })}</th>
                    <td>{formatNumber(month.fills, { locale })}</td>
                    <td>{formatNumber(month.litres, { locale })}</td>
                    <td>
                      {month.distanceKm == null
                        ? t('fleetOps.noData')
                        : formatNumber(month.distanceKm, { locale })}
                    </td>
                    <td>
                      {month.lPer100Km == null
                        ? t('fleetOps.noData')
                        : t('fleetOps.per100', {
                            value: formatNumber(month.lPer100Km, { locale }),
                          })}
                    </td>
                    <td>{money(month.costYer)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="fleet-section" aria-labelledby="health-trips-heading">
          <h2 id="health-trips-heading">{t('fleetOps.byTrip')}</h2>
          {fuel.byTrip.length === 0 ? (
            <EmptyState title={t('fleetOps.noTrips')} />
          ) : (
            <div className="table-scroll">
              <table className="fleet-ledger">
                <thead>
                  <tr>
                    <th scope="col">{t('ops.tripCode')}</th>
                    <th scope="col">{t('ops.departure')}</th>
                    <th scope="col">{t('fleetOps.distance')}</th>
                    <th scope="col">{t('fleetOps.litres')}</th>
                    <th scope="col">{t('fleetOps.consumption')}</th>
                    <th scope="col">{t('fleetOps.tripCost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {fuel.byTrip.map((trip) => (
                    <tr key={trip.tripId}>
                      <th scope="row">{trip.code}</th>
                      <td>{formatDate(trip.departureAt, { locale })}</td>
                      <td>
                        {trip.distanceKm == null
                          ? t('fleetOps.noData')
                          : formatNumber(trip.distanceKm, { locale })}
                      </td>
                      <td>{formatNumber(trip.litres, { locale })}</td>
                      <td>
                        {trip.lPer100Km == null
                          ? t('fleetOps.noData')
                          : t('fleetOps.per100', {
                              value: formatNumber(trip.lPer100Km, { locale }),
                            })}
                      </td>
                      <td>{money(trip.costYer)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="fleet-section" aria-labelledby="health-segments-heading">
          <h2 id="health-segments-heading">{t('fleetOps.segments')}</h2>
          {fuel.segments.length === 0 ? (
            <EmptyState title={t('fleetOps.noSegments')} />
          ) : (
            <div className="table-scroll">
              <table className="fleet-ledger">
                <thead>
                  <tr>
                    <th scope="col">{t('ops.departure')}</th>
                    <th scope="col">{t('fleetOps.distance')}</th>
                    <th scope="col">{t('fleetOps.litres')}</th>
                    <th scope="col">{t('fleetOps.consumption')}</th>
                    <th scope="col">{t('fleetOps.costPerKm')}</th>
                  </tr>
                </thead>
                <tbody>
                  {fuel.segments.map((segment) => (
                    <tr key={`${segment.fromKm}-${segment.toKm}`}>
                      <td>{formatDate(segment.filledAt, { locale })}</td>
                      <td>{formatNumber(segment.distanceKm, { locale })}</td>
                      <td>{formatNumber(segment.litres, { locale })}</td>
                      <td>
                        {segment.lPer100Km == null
                          ? t('fleetOps.noData')
                          : t('fleetOps.per100', {
                              value: formatNumber(segment.lPer100Km, { locale }),
                            })}
                      </td>
                      <td>
                        {segment.costPerKmYer == null
                          ? t('fleetOps.noData')
                          : money(segment.costPerKmYer)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="fleet-section" aria-labelledby="health-work-heading">
          <h2 id="health-work-heading">{t('fleetOps.recentWork')}</h2>
          {maintenance.recentRecords.length === 0 ? (
            <EmptyState title={t('fleetOps.noWork')} />
          ) : (
            <div className="table-scroll">
              <table className="fleet-ledger">
                <thead>
                  <tr>
                    <th scope="col">{t('fleetOps.kind')}</th>
                    <th scope="col">{t('fleetOps.lastDoneOn')}</th>
                    <th scope="col">{t('fleet.odometerKm')}</th>
                    <th scope="col">{t('fleetOps.vendor')}</th>
                    <th scope="col">{t('fleetOps.cost')}</th>
                    <th scope="col">{t('fleetOps.attachment')}</th>
                  </tr>
                </thead>
                <tbody>
                  {maintenance.recentRecords.map((record) => (
                    <tr key={record.id}>
                      <td>{t(MAINTENANCE_KIND_KEY[record.kind] ?? 'fleetOps.kind.other')}</td>
                      <td>{record.performedOn}</td>
                      <td>
                        {record.odometerKm == null
                          ? t('fleetOps.noData')
                          : formatNumber(record.odometerKm, { locale })}
                      </td>
                      <td>{record.vendor ?? t('fleetOps.noData')}</td>
                      <td>{money(record.costYer)}</td>
                      <td>
                        {record.attachmentPath ? (
                          <a
                            href={`/api/data/storage/v1/object/authenticated/vehicle-documents/${record.attachmentPath}`}
                          >
                            {t('fleetOps.viewAttachment')}
                          </a>
                        ) : (
                          t('fleetOps.noData')
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </ConsoleShell>
    </>
  );
}
