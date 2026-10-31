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

  // The overview is the only way into the fleet from the shell, so it links, it does not advertise.
  const screens = [
    {
      key: 'console.navVehicles' as const,
      note: 'console.tileVehicles' as const,
      href: `/${locale}/operator/vehicles`,
    },
    {
      key: 'console.navDrivers' as const,
      note: 'console.tileDrivers' as const,
      href: `/${locale}/operator/drivers`,
    },
  ];

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator" />
      <ConsoleShell
        locale={locale}
        title="console.operator"
        subtitle="console.subtitle.operator"
        phase="3"
        items={[
          { key: 'console.navOverview', href: `/${locale}/operator` },
          { key: 'console.navVehicles', href: `/${locale}/operator/vehicles` },
          { key: 'console.navDrivers', href: `/${locale}/operator/drivers` },
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
