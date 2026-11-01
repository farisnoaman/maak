import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  describeSavedSearch,
  isLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { AccountNav } from '@/components/account/AccountNav';
import { NotificationInbox } from '@/components/account/NotificationInbox';
import { Badge } from '@/components/ui/Feedback';
import { loadAccountContext } from '@/lib/account';
import { loadInbox, loadSavedSearches } from '@/lib/notifications';

/**
 * The notification centre.
 *
 * The account page's bell shows the last few items; this is the page you go to when you are looking for
 * *why* a message did or did not arrive. It therefore shows the delivery trail next to each event, and it
 * carries the two settings that change that trail: preferences and saved searches.
 */
// The inbox is a person's own rows, read with their cookie: prerendering it would ship an empty
// notification list to everybody who opens the built page.
export const dynamic = 'force-dynamic';

export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const account = await loadAccountContext();
  if (account.configured && !account.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/account/notifications`);
  }

  const [inbox, searches] = await Promise.all([loadInbox({ limit: 50 }), loadSavedSearches()]);

  return (
    <>
      <SiteHeader locale={locale} pathname="/account/notifications" />
      <main id="main" className="shell section account-page">
        <header className="account-head">
          <h1>{t('notifications.pageTitle')}</h1>
          <p className="form-hint">{t('notifications.pageSubtitle')}</p>
          <Link
            className="button button--subtle button--sm"
            href={`/${locale}/account/notifications/preferences`}
          >
            {t('notifications.preferencesTitle')}
          </Link>
        </header>

        <AccountNav locale={locale} current="/account/notifications" />

        <section aria-labelledby="inbox">
          <h2 id="inbox">{t('notifications.inboxTitle')}</h2>
          <NotificationInbox
            locale={locale}
            items={inbox.items}
            unread={inbox.unread}
            configured={inbox.configured}
          />
        </section>

        <section aria-labelledby="saved-searches">
          <h2 id="saved-searches">{t('search.savedTitle')}</h2>
          {searches.length === 0 ? (
            <p className="form-hint">{t('search.savedEmpty')}</p>
          ) : (
            <ul className="saved-searches">
              {searches.map((search) => {
                const filters = search.filters as {
                  priceMax?: number;
                  direct?: boolean;
                  dateFrom?: string;
                  q?: string;
                };
                return (
                  <li key={search.id} className="saved-search">
                    <div>
                      <p>{search.label ?? describeSavedSearch(filters, {}, { locale })}</p>
                      <p className="form-hint">
                        {describeSavedSearch(filters, {}, { locale })} ·{' '}
                        {t('search.matches', { count: search.matches })}
                      </p>
                    </div>
                    <Badge tone={search.notify ? 'success' : 'neutral'}>
                      {search.notify ? t('search.alertsOn') : t('search.alertsOff')}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
