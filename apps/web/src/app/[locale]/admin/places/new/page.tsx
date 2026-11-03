import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminNav } from '@/components/admin/AdminNav';
import { EmptyState } from '@/components/ui/Feedback';
import { PlaceConsole } from '@/components/geo/PlaceConsole';
import { loadAccountContext } from '@/lib/account';
import { loadGeoDirectory } from '@/lib/geo';

/**
 * `/admin/places/new` — the "add a place" form, on its own page.
 *
 * It used to be eleven fields standing open below the review queue, whether or not anyone was adding a place; then a
 * disclosure row that kept the queue on screen. It is a page now: the queue is `/admin/places`, this is the form, and
 * saving returns to the queue. A verified operator is sent straight here, because it is the only thing they may do.
 */
export default async function NewPlacePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/places/new`);
  }

  const isStaff =
    !loaded.configured ||
    loaded.roles.some((role) => role === 'platform_staff' || role === 'platform_admin');
  const verified =
    !loaded.configured ||
    loaded.profile?.verificationStatus === 'verified' ||
    loaded.organizations.some((organization) => organization.verificationStatus === 'verified');

  if (!isStaff && !verified) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/admin/places" />
        <main id="main" className="shell section">
          <h1>{t('places.addPlace')}</h1>
          <EmptyState title={t('errors.NOT_VERIFIED')} description={t('places.subtitle')} />
        </main>
      </>
    );
  }

  const directory = await loadGeoDirectory(loaded);

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/places" />
      <ConsoleShell
        consoleTitle="console.admin"
        pathname="/admin/places"
        locale={locale}
        title="places.addPlace"
        subtitle="places.subtitle"
        groups={adminNav(locale)}
      >
        {directory.configured ? null : <PreviewBanner locale={locale} />}
        <PlaceConsole locale={locale} directory={directory} canDecide={isStaff} mode="new" />
      </ConsoleShell>
    </>
  );
}
