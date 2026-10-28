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
      <SiteHeader locale={locale} />
      <ConsoleShell
        locale={locale}
        title="console.admin"
        subtitle="console.subtitle.admin"
        phase="10"
        items={[{ key: 'console.navOverview', href: `/${locale}/admin` }]}
      >
        <div className="console-tile">
          <h2>{t('console.navOverview')}</h2>
          <p>{t('console.placeholder')}</p>
        </div>
      </ConsoleShell>
    </>
  );
}
