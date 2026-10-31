'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';

/**
 * The phone's primary navigation.
 *
 * A travel product is used with one thumb, and the header menu costs two taps (open, then choose) before
 * a passenger can reach the marketplace or their own trips. Below 720px this bar puts the four
 * destinations that carry the product at the bottom of the screen, where a thumb already is; above it the
 * bar is not rendered at all — the header keeps the only navigation, so there is never a second, competing
 * menu on a desktop and never a duplicated set of links for a screen reader.
 *
 * It is deliberately a client component for one reason only: `usePathname()` is how `aria-current` can be
 * correct. Everything it renders is a plain `<a>` — no JavaScript is required to navigate.
 */

interface Tab {
  readonly key: TranslationKey;
  readonly href: string;
  /** Path prefixes that keep this tab current. */
  readonly match: readonly string[];
  readonly icon: 'home' | 'market' | 'trips' | 'console';
}

const ICONS: Record<Tab['icon'], string> = {
  // 24px strokes, no fills: they inherit `currentColor`, so the active state needs one rule, not four.
  home: 'M3 11.5 12 4l9 7.5M6 10v10h4v-6h4v6h4V10',
  market: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4',
  trips: 'M4 7h16v11H4zM8 7V5h8v2M4 12h16',
  console: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
};

export function MobileTabBar() {
  const pathname = usePathname() ?? '/';
  const [, first, ...rest] = pathname.split('/');
  const locale: Locale = isLocale(first) ? first : 'ar';
  const section = `/${rest.join('/')}`;
  const t = (key: TranslationKey) => translate(locale, key);

  const tabs: Tab[] = [
    { key: 'nav.home', href: `/${locale}`, match: ['/'], icon: 'home' },
    { key: 'nav.trips', href: `/${locale}/trips`, match: ['/trips'], icon: 'market' },
    { key: 'nav.account', href: `/${locale}/account`, match: ['/account'], icon: 'trips' },
    {
      key: 'nav.tabConsole',
      href: `/${locale}/console`,
      match: ['/operator', '/staff', '/admin'],
      icon: 'console',
    },
  ];

  const isCurrent = (tab: Tab) =>
    tab.match.some((prefix) => (prefix === '/' ? section === '/' : section.startsWith(prefix)));

  return (
    <nav className="mobile-tabbar" aria-label={t('nav.tabbar')}>
      {tabs.map((tab) => (
        <Link
          className="tabbar__link"
          key={tab.href}
          href={tab.href}
          aria-current={isCurrent(tab) ? 'page' : undefined}
        >
          <svg
            aria-hidden="true"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={ICONS[tab.icon]} />
          </svg>
          <span>{t(tab.key)}</span>
        </Link>
      ))}
    </nav>
  );
}
