import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { FleetRollup } from '@/components/fleet/FleetRollup';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import { loadFleetSettings, loadFleetSummary, loadReportAccess } from '@/lib/fleet-ops';

/**
 * `/operator/fleet` — the rollup, and the thresholds behind it.
 *
 * Deliberately a separate screen from `/operator/vehicles`: that page is about *what the vehicle is*
 * (its specification, documents, photographs), this one is about *what it costs and what it needs*. An
 * owner looking for "which van is late for its oil change" should not have to read a seat count first.
 */
export default async function OperatorFleetPage({
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

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/fleet`);
  }

  const query = await searchParams;
  const org = loaded.configured
    ? activeOrganization(loaded, typeof query.org === 'string' ? query.org : undefined)
    : null;

  const summary = await loadFleetSummary(loaded, org?.id ?? null);
  const settings = await loadFleetSettings(org?.id ?? null, loaded.user?.id ?? null);
  const reportAccess = await loadReportAccess(loaded, org?.id ?? null);

  // Thresholds belong to the context: an individual owner sets their own, a company its own row.
  const canManage =
    org != null
      ? org.role === 'owner' || org.role === 'manager'
      : loaded.roles.includes('platform_staff') ||
        loaded.roles.includes('platform_admin') ||
        summary.vehicles.length > 0;

  const nav = [
    { key: 'console.navOverview' as TranslationKey, href: `/${locale}/operator` },
    { key: 'console.navVehicles' as TranslationKey, href: `/${locale}/operator/vehicles` },
    { key: 'console.navFleet' as TranslationKey, href: `/${locale}/operator/fleet` },
    { key: 'console.navDrivers' as TranslationKey, href: `/${locale}/operator/drivers` },
    { key: 'org.team' as TranslationKey, href: `/${locale}/operator/team` },
  ];

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/fleet" />
      <ConsoleShell
        consoleTitle="console.operator"
        pathname="/operator/fleet"
        locale={locale}
        title="fleetOps.fleet"
        subtitle="fleetOps.fleetSubtitle"
        items={nav}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        {/* The context bar, and the one number that answers "whose fleet am I looking at". Kept out of
            `FleetRollup` because it is a property of the screen, not of the rollup. */}
        <div className="fleet-page-head">
          <p className="fleet-page-head__count">
            {t('fleetOps.vehiclesCount', { count: summary.vehicles.length })}
            <span className="fleet-page-head__context">
              {org ? org.name : t('fleet.personalOwner')}
            </span>
          </p>
          {/* The console works on one context at a time (see `/operator/vehicles`), and the same rule
              applies here: thresholds are per context, so switching is a real switch, not a filter. */}
          {loaded.organizations.filter((row) => row.status === 'active').length > 0 ? (
            <nav className="fleet-context" aria-label={t('fleet.context')}>
              <a href={`/${locale}/operator/fleet`} aria-current={org ? undefined : 'page'}>
                {t('fleet.personalOwner')}
              </a>
              {loaded.organizations
                .filter((row) => row.status === 'active')
                .map((row) => (
                  <a
                    key={row.id}
                    href={`/${locale}/operator/fleet?org=${row.id}`}
                    aria-current={org?.id === row.id ? 'page' : undefined}
                  >
                    {row.name}
                  </a>
                ))}
            </nav>
          ) : null}
        </div>

        <FleetRollup
          locale={locale}
          configured={loaded.configured}
          orgId={org?.id ?? null}
          summary={summary}
          settings={settings}
          canManage={canManage}
          basePath={`/${locale}/operator`}
          reportAllowed={reportAccess.allowed}
        />
      </ConsoleShell>
    </>
  );
}
