import Link from 'next/link';
import { translate, type Locale, type TranslationKey } from '@maak/core';

/**
 * The account area's own navigation.
 *
 * Before this, `/account/bookings`, `/account/invitations`, `/account/licence` and `/account/verification`
 * were reachable only from the hub's button row — so a person on their bookings had no way back to their
 * details except the browser's back button, and an invitation link was the only path to the invitations
 * screen at all. Every account page now carries the same row.
 *
 * It is a row of pills rather than a menu, and it scrolls sideways on a phone: navigation that has to be
 * opened first is navigation half the people on a bus will never open. Nothing here is hidden at any
 * width — the narrow layout scrolls, it does not collapse.
 */
const SECTIONS: readonly { readonly key: TranslationKey; readonly path: string }[] = [
  { key: 'account.overview', path: '/account' },
  { key: 'bookings.myTitle', path: '/account/bookings' },
  { key: 'account.notifications', path: '/account/notifications' },
  { key: 'account.invitations', path: '/account/invitations' },
  { key: 'fleet.accountLicence', path: '/account/licence' },
  { key: 'nav.verification', path: '/account/verification' },
];

export function AccountNav({
  locale,
  current,
}: {
  readonly locale: Locale;
  /** The section this page belongs to, e.g. `/account/bookings` for a booking's detail page. */
  readonly current: string;
}) {
  const t = (key: TranslationKey) => translate(locale, key);

  return (
    <nav className="account-nav" aria-label={t('account.sections')}>
      {SECTIONS.map((section) => (
        <Link
          key={section.path}
          className="account-nav__link"
          href={`/${locale}${section.path}`}
          aria-current={section.path === current ? 'page' : undefined}
        >
          {t(section.key)}
        </Link>
      ))}
    </nav>
  );
}
