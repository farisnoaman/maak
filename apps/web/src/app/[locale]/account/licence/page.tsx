import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { EmptyState } from '@/components/ui/Feedback';
import { AccountNav } from '@/components/account/AccountNav';
import { AcceptInvitePanel, LicencePanel } from '@/components/driver/LicencePanel';
import { loadAccountContext } from '@/lib/account';
import { loadDriverState } from '@/lib/driver';
import { signedObjectUrl } from '@/lib/storage';

/**
 * The driver's licence — on the web, not only in the app.
 *
 * Three states, in the order a person meets them:
 *
 *  - **no driver record**: an operator has not invited this phone number. The page says so instead of
 *    pretending to be a form that cannot save.
 *  - **an invitation**: an unbound `driver_profiles` row addressed to this account's phone (readable
 *    only through the policy added in `00018`). One button accepts it.
 *  - **a driver profile**: the licence number, class, expiry and image, plus the review state.
 *
 * The licence image itself never leaves the private bucket as a public URL: the link points at the
 * authenticated storage proxy, and the database decides whether this account may read that folder.
 */
export default async function AccountLicencePage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/account/licence`);
  }

  const state = await loadDriverState();
  const userId = loaded.user?.id ?? '';
  const licencePhotoUrl = state.driver?.licencePhotoPath
    ? await signedObjectUrl('driver-documents', state.driver.licencePhotoPath)
    : null;

  return (
    <>
      <SiteHeader locale={locale} pathname="/account/licence" />
      <main id="main" className="shell section account-page">
        <a className="trip-back" href={`/${locale}/account`}>
          <span className="back-arrow" aria-hidden="true">
            ←{' '}
          </span>
          {t('common.back')}
        </a>
        <header className="account-head">
          <h1>{t('fleet.accountLicence')}</h1>
          <p className="form-hint">{t('fleet.accountLicenceSubtitle')}</p>
        </header>

        <AccountNav locale={locale} current="/account/licence" />

        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        {state.invite ? (
          <>
            <h2>{t('fleet.acceptInvite')}</h2>
            <AcceptInvitePanel locale={locale} invite={state.invite} />
          </>
        ) : state.driver ? (
          <LicencePanel
            locale={locale}
            userId={userId}
            driver={state.driver}
            photoUrl={licencePhotoUrl}
          />
        ) : (
          <EmptyState
            title={t('fleet.noDriverProfile')}
            description={t('fleet.noDriverProfileHint')}
            action={
              <Link className="btn btn--ghost" href={`/${locale}/account`}>
                {t('common.back')}
              </Link>
            }
          />
        )}
      </main>
    </>
  );
}
