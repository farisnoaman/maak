import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { ExpensesPanel } from '@/components/finance/ExpensesPanel';
import { operatorMoneyNav } from '@/components/payments/financeNav';
import { loadAccountContext } from '@/lib/account';
import { loadExpenses } from '@/lib/finance';

/**
 * `/operator/expenses` — what the fleet spent.
 *
 * A driver records their own fuel; an operator records theirs and can void a mistake. Both arrive through
 * `expense.record`, and only `settleFromBalance` touches the ledger, because money the operator paid from
 * their pocket never passed through the platform.
 */
export const dynamic = 'force-dynamic';

export default async function OperatorExpensesPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/expenses`);
  }

  const org = loaded.organizations[0] ?? null;
  const canVoid =
    org !== null
      ? ['owner', 'manager', 'accountant'].includes(org.role)
      : loaded.roles.includes('finance_officer');

  const expenses = await loadExpenses(org?.id ?? null);

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/expenses" />
      <ConsoleShell
        consoleTitle="console.operator"
        pathname="/operator/expenses"
        locale={locale}
        title="expenses.title"
        subtitle="expenses.subtitle"
        items={operatorMoneyNav(locale)}
      >
        <ExpensesPanel
          locale={locale}
          orgId={org?.id ?? null}
          expenses={expenses}
          canVoid={canVoid}
        />
        {expenses.length === 0 ? <p className="form-hint">{t('expenses.empty')}</p> : null}
      </ConsoleShell>
    </>
  );
}
