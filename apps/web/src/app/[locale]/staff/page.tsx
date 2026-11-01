import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { staffNav } from '@/components/staff/StaffNav';

/**
 * The staff console's front door.
 *
 * Was five identical tiles, each with its own "Open" button and a note that repeated the page's own subtitle — a
 * menu with nothing to say. Now the tiles carry the question each screen answers, and the two queues the console
 * exists for are the ones that come first.
 */
export default async function StaffConsolePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const screens: {
    key: TranslationKey;
    note: TranslationKey;
    href: string;
    primary?: boolean;
  }[] = [
    {
      key: 'ops.dashboardTitle',
      note: 'console.tileDashboard',
      href: `/${locale}/staff/dashboard`,
      primary: true,
    },
    {
      key: 'console.navVerifications',
      note: 'console.tileReviewAccounts',
      href: `/${locale}/staff/verifications`,
      primary: true,
    },
    {
      key: 'fleet.staffQueue',
      note: 'console.tileReviewVehicles',
      href: `/${locale}/staff/vehicles`,
    },
    {
      key: 'staff.trips.title',
      note: 'staff.trips.subtitle',
      href: `/${locale}/staff/trips`,
    },
    {
      key: 'ops.scanTitle',
      note: 'ops.scanHint',
      href: `/${locale}/staff/scan`,
    },
  ];

  return (
    <>
      <SiteHeader locale={locale} pathname="/staff" />
      <ConsoleShell
        locale={locale}
        title="console.staff"
        consoleTitle="console.staff"
        subtitle="console.subtitle.staff"
        pathname="/staff"
        groups={staffNav(locale)}
        layout="tiles"
      >
        {screens.map((screen) => (
          /* The whole tile is the link, not a button at the bottom of one: on a phone it is the only part that
             should need aiming at. */
          <Link
            className={`console-tile console-tile--link${screen.primary ? ' console-tile--primary' : ''}`}
            href={screen.href}
            key={screen.href}
          >
            <h2>{t(screen.key)}</h2>
            <p>{t(screen.note)}</p>
            <span className="console-tile__go route-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        ))}
      </ConsoleShell>
    </>
  );
}
