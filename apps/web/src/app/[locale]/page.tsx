import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  departureLabel,
  formatMinor,
  isLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { SiteFooter } from '@/components/SiteFooter';
import { FareCalculator } from '@/components/FareCalculator';
import { TripSearchForm } from '@/components/TripSearchForm';
import { PublicTripCard } from '@/components/trips/PublicTripCard';
import { loadPublicGovernorates, loadPublicTrips } from '@/lib/trips';

export const metadata: Metadata = {
  title: 'معك — احجز مقعدك بين المحافظات',
  alternates: {
    languages: { ar: '/ar', en: '/en' },
  },
};

/**
 * The home page.
 *
 * It was a build report: a phase number as the eyebrow, a unit-test count as a hero statistic, three cards about the
 * write path, and seven console cards of which five said "coming soon" — while `/trips` was serving real departures
 * the page never mentioned. `docs/polish-plan.md` §1 has the full accounting.
 *
 * What it is now, in the order a traveller asks:
 *
 *   1. where can I go, and when   → the search form, then the next real departures beside it
 *   2. is this real               → three trust lines, then trips you can actually book
 *   3. what will it cost          → the fare calculator, which is the server's own formula
 *   4. what if I drive for a living → the operator band
 *   5. where do the staff go      → one quiet row of console links, no phase pills
 *
 * Every number on this page comes from the database or is not shown. A home page cannot be "polished" into saying
 * something true; it can only be arranged so the true things come first.
 */
const TRUST: { icon: string; key: TranslationKey }[] = [
  { icon: '✓', key: 'home.trustVerified' },
  { icon: '✓', key: 'home.trustPrice' },
  { icon: '✓', key: 'home.trustTrack' },
];

const STEPS: { title: TranslationKey; body: TranslationKey }[] = [
  { title: 'home.howSearchTitle', body: 'home.howSearchBody' },
  { title: 'home.howBookTitle', body: 'home.howBookBody' },
  { title: 'home.howTravelTitle', body: 'home.howTravelBody' },
];

