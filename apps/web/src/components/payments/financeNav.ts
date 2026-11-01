import type { TranslationKey } from '@maak/core';

/**
 * The finance desk's navigation, in one place.
 *
 * Four screens, one list: the desk moves between the ledger, the accounts, the agents and the payout queue
 * all day, and a link missing from one page is a feature nobody finds.
 */
export function financeNav(locale: string) {
  return [
    { key: 'console.navFinancePayments' as TranslationKey, href: `/${locale}/finance/payments` },
    { key: 'console.navFinanceAccounts' as TranslationKey, href: `/${locale}/finance/accounts` },
    { key: 'console.navFinanceAgents' as TranslationKey, href: `/${locale}/finance/agents` },
    { key: 'console.navFinancePayouts' as TranslationKey, href: `/${locale}/finance/payouts` },
    { key: 'console.navOverview' as TranslationKey, href: `/${locale}/staff/dashboard` },
  ];
}
