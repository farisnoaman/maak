import Link from 'next/link';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import { LocaleSwitch } from './LocaleSwitch';
import { OpenInTab } from './OpenInTab';

/**
 * Shared header for every page. Server-rendered: navigation and the language switcher work
 * without JavaScript, and the switcher receives the current query string so filters survive.
 *
 * Mobile-first: below 720px the links live behind a `<details>` disclosure, which opens without a
 * line of JavaScript and is keyboard-operable out of the box. Above 720px the `<summary>` is hidden
 * and the same links render inline — one navigation, two presentations, no duplicated links to
 * confuse a screen reader or a crawler.
 */
export function SiteHeader({
  locale,
  pathname = '/',
  search = '',
}: {
  readonly locale: Locale;
  readonly pathname?: string;
  readonly search?: string;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const withQuery = (path: string) => `/${locale}${path}${search ? `?${search}` : ''}`;

  const links: { key: TranslationKey; href: string }[] = [
    { key: 'nav.home', href: `/${locale}` },
    // The marketplace is the product's front door for a visitor with no account; it must be reachable
    // from every page, not only by typing the URL.
    { key: 'nav.trips', href: withQuery('/trips') },
    { key: 'console.navVehicles', href: withQuery('/operator/vehicles') },
    { key: 'nav.styleguide', href: withQuery('/styleguide') },
    { key: 'nav.signIn', href: withQuery('/auth/sign-in') },
    { key: 'nav.account', href: withQuery('/account') },
  ];

  return (
    <header className="site-header">
      <div className="shell site-header__inner">
        <Link className="brand" href={`/${locale}`}>
          <span className="brand__mark" aria-hidden="true">
            {t('common.brandMark')}
          </span>
          <span className="brand__text">
            {t('common.appName')}
            <span className="brand__sub">{t('common.tagline')}</span>
          </span>
        </Link>

        <span className="header__spacer" />

        <nav className="site-nav" aria-label={t('home.sectionConsoles')}>
          {/*
            `suppressHydrationWarning` because `open` belongs to whoever opened the menu: the browser restores
            it on reload and on back/forward navigation, before hydration runs, so the DOM legitimately differs
            from the server HTML. The same reasoning is written out at length in
            `components/trips/FilterDisclosure.tsx`; here nothing sets the attribute in JavaScript at all.
          */}
          <details className="site-menu" suppressHydrationWarning>
            <summary className="site-menu__toggle" aria-label={t('nav.menu')}>
              <span aria-hidden="true">☰</span>
              <span className="site-menu__label">{t('nav.menu')}</span>
            </summary>
            <div className="site-menu__links">
              {links.map((link) => (
                <Link className="nav-link" key={link.href} href={link.href}>
                  {t(link.key)}
                </Link>
              ))}
              {/* Only renders inside an iframe: a first-party tab if the browser blocks the session here. */}
              <OpenInTab locale={locale} path={withQuery('/auth/sign-in')} />
            </div>
          </details>
        </nav>

        <LocaleSwitch
          current={locale}
          label={t('common.language')}
          pathname={pathname}
          search={search}
        />
      </div>
    </header>
  );
}
