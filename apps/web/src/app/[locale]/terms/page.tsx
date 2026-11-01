import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, type Locale } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { LegalPage } from '@/components/LegalPage';
import { legalDocument } from '@/lib/legal';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale: raw } = await params;
  const locale: Locale = isLocale(raw) ? raw : 'ar';
  const doc = legalDocument('terms', locale);
  return {
    title: doc.title,
    alternates: { languages: { ar: '/ar/terms', en: '/en/terms' } },
  };
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  return (
    <>
      <SiteHeader locale={locale} pathname="/terms" />
      <LegalPage locale={locale} id="terms" />
    </>
  );
}
