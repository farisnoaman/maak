import { notFound, redirect } from 'next/navigation';
import {
  isLocale,
  notificationText,
  sampleParamsFor,
  translate,
  type Locale,
  type NotificationKind,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { Badge } from '@/components/ui/Feedback';
import { loadAccountContext } from '@/lib/account';
import { loadNotificationCatalogue } from '@/lib/notifications';

/**
 * The template preview.
 *
 * Every event, its default channels, its priority and the sentence it produces — in both locales, side by
 * side. The two sentence columns are rendered by the *same* function the sender uses (`notificationText`),
 * with the sample payload from `@maak/core`, so a template that reads badly in Arabic or is missing a variable
 * looks wrong here before it looks wrong on somebody's phone.
 *
 * The catalogue comes back through the staff-only `dispatch` action rather than from the table, so the
 * capability is enforced in one place and a non-staff session gets a readable refusal.
 */
export const dynamic = 'force-dynamic';

const CHANNEL_LABEL: Record<string, TranslationKey> = {
  in_app: 'notifications.channel.in_app',
  push: 'notifications.channel.push',
  email: 'notifications.channel.email',
  whatsapp: 'notifications.channel.whatsapp',
};

const PRIORITY_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  normal: 'warning',
  low: 'neutral',
};

export default async function NotificationCataloguePage({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/notifications`);
  }

  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const { configured, timezone, events } = await loadNotificationCatalogue();

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/notifications" />
      <ConsoleShell
        consoleTitle="console.admin"
        pathname="/admin/notifications"
        locale={locale}
        title="catalogue.title"
        subtitle="catalogue.subtitle"
        items={[
          { key: 'console.navOverview', href: `/${locale}/admin` },
          { key: 'catalogue.title', href: `/${locale}/admin/notifications` },
          { key: 'notifications.pageTitle', href: `/${locale}/account/notifications` },
        ]}
      >
        {!configured ? (
          <p className="form-error" role="alert">
            {t('catalogue.staffOnly')}
          </p>
        ) : (
          <>
            <p className="form-hint">
              {`${t('catalogue.count', { count: events.length })} · ${t('catalogue.timezone', {
                timezone,
              })}`}
            </p>
            <div className="table-scroll">
              <table className="table catalogue">
                <caption className="table__caption">{t('catalogue.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('notifications.eventColumn')}</th>
                    <th scope="col">{t('catalogue.priority')}</th>
                    <th scope="col">{t('notifications.channelsLabel')}</th>
                    <th scope="col" lang="ar" dir="rtl">
                      {t('common.arabic')}
                    </th>
                    <th scope="col" lang="en" dir="ltr">
                      {t('common.english')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => {
                    const item = {
                      kind: event.kind as NotificationKind,
                      titleKey: event.titleKey,
                      params: sampleParamsFor(event.kind),
                    };
                    return (
                      <tr key={event.kind}>
                        <th scope="row">
                          {t(`notifications.event.${event.kind}` as TranslationKey)}
                        </th>
                        <td>
                          <Badge tone={PRIORITY_TONE[event.priority] ?? 'neutral'}>
                            {t(`notifications.priority.${event.priority}` as TranslationKey)}
                          </Badge>
                        </td>
                        <td>
                          <ul className="catalogue__channels">
                            {event.channels.map((channel) => (
                              <li key={channel}>
                                {t(CHANNEL_LABEL[channel] ?? 'notifications.channelsLabel')}
                              </li>
                            ))}
                          </ul>
                        </td>
                        <td lang="ar" dir="rtl" className="catalogue__sentence">
                          {notificationText('ar', item)}
                        </td>
                        <td lang="en" dir="ltr" className="catalogue__sentence">
                          {notificationText('en', item)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </ConsoleShell>
    </>
  );
}
