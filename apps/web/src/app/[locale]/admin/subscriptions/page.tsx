import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  formatDate,
  formatMinor,
  isLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminNav } from '@/components/admin/AdminNav';
import { Badge, EmptyState } from '@/components/ui/Feedback';
import { loadAccountContext } from '@/lib/account';
import { loadSubscriptions } from '@/lib/finance';

/**
 * `/admin/subscriptions` — who is on what.
 *
 * Read-only on purpose: the plans editor changes prices, and the *operator's* billing page changes their own
 * plan. An admin screen that could silently switch somebody's plan is an audit trail with a missing actor.
 * The quota grants support hands out are their own page (`/overrides`), because they answer a different question
 * ("what did we promise?") from the one this list answers ("what are we billing?").
 */
export const dynamic = 'force-dynamic';

export default async function AdminSubscriptionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/subscriptions`);
  }

  const allowed =
    loaded.roles.includes('platform_admin') ||
    loaded.roles.includes('finance_officer') ||
    loaded.roles.includes('platform_staff');

  if (!allowed) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/admin/subscriptions" />
        <ConsoleShell
          consoleTitle="console.admin"
          pathname="/admin/subscriptions"
          locale={locale}
          title="subs.title"
          subtitle="subs.subtitle"
          groups={adminNav(locale)}
        >
          <p className="form-hint">{t('errors.FORBIDDEN')}</p>
        </ConsoleShell>
      </>
    );
  }

  const subscriptions = await loadSubscriptions();

  /*
   * Two numbers the table could not answer: how much of this page is *live* money, and how many rows are actually
   * paying. A billing screen that lists rows without a total makes the reader do arithmetic in their head — and the
   * question an admin opens this page with is always "what is the run rate".
   */
  const activeCount = subscriptions.filter(
    (row) => row.status === 'active' || row.status === 'trialing',
  ).length;
  const monthlyYer = subscriptions
    .filter((row) => row.status === 'active' || row.status === 'trialing')
    .reduce((total, row) => total + row.priceYer, 0);

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/subscriptions" />
      <ConsoleShell
        pathname="/admin/subscriptions"
        consoleTitle="console.admin"
        locale={locale}
        title="subs.title"
        subtitle="subs.subtitle"
        groups={adminNav(locale)}
        actions={
          <Link
            className="ui-btn ui-btn--ghost ui-btn--sm"
            href={`/${locale}/admin/subscriptions/overrides`}
          >
            {t('subs.overrides')}
          </Link>
        }
        facts={[
          { label: t('subs.factLive'), value: String(subscriptions.length) },
          { label: t('subs.factActive'), value: String(activeCount) },
          {
            label: t('subs.factMonthly'),
            value: formatMinor(monthlyYer, 'YER', { locale }),
          },
        ]}
      >
        <section className="console-section">
          <div className="console-section__head">
            <h2>{t('subs.liveHeading')}</h2>
            <span className="console-section__meta">{subscriptions.length}</span>
          </div>
          {subscriptions.length === 0 ? (
            <EmptyState title={t('subs.empty')} description={t('subs.subtitle')} icon="wallet" />
          ) : (
            /*
             * One subscription is a thing, not a row: who pays, on what plan, how much, until when — and the two
             * states that change the answer (cancelling, or moving to another plan) get a line of their own instead
             * of being invisible. The table lost the price/period alignment anyway once it stacked on a phone.
             */
            <ul className="sub-list">
              {subscriptions.map((subscription) => {
                return (
                  <li className="sub-card" key={subscription.id}>
                    <div className="sub-card__head">
                      <h3 className="sub-card__owner">
                        {subscription.ownerName ?? (
                          /* No name to show: a short id at least points somewhere, a 36-character UUID does not. */
                          <bdi dir="ltr" className="id-short">
                            {(subscription.ownerOrgId ?? subscription.ownerUserId ?? '—').slice(
                              0,
                              8,
                            )}
                          </bdi>
                        )}
                      </h3>
                      <Badge
                        tone={
                          subscription.status === 'active'
                            ? 'success'
                            : subscription.status === 'trialing'
                              ? 'info'
                              : 'warning'
                        }
                      >
                        {t(`sub.status.${subscription.status}` as TranslationKey)}
                      </Badge>
                    </div>

                    <p className="sub-card__price num">
                      {formatMinor(subscription.priceYer, 'YER', { locale })}
                      <small>{t(`plan.${subscription.planCode}` as TranslationKey)}</small>
                    </p>

                    <dl className="sub-card__meta">
                      <div>
                        <dt>{t('subs.period')}</dt>
                        <dd className="num">
                          {formatDate(subscription.currentPeriodStart, { locale })} —{' '}
                          {formatDate(subscription.currentPeriodEnd, { locale })}
                        </dd>
                      </div>
                      {subscription.trialEndsAt ? (
                        <div>
                          <dt>{t('sub.status.trialing')}</dt>
                          <dd>
                            {t('subs.trialEnds', {
                              date: formatDate(subscription.trialEndsAt, { locale }),
                            })}
                          </dd>
                        </div>
                      ) : null}
                    </dl>

                    {subscription.cancelAtPeriodEnd || subscription.pendingPlanCode ? (
                      <p className="sub-card__flag">
                        {subscription.cancelAtPeriodEnd
                          ? t('subs.cancelAtEnd')
                          : t('subs.switchTo', {
                              plan: t(`plan.${subscription.pendingPlanCode}` as TranslationKey),
                            })}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </ConsoleShell>
    </>
  );
}
