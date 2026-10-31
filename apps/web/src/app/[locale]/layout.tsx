import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { DIRECTION, LOCALES, isLocale, type Locale } from '@maak/core';
import '@maak/design-tokens/tokens.css';
import '../globals.css';
import { ToastProvider } from '@/components/ui/Toast';
import { SessionTokenKeeper } from '@/components/SessionTokenKeeper';
import { StaleBuildBanner } from '@/components/StaleBuildBanner';
import { BUILD } from '@/lib/build';

/**
 * Mobile-first viewport: the layout is designed at 320px and grows, so the page is never wider than
 * the device, never zooms, and lets the phone draw under the notch (`viewportFit: cover`) while the
 * header keeps its own padding.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0d7a5f' },
    { media: '(prefers-color-scheme: dark)', color: '#0d7a5f' },
  ],
};

export const metadata: Metadata = {
  title: 'Maak — إدارة الرحلات',
  description:
    'منصة إدارة الرحلات في اليمن: حسابات أفراد وشركات، مركبات وسائقون موثّقون، رحلات عامة، دفع ومحاسبة.',
};

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <html lang={locale} dir={DIRECTION[locale as Locale]} data-build={BUILD}>
      <body>
        <a className="skip-link" href="#main">
          {locale === 'ar' ? 'تخطَّ إلى المحتوى' : 'Skip to content'}
        </a>
        <SessionTokenKeeper />
        <StaleBuildBanner build={BUILD} locale={locale as Locale} />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
