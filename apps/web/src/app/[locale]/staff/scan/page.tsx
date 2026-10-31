import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { ScanPanel } from '@/components/staff/ScanPanel';
import { loadAccountContext } from '@/lib/account';

/**
 * The scan screen.
 *
 * Thin by design: the page resolves the locale and the session, and everything that needs a browser —
 * camera, token, result — is in `ScanPanel`. The permission check is not here, and that is the point:
 * `staff_scan` decides who may look, so a wrong turn in the UI cannot widen anything.
 */
export const dynamic = 'force-dynamic';

export default async function StaffScanPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

  const account = await loadAccountContext();
  if (account.configured && !account.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/staff/scan`);
  }

  return (
    <>
      <SiteHeader locale={locale} pathname="/staff" />
      <ConsoleShell
        locale={locale}
        title="ops.scanTitle"
        subtitle="console.subtitle.staff"
        phase="7"
        items={[
          { key: 'console.navOverview', href: `/${locale}/staff` },
          { key: 'ops.dashboard', href: `/${locale}/staff/dashboard` },
          { key: 'ops.scan', href: `/${locale}/staff/scan` },
          { key: 'staff.trips.title', href: `/${locale}/staff/trips` },
        ]}
      >
        <h2 className="visually-hidden">{t('ops.scanTitle')}</h2>
        <ScanPanel locale={locale} />
      </ConsoleShell>
    </>
  );
}
