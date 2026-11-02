import { notFound, redirect } from 'next/navigation';
import {
  formatDate,
  formatMinor,
  isLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import Link from 'next/link';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { MoneyHeadline } from '@/components/finance/MoneyHeadline';
import { SummaryCards } from '@/components/finance/SummaryCards';
import { financeNav } from '@/components/payments/financeNav';
import { loadAccountContext } from '@/lib/account';
import {
  accountName,
  accountNames,
  canReadPlatformFinance,
  loadFinanceDashboard,
  loadLedgerAccounts,
} from '@/lib/finance';

/**
 * `/finance/dashboard` — the money page.
 *
 * Everything here comes from `finance.dashboard`, which computes from the ledger rather than from a rollup
 * table: a rollup that has drifted says the platform earned money it did not. The scope switch is explicit —
 * finance sees the platform, an operator sees their own account — and the numbers are the same code either
 * way, which is why the two views cannot disagree about what "profit" means.
 */
export const dynamic = 'force-dynamic';

export default async function FinanceDashboardPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/finance/dashboard`);
  }

  const platform = canReadPlatformFinance(loaded.roles);
  const org = loaded.organizations[0] ?? null;

  const [dashboard, accounts] = await Promise.all([
    loadFinanceDashboard(
      platform
        ? { platform: true }
        : { orgId: org?.id ?? null, ownerUserId: loaded.user?.id ?? null },
    ),
    // The chart of accounts, so the balances below are named ("Payable to operators") rather than keyed
    // ("operator_payable"). Reference data, read with the visitor's own session.
    loadLedgerAccounts(),
  ]);
  const names = accountNames(accounts, locale);
  const period = dashboard
    ? `${formatDate(dashboard.period.from, { locale })} → ${formatDate(dashboard.period.to, { locale })}`
    : '';

  return (
    <>
      <SiteHeader locale={locale} pathname="/finance/dashboard" />
      <ConsoleShell
        consoleTitle="console.finance"
        pathname="/finance/dashboard"
        locale={locale}
        title="financeDash.title"
        subtitle="financeDash.subtitle"
        items={financeNav(locale)}
      >
        {dashboard === null ? (
          /* Not the subtitle again: the header already carries it. "We could not read the ledger" is the one thing
             this state has to say, and it is a different sentence from "here is what this page is". */
          <div className="ops-empty">
            <p className="ops-empty__title">{t('financeDash.unavailable')}</p>
            <p className="form-hint">{t('financeDash.unavailableBody')}</p>
            <Link className="ui-btn ui-btn--ghost" href={`/${locale}/finance/dashboard`}>
              {t('common.retry')}
            </Link>
          </div>
        ) : (
          <>
            <section className="finance-month" aria-labelledby="finance-month">
              <div className="ops-section__head">
                <h2 id="finance-month">{t('financeDash.month')}</h2>
                {/* When the figures were read. A count without a time is a count you cannot trust. */}
                <span className="console-head__stamp">{period}</span>
              </div>
              <MoneyHeadline
                locale={locale}
                summary={dashboard.summary}
                platform={dashboard.platform}
              />
              <SummaryCards
                locale={locale}
                summary={dashboard.summary}
                platform={dashboard.platform}
              />
            </section>

            <section>
              <h2>{t('statement.accounts')}</h2>
              {Object.keys(dashboard.totals).length === 0 ? (
                <p className="form-hint">{t('financeDash.noActivity')}</p>
              ) : (
                <div className="table-scroll">
                  <table className="data-table table-cards">
                    <caption className="visually-hidden">{t('statement.accounts')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('ledger.account')}</th>
                        <th scope="col">{t('ledger.debit')}</th>
                        <th scope="col">{t('ledger.credit')}</th>
                        <th scope="col">{t('financeDash.netBalance')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(dashboard.totals).map(([account, total]) => (
                        <tr key={account}>
                          <th scope="row" data-label={t('ledger.account')}>
                            {accountName(names, account)}
                          </th>
                          <td data-label={t('ledger.debit')}>
                            {formatMinor(total.debit, 'YER', { locale })}
                          </td>
                          <td data-label={t('ledger.credit')}>
                            {formatMinor(total.credit, 'YER', { locale })}
                          </td>
                          <td data-label={t('financeDash.netBalance')}>
                            {formatMinor(total.net, 'YER', { locale })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {platform ? (
              <section>
                <h2>{t('financeDash.integrity')}</h2>
                <p>{t('financeDash.integrityOk')}</p>
                <Link className="ui-btn ui-btn--ghost" href={`/${locale}/finance/reconciliation`}>
                  {t('recon.title')}
                </Link>
              </section>
            ) : (
              <section>
                <h2>{t('financeDash.plan')}</h2>
                <p>
                  {t(`plan.${dashboard.plan ?? 'basic'}` as TranslationKey)}
                  {dashboard.subscription
                    ? ` · ${t(`sub.status.${dashboard.subscription.status}` as TranslationKey)}`
                    : ''}
                </p>
                <Link className="ui-btn ui-btn--ghost" href={`/${locale}/operator/billing`}>
                  {t('billing.title')}
                </Link>
              </section>
            )}
          </>
        )}
      </ConsoleShell>
    </>
  );
}
