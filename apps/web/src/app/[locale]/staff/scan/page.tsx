import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { ScanPanel } from '@/components/staff/ScanPanel';
import { staffNav } from '@/components/staff/StaffNav';
import { loadAccountContext } from '@/lib/account';

/**
 * The scan screen.
 *
 * Thin by design: the page resolves the locale and the session, and everything that needs a browser —
 * camera, token, result — is in `ScanPanel`. The permission check is not here, and that is the point:
 * `staff_scan` decides who may look, so a wrong turn in the UI cannot widen anything.
 *
 * Two things were removed here. A `visually-hidden` `<h2>` repeated the `<h1>` three lines above it, so the page
 * announced its own title twice. And the title said "Check a trip" while the nav that led here said "Scan" — the
 * same screen under two names; the page now takes the scanner's name and keeps the sentence for the subtitle,
 * where it explains what to do instead of restating where you are.
 */
export const dynamic = 'force-dynamic';

export default async function StaffScanPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const account = await loadAccountContext();
  if (account.configured && !account.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/staff/scan`);
  }

  return (
    <>
      <SiteHeader locale={locale} pathname="/staff/scan" />
      <ConsoleShell
        locale={locale}
        title="ops.scan"
        consoleTitle="console.staff"
        subtitle="ops.scanSubtitle"
        pathname="/staff/scan"
        groups={staffNav(locale)}
        actions={
          <Link className="btn btn--ghost" href={`/${locale}/staff/trips`}>
            {t('staff.trips.title')}
          </Link>
        }
      >
        <ScanPanel locale={locale} />
      </ConsoleShell>
    </>
  );
}
