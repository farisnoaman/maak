import Link from 'next/link';
import { LOCALES, LOCALE_LABEL, type Locale } from '@maak/core';

/**
 * Locale switch as plain server-rendered links.
 *
 * No client JavaScript, so it works with JS disabled, is crawlable, and keeps the full query string
 * (`search` is the already-serialised query). Swapping the first path segment is all that changes —
 * a shared link never loses its filters.
 */
export function LocaleSwitch({
  current,
  label,
  pathname,
  search = '',
}: {
  readonly current: Locale;
  readonly label: string;
  /** Current path without the locale, e.g. `/styleguide`. */
  readonly pathname: string;
  /** Serialised query, including the leading `?`, or an empty string. */
  readonly search?: string;
}) {
  const suffix = search && !search.startsWith('?') ? `?${search}` : search;

  return (
    <nav className="locale-switch" aria-label={label}>
      {LOCALES.map((locale) => (
        <Link
          key={locale}
          href={`/${locale}${pathname === '/' ? '' : pathname}${suffix}`}
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
