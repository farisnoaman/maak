import Link from 'next/link';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import { Icon } from '@/components/ui/Icon';

/**
 * The half of the sign-in page that answers "why would I sign in".
 *
 * A login screen that is one card on an empty page asks a visitor to remember what brought them here. Three lines —
 * the next journey, the booking code, the company — are what is actually behind the door, and each is a thing this
 * product already does rather than a promise. The door at the bottom matters as much: somebody who only wants to
 * look at trips should be able to leave the form without closing the tab.
 *
 * On a phone it is not a hidden panel and not a second screen: it sits under the form, because it is reassurance,
 * not navigation.
 */
export function AuthAside({
  locale,
  title,
}: {
  readonly locale: Locale;
  readonly title: TranslationKey;
}) {
  const t = (key: TranslationKey) => translate(locale, key);

  const points: {
    icon: 'bus' | 'ticket' | 'users';
    title: TranslationKey;
    body: TranslationKey;
  }[] = [
    { icon: 'bus', title: 'auth.pointJourney', body: 'auth.pointJourneyBody' },
    { icon: 'ticket', title: 'auth.pointCode', body: 'auth.pointCodeBody' },
    { icon: 'users', title: 'auth.pointCompany', body: 'auth.pointCompanyBody' },
  ];

  return (
    <aside className="auth-aside" aria-labelledby="auth-aside-title">
      <h2 className="auth-aside__title" id="auth-aside-title">
        {t(title)}
      </h2>
      <ul className="auth-points">
        {points.map((point) => (
          <li className="auth-point" key={point.title}>
            <span className="auth-point__icon" aria-hidden="true">
              <Icon name={point.icon} size={18} />
            </span>
            <span className="auth-point__body">
              <span className="auth-point__title">{t(point.title)}</span>
              <span className="auth-point__text">{t(point.body)}</span>
            </span>
          </li>
        ))}
      </ul>
      <Link className="ui-btn ui-btn--ghost ui-btn--block" href={`/${locale}/trips`}>
        {t('auth.browse')}
      </Link>
    </aside>
  );
}
