import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  activeFilterCount,
  isLocale,
  readTripFilters,
  searchSuffix,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { EmptyState } from '@/components/ui/Feedback';
import { FilterDisclosure } from '@/components/trips/FilterDisclosure';
import { PublicTripCard } from '@/components/trips/PublicTripCard';
import { loadPublicTrips } from '@/lib/trips';
import { tripsMetadata } from '@/lib/seo';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return isLocale(locale) ? tripsMetadata(locale) : {};
}

const SORTS = ['soonest', 'cheapest', 'featured'] as const;
const GENDERS = ['any', 'women_only', 'men_only'] as const;

/**
 * The marketplace.
 *
 * Server-rendered from `search_public_trips`, with the filters in the URL — which is what makes a result
 * shareable, cacheable and usable before JavaScript loads. The filter panel is a plain GET form inside a
 * disclosure: one collapsed row with a count on a phone, a sidebar on a desktop. The opening of that
 * disclosure is the one thing that cannot be CSS — a closed disclosure hides its own content and no
 * rule can undo it — so `FilterDisclosure` sets the attribute and the stylesheet hides the summary only
 * once it has (`data-enhanced`).
 */
export default async function TripsPage({
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

  const query = await searchParams;
  const state = readTripFilters(query);
  const activeCount = activeFilterCount(state);

  // The language switcher re-renders the same path in the other direction; without the query it would
  // silently drop every filter, which is exactly what "shareable in both locales" must not do.
  const suffix = searchSuffix(query, ['st']);

  const page = await loadPublicTrips(
    locale,
    {
      q: state.q,
      origin: state.origin,
      destination: state.destination,
      gender: state.gender as ('any' | 'women_only' | 'men_only')[] | undefined,
      booking: state.booking as ('per_seat' | 'whole_trip' | 'both')[] | undefined,
      direct: state.direct,
      priceMax: state.priceMax,
      dateFrom: state.dateFrom,
      dateTo: state.dateTo,
    },
    { sort: state.sort ?? 'soonest' },
  );

  const base = `/${locale}/trips`;

  // Keep every filter when paging: a "next" link that silently drops the search is a bug the user reads
  // as "there are no more results".
  const cursorHref = (() => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key === 'cursor' || value == null) continue;
      for (const item of Array.isArray(value) ? value : [value]) search.append(key, item);
    }
    if (page.nextCursor) search.set('cursor', page.nextCursor);
    return `${base}?${search.toString()}`;
  })();

  // The selected governorates are ids; the cards only carry codes, so the match is resolved once.
  const chosen = new Set([...(state.origin ?? []), ...(state.destination ?? [])]);
  const highlight = page.items.flatMap((trip) => [
    ...(chosen.has(trip.origin.id) ? [trip.origin.code] : []),
    ...(chosen.has(trip.destination.id) ? [trip.destination.code] : []),
  ]);

  return (
    <>
      <SiteHeader locale={locale} pathname="/trips" search={suffix} />
      <main id="main" className="shell">
        <PreviewBanner locale={locale} />

        <header className="trips-hero">
          <h1>{t('trips.search.title')}</h1>
          <p>{t('trips.search.subtitle')}</p>
        </header>

        <div className="trips-layout">
          <FilterDisclosure defaultOpen={activeCount > 0}>
            <summary>
              {t('trips.search.filter')}
              {activeCount > 0 ? <span className="trip-filters__count">{activeCount}</span> : null}
            </summary>
            <form method="get" action={base}>
              <div className="trip-filters__group">
                <label htmlFor="filter-q">{t('trips.search.q')}</label>
                <input
                  id="filter-q"
                  name="q"
                  type="search"
                  defaultValue={state.q ?? ''}
                  className="ui-input"
                />
              </div>

              <div className="trip-filters__group">
                <label htmlFor="filter-origin">{t('trips.origin')}</label>
                <select
                  id="filter-origin"
                  name="origin"
                  defaultValue={state.origin?.[0] ?? ''}
                  className="ui-select"
                >
                  <option value="">{t('trips.search.any')}</option>
                  {page.facets.origins.map((governorate) => (
                    <option key={governorate.id} value={governorate.id}>
                      {governorate.name} ({governorate.count})
                    </option>
                  ))}
                </select>
              </div>

              <div className="trip-filters__group">
                <label htmlFor="filter-destination">{t('trips.destination')}</label>
                <select
                  id="filter-destination"
                  name="destination"
                  defaultValue={state.destination?.[0] ?? ''}
                  className="ui-select"
                >
                  <option value="">{t('trips.search.any')}</option>
                  {page.facets.destinations.map((governorate) => (
                    <option key={governorate.id} value={governorate.id}>
                      {governorate.name} ({governorate.count})
                    </option>
                  ))}
                </select>
              </div>

              <fieldset className="trip-filters__group">
                <legend>{t('trips.genderPolicy')}</legend>
                <div className="trip-filters__options">
                  {GENDERS.map((value) => {
                    const facet = page.facets.genders.find((row) => row.value === value);
                    return (
                      <label className="trip-filters__option" key={value}>
                        <input
                          type="radio"
                          name="gender"
                          value={value}
                          defaultChecked={state.gender?.[0] === value}
                        />
                        <span>{t(`trips.gender.${value}` as TranslationKey)}</span>
                        <span className="trip-filters__count">{facet?.count ?? 0}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <div className="trip-filters__group">
                <label className="trip-filters__option" htmlFor="filter-direct">
                  <input
                    id="filter-direct"
                    type="checkbox"
                    name="direct"
                    value="1"
                    defaultChecked={state.direct === true}
                  />
                  <span>{t('trips.search.direct')}</span>
                  <span className="trip-filters__count">{page.facets.direct.direct}</span>
                </label>
              </div>

              <div className="trip-filters__group">
                <label htmlFor="filter-price">{t('trips.search.priceMax')}</label>
                <input
                  id="filter-price"
                  name="priceMax"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  defaultValue={state.priceMax ?? ''}
                  className="ui-input"
                />
              </div>

              <div className="trip-filters__group">
                <label htmlFor="filter-from">{t('trips.search.dateFrom')}</label>
                <input
                  id="filter-from"
                  name="dateFrom"
                  type="date"
                  defaultValue={state.dateFrom ?? ''}
                  className="ui-input"
                />
              </div>

              <div className="trip-filters__group">
                <label htmlFor="filter-to">{t('trips.search.dateTo')}</label>
                <input
                  id="filter-to"
                  name="dateTo"
                  type="date"
                  defaultValue={state.dateTo ?? ''}
                  className="ui-input"
                />
              </div>

              <div className="trip-filters__group">
                <label htmlFor="filter-sort">{t('trips.sortLabel')}</label>
                <select
                  id="filter-sort"
                  name="sort"
                  defaultValue={state.sort ?? 'soonest'}
                  className="ui-select"
                >
                  {SORTS.map((sort) => (
                    <option key={sort} value={sort}>
                      {t(`trips.sort.${sort}` as TranslationKey)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="trip-filters__actions">
                <button type="submit" className="ui-btn ui-btn--primary">
                  {t('trips.search.filter')}
                </button>
                <Link className="ui-btn ui-btn--ghost" href={base}>
                  {t('trips.search.clear')}
                </Link>
              </div>
            </form>
          </FilterDisclosure>

          <section aria-live="polite" aria-atomic="true" className="trips-results">
            <p className="trips-count" role="status">
              {t('trips.search.results', { count: page.total })}
            </p>

            {page.items.length === 0 ? (
              <EmptyState
                title={t('trips.search.noResults')}
                description={t('trips.search.subtitle')}
                action={
                  <Link className="btn btn--ghost" href={base}>
                    {t('trips.search.clear')}
                  </Link>
                }
              />
            ) : (
              <div className="trips-grid">
                {page.items.map((trip) => (
                  <PublicTripCard
                    key={trip.id}
                    locale={locale}
                    trip={trip}
                    href={`/${locale}/trips/${trip.code}`}
                    highlight={highlight}
                  />
                ))}
              </div>
            )}

            {page.nextCursor ? (
              <nav className="trips-pager" aria-label={t('trips.search.title')}>
                <Link className="ui-btn ui-btn--ghost" href={cursorHref}>
                  {t('trips.search.next')}
                </Link>
              </nav>
            ) : null}
          </section>
        </div>
      </main>
    </>
  );
}
