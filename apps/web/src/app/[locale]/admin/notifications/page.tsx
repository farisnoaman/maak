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
import { adminNav } from '@/components/admin/AdminNav';
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

/**
 * The catalogue has 39 events in one alphabetical-by-kind list, and kind names are machine words:
 * `agent_cash_in_settled` sits next to `booking_accepted` only by accident of spelling. Nobody looks for a template by
 * its prefix — they look for "the payment one" — so the prefixes become seven families with a count each, and the
 * page that was a 39-row wall becomes seven named drawers you can close.
 */
const FAMILIES = [
  { id: 'trips', match: /^(booking_|trip_|saved_search_|no_show_)/ },
  { id: 'money', match: /^(payment_|refund_|payout_|invoice_|finance_)/ },
  { id: 'plan', match: /^(subscription_|quota_)/ },
  { id: 'verification', match: /^verification_/ },
  { id: 'people', match: /^(member_|role_)/ },
  { id: 'fleet', match: /^vehicle_/ },
  { id: 'platform', match: /^(agent_|ops_)/ },
] as const;

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
        title="console.navTemplates"
        subtitle="catalogue.subtitle"
        groups={adminNav(locale)}
        facts={[
          { label: t('catalogue.factEvents'), value: String(events.length) },
          { label: t('catalogue.factTimezone'), value: timezone },
        ]}
      >
        {!configured ? (
          <p className="form-error" role="alert">
            {t('catalogue.staffOnly')}
          </p>
        ) : (
          <>
            <p className="form-hint">{t('catalogue.caption')}</p>
            <div className="catalogue-groups">
              {FAMILIES.map((family) => {
                const rows = events.filter((event) => family.match.test(event.kind));
                if (rows.length === 0) return null;
                return (
                  <details
                    className="catalogue-group"
                    key={family.id}
                    open
                    suppressHydrationWarning
                  >
                    <summary className="catalogue-group__summary">
                      <span className="catalogue-group__name">
                        {t(`catalogue.group.${family.id}` as TranslationKey)}
                      </span>
                      <span className="catalogue-group__count">{rows.length}</span>
                    </summary>
                    <ul className="catalogue-list">
                      {rows.map((event) => {
                        const item = {
                          kind: event.kind as NotificationKind,
                          titleKey: event.titleKey,
                          params: sampleParamsFor(event.kind),
                        };
                        return (
                          <li className="catalogue-event" key={event.kind}>
                            <div className="catalogue-event__head">
                              <h3 className="catalogue-event__name">
                                {t(`notifications.event.${event.kind}` as TranslationKey)}
                              </h3>
                              <Badge tone={PRIORITY_TONE[event.priority] ?? 'neutral'}>
                                {t(`notifications.priority.${event.priority}` as TranslationKey)}
                              </Badge>
                            </div>
                            <ul className="catalogue-event__channels">
                              {event.channels.map((channel) => (
                                <li key={channel}>
                                  {t(CHANNEL_LABEL[channel] ?? 'notifications.channelsLabel')}
                                </li>
                              ))}
                            </ul>
                            {/*
                              Both sentences, from the same function the sender calls, with the sample payload —
                              that is the point of the page. They sit in one row because the question is "does the
                              Arabic still read right, and does the English mean the same thing", which is a
                              comparison, not two columns of prose.
                            */}
                            <div className="catalogue-event__says">
                              <p lang="ar" dir="rtl" className="catalogue-event__sentence">
                                {notificationText('ar', item)}
                              </p>
                              <p lang="en" dir="ltr" className="catalogue-event__sentence">
                                {notificationText('en', item)}
                              </p>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                );
              })}
            </div>
          </>
        )}
      </ConsoleShell>
    </>
  );
}
