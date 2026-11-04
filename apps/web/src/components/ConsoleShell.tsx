import Link from 'next/link';
import type { ReactNode } from 'react';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import { Icon, type IconName } from './ui/Icon';

export interface ConsoleNavItem {
  readonly key: TranslationKey;
  readonly href: string;
  /**
   * The mark beside the label. Optional, and per console rather than per row: a strip where three destinations have
   * a glyph and seven do not looks like a page missing its images, so the shell only paints icons when the console
   * declares them for its whole list (see `.console-nav--icons`).
   */
  readonly icon?: IconName;
}

export interface ConsoleNavGroup {
  readonly key: TranslationKey;
  readonly items: readonly ConsoleNavItem[];
}

/** A number from this screen's own data. `href` turns the whole card into the door to what produced it. */
export interface ConsoleFact {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly href?: string;
  readonly tone?: 'warning';
}

/**
 * The console shell — one layout for operator, staff, finance and admin.
 *
 * **It is a dashboard, not a document with a menu beside it.** Two shapes were tried before this one and both were
 * wrong in the same direction: the page carried a frame that was not its content. The bordered `console-panel` put
 * a card around every screen; the deep-forest sidebar that replaced it put the *navigation* in a panel as heavy as
 * the page, and paid a permanent 236px column for it — so on a laptop the data got two thirds of the width and the
 * rail got the eye, on every screen, forever.
 *
 * This one gives the width back. The navigation is a **bar across the top**: the console's name and its groups in
 * one strip, directly visible (no disclosure, no hamburger), scrollable sideways on a phone rather than folded away.
 * Below it the page is a **grid** — the title and the verb on one line, the figures as a **KPI strip**, and the
 * sections underneath in two columns that collapse to one on a narrow screen. Sections are panels: a hairline, a
 * radius, the paper surface, a heading and a count. Anything itemised inside a section keeps its own smaller card,
 * which is two levels of nesting and the limit.
 *
 * **Two columns only where two columns help.** A table, a list or a form wants the full width, and gets it: a
 * section that contains a `.table-scroll`, a `table` or a form spans both tracks by construction (`:has()`), so a
 * page of one table is not a page with an empty column beside it. `layout="tiles"` is the denser auto-fill grid the
 * hub screens use instead.
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
  facts,
  layout = 'content',
  children,
}: {
  readonly locale: Locale;
  readonly title: TranslationKey;
  readonly subtitle: TranslationKey;
  /** The console this page belongs to — the bar's heading. Defaults to the page title for single-page consoles. */
  readonly consoleTitle?: TranslationKey;
  /** Locale-less path of the current page, e.g. `/admin/places`. Used to mark the active nav item. */
  readonly pathname?: string;
  readonly items?: readonly ConsoleNavItem[];
  readonly groups?: readonly ConsoleNavGroup[];
  /** The page's primary verb — in the title row, where a console puts its action. */
  readonly actions?: ReactNode;
  /**
   * Two to five numbers from this screen's own data, in the strip under the title.
   *
   * A dashboard should answer "how much" before it is read: three live subscriptions, 37 events, one region. They
   * are cards in a grid, not a sentence — the strip is scanned, not parsed.
   */
  readonly facts?: readonly ConsoleFact[];
  /**
   * `content` is the two-column section grid; `tiles` is the auto-filling grid the hub screens use; `single` is one
   * full-width column for a screen that is one long table.
   */
  readonly layout?: 'content' | 'tiles' | 'single';
  readonly children: ReactNode;
}) {
  const t = (key: TranslationKey) => translate(locale, key);

  const sections: readonly ConsoleNavGroup[] = groups ?? (items ? [{ key: title, items }] : []);
  const current = pathname ? `/${locale}${pathname}` : null;
  const brand = consoleTitle ?? title;

  /**
   * The destination you are standing on, by the longest prefix — not by exact match.
   *
   * A console is a tree: `/admin/users/deletions` is a screen *inside* Users, `/admin/regions/new` is Regions at the
   * moment of adding one. Resolving the prefix here means a page never has to paint its own row by hand, and the
   * sub-screens that once lit up nothing now name themselves.
   */
  const flat = sections.flatMap((section) => section.items.map((item) => ({ ...item, section })));
  const active = current
    ? flat
        .filter((item) => current === item.href || current.startsWith(`${item.href}/`))
        .sort((a, b) => b.href.length - a.href.length)[0]
    : undefined;

  /* Icons are a console's choice, not a row's: see `ConsoleNavItem.icon`. */
  const hasIcons = flat.some((item) => item.icon !== undefined);

  const bodyClass =
    layout === 'tiles'
      ? 'console-body console-body--tiles'
      : layout === 'single'
        ? 'console-body console-body--single'
        : 'console-body';

  return (
    <main id="main" className="shell console-layout">
      {/*
        The bar. The product's mark, the console's name, and every destination in one strip — visible at every
        width, scrolling sideways on a phone instead of folding into a menu. For sighted keyboard users this is also
        the fastest way across the console: two or three tabs, no panel to open first.
      */}
      <header className="console-bar">
        <div className="console-bar__id">
          <Link className="console-bar__brand" href={`/${locale}`}>
            <span className="brand__mark" aria-hidden="true">
              {t('common.brandMark')}
            </span>
            <span className="console-bar__product">{t('common.appName')}</span>
          </Link>
          <span className="console-bar__sep" aria-hidden="true">
            /
          </span>
          <span className="console-bar__console">{t(brand)}</span>
        </div>

        <nav
          className={hasIcons ? 'console-nav console-nav--icons' : 'console-nav'}
          aria-label={t(brand)}
        >
          {sections.map((section) => (
            <div className="console-nav__group" key={section.key}>
              {/* A group caption earns its line only when the list has groups; a flat console's tabs speak for themselves. */}
              {groups ? <p className="console-nav__label">{t(section.key)}</p> : null}
              <ul className="console-nav__row">
                {section.items.map((item) => {
                  const here = active?.href === item.href;
                  return (
                    <li key={item.href}>
                      <Link href={item.href} aria-current={here ? 'page' : undefined}>
                        {hasIcons ? (
                          <span className="console-nav__icon" aria-hidden="true">
                            {item.icon ? <Icon name={item.icon} size={15} /> : null}
                          </span>
                        ) : null}
                        <span className="console-nav__text">{t(item.key)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </header>

      <div className="console-head">
        <div className="console-head__text">
          {/* Where you are, above what you are looking at — the one line the bar cannot keep once it scrolls away. */}
          <p className="console-head__eyebrow">
            <span>{t(brand)}</span>
            {groups && active ? (
              <>
                <span className="console-head__eyebrow-sep" aria-hidden="true">
                  /
                </span>
                <span>{t(active.section.key)}</span>
              </>
            ) : null}
          </p>
          <h1>{t(title)}</h1>
          <p className="console-head__sub">{t(subtitle)}</p>
        </div>
        {actions ? <div className="console-head__actions">{actions}</div> : null}
      </div>

      {facts && facts.length > 0 ? (
        <dl className="console-kpis">
          {facts.map((fact) => {
            const inner = (
              <>
                <dt className="console-kpi__label">{fact.label}</dt>
                <dd className="console-kpi__value num">{fact.value}</dd>
                {fact.note ? <span className="console-kpi__note">{fact.note}</span> : null}
              </>
            );
            return fact.href ? (
              <Link
                className="console-kpi console-kpi--link"
                href={fact.href}
                key={fact.label + fact.href}
              >
                {inner}
                <span className="console-kpi__go" aria-hidden="true">
                  <Icon name="arrow" size={14} />
                </span>
              </Link>
            ) : (
              <div
                className={`console-kpi${fact.tone === 'warning' ? ' console-kpi--warn' : ''}`}
                key={fact.label}
              >
                {inner}
              </div>
            );
          })}
        </dl>
      ) : null}

      <div className={bodyClass}>{children}</div>
    </main>
  );
}
