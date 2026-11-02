import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminNav } from '@/components/admin/AdminNav';
import { EmptyState } from '@/components/ui/Feedback';
import { SupervisorPanel } from '@/components/geo/SupervisorPanel';
import { loadAccountContext } from '@/lib/account';
import { loadGeoDirectory } from '@/lib/geo';

/**
 * `/admin/regions/supervisors` — who answers for which patch.
 *
 * It sat under the region tree on the same page, below the tree and above nothing: two subjects (structure, staffing)
 * in one scroll. It is a page of its own now, reached from the tree's header.
 */
export default async function RegionSupervisorsPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/regions/supervisors`);
  }

  const isAdmin = !loaded.configured || loaded.roles.includes('platform_admin');
  if (!isAdmin) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/admin/regions" />
        <main id="main" className="shell section">
          <h1>{t('supervisors.title')}</h1>
          <EmptyState title={t('errors.FORBIDDEN')} description={t('supervisors.subtitle')} />
        </main>
      </>
    );
  }

  const directory = await loadGeoDirectory(loaded);

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/regions" />
      <ConsoleShell
        consoleTitle="console.admin"
        pathname="/admin/regions"
        locale={locale}
        title="supervisors.title"
        subtitle="supervisors.subtitle"
        groups={adminNav(locale)}
      >
        {directory.configured ? null : <PreviewBanner locale={locale} />}
        <SupervisorPanel locale={locale} directory={directory} />
      </ConsoleShell>
    </>
  );
}
