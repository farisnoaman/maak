import { translate, type Locale, type TranslationKey } from '@maak/core';

/**
 * The search a phone user actually starts with.
 *
 * A plain GET form: no JavaScript, no client state, and the result is a URL that can be shared, opened on
 * another device, or bookmarked — the three things a search box on a travel home page exists to produce.
 * The field names are the names `readTripFilters()` already reads (`origin`, `destination`, `dateFrom`), so
 * the home page and the filter panel cannot drift apart into two vocabularies.
 *
 * It is designed at 320px: three stacked fields, a full-width button, then a row at 640px.
 */
export function TripSearchForm({
  locale,
  governorates,
}: {
  readonly locale: Locale;
  readonly governorates: readonly { id: string; nameAr: string; nameEn: string | null }[];
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const name = (governorate: { nameAr: string; nameEn: string | null }) =>
    (locale === 'ar' ? governorate.nameAr : (governorate.nameEn ?? governorate.nameAr)) || '—';

  if (governorates.length === 0) return null;

  return (
    <form className="hero-search" method="get" action={`/${locale}/trips`} role="search">
      <div className="hero-search__field">
        <label htmlFor="hero-origin">{t('trips.origin')}</label>
        <select id="hero-origin" name="origin" className="ui-select" defaultValue="">
          <option value="">{t('trips.search.any')}</option>
          {governorates.map((governorate) => (
            <option key={governorate.id} value={governorate.id}>
              {name(governorate)}
            </option>
          ))}
        </select>
      </div>

      <div className="hero-search__field">
        <label htmlFor="hero-destination">{t('trips.destination')}</label>
        <select id="hero-destination" name="destination" className="ui-select" defaultValue="">
          <option value="">{t('trips.search.any')}</option>
          {governorates.map((governorate) => (
            <option key={governorate.id} value={governorate.id}>
              {name(governorate)}
            </option>
          ))}
        </select>
      </div>

      <div className="hero-search__field">
        <label htmlFor="hero-date">{t('trips.search.dateFrom')}</label>
        <input
          id="hero-date"
          name="dateFrom"
          type="date"
          className="ui-input"
          inputMode="numeric"
        />
      </div>

      <button type="submit" className="ui-btn ui-btn--primary hero-search__submit">
        {t('trips.search.submit')}
      </button>
    </form>
  );
}
