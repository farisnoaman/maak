import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';

export default async function ConsolePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  // The staff fleet queue lives under the same shell as the account queue: one console, two doors.
  const screens = [
    {
      key: 'ops.dashboardTitle' as const,
      note: 'console.subtitle.staff' as const,
      href: `/${locale}/staff/dashboard`,
    },
    {
      key: 'ops.scanTitle' as const,
      note: 'ops.scanHint' as const,
      href: `/${locale}/staff/scan`,
    },
    {
      key: 'staff.trips.title' as const,
      note: 'staff.trips.subtitle' as const,
      href: `/${locale}/staff/trips`,
    },
    {
      key: 'console.navVehicles' as const,
      note: 'console.tileReviewVehicles' as const,
      href: `/${locale}/staff/vehicles`,
    },
    {
      key: 'console.navVerifications' as const,
      note: 'console.tileReviewAccounts' as const,
      href: `/${locale}/staff/verifications`,
    },
  ];

  return (
    <>
      <SiteHeader locale={locale} pathname="/staff" />
      <ConsoleShell
        locale={locale}
        title="console.staff"
        subtitle="console.subtitle.staff"
        phase="7"
        items={[
          { key: 'console.navOverview', href: `/${locale}/staff` },
          { key: 'ops.dashboard', href: `/${locale}/staff/dashboard` },
          { key: 'ops.scan', href: `/${locale}/staff/scan` },
          { key: 'staff.trips.title', href: `/${locale}/staff/trips` },
          { key: 'console.navVehicles', href: `/${locale}/staff/vehicles` },
          { key: 'nav.verificationQueue', href: `/${locale}/staff/verifications` },
          { key: 'nav.places', href: `/${locale}/admin/places` },
        ]}
      >
        {screens.map((screen) => (
          <div className="console-tile" key={screen.href}>
            <h2>{t(screen.key)}</h2>
            <p>{t(screen.note)}</p>
            <Link className="btn btn--primary" href={screen.href}>
              {t('console.open')}
            </Link>
          </div>
        ))}
      </ConsoleShell>
    </>
  );
}
