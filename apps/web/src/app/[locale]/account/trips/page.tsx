import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { EmptyState } from '@/components/ui/Feedback';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import { loadTrips } from '@/lib/trips';
import { Badge } from '@/components/ui/Feedback';
import { departureLabel, tripStatusKey } from '@maak/core';

/**
 * My trips — the passenger's shell.
 *
 * Bookings are Phase 5, so the list is populated from the one thing a passenger *can* have today: the
 * trips they operate (`trip.bookings` would read here once Phase 5 lands). Rendering the shell now is
 * deliberate — the empty state, the sign-in redirect and the navigation entry are the parts that get
 * forgotten when a feature is added late, and a booking screen that appears from nowhere is worse than
 * one that says "nothing yet".
 */
export default async function AccountTripsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/account/trips`);
  }

  const query = await searchParams;
  // Personal is the default context; an organization is shown only when the URL asks for it. Defaulting
  // to the company made every personal trip invisible the moment an owner joined one.
  const org = loaded.configured
    ? typeof query.org === 'string'
      ? activeOrganization(loaded, query.org)
      : null
    : null;
  const data = await loadTrips(loaded);
  const operated = data.trips.filter((trip) =>
    org ? trip.ownerOrgId === org.id : trip.ownerUserId === loaded.user?.id,
  );

  return (
    <>
      <SiteHeader locale={locale} pathname="/account/trips" />
      <main id="main" className="shell">
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}
        <h1>{t('trips.history.title')}</h1>
        <p className="trip-form__hint">{t('trips.history.subtitle')}</p>

        {operated.length === 0 ? (
          <EmptyState
            title={t('trips.history.empty')}
            description={t('trips.history.emptyHint')}
            action={
              <Link className="btn btn--primary" href={`/${locale}/trips`}>
                {t('trips.search.title')}
              </Link>
            }
          />
        ) : (
          <ul className="trip-queue">
            {operated.slice(0, 12).map((trip) => {
              const when = departureLabel(trip.departureAt, locale);
              return (
                <li className="card trip-queue__item" key={trip.id}>
                  <h2>
                    {trip.origin.nameAr} ← {trip.destination.nameAr}
                  </h2>
                  <p className="trip-form__hint">
                    {trip.code} · {when.date} · <bdi>{when.time}</bdi>
                  </p>
                  <div className="trip-badges">
                    <Badge tone={trip.status === 'published' ? 'success' : 'neutral'}>
                      {t(tripStatusKey(trip.status))}
                    </Badge>
                    {trip.status === 'published' ? (
                      <Link className="ui-btn ui-btn--ghost" href={`/${locale}/trips/${trip.code}`}>
                        {t('trips.view')}
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </>
  );
}
