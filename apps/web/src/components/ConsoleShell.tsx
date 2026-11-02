import Link from 'next/link';
import type { ReactNode } from 'react';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import { Icon } from './ui/Icon';

export interface ConsoleNavItem {
  readonly key: TranslationKey;
  readonly href: string;
}

export interface ConsoleNavGroup {
  readonly key: TranslationKey;
  readonly items: readonly ConsoleNavItem[];
}

/**
 * The console shell — one layout for operator, staff, finance and admin.
 *
 * **It is a page, not a card.** The panel used to be `card console-panel`, a bordered, shadowed box, and every
 * screen put its own cards inside it: a card in a card, two frames around the same content, one of them costing
 * 24px of padding on each edge and a shadow that drew the eye to the frame instead of the data. The frame is gone.
 * What is left is a page: a header band (title, subtitle, the page's primary action) sitting on the page surface,
 * a hairline under it, and the content below on that same surface, divided by rules rather than boxed into tiles.
 *
 * The sections inside keep their own `h2`s so the page still has an outline — a screen reader lands on "Awaiting
 * review" instead of one undifferentiated block — but the boxes those headings used to sit in are flat
 * (`.console-body > .card`), so there is exactly one frame on the screen: the browser window.
 *
 * **The navigation is one list, presented two ways.** Above 900px it is a sticky sidebar: the console's name,
 * then its groups, then one row per destination. On a phone it is a single row that says *where you are* —
 * "Administration · Regions" — opened by tap into the same list. It used to be nine chips wrapped three rows deep
 * above every page title, which cost the top third of a phone screen and read as a tag cloud rather than a console.
 * The mechanism is the one the site header already uses: a native `<details>`, so it opens without a line of
 * JavaScript and is keyboard-operable for free; above the breakpoint the summary is hidden and the list is forced
 * visible, because authored `display` beats the UA rule that hides a closed disclosure's children.
 */
export function ConsoleShell({
  locale,
  title,
  subtitle,
  consoleTitle,
  pathname,
  items,
  groups,
  actions,
  layout = 'content',
  children,
}: {
  readonly locale: Locale;
  readonly title: TranslationKey;
  readonly subtitle: TranslationKey;
  /** The console this page belongs to — the sidebar heading. Defaults to the page title for single-page consoles. */
  readonly consoleTitle?: TranslationKey;
  /** Locale-less path of the current page, e.g. `/admin/places`. Used only to mark the active nav item. */
  readonly pathname?: string;
  readonly items?: readonly ConsoleNavItem[];
  readonly groups?: readonly ConsoleNavGroup[];
  /** The page's primary verb — beside the title, where a console puts its action, not buried in the content. */
  readonly actions?: ReactNode;
  /**
   * `content` is one full-width column: the right shape for a table, a form or a list. `tiles` is the auto-filling
   * grid the overview screens use.
   */
  readonly layout?: 'content' | 'tiles';
  readonly children: ReactNode;
}) {
  const t = (key: TranslationKey) => translate(locale, key);

  const sections: readonly ConsoleNavGroup[] = groups ?? (items ? [{ key: title, items }] : []);
  const current = pathname ? `/${locale}${pathname}` : null;
  const brand = consoleTitle ?? title;
  /* The menu's second line: the destination you are standing on, named. Falls back to the console's own name. */
  const currentKey =
    sections.flatMap((section) => section.items).find((item) => item.href === current)?.key ??
    brand;

  return (
    <main id="main" className="shell console-layout">
      <aside className="console-side">
        {/*
          The way out, for a desktop.
          A console used to be a room with no door: the sidebar named the console and nothing named the product, so
          the only route back to the public site was to edit the address bar (a phone at least has the tab bar). The
          lockup is the same one the site header uses, so the two halves of the product share an identity — and it
          is hidden on a phone, where the header row above already says where you are.
        */}
        <Link className="console-side__home" href={`/${locale}`}>
          <span className="brand__mark" aria-hidden="true">
            {t('common.brandMark')}
          </span>
          <span>{t('common.appName')}</span>
        </Link>
        {/* Not an <h1>: the page has exactly one, in the header band. Shown beside the sidebar, not in the menu. */}
        <p className="console-side__brand">{t(brand)}</p>

        <details className="console-menu" suppressHydrationWarning>
          <summary className="console-menu__toggle">
            <span className="console-menu__text">
              <span className="console-menu__brand">{t(brand)}</span>
              <span className="console-menu__current">{t(currentKey)}</span>
            </span>
            <span className="console-menu__glyphs" aria-hidden="true">
              <Icon
                name="menu"
                size={18}
                className="console-menu__glyph console-menu__glyph--open"
              />
              <Icon
                name="close"
                size={18}
                className="console-menu__glyph console-menu__glyph--close"
              />
            </span>
          </summary>

          <nav className="console-nav" aria-label={t(brand)}>
            {sections.map((section) => (
              <div className="console-nav__group" key={section.key}>
                {groups ? <p className="console-nav__label">{t(section.key)}</p> : null}
                {section.items.map((item) => {
                  const active = current !== null && item.href === current;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                    >
                      {t(item.key)}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>
        </details>
      </aside>

      <div className="console-main">
        <header className="console-head">
          <div className="console-head__text">
            <h1>{t(title)}</h1>
            <p className="console-head__sub">{t(subtitle)}</p>
          </div>
          {actions ? <div className="console-head__actions">{actions}</div> : null}
        </header>
        <div className={layout === 'tiles' ? 'console-body console-body--tiles' : 'console-body'}>
          {children}
        </div>
      </div>
    </main>
  );
}
