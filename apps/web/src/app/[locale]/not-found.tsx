import { headers } from 'next/headers';
import { isLocale, translate, DEFAULT_LOCALE, type Locale, type TranslationKey } from '@maak/core';
import { Icon } from '@/components/ui/Icon';

/**
 * The 404, as a page rather than a sentence.
 *
 * It used to be an `h1` and two buttons on bare paper: no brand, no way to the marketplace, and — on a desktop,
 * where the phone's tab bar is not rendered — no way anywhere at all. A not-found page is still a page of the
 * product, and its whole job is the next step.
 *
 * `notFound()` passes a `not-found.tsx` no route params, so the language comes from the header the proxy forwards
 * (`x-maak-locale`) — without it an English operator opening a deleted trip was apologised to in Arabic.
 */
export default async function NotFound() {
  const raw = (await headers()).get('x-maak-locale');
  const locale: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const t = (key: TranslationKey) => translate(locale, key);

  return (
    <main id="main" className="shell state-screen">
      <div className="state-screen__panel">
        <span className="state-screen__mark" aria-hidden="true">
          <Icon name="route" size={24} />
        </span>
        <p className="state-screen__code num">404</p>
        <h1>{t('errors.NOT_FOUND')}</h1>
        <p className="state-screen__body">{t('page.notFoundBody')}</p>
        <div className="state-screen__actions">
          <a className="btn btn--primary" href={`/${locale}`}>
            {t('nav.home')}
          </a>
          <a className="btn btn--ghost" href={`/${locale}/trips`}>
            {t('nav.trips')}
          </a>
        </div>
        <ul className="state-screen__links">
          <li>
            <a href={locale === 'ar' ? '/en' : '/ar'} hrefLang={locale === 'ar' ? 'en' : 'ar'}>
              {locale === 'ar' ? 'English' : 'العربية'}
            </a>
          </li>
        </ul>
      </div>
    </main>
  );
}
