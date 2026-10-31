import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { AccountsManager } from '@/components/payments/AccountsManager';
import { financeNav } from '@/components/payments/financeNav';
import { loadAccountContext } from '@/lib/account';
import { loadPaymentAccounts } from '@/lib/payments';

/**
 * `/finance/accounts` — where money is allowed to land.
 *
 * An unverified account number is how a payout reaches a stranger's wallet, so the desk's accounts are live
 * on creation (there is nobody above them) and an operator's wait for a human. Both lists are the same
 * table under RLS; the split is presentational.
 */
export const dynamic = 'force-dynamic';

export default async function FinanceAccountsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/finance/accounts`);
  }

  const accounts = await loadPaymentAccounts();
  const isFinance =
    loaded.roles.includes('finance_officer') ||
    loaded.roles.includes('platform_admin') ||
    loaded.roles.includes('platform_staff');

  return (
    <>
      <SiteHeader locale={locale} pathname="/finance/accounts" />
      <ConsoleShell
        locale={locale}
        title="financeAccounts.title"
        subtitle="financeAccounts.subtitle"
        phase="9"
        items={financeNav(locale)}
      >
        <section>
          {!isFinance ? <p className="ui-alert">{t('financeAccounts.subtitle')}</p> : null}
          <AccountsManager locale={locale} accounts={accounts} canCreate={isFinance} />
        </section>
      </ConsoleShell>
    </>
  );
}
