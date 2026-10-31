import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { DriverConsole } from '@/components/fleet/DriverConsole';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import { signedObjectUrl } from '@/lib/storage';
import { loadFleet } from '@/lib/fleet';

export default async function OperatorDriversPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/drivers`);
  }

  const query = await searchParams;
  const org = loaded.configured
    ? activeOrganization(loaded, typeof query.org === 'string' ? query.org : undefined)
    : null;
  const fleet = await loadFleet(loaded);
  const verified = !loaded.configured || loaded.profile?.verificationStatus === 'verified';

  const drivers = fleet.drivers.filter((driver) =>
    org ? driver.orgId === org.id : driver.orgId === null,
  );
  const vehicleNames = new Map<string, string>();
  for (const vehicle of fleet.vehicles) {
    vehicleNames.set(vehicle.id, `${vehicle.make} ${vehicle.model} · ${vehicle.plateNumber}`);
  }
  const assignedByDriver = new Map(fleet.assignments.map((row) => [row.driverId, row.vehicleId]));

  const vehiclesInScope = fleet.vehicles.filter((vehicle) =>
    org ? vehicle.ownerOrgId === org.id : vehicle.ownerUserId === loaded.user?.id,
  );

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/drivers" />
      <ConsoleShell
        locale={locale}
        title="fleet.drivers"
        subtitle="console.subtitle.operator"
        phase="3"
        items={[
          { key: 'console.navOverview', href: `/${locale}/operator` },
          { key: 'console.navVehicles', href: `/${locale}/operator/vehicles` },
          { key: 'console.navFleet', href: `/${locale}/operator/fleet` },
          { key: 'console.navDrivers', href: `/${locale}/operator/drivers` },
          { key: 'org.team', href: `/${locale}/operator/team` },
        ]}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}
        <div className="fleet-toolbar">
          <p className="fleet-hint">
            {t('fleet.driverCount', { count: drivers.length })}
            {org ? ` · ${org.name}` : ` · ${t('fleet.personalOwner')}`}
          </p>
          {loaded.organizations.filter((row) => row.status === 'active').length > 0 ? (
            <nav className="fleet-context" aria-label={t('fleet.context')}>
              <a href={`/${locale}/operator/drivers`} aria-current={org ? undefined : 'page'}>
                {t('fleet.personalOwner')}
              </a>
              {loaded.organizations
                .filter((row) => row.status === 'active')
                .map((row) => (
                  <a
                    key={row.id}
                    href={`/${locale}/operator/drivers?org=${row.id}`}
                    aria-current={org?.id === row.id ? 'page' : undefined}
                  >
                    {row.name}
                  </a>
                ))}
            </nav>
          ) : null}
        </div>
        <DriverConsole
          locale={locale}
          configured={loaded.configured}
          orgId={org?.id ?? null}
          orgName={org?.name ?? null}
          canInvite={verified}
          vehicles={vehiclesInScope.map((vehicle) => ({
            id: vehicle.id,
            name: vehicleNames.get(vehicle.id) ?? vehicle.plateNumber,
          }))}
          drivers={await Promise.all(
            drivers.map(async (driver) => {
              const vehicleId = assignedByDriver.get(driver.id);
              return {
                id: driver.id,
                fullName: driver.fullName,
                phone: driver.phone,
                licenceNo: driver.licenceNo,
                licenceExpiry: driver.licenceExpiry,
                licencePhotoUrl: driver.licencePhotoPath
                  ? await signedObjectUrl('driver-documents', driver.licencePhotoPath)
                  : null,
                status: driver.status,
                verificationStatus: driver.verificationStatus,
                vehicleName: vehicleId ? (vehicleNames.get(vehicleId) ?? null) : null,
              };
            }),
          )}
        />
      </ConsoleShell>
    </>
  );
}
