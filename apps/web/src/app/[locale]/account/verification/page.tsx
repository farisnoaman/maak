import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { AccountNav } from '@/components/account/AccountNav';
import { VerificationWizard } from '@/components/account/VerificationWizard';
import { loadAccountContext } from '@/lib/account';
import { previewAccount } from '@/lib/preview-data';

export default async function VerificationPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/account/verification`);
  }

  const preview = !loaded.configured;
  const data = preview ? previewAccount : loaded;

  return (
    <>
      <SiteHeader locale={locale} pathname="/account/verification" />
      <main id="main" className="shell section account-page">
        <header className="account-head">
          <h1>{t('verification.title')}</h1>
          <p className="form-hint">{t('verification.subtitle')}</p>
        </header>

        <AccountNav locale={locale} current="/account/verification" />

        {preview ? <PreviewBanner locale={locale} /> : null}

        <VerificationWizard
          locale={locale}
          userId={data.user?.id ?? ''}
          configured={!preview}
          initialStatus={data.profile?.verificationStatus ?? 'unverified'}
          initialNote={data.profile?.verificationNote ?? null}
          profile={{
            fullName: data.profile?.fullName ?? null,
            nationalIdType: data.profile?.nationalIdType ?? null,
            birthPlace: data.profile?.birthPlace ?? null,
          }}
        />
      </main>
    </>
  );
}
