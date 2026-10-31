import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { formatDateTime, isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { Badge, EmptyState } from '@/components/ui/Feedback';
import { loadAccountContext } from '@/lib/account';
import { loadDriverTrips } from '@/lib/driver-trips';

/**
 * The driver's trips.
 *
 * A driver opens the app in a vehicle, not at a desk: this page exists so the console is one tap away
 * instead of a URL somebody has to be told. It is the web counterpart of the native driver screen — the
 * same commands, the same rules, no background location cadence (that is the native app's job).
 */
export const dynamic = 'force-dynamic';

export default async function DriverHomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const account = await loadAccountContext();
  if (account.configured && !account.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/driver`);
  }

  const { trips } = await loadDriverTrips();

  return (
    <>
      <SiteHeader locale={locale} pathname="/driver" />
      <main id="main" className="shell section">
        <h1>{t('driver.title')}</h1>
        <p className="trip-form__hint">{t('driver.subtitle')}</p>

        {trips.length === 0 ? (
          <EmptyState
            title={t('driver.empty')}
            description={t('driver.emptyBody')}
            action={
              <Link className="ui-btn ui-btn--ghost ui-btn--md" href={`/${locale}/account`}>
                {t('nav.account')}
              </Link>
            }
          />
        ) : (
          <ul className="card-list">
            {trips.map((trip) => (
              <li key={trip.id} className="card">
                <div className="card__head">
                  <strong>{trip.code}</strong>
                  <Badge tone={trip.status === 'in_progress' ? 'success' : 'neutral'}>
                    {trip.status}
                  </Badge>
                </div>
                <p className="trip-form__hint">
                  {trip.origin} → {trip.destination} ·{' '}
                  {formatDateTime(trip.departureAt, { locale })}
                </p>
                <Link
                  className="ui-btn ui-btn--primary ui-btn--md"
                  href={`/${locale}/driver/trips/${trip.code}`}
                >
                  {t('driver.open')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
