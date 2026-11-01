import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { AccountNav } from '@/components/account/AccountNav';
import { NotificationPreferences } from '@/components/account/NotificationPreferences';
import { loadAccountContext } from '@/lib/account';
import { loadNotificationPreferences } from '@/lib/notifications';

/** Preferences. Writes go through the gateway; this page only reads what the database currently says. */
// The inbox is a person's own rows, read with their cookie: prerendering it would ship an empty
// notification list to everybody who opens the built page.
export const dynamic = 'force-dynamic';

export default async function PreferencesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const account = await loadAccountContext();
  if (account.configured && !account.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/account/notifications/preferences`);
  }

  const view = await loadNotificationPreferences();

  return (
    <>
      <SiteHeader locale={locale} pathname="/account/notifications/preferences" />
      <main id="main" className="shell section account-page">
        <header className="account-head">
          <h1>{t('notifications.preferencesTitle')}</h1>
          <p className="form-hint">{t('notifications.preferencesSubtitle')}</p>
        </header>

        <AccountNav locale={locale} current="/account/notifications" />

        <NotificationPreferences
          locale={locale}
          events={view.events}
          settings={view.settings}
          devices={view.devices}
          configured={view.configured}
        />
      </main>
    </>
  );
}
