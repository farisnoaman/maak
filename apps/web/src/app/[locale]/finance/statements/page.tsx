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
import { StatementExport } from '@/components/finance/StatementExport';
import { financeNav } from '@/components/payments/financeNav';
import { loadAccountContext } from '@/lib/account';
import { loadStatement } from '@/lib/finance';

/**
 * `/finance/statements` — the period statement, and the export of it.
 *
 * Both renderings come from one function (`finance.statement`), so the screen and the CSV cannot disagree
 * about the balance. The export is a logged action because `finance_exports` is counted from that log.
 */
export const dynamic = 'force-dynamic';

export default async function FinanceStatementsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/finance/statements`);
  }

  const query = await searchParams;
  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const defaultTo = now.toISOString().slice(0, 10);
  const from = typeof query.from === 'string' && query.from !== '' ? query.from : defaultFrom;
  const to = typeof query.to === 'string' && query.to !== '' ? query.to : defaultTo;

  const platform = loaded.roles.some((role) =>
    ['platform_admin', 'platform_staff', 'finance_officer'].includes(role),
  );
  const org = loaded.organizations[0] ?? null;
  const statement = await loadStatement(
    platform
      ? { platform: true }
      : { orgId: org?.id ?? null, ownerUserId: loaded.user?.id ?? null },
    `${from}T00:00:00.000Z`,
    `${to}T00:00:00.000Z`,
  );

  return (
    <>
      <SiteHeader locale={locale} pathname="/finance/statements" />
      <ConsoleShell
        locale={locale}
        title="statement.title"
        subtitle="statement.subtitle"
        phase="10"
        items={financeNav(locale)}
      >
        <section>
          <h2>
            {formatDate(from, { locale })} → {formatDate(to, { locale })}
          </h2>
          {statement === null ? (
            <p className="form-hint">{t('statement.empty')}</p>
          ) : (
            <>
              <dl className="finance-summary">
                {Object.entries(statement.totals).map(([account, total]) => (
                  <div className="finance-summary__row" key={account}>
                    <dt>{account}</dt>
                    <dd>{formatMinor(total.net, 'YER', { locale })}</dd>
                  </div>
                ))}
                <div className="finance-summary__row">
                  <dt>{t('statement.balance')}</dt>
                  <dd>{formatMinor(statement.balance, 'YER', { locale })}</dd>
                </div>
              </dl>

              <h3>{t('statement.expenses')}</h3>
              {statement.expenses.length === 0 ? (
                <p className="form-hint">{t('expenses.empty')}</p>
              ) : (
                <div className="table-scroll">
                  <table className="data-table table-cards">
                    <caption className="visually-hidden">{t('statement.expenses')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('expenses.date')}</th>
                        <th scope="col">{t('expenses.category')}</th>
                        <th scope="col">{t('expenses.amount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.expenses.map((expense) => (
                        <tr key={expense.id}>
                          <th scope="row" data-label={t('expenses.date')}>
                            {formatDate(expense.incurredOn, { locale })}
                          </th>
                          <td data-label={t('expenses.category')}>
                            {t(`cat.${expense.category}` as TranslationKey)}
                          </td>
                          <td data-label={t('expenses.amount')}>
                            {formatMinor(expense.amountYer, 'YER', { locale })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <StatementExport
                locale={locale}
                from={from}
                to={to}
                canExport={statement !== null}
                orgId={platform ? null : (org?.id ?? null)}
                ownerUserId={platform ? null : (loaded.user?.id ?? null)}
              />
            </>
          )}
        </section>
      </ConsoleShell>
    </>
  );
}
