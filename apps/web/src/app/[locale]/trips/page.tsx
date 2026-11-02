import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  activeFilterCount,
  filterHref,
  formatMinor,
  isLocale,
  readTripFilters,
  type SavedSearchFilters,
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
import { SaveSearchControl } from '@/components/trips/SaveSearchControl';
import { loadPublicGovernorates, loadPublicTrips } from '@/lib/trips';
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

  const [governorates, page] = await Promise.all([
    loadPublicGovernorates(),
    loadPublicTrips(
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
    ),
  ]);

  const base = `/${locale}/trips`;

  /**
   * The URL with some filters removed and others kept.
   *
   * Delegates to `filterHref()` in `@maak/core`, which always drops `st` (the session token) and `cursor`
   * (a position in *this* result set) — see the note there. Doing it here by hand is how every link on this
   * page ended up carrying the token, and why the sort tabs reported a hydration mismatch.
   */
  const hrefWith = (options: {
    drop?: readonly string[];
    dropValue?: { key: string; value: string };
    sort?: string;
  }): string =>
    filterHref(base, query, {
      drop: options.drop,
      dropValue: options.dropValue,
      set: options.sort ? { sort: options.sort } : undefined,
    });

  /**
   * What is currently filtering this list, as chips a person can take off one at a time.
   *
   * On a phone the filter panel is collapsed, so before this the only sign a filter was applied was the count on
   * the summary — and the only way to undo one of five was "clear" and start again.
   */
  const applied: { key: string; label: string; href: string }[] = [];
  const nameOf = (id: string) =>
    governorates.find((governorate) => governorate.id === id)?.[
      locale === 'ar' ? 'nameAr' : 'nameEn'
    ] ??
    governorates.find((governorate) => governorate.id === id)?.nameAr ??
    // Last resort is the facet (which carries the localised name) and then the id, so a chip is never blank.
    page.facets.origins.find((facet) => facet.id === id)?.name ??
    page.facets.destinations.find((facet) => facet.id === id)?.name ??
    id;

  if (state.q) {
    applied.push({
      key: 'q',
      label: `«${state.q}»`,
      href: hrefWith({ drop: ['q'] }),
    });
  }
  for (const id of state.origin ?? []) {
    applied.push({
      key: `origin:${id}`,
      label: `${t('trips.origin')}: ${nameOf(id)}`,
      href: hrefWith({ dropValue: { key: 'origin', value: id } }),
    });
  }
  for (const id of state.destination ?? []) {
    applied.push({
      key: `destination:${id}`,
      label: `${t('trips.destination')}: ${nameOf(id)}`,
      href: hrefWith({ dropValue: { key: 'destination', value: id } }),
    });
  }
  for (const value of state.gender ?? []) {
    if (value === 'any') continue;
    applied.push({
      key: `gender:${value}`,
      label: t(`trips.gender.${value}` as TranslationKey),
      href: hrefWith({ dropValue: { key: 'gender', value } }),
    });
  }
  if (state.direct) {
    applied.push({
      key: 'direct',
      label: t('trips.search.direct'),
      href: hrefWith({ drop: ['direct'] }),
    });
  }
  if (state.priceMax != null) {
    applied.push({
      key: 'priceMax',
      label: `${t('trips.search.priceMax')}: ${formatMinor(state.priceMax, 'YER', { locale })}`,
      href: hrefWith({ drop: ['priceMax'] }),
    });
  }
  if (state.dateFrom) {
    applied.push({
      key: 'dateFrom',
      label: `${t('trips.search.dateFrom')}: ${state.dateFrom}`,
      href: hrefWith({ drop: ['dateFrom'] }),
    });
  }
  if (state.dateTo) {
    applied.push({
      key: 'dateTo',
      label: `${t('trips.search.dateTo')}: ${state.dateTo}`,
      href: hrefWith({ drop: ['dateTo'] }),
    });
  }
  const currentSort = state.sort ?? 'soonest';

  // Keep every filter when paging: a "next" link that silently drops the search is a bug the user reads
  // as "there are no more results". `filterHref` also drops the token and sets the new cursor.
  const cursorHref = filterHref(base, query, { set: { cursor: page.nextCursor } });

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
        {!page.configured ? <PreviewBanner locale={locale} /> : null}

        <header className="trips-hero">
          <h1>{t('trips.search.title')}</h1>
          <p>{t('trips.search.subtitle')}</p>
          {/* Phase 11: the search on screen can become an alert, with the same predicate — not a
              re-typed approximation of it. */}
          <SaveSearchControl
            locale={locale}
            filters={{
              q: state.q,
              origin: state.origin,
              destination: state.destination,
              gender: state.gender as SavedSearchFilters['gender'],
              booking: state.booking as SavedSearchFilters['booking'],
              direct: state.direct,
              priceMax: state.priceMax,
              dateFrom: state.dateFrom,
              dateTo: state.dateTo,
            }}
          />
        </header>

        <div className="trips-layout">
          <FilterDisclosure>
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

              {/* Sort is not a filter: it does not narrow the list, and hiding it in a collapsed panel made the
                  cheapest trip three taps away. The visible control is the row of links above the results; this
                  hidden input is what keeps the chosen order when the filters are submitted. */}
              <input type="hidden" name="sort" value={currentSort} />

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
            <div className="trips-toolbar">
              <p className="trips-count" role="status">
                {t('trips.search.results', { count: page.total })}
              </p>
              <nav className="trips-sort" aria-label={t('trips.sortLabel')}>
                {SORTS.map((sort) => (
                  <Link
                    key={sort}
                    href={hrefWith({ sort })}
                    className="trips-sort__link"
                    aria-current={currentSort === sort ? 'true' : undefined}
                  >
                    {t(`trips.sort.${sort}` as TranslationKey)}
                  </Link>
                ))}
              </nav>
            </div>

            {applied.length > 0 ? (
              <ul className="filter-chips" aria-label={t('trips.search.applied')}>
                {applied.map((chip) => (
                  <li key={chip.key}>
                    <Link className="filter-chip" href={chip.href}>
                      <span>{chip.label}</span>
                      <span className="filter-chip__x" aria-hidden="true">
                        ✕
                      </span>
                      <span className="sr-only">
                        {t('trips.search.removeFilter', { name: chip.label })}
                      </span>
                    </Link>
                  </li>
                ))}
                {applied.length > 1 && page.items.length > 0 ? (
                  <li>
                    <Link className="filter-chip filter-chip--clear" href={base}>
                      {t('trips.search.clearAll')}
                    </Link>
                  </li>
                ) : null}
              </ul>
            ) : null}

            {page.items.length === 0 ? (
              <EmptyState
                title={t('trips.search.noResults')}
                description={t('trips.search.noResultsBody')}
                action={
                  applied.length > 0 ? (
                    <Link className="btn btn--ghost" href={base}>
                      {t('trips.search.clearAll')}
                    </Link>
                  ) : null
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
