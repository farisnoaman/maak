import Link from 'next/link';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import { LocaleSwitch } from './LocaleSwitch';
import { OpenInTab } from './OpenInTab';

/**
 * Shared header for every page. Server-rendered: navigation and the language switcher work
 * without JavaScript, and the switcher receives the current query string so filters survive.
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
  const withQuery = (path: string) => `/${locale}${path}${search ? `?${search}` : ''}`;

  return (
    <header className="site-header">
      <div className="shell site-header__inner">
        <Link className="brand" href={`/${locale}`}>
          <span className="brand__mark" aria-hidden="true">
            {t('common.brandMark')}
          </span>
          <span>
            {t('common.appName')}
            <span className="brand__sub" style={{ display: 'block' }}>
              {t('common.tagline')}
            </span>
          </span>
        </Link>

        <span className="header__spacer" />

        <nav
          aria-label={t('home.sectionConsoles')}
          style={{ display: 'flex', gap: 'var(--space-2)' }}
        >
          <Link className="nav-link" href={`/${locale}`}>
            {t('nav.home')}
          </Link>
          <Link className="nav-link" href={withQuery('/styleguide')}>
            {t('nav.styleguide')}
          </Link>
          <Link className="nav-link" href={withQuery('/auth/sign-in')}>
            {t('nav.signIn')}
          </Link>
          <Link className="nav-link" href={withQuery('/account')}>
            {t('nav.account')}
          </Link>
          {/* Only renders inside an iframe: a first-party tab if the browser blocks the session here. */}
          <OpenInTab locale={locale} path={withQuery('/auth/sign-in')} />
        </nav>

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
