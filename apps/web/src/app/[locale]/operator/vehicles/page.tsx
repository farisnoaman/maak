import { notFound, redirect } from 'next/navigation';
import { translate, isLocale, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { VehicleCard, publicPhotoUrl } from '@/components/fleet/VehicleCard';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import { loadFleet } from '@/lib/fleet';

export default async function OperatorVehiclesPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/vehicles`);
  }

  const query = await searchParams;
  const org = loaded.configured
    ? activeOrganization(loaded, typeof query.org === 'string' ? query.org : undefined)
    : null;
  const fleet = await loadFleet(loaded);
  const verified = loaded.profile?.verificationStatus === 'verified';

  // One vehicle may be owned personally or by the organization in scope; the list shows the selected
  // context, which is what the operator chose in the URL.
  const vehicles = fleet.vehicles.filter((vehicle) =>
    org ? vehicle.ownerOrgId === org.id : vehicle.ownerUserId === loaded.user?.id,
  );
  const assignments = new Map(fleet.assignments.map((row) => [row.vehicleId, row.driverName]));
  const primaryPhotos = new Map(
    fleet.photos
      .filter((photo) => photo.isPrimary)
      .map((photo) => [photo.vehicleId, photo.storagePath]),
  );

  const nav = [
    { key: 'console.navOverview' as TranslationKey, href: `/${locale}/operator` },
    { key: 'console.navVehicles' as TranslationKey, href: `/${locale}/operator/vehicles` },

    { key: 'console.navFleet' as TranslationKey, href: `/${locale}/operator/fleet` },
    { key: 'console.navDrivers' as TranslationKey, href: `/${locale}/operator/drivers` },
    { key: 'org.team' as TranslationKey, href: `/${locale}/operator/team` },
  ];

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/vehicles" />
      <ConsoleShell
        consoleTitle="console.operator"
        pathname="/operator/vehicles"
        locale={locale}
        title="fleet.vehicles"
        subtitle="console.subtitle.operator"
        items={nav}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        <div className="fleet-toolbar">
          <p>
            {t('fleet.vehicleCount', { count: vehicles.length })}
            {org ? ` · ${org.name}` : ` · ${t('fleet.personalOwner')}`}
          </p>
          {/* The console works on one context at a time. Without a way back, an owner who has both a
              personal vehicle and a company would think one of them had disappeared. */}
          {loaded.organizations.filter((row) => row.status === 'active').length > 0 ? (
            <nav className="fleet-context" aria-label={t('fleet.context')}>
              <a href={`/${locale}/operator/vehicles`} aria-current={org ? undefined : 'page'}>
                {t('fleet.personalOwner')}
              </a>
              {loaded.organizations
                .filter((row) => row.status === 'active')
                .map((row) => (
                  <a
                    key={row.id}
                    href={`/${locale}/operator/vehicles?org=${row.id}`}
                    aria-current={org?.id === row.id ? 'page' : undefined}
                  >
                    {row.name}
                  </a>
                ))}
            </nav>
          ) : null}
          {verified || !loaded.configured ? (
            <a
              className="btn btn--primary"
              href={`/${locale}/operator/vehicles/new${org ? `?org=${org.id}` : ''}`}
            >
              {t('fleet.addVehicle')}
            </a>
          ) : (
            <span className="fleet-note">{t('fleet.requiresVerification')}</span>
          )}
        </div>

        {vehicles.length === 0 ? (
          <EmptyState
            title={t('fleet.noVehicles')}
            description={t('fleet.requiresVerification')}
            action={
              <a className="btn btn--primary" href={`/${locale}/operator/vehicles/new`}>
                {t('fleet.addVehicle')}
              </a>
            }
          />
        ) : (
          <div className="fleet-grid">
            {vehicles.map((vehicle) => (
              <VehicleCard
                key={vehicle.id}
                locale={locale}
                vehicle={vehicle}
                photoUrl={
                  primaryPhotos.has(vehicle.id)
                    ? publicPhotoUrl(primaryPhotos.get(vehicle.id)!)
                    : null
                }
                driverName={assignments.get(vehicle.id) ?? null}
              />
            ))}
          </div>
        )}
      </ConsoleShell>
    </>
  );
}
