import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { TripWizard } from '@/components/trips/TripWizard';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import { loadTripOptions } from '@/lib/trips';

export default async function NewTripPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/trips/new`);
  }

  const query = await searchParams;
  // Personal unless the URL names an organization — the same rule the list and calendar follow.
  const org = loaded.configured
    ? typeof query.org === 'string'
      ? activeOrganization(loaded, query.org)
      : null
    : null;

  const options = await loadTripOptions(loaded);

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/trips" />
      <ConsoleShell
        locale={locale}
        title="trips.new"
        subtitle="trips.subtitle"
        phase="4"
        items={[
          { key: 'console.navOverview', href: `/${locale}/operator` },
          { key: 'console.navTrips', href: `/${locale}/operator/trips` },
          { key: 'console.navVehicles', href: `/${locale}/operator/vehicles` },
          { key: 'console.navDrivers', href: `/${locale}/operator/drivers` },
        ]}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}
        <p className="trip-form__hint">{t('trips.entryLocked')}</p>
        <TripWizard locale={locale} orgId={org?.id ?? null} options={options} />
      </ConsoleShell>
    </>
  );
}
