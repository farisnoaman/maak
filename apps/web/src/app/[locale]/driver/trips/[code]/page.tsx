import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { EmptyState } from '@/components/ui/Feedback';
import { TripRunPanel } from '@/components/driver/TripRunPanel';
import { loadAccountContext } from '@/lib/account';
import { loadDriverTrip } from '@/lib/driver-trips';

/**
 * One trip's console, for the driver assigned to it.
 *
 * `loadDriverTrip` returns nothing for a trip that is not theirs — RLS decides, not this page — so the
 * "not yours" state is the only thing to render for somebody who guesses a code.
 */
export const dynamic = 'force-dynamic';

export default async function DriverTripPage({
  params,
}: {
  params: Promise<{ locale: string; code: string }>;
}) {
  const { locale: raw, code } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const account = await loadAccountContext();
  if (account.configured && !account.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/driver/trips/${code}`);
  }

  const trip = await loadDriverTrip(code);

  return (
    <>
      <SiteHeader locale={locale} pathname="/driver" />
      <main id="main" className="shell section">
        <Link className="trip-back" href={`/${locale}/driver`}>
          ← {t('driver.back')}
        </Link>
        <h1>{trip ? `${trip.code}` : t('driver.notYours')}</h1>

        {trip ? (
          <>
            <p className="trip-form__hint">
              {trip.origin} → {trip.destination}
            </p>
            <TripRunPanel locale={locale} trip={trip} />
            <p className="trip-form__hint">
              <Link href={`/${locale}/trips/${trip.code}/live`}>{t('driver.liveLink')}</Link>
            </p>
          </>
        ) : (
          <EmptyState
            title={t('driver.notYours')}
            description={t('driver.emptyBody')}
            action={
              <Link className="ui-btn ui-btn--ghost ui-btn--md" href={`/${locale}/driver`}>
                {t('driver.back')}
              </Link>
            }
          />
        )}
      </main>
    </>
  );
}
