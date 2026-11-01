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
import { Badge } from '@/components/ui/Feedback';
import { adminMoneyNav } from '@/components/payments/financeNav';
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
          items={adminMoneyNav(locale)}
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

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/subscriptions" />
      <ConsoleShell
        locale={locale}
        title="subs.title"
        subtitle="subs.subtitle"
        items={adminMoneyNav(locale)}
      >
        <section>
          <h2>{t('subs.title')}</h2>
          {subscriptions.length === 0 ? (
            <p className="form-hint">{t('subs.empty')}</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table table-cards">
                <caption className="visually-hidden">{t('subs.title')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('subs.owner')}</th>
                    <th scope="col">{t('subs.plan')}</th>
                    <th scope="col">{t('subs.status')}</th>
                    <th scope="col">{t('billing.price')}</th>
                    <th scope="col">{t('subs.period')}</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((subscription) => (
                    <tr key={subscription.id}>
                      <th scope="row" data-label={t('subs.owner')}>
                        <bdi dir="ltr">
                          {subscription.ownerOrgId ?? subscription.ownerUserId ?? '—'}
                        </bdi>
                      </th>
                      <td data-label={t('subs.plan')}>
                        {t(`plan.${subscription.planCode}` as TranslationKey)}
                      </td>
                      <td data-label={t('subs.status')}>
                        <Badge tone={subscription.status === 'active' ? 'success' : 'warning'}>
                          {t(`sub.status.${subscription.status}` as TranslationKey)}
                        </Badge>
                      </td>
                      <td data-label={t('billing.price')}>
                        {formatMinor(subscription.priceYer, 'YER', { locale })}
                      </td>
                      <td data-label={t('subs.period')}>
                        {formatDate(subscription.currentPeriodStart, { locale })} →{' '}
                        {formatDate(subscription.currentPeriodEnd, { locale })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h2>{t('subs.overrides')}</h2>
          {overrides.length === 0 ? (
            <p className="form-hint">{t('subs.noOverrides')}</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table table-cards">
                <caption className="visually-hidden">{t('subs.overrides')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('subs.metric')}</th>
                    <th scope="col">{t('subs.limitValue')}</th>
                    <th scope="col">{t('subs.expiresAt')}</th>
                    <th scope="col">{t('subs.reason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {overrides.map((override) => (
                    <tr key={override.id}>
                      <th scope="row" data-label={t('subs.metric')}>
                        {t(`metric.${override.metric}` as TranslationKey)}
                      </th>
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
