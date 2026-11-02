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
 * `/admin/places/find` — the place search, on its own page.
 *
 * The picker is a tool you reach for while creating a trip, not a section you read on the review screen. It moved out
 * of the queue page for the same reason the form did: a page should answer one question.
 */
export default async function FindPlacePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/places/find`);
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
          <h1>{t('places.findPlace')}</h1>
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
        title="places.findPlace"
        subtitle="places.browseHint"
        groups={adminNav(locale)}
      >
        {directory.configured ? null : <PreviewBanner locale={locale} />}
        <PlaceConsole locale={locale} directory={directory} canDecide={isStaff} mode="find" />
      </ConsoleShell>
    </>
  );
}
