import type { TranslationKey } from '@maak/core';

/**
 * Navigation for the three consoles that touch money.
 *
 * One list per console, because the desks are different jobs: finance works the ledger all day, an operator
 * looks at their plan once a month, and an admin edits prices when the business changes its mind. A link
 * missing from one list is a page nobody finds, so the lists live beside each other where the omission is
 * visible.
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

export function adminMoneyNav(locale: string) {
  return [
    { key: 'financeNav.plans' as TranslationKey, href: `/${locale}/admin/plans` },
    { key: 'financeNav.subscriptions' as TranslationKey, href: `/${locale}/admin/subscriptions` },
    { key: 'catalogue.title' as TranslationKey, href: `/${locale}/admin/notifications` },
    { key: 'financeNav.invoices' as TranslationKey, href: `/${locale}/finance/invoices` },
    { key: 'console.navFinancePayouts' as TranslationKey, href: `/${locale}/finance/payouts` },
  ];
}
