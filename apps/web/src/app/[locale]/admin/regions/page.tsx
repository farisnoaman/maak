import { notFound, redirect } from 'next/navigation';
import { expandCoverage, isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminNav } from '@/components/admin/AdminNav';
import { EmptyState } from '@/components/ui/Feedback';
import { RegionConsole } from '@/components/geo/RegionConsole';
import { loadAccountContext } from '@/lib/account';
import { loadGeoDirectory } from '@/lib/geo';

export default async function AdminRegionsPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/regions`);
  }

  // Regions are platform structure: an admin decides them. Staff can read the tree but not edit it.
  const isAdmin = !loaded.configured || loaded.roles.includes('platform_admin');
  if (!isAdmin) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/admin/regions" />
        <main id="main" className="shell section">
          <h1>{t('geo.title')}</h1>
          <EmptyState title={t('errors.FORBIDDEN')} description={t('geo.subtitle')} />
        </main>
      </>
    );
  }

  const directory = await loadGeoDirectory(loaded);

  /*
   * Three numbers the page was making the reader work out: how many regions are live, how much of the country they
   * actually cover, and whether anyone is supervising it. `expandCoverage` is the same union the command stores, so the
   * figure in the band and the figure under a region can never disagree.
   */
  const active = directory.regions.filter((region) => region.isActive);
  const coveredDistricts = new Set(
    active.flatMap((region) =>
      expandCoverage(
        { governorateIds: region.governorateIds, districtIds: region.districtIds },
        directory.districts,
      ),
    ),
  ).size;

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/regions" />
      <ConsoleShell
        consoleTitle="console.admin"
        pathname="/admin/regions"
        locale={locale}
        title="geo.title"
        subtitle="geo.subtitle"
        groups={adminNav(locale)}
        facts={[
          { label: t('geo.factRegions'), value: String(active.length) },
          { label: t('geo.factDistricts'), value: String(coveredDistricts) },
          {
            label: t('geo.factSupervisors'),
            value: String(directory.supervisors.length),
            href: `/${locale}/admin/regions/supervisors`,
          },
        ]}
      >
        {directory.configured ? null : <PreviewBanner locale={locale} />}
        <RegionConsole locale={locale} directory={directory} />
      </ConsoleShell>
    </>
  );
}
