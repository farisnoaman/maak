import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminNav } from '@/components/admin/AdminNav';
import { EmptyState } from '@/components/ui/Feedback';
import { RegionConsole } from '@/components/geo/RegionConsole';
import { loadAccountContext } from '@/lib/account';
import { loadGeoDirectory } from '@/lib/geo';

/**
 * `/admin/regions/new` — the region form, on its own page.
 *
 * The form used to open underneath the tree, which meant the list had to stay half the screen and the page carried two
 * jobs. A URL per job is the console convention everywhere else: the tree is the index, this is the entry, and saving
 * returns to the index.
 */
export default async function NewRegionPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/regions/new`);
  }

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

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/regions" />
      <ConsoleShell
        consoleTitle="console.admin"
        pathname="/admin/regions"
        locale={locale}
        title="geo.newRegion"
        subtitle="geo.newRegionHint"
        groups={adminNav(locale)}
      >
        {directory.configured ? null : <PreviewBanner locale={locale} />}
        <RegionConsole locale={locale} directory={directory} mode="editor" />
      </ConsoleShell>
    </>
  );
}
