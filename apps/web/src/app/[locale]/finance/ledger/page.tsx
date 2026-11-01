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
import { JournalDesk } from '@/components/finance/JournalDesk';
import { financeNav } from '@/components/payments/financeNav';
import { loadAccountContext } from '@/lib/account';
import { loadStatement } from '@/lib/finance';

/**
 * `/finance/ledger` — the journal.
 *
 * The month's entries are read through `finance.statement` rather than straight from the table, so the page
 * shows the same lines the statement and the export produce. Posting is allowed for finance only; the
 * editor is not rendered for anyone else, because a disabled button invites people to ask for permission
 * they do not need.
 */
export const dynamic = 'force-dynamic';

function monthBounds(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

export default async function FinanceLedgerPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/finance/ledger`);
  }

  const canPost =
    loaded.roles.includes('finance_officer') || loaded.roles.includes('platform_admin');
  const org = loaded.organizations[0] ?? null;
  const { from, to } = monthBounds();
  const statement = await loadStatement(
    canPost ? { platform: true } : { orgId: org?.id ?? null, ownerUserId: loaded.user?.id ?? null },
    from,
    to,
  );

  return (
    <>
      <SiteHeader locale={locale} pathname="/finance/ledger" />
      <ConsoleShell
        locale={locale}
        title="ledger.title"
        subtitle="ledger.subtitle"
        phase="10"
        items={financeNav(locale)}
      >
        <section>
          <h2>{t('ledger.post')}</h2>
          <JournalDesk locale={locale} canPost={canPost} />
        </section>

        <section>
          <h2>{t('statement.journals')}</h2>
          {!statement || statement.journals.length === 0 ? (
            <p className="form-hint">{t('ledger.empty')}</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table table-cards">
                <caption className="visually-hidden">{t('statement.journals')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('ledger.postingDate')}</th>
                    <th scope="col">{t('ledger.description')}</th>
                    <th scope="col">{t('ledger.account')}</th>
                    <th scope="col">{t('ledger.debit')}</th>
                    <th scope="col">{t('ledger.credit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.journals.flatMap((journal) =>
                    journal.lines.map((line) => (
                      <tr key={`${journal.id}-${line.account}-${line.direction}`}>
                        <th scope="row" data-label={t('ledger.postingDate')}>
                          {formatDate(journal.postingDate, { locale })}
                        </th>
                        <td data-label={t('ledger.description')}>
                          {journal.description ?? journal.sourceKind}
                        </td>
                        <td data-label={t('ledger.account')}>{line.account}</td>
                        <td data-label={t('ledger.debit')}>
                          {line.direction === 'debit'
                            ? formatMinor(line.amountYer, 'YER', { locale })
                            : '—'}
                        </td>
                        <td data-label={t('ledger.credit')}>
                          {line.direction === 'credit'
                            ? formatMinor(line.amountYer, 'YER', { locale })
                            : '—'}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </ConsoleShell>
    </>
  );
}
