import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { VehicleDetail } from '@/components/fleet/VehicleDetail';
import { loadAccountContext } from '@/lib/account';
import { loadFleet, loadVehicle } from '@/lib/fleet';

export default async function VehicleDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: raw, id } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/vehicles/${id}`);
  }

  const preview = !loaded.configured;
  const fleet = await loadFleet(loaded);
  const detail = preview
    ? (() => {
        const vehicle = fleet.vehicles.find((row) => row.id === id) ?? fleet.vehicles[0];
        if (!vehicle) return null;
        return {
          vehicle,
          photos: fleet.photos,
          documents: fleet.documents,
          assignment: fleet.assignments[0] ?? null,
        };
      })()
    : await loadVehicle(id);

  // RLS already refuses a vehicle that is not the visitor's; this is the friendly half of that.
  if (!detail) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/operator/vehicles" />
        <ConsoleShell
          locale={locale}
          title="fleet.vehicles"
          subtitle="console.subtitle.operator"
          phase="3"
          items={[{ key: 'console.navVehicles', href: `/${locale}/operator/vehicles` }]}
        >
          <EmptyState title={t('errors.NOT_FOUND')} />
        </ConsoleShell>
      </>
    );
  }

  const verified = preview || loaded.profile?.verificationStatus === 'verified';
  const assignment = detail.assignment;

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/vehicles" />
      <ConsoleShell
        locale={locale}
        title="fleet.vehicles"
        subtitle="console.subtitle.operator"
        phase="3"
        items={[
          { key: 'console.navOverview', href: `/${locale}/operator` },
          { key: 'console.navVehicles', href: `/${locale}/operator/vehicles` },

          { key: 'console.navFleet', href: `/${locale}/operator/fleet` },
          { key: 'console.navDrivers', href: `/${locale}/operator/drivers` },
        ]}
      >
        {preview ? <PreviewBanner locale={locale} /> : null}
        <a className="btn btn--ghost" href={`/${locale}/operator/vehicles`}>
          {t('fleet.back')}
        </a>
        <VehicleDetail
          locale={locale}
          configured={loaded.configured}
          verified={verified}
          orgId={detail.vehicle.ownerOrgId}
          orgName={null}
          vehicle={detail.vehicle}
          photos={detail.photos.map((photo) => ({
            id: photo.id,
            storagePath: photo.storagePath,
            isPrimary: photo.isPrimary,
          }))}
          documents={detail.documents.map((document) => ({
            id: document.id,
            kind: document.kind,
            storagePath: document.storagePath,
          }))}
          driver={
            assignment
              ? {
                  id: assignment.driverId,
                  name: assignment.driverName,
                  verificationStatus:
                    fleet.drivers.find((driver) => driver.id === assignment.driverId)
                      ?.verificationStatus ?? 'unverified',
                }
              : null
          }
          drivers={fleet.drivers.map((driver) => ({
            id: driver.id,
            name: driver.fullName,
            verificationStatus: driver.verificationStatus,
          }))}
        />
      </ConsoleShell>
    </>
  );
}
