import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { PlaceConsole } from '@/components/geo/PlaceConsole';
import { loadAccountContext } from '@/lib/account';
import { loadGeoDirectory } from '@/lib/geo';

export default async function AdminPlacesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/places`);
  }

  const isStaff =
    !loaded.configured ||
    loaded.roles.some((role) => role === 'platform_staff' || role === 'platform_admin');
  // Any verified account may submit a gathering point; reviewing it is staff-only.
  const verified =
    !loaded.configured ||
    loaded.profile?.verificationStatus === 'verified' ||
    loaded.organizations.some((organization) => organization.verificationStatus === 'verified');

  if (!isStaff && !verified) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/admin/places" />
        <main id="main" className="shell section">
          <h1>{t('places.title')}</h1>
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
        locale={locale}
        title="places.title"
        subtitle="places.subtitle"
        phase="2"
        items={[
          { key: 'console.navOverview', href: `/${locale}/admin` },
          { key: 'nav.regions', href: `/${locale}/admin/regions` },
          { key: 'nav.places', href: `/${locale}/admin/places` },
          { key: 'nav.account', href: `/${locale}/account` },
        ]}
      >
        {directory.configured ? null : <PreviewBanner locale={locale} />}
        <PlaceConsole locale={locale} directory={directory} canDecide={isStaff} />
      </ConsoleShell>
    </>
  );
}
