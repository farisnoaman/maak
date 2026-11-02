import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { StaffReview } from '@/components/fleet/StaffReview';
import { loadAccountContext } from '@/lib/account';
import { signedObjectUrl } from '@/lib/storage';
import { loadFleet } from '@/lib/fleet';
import { staffNav } from '@/components/staff/StaffNav';

/** Staff-only: the vehicle and driver queues, with the documents inline. */
export default async function StaffVehiclesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/staff/vehicles`);
  }

  const isStaff =
    !loaded.configured ||
    loaded.roles.includes('platform_staff') ||
    loaded.roles.includes('platform_admin');

  if (!isStaff) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/staff/vehicles" />
        <ConsoleShell
          locale={locale}
          title="fleet.staffQueue"
          consoleTitle="console.staff"
          subtitle="console.subtitle.vehicles"
          pathname="/staff/vehicles"
          groups={staffNav(locale)}
        >
          <EmptyState title={t('errors.FORBIDDEN')} />
        </ConsoleShell>
      </>
    );
  }

  const fleet = await loadFleet(loaded);
  const documentsByVehicle = new Map<string, { id: string; kind: string; url: string }[]>();
  for (const document of fleet.documents) {
    const list = documentsByVehicle.get(document.vehicleId) ?? [];
    list.push({
      id: document.id,
      kind: document.kind,
      // Authenticated read of the private bucket: storage RLS decides, not the page.
      url: `/api/data/storage/v1/object/authenticated/vehicle-documents/${document.storagePath}`,
    });
    documentsByVehicle.set(document.vehicleId, list);
  }

  return (
    <>
      <SiteHeader locale={locale} pathname="/staff/vehicles" />
      <ConsoleShell
        locale={locale}
        title="fleet.staffQueue"
        consoleTitle="console.staff"
        subtitle="console.subtitle.vehicles"
        pathname="/staff/vehicles"
        groups={staffNav(locale)}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}
        {fleet.pendingVehicles.length === 0 && fleet.pendingDrivers.length === 0 ? (
          <EmptyState
            title={t('console.emptyVehicles')}
            description={t('console.emptyVehiclesBody')}
            action={
              <Link className="btn btn--ghost" href={`/${locale}/staff/dashboard`}>
                {t('ops.dashboardTitle')}
              </Link>
            }
          />
        ) : (
          <StaffReview
            locale={locale}
            configured={loaded.configured}
            vehicles={fleet.pendingVehicles.map((vehicle) => ({
              id: vehicle.id,
              make: vehicle.make,
              model: vehicle.model,
              modelYear: vehicle.modelYear,
              plateNumber: vehicle.plateNumber,
              bodyType: vehicle.bodyType,
              fuelType: vehicle.fuelType,
              seatsPassenger: vehicle.seatsPassenger,
              insuranceExpiry: vehicle.insuranceExpiry,
              inspectionExpiry: vehicle.inspectionExpiry,
              documents: documentsByVehicle.get(vehicle.id) ?? [],
            }))}
            drivers={await Promise.all(
              fleet.pendingDrivers.map(async (driver) => ({
                id: driver.id,
                fullName: driver.fullName,
                phone: driver.phone,
                licenceNo: driver.licenceNo,
                licenceExpiry: driver.licenceExpiry,
                // Same pattern as vehicle documents, with a clock: storage RLS decides who may look, and
                // the signature decides for how long.
                licencePhotoUrl: driver.licencePhotoPath
                  ? await signedObjectUrl('driver-documents', driver.licencePhotoPath)
                  : null,
                status: driver.status,
              })),
            )}
          />
        )}
      </ConsoleShell>
    </>
  );
}
