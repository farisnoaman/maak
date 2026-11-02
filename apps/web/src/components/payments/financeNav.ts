import type { TranslationKey } from '@maak/core';

/**
 * Navigation for the two desks that touch money all day.
 *
 * One list per desk, because the jobs are different: finance works the ledger, an operator looks at their own
 * plan and payouts. The admin console's links are grouped in `components/admin/AdminNav.ts` — its old list here
 * pointed at `/finance/invoices` and `/finance/payouts`, screens that belong to another console.
 */
export function financeNav(locale: string) {
  return [
    { key: 'financeNav.dashboard' as TranslationKey, href: `/${locale}/finance/dashboard` },
    { key: 'financeNav.invoices' as TranslationKey, href: `/${locale}/finance/invoices` },
    { key: 'financeNav.statements' as TranslationKey, href: `/${locale}/finance/statements` },
    { key: 'financeNav.ledger' as TranslationKey, href: `/${locale}/finance/ledger` },
    {
      key: 'financeNav.reconciliation' as TranslationKey,
      href: `/${locale}/finance/reconciliation`,
    },
    { key: 'console.navFinancePayments' as TranslationKey, href: `/${locale}/finance/payments` },
    { key: 'console.navFinanceAccounts' as TranslationKey, href: `/${locale}/finance/accounts` },
    { key: 'console.navFinanceAgents' as TranslationKey, href: `/${locale}/finance/agents` },
    { key: 'console.navFinancePayouts' as TranslationKey, href: `/${locale}/finance/payouts` },
    { key: 'console.navOverview' as TranslationKey, href: `/${locale}/staff/dashboard` },
  ];
}

export function operatorMoneyNav(locale: string) {
  return [
    { key: 'financeNav.billing' as TranslationKey, href: `/${locale}/operator/billing` },
    { key: 'financeNav.expenses' as TranslationKey, href: `/${locale}/operator/expenses` },
    { key: 'console.navPayments' as TranslationKey, href: `/${locale}/operator/payments` },
    { key: 'console.navPayouts' as TranslationKey, href: `/${locale}/operator/payouts` },
  ];
}
