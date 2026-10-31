import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { VehicleWizard } from '@/components/fleet/VehicleWizard';
import { activeOrganization, loadAccountContext } from '@/lib/account';

export default async function NewVehiclePage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/vehicles/new`);
  }

  const query = await searchParams;
  const org = loaded.configured
    ? activeOrganization(loaded, typeof query.org === 'string' ? query.org : undefined)
    : null;
  const verified = !loaded.configured || loaded.profile?.verificationStatus === 'verified';

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/vehicles" />
      <ConsoleShell
        locale={locale}
        title="fleet.addVehicle"
        subtitle="console.subtitle.operator"
        phase="3"
        items={[
          { key: 'console.navOverview', href: `/${locale}/operator` },
          { key: 'console.navVehicles', href: `/${locale}/operator/vehicles` },
          { key: 'console.navFleet', href: `/${locale}/operator/fleet` },
          { key: 'console.navDrivers', href: `/${locale}/operator/drivers` },
        ]}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}
        <p className="fleet-hint">{t('verification.subtitle')}</p>
        <VehicleWizard
          locale={locale}
          configured={loaded.configured}
          verified={verified}
          orgId={org?.id ?? null}
          orgName={org?.name ?? null}
        />
      </ConsoleShell>
    </>
  );
}
