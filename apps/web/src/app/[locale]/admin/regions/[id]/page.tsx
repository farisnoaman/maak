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
 * `/admin/regions/[id]` — one region, in the same form it was created with.
 *
 * Same component, same validation, same command as `/admin/regions/new`: an edit screen that is a second copy of a
 * form is a field that will one day exist in one and not the other.
 */
export default async function EditRegionPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/regions/${id}`);
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
  const region = directory.regions.find((candidate) => candidate.id === id);
  /* A preview (no database) has no ids to resolve, so the form still opens — with nothing loaded. */
  if (!region && directory.configured) notFound();

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/regions" />
      <ConsoleShell
        consoleTitle="console.admin"
        pathname="/admin/regions"
        locale={locale}
        title="geo.editRegion"
        subtitle="geo.subtitle"
        groups={adminNav(locale)}
      >
        {directory.configured ? null : <PreviewBanner locale={locale} />}
        <RegionConsole locale={locale} directory={directory} mode="editor" regionId={id} />
      </ConsoleShell>
    </>
  );
}
