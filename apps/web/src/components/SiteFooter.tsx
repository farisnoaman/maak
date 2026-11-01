import Link from 'next/link';
import { translate, type Locale, type TranslationKey } from '@maak/core';

/**
 * The footer, once, for every public page.
 *
 * Before this it existed only on the home page and said `Phase 2 · Next.js · Expo · Supabase` — a stack list, which
 * is a hiring page, not a travel site. What a footer is actually for: a way out of a dead end. So three groups —
 * where to travel, where to work, what the terms are — and one line of rights.
 *
 * Server component and plain links: it renders with JavaScript off, which is how a footer has to behave when it is
 * the thing someone reaches for on a broken page.
 */
export function SiteFooter({ locale }: { readonly locale: Locale }) {
  const t = (key: TranslationKey) => translate(locale, key);
  const href = (path: string) => `/${locale}${path}`;

  const groups: { title: TranslationKey; links: { key: TranslationKey; href: string }[] }[] = [
    {
      title: 'footer.travel',
      links: [
        { key: 'nav.trips', href: href('/trips') },
        { key: 'footer.myBookings', href: href('/account/bookings') },
        { key: 'nav.account', href: href('/account') },
      ],
    },
    {
      title: 'footer.platform',
      links: [
        { key: 'footer.forOperators', href: href('/operator') },
        { key: 'footer.forTeams', href: href('/console') },
        { key: 'nav.styleguide', href: href('/styleguide') },
      ],
    },
    {
      title: 'footer.information',
      links: [
        { key: 'nav.privacy', href: href('/privacy') },
        { key: 'nav.terms', href: href('/terms') },
      ],
    },
  ];

  return (
    <footer className="site-footer">
      <div className="shell">
        <div className="site-footer__grid">
          <div className="site-footer__brand">
            <Link className="brand" href={`/${locale}`}>
              <span className="brand__mark" aria-hidden="true">
                {t('common.brandMark')}
              </span>
              <span className="brand__text">
                {t('common.appName')}
                <span className="brand__sub">{t('footer.tagline')}</span>
              </span>
            </Link>
          </div>

          {groups.map((group) => (
            <nav className="site-footer__group" key={group.title} aria-label={t(group.title)}>
              <h2>{t(group.title)}</h2>
              <ul>
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href}>{t(link.key)}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="site-footer__bottom">
          <span>{t('footer.rights')}</span>
          <span className="site-footer__flag" aria-hidden="true">
            {t('footer.madeIn')}
          </span>
        </div>
      </div>
    </footer>
  );
}
