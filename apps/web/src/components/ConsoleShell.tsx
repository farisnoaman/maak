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
 * *-console layout shared by operator, staff and admin.
 *
 * One component means one place to change navigation, one place to add a permission gate, and no drift between
 * consoles. Items are filtered by the caller (server-side), never hidden in the client as a security measure.
 *
 * Four things changed in the polish pass, all of them visible defects:
 *
 *  - **The phase badge is gone.** Every screen carried `<Phase N>` next to its title, and the four staff screens
 *    disagreed about N (7, 4, 3, 1) — build bookkeeping shown to the person doing the work. Progress belongs in
 *    `IMPLEMENTATION_PLAN.md`, and an unfinished screen says so in its own words.
 *  - **The console name and the page title are separate.** Both came from `title`, so `/staff/verifications`
 *    printed "Verification review" as the sidebar heading, as the `<h1>`, and again on the link that got you
 *    there. `consoleTitle` names the console; `title` names the page.
 *  - **The active item is marked.** The stylesheet has styled `[aria-current='page']` since the first console,
 *    and nothing ever set the attribute — so the sidebar never showed where you were.
 *  - **Grouping and actions.** `groups` lets a console say *today / review / reference* instead of nine flat
 *    links, and `actions` puts a page's primary verb next to its title rather than buried in the content.
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
  /** Locale-less path of the current page, e.g. `/staff/dashboard`. Used only to mark the active nav item. */
  readonly pathname?: string;
  readonly items?: readonly ConsoleNavItem[];
  readonly groups?: readonly ConsoleNavGroup[];
  readonly actions?: ReactNode;
  /**
   * `content` is one full-width column — the right shape for a table, a form or a list. `tiles` is the
   * auto-filling card grid the overview screens use. The old default was the tile grid, which silently
   * rendered every content page inside a 220px track.
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
        {/* Not an <h1>: the page has exactly one, inside the panel. */}
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

      <section className="card console-panel">
        <header className="console-panel__head">
          <h1>{t(title)}</h1>
          {actions ? <div className="console-panel__actions">{actions}</div> : null}
        </header>
        <p className="console-panel__subtitle">{t(subtitle)}</p>
        <div className={layout === 'tiles' ? 'console-grid console-grid--tiles' : 'console-grid'}>
          {children}
        </div>
      </section>
    </main>
  );
}
