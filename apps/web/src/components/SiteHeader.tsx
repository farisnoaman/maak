import Link from 'next/link';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import { Icon } from './ui/Icon';
import { LocaleSwitch } from './LocaleSwitch';
import { DetailsForDesktop } from './ui/DetailsForDesktop';
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
  /**
   * `search` may arrive either way: `searchSuffix()` in `@maak/core` returns a string that already starts
   * with `?`, and a hand-built caller usually does not. Prefixing blindly produced `/en/trips??sort=soonest`
   * — a link whose query key is literally `?sort`, so clicking "Trips" from a filtered marketplace silently
   * dropped the filters it was meant to keep. `LocaleSwitch` already normalised this; now both do, the same way.
   */
  const suffix = search && !search.startsWith('?') ? `?${search}` : search;
  /**
   * Filters belong to the list they filter. Keeping them on every link meant `/account?sort=soonest&direct=1`
   * — a sort order on a page with nothing to sort, and a sign-in link carrying a marketplace query a visitor
   * would then see in their history. Only the link that stays on this list carries them.
   */
  const withQuery = (path: string) => `/${locale}${path}${path === pathname ? suffix : ''}`;
  /**
   * Where the visitor is standing, marked in the navigation itself.
   *
   * The header was four identical links on every page: the way to tell you were on the marketplace was to read
   * the page you had just landed on. `aria-current="page"` is the same fact for a screen reader, and it is what
   * the underline is drawn from — one attribute, two audiences.
   */
  const isCurrent = (path: string) =>
    path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`);

  /**
   * Four links, and the language switch.
   *
   * It used to be eight: the vehicles console and the component styleguide were in here, next to the two legal
   * documents. A primary navigation is a list of places a *visitor* goes — a developer tool and one screen of an
   * operator's console are not, and neither is a privacy policy, which belongs in the footer where people look for
   * it. Nothing was deleted: `SiteFooter` links all of them, on every public page.
   */
  const links: { key: TranslationKey; href: string }[] = [
    { key: 'nav.home', href: `/${locale}` },
    // The marketplace is the product's front door for a visitor with no account; it must be reachable
    // from every page, not only by typing the URL.
    { key: 'nav.trips', href: withQuery('/trips') },
    { key: 'nav.account', href: withQuery('/account') },
    { key: 'nav.signIn', href: withQuery('/auth/sign-in') },
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

        <nav className="site-nav" aria-label={t('nav.primary')}>
          {/*
            `suppressHydrationWarning` because `open` belongs to whoever opened the menu: the browser restores
            it on reload and on back/forward navigation, before hydration runs, so the DOM legitimately differs
            from the server HTML. The same reasoning is written out at length in
            `components/trips/FilterDisclosure.tsx`; here nothing sets the attribute in JavaScript at all.
          */}
          <details className="site-menu" id="site-menu" suppressHydrationWarning>
            <summary className="site-menu__toggle" aria-label={t('nav.menu')}>
              {/* Two draws, one visible: the toggle says "menu" closed and "close" open. It used to be the
                  character `☰`, which stayed `☰` while the menu was open. */}
              <span className="site-menu__glyphs" aria-hidden="true">
                <Icon name="menu" size={20} className="site-menu__glyph site-menu__glyph--open" />
                <Icon name="close" size={20} className="site-menu__glyph site-menu__glyph--close" />
              </span>
              <span className="site-menu__label">{t('nav.menu')}</span>
            </summary>
            <div className="site-menu__links">
              {links.map((link) => {
                const path = link.href.slice(locale.length + 1).split('?')[0] || '/';
                const current = isCurrent(path);
                /* The last link is the one a stranger is here to take: it is a button, not another item in a row
                   of the same grey words. Everything else stays quiet so the button is the only loud thing. */
                const cta = path === '/auth/sign-in';
                const className = [
                  'nav-link',
                  cta ? 'nav-link--cta' : '',
                  current ? 'nav-link--current' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <Link
                    className={className}
                    key={link.href}
                    href={link.href}
                    aria-current={current ? 'page' : undefined}
                  >
                    {t(link.key)}
                  </Link>
                );
              })}
              {/* Only renders inside an iframe: a first-party tab if the browser blocks the session here. */}
              <OpenInTab locale={locale} path={`/${locale}/auth/sign-in`} />
            </div>
          </details>
        </nav>

        {/* Above 720px the links are laid out inline and the summary is hidden — which is only true if the panel
            is actually open. `::details-content` paints it; this puts the `open` attribute on it, which is what
            screen readers read. See the component for the whole story. */}
        <DetailsForDesktop id="site-menu" breakpoint={720} />

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