/** Internal surfaces: reachable, unnamed by phase, and last on the page. */
const TEAMS: { key: TranslationKey; href: string }[] = [
  { key: 'console.operator', href: '/operator' },
  { key: 'console.staff', href: '/staff' },
  { key: 'console.finance', href: '/finance' },
  { key: 'console.admin', href: '/admin' },
];

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  // One call, two uses: the cards below and the departure list in the hero. `featured` first because an operator
  // pays for that placement, and falling back to soonest is the search function's job, not this page's.
  const [governorates, page] = await Promise.all([
    loadPublicGovernorates(),
    loadPublicTrips(locale, {}, { sort: 'featured', limit: 6 }),
  ]);

  const featured = page.items.slice(0, 6);
  const nextDepartures = page.items.slice(0, 3);
  // Only destinations with more than one departure are "popular"; below that the section is a wall of "1 trip"
  // chips, which is noise dressed as data. Three or more of them, or the section does not render at all.
  const destinations = [...page.facets.destinations]
    .filter((destination) => destination.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const showDestinations = destinations.length >= 3;

  return (
    <>
      <SiteHeader locale={locale} />

      <main id="main">
        <section className="hero">
          <div className="shell hero__grid">
            <div>
              <span className="eyebrow">
                <span aria-hidden="true">◆</span>
                {t('home.eyebrow')}
              </span>
              <h1>{t('home.heroTitle')}</h1>
              <p className="lead">{t('home.heroSubtitle')}</p>

              {/* Above everything else, because on a phone this is the whole page: where from, where to, when —
                  and the result is a URL, not a modal. */}
              <TripSearchForm locale={locale} governorates={governorates} />

              <ul className="trust-row">
                {TRUST.map((item) => (
                  <li key={item.key}>
                    <span className="trust-row__tick" aria-hidden="true">
                      {item.icon}
                    </span>
                    {t(item.key)}
                  </li>
                ))}
              </ul>
            </div>

            {/* Real departures, not a promise: three rows a visitor can tap through to a seat. */}
            <aside className="hero__aside" aria-labelledby="next-departures">
              <div className="hero__aside-head">
                <h2 id="next-departures">{t('home.nextDepartures')}</h2>
                <Link className="link-more" href={`/${locale}/trips`}>
                  {t('home.allTrips')}
                </Link>
              </div>

              {nextDepartures.length === 0 ? (
                <p className="hero__aside-empty">{t('home.noTrips')}</p>
              ) : (
                <ul className="departure-list">
                  {nextDepartures.map((trip) => {
                    const when = departureLabel(trip.departureAt, locale);
                    return (
                      <li key={trip.id}>
                        <Link className="departure" href={`/${locale}/trips/${trip.code}`}>
                          <span className="departure__route">
                            {trip.origin.name} <span aria-hidden="true">→</span>{' '}
                            {trip.destination.name}
                          </span>
                          <span className="departure__meta">
                            {when.date} · <bdi>{when.time}</bdi>
                          </span>
                          <span className="departure__foot">
                            <span className="departure__price num">
                              {trip.priceFromYer == null
                                ? '—'
                                : formatMinor(trip.priceFromYer, 'YER', { locale })}
                            </span>
                            <span
                              className={
                                trip.seatsAvailable > 0
                                  ? 'departure__seats'
                                  : 'departure__seats is-out'
                              }
                            >
                              {trip.seatsAvailable > 0
                                ? t('trips.seatsAvailable', { count: trip.seatsAvailable })
                                : t('trips.badgeSoldOut')}
                            </span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </aside>
          </div>
        </section>

        <section className="section" id="trips" aria-labelledby="featured-heading">
          <div className="shell">
            <div className="section__head section__head--row">
              <div>
                <h2 id="featured-heading">{t('home.sectionFeatured')}</h2>
                <p>{t('home.sectionFeaturedBody')}</p>
              </div>
              <Link className="link-more" href={`/${locale}/trips`}>
                {t('home.allTrips')}
              </Link>
            </div>

            {featured.length === 0 ? (
              <div className="empty-panel">
                <p className="empty-panel__title">{t('home.noTrips')}</p>
                <p className="empty-panel__body">{t('home.noTripsBody')}</p>
                <Link className="btn btn--ghost" href={`/${locale}/trips`}>
                  {t('home.allTrips')}
                </Link>
              </div>
            ) : (
              <div className="trips-grid">
                {featured.map((trip) => (
                  <PublicTripCard
                    key={trip.id}
                    locale={locale}
                    trip={trip}
                    href={`/${locale}/trips/${trip.code}`}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        {showDestinations ? (
          <section
            className="section section--muted"
            id="destinations"
            aria-labelledby="destinations-heading"
          >
            <div className="shell">
              <div className="section__head">
                <h2 id="destinations-heading">{t('home.sectionDestinations')}</h2>
                <p>{t('home.sectionDestinationsBody')}</p>
              </div>
              <ul className="destinations">
                {destinations.map((destination) => (
                  <li key={destination.id}>
                    <Link
                      className="destination-chip"
                      href={`/${locale}/trips?destination=${destination.id}`}
                    >
                      <span className="destination-chip__name">{destination.name}</span>
                      <span className="destination-chip__count num">
                        {t('home.tripsToDestination', { count: destination.count })}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        <section className="section" id="how" aria-labelledby="how-heading">
          <div className="shell">
            <div className="section__head">
              <h2 id="how-heading">{t('home.sectionHow')}</h2>
            </div>
            <ol className="steps">
              {STEPS.map((step, index) => (
                <li className="step" key={step.title}>
                  <span className="step__num num" aria-hidden="true">
                    {index + 1}
                  </span>
                  <h3>{t(step.title)}</h3>
                  <p>{t(step.body)}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="section section--muted" id="price" aria-labelledby="price-heading">
          <div className="shell price-grid">
            <div className="section__head">
              <h2 id="price-heading">{t('home.sectionPrice')}</h2>
              <p>{t('home.sectionPriceBody')}</p>
            </div>
            <FareCalculator locale={locale} />
          </div>
        </section>

        <section className="section" id="operators" aria-labelledby="operators-heading">
          <div className="shell">
            <div className="operator-band">
              <div>
                <h2 id="operators-heading">{t('home.operatorTitle')}</h2>
                <p>{t('home.operatorBody')}</p>
              </div>
              <Link className="btn btn--primary" href={`/${locale}/operator`}>
                {t('home.operatorCta')}
              </Link>
            </div>
          </div>
        </section>

        <section className="section teams" id="teams" aria-labelledby="teams-heading">
          <div className="shell teams__inner">
            <div>
              <h2 id="teams-heading">{t('home.teamsTitle')}</h2>
              <p>{t('home.teamsBody')}</p>
            </div>
            <ul className="teams__links">
              {TEAMS.map((team) => (
                <li key={team.href}>
                  <Link className="teams__link" href={`/${locale}${team.href}`}>
                    {t(team.key)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <SiteFooter locale={locale} />
    </>
  );
}
