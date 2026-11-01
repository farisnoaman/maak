import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { DIRECTION, LOCALES, isLocale, type Locale } from '@maak/core';
import '@maak/design-tokens/tokens.css';
import '../globals.css';
import { ToastProvider } from '@/components/ui/Toast';
import { MobileTabBar } from '@/components/MobileTabBar';
import { ServiceWorker } from '@/components/ServiceWorker';
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
  // Canonical and hreflang URLs are absolute; without a base Next.js refuses to emit them.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  // The title is the browser tab and a search result: it should say what the product is, not who the software
  // is built for. `إدارة الرحلات` described the console. Pages that know better set their own — the home page
  // does, and so does every console screen.
  title: 'معك — منصة الرحلات بين المحافظات',
  description:
    'احجز مقعدك في رحلات يومية بين المحافظات اليمنية من مشغّلين ومركبات موثّقة، بسعر واضح قبل الحجز وتتبّع مباشر للرحلة.',
  // iOS ignores the manifest's icons and reads this one; `appleWebApp` is what makes "Add to Home
  // Screen" open without browser chrome.
  icons: { apple: '/icons/180' },
  appleWebApp: { capable: true, title: 'معك', statusBarStyle: 'default' },
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
        <ServiceWorker />
        <StaleBuildBanner build={BUILD} locale={locale as Locale} />
        <ToastProvider>{children}</ToastProvider>
        {/* The phone's primary navigation. Rendered for every screen; CSS keeps it out of the way on
            a desktop, where the header already carries the same four destinations. */}
        <MobileTabBar />
      </body>
    </html>
  );
}
