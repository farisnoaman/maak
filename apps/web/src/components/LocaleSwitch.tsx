'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { LOCALES, LOCALE_LABEL, type Locale } from '@maak/core';

/**
 * Preserves path + query when switching locale, so a shared link never drops filters.
 * Uses `<Link>` (not router.push) so the switch is a real navigation and shareable.
 */
export function LocaleSwitch({ current, label }: { current: Locale; label: string }) {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();

  function pathFor(locale: Locale): string {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0) return `/${locale}`;
    segments[0] = locale;
    const query = searchParams?.toString();
    return `/${segments.join('/')}${query ? `?${query}` : ''}`;
  }

  return (
    <nav className="locale-switch" aria-label={label}>
      {LOCALES.map((locale) => (
        <Link
          key={locale}
          href={pathFor(locale)}
          hrefLang={locale}
          lang={locale}
          aria-current={locale === current ? 'true' : undefined}
        >
          {LOCALE_LABEL[locale]}
        </Link>
      ))}
    </nav>
  );
}
