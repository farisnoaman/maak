import Link from 'next/link';
import type { ReactNode } from 'react';
import { translate, type Locale, type TranslationKey } from '@maak/core';

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

  return (
    <main id="main" className="shell console-layout">
      <aside className="console-side">
        {/* Not an <h1>: the page has exactly one, in the header band. */}
        <p className="console-side__brand">{t(brand)}</p>
        <nav className="console-nav" aria-label={t(brand)}>
          {sections.map((section) => (
            <div className="console-nav__group" key={section.key}>
              {groups ? <p className="console-nav__label">{t(section.key)}</p> : null}
              {section.items.map((item) => {
                const active = current !== null && item.href === current;
                return (
                  <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}>
                    {t(item.key)}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
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
