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

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin" />
      <ConsoleShell
        locale={locale}
        consoleTitle="console.admin"
        pathname="/admin"
        title="console.navOverview"
        subtitle="console.subtitle.admin"
        layout="tiles"
        items={[
          { key: 'console.navOverview', href: `/${locale}/admin` },
          { key: 'catalogue.title', href: `/${locale}/admin/notifications` },
          { key: 'nav.regions', href: `/${locale}/admin/regions` },
          { key: 'nav.places', href: `/${locale}/admin/places` },
          { key: 'nav.roles', href: `/${locale}/admin/users` },
        ]}
      >
        {/* A hub whose only tile says "placeholder" is a hub nobody opens twice: it now leads to the two admin
            screens this phase and the last one actually shipped, and keeps the placeholder for the rest. */}
        <div className="console-tile">
          <h2>
            <Link href={`/${locale}/admin/notifications`}>{t('catalogue.title')}</Link>
          </h2>
          <p>{t('catalogue.subtitle')}</p>
        </div>
        <div className="console-tile">
          <h2>
            <Link href={`/${locale}/admin/plans`}>{t('financeNav.plans')}</Link>
          </h2>
          <p>{t('console.placeholder')}</p>
        </div>
      </ConsoleShell>
    </>
  );
}
