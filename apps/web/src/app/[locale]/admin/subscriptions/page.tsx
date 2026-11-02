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
import { loadQuotaOverrides, loadSubscriptions } from '@/lib/finance';

/**
 * `/admin/subscriptions` — who is on what, and the support grants that sit beside the plan.
 *
 * Read-only on purpose: the plans editor changes prices, and the *operator's* billing page changes their own
 * plan. An admin screen that could silently switch somebody's plan is an audit trail with a missing actor.
 * Quota overrides are the exception — they are a support action, and they expire.
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

  const [subscriptions, overrides] = await Promise.all([
    loadSubscriptions(),
    loadQuotaOverrides(null),
  ]);

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

        <section className="console-section" id="overrides">
          <div className="console-section__head">
            <h2>{t('subs.overrides')}</h2>
            <span className="console-section__meta">{overrides.length}</span>
          </div>
          {overrides.length === 0 ? (
            <EmptyState
              title={t('subs.noOverrides')}
              description={t('subs.noOverridesHint')}
              icon="check"
            />
          ) : (
            <div className="table-scroll">
              <table className="data-table table-cards">
                <caption className="visually-hidden">{t('subs.overrides')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('subs.overrideFor')}</th>
                    <th scope="col">{t('subs.metric')}</th>
                    <th scope="col">{t('subs.limitValue')}</th>
                    <th scope="col">{t('subs.expiresAt')}</th>
                    <th scope="col">{t('subs.reason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {overrides.map((override) => (
                    <tr key={override.id}>
                      <th scope="row" data-label={t('subs.overrideFor')}>
                        {override.ownerOrgId ? (
                          <bdi dir="ltr" className="id-short">
                            {override.ownerOrgId.slice(0, 8)}
                          </bdi>
                        ) : (
                          t('plans.platformWide')
                        )}
                      </th>
                      <td data-label={t('subs.metric')}>
                        {t(`metric.${override.metric}` as TranslationKey)}
                      </td>
                      <td data-label={t('subs.limitValue')}>
                        {override.limitValue === null
                          ? t('billing.unlimited')
                          : override.limitValue}
                      </td>
                      <td data-label={t('subs.expiresAt')}>
                        {override.expiresAt === null
                          ? t('billing.unlimited')
                          : t('billing.overrideUntil', {
                              date: formatDate(override.expiresAt, { locale }),
                            })}
                      </td>
                      <td data-label={t('subs.reason')}>{override.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </ConsoleShell>
    </>
  );
}
