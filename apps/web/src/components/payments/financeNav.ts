import type { ConsoleNavGroup } from '@/components/ConsoleShell';
import type { IconName } from '@/components/ui/Icon';
import type { TranslationKey } from '@maak/core';

/**
 * The finance console's navigation, in one place.
 *
 * It was a flat list of ten links, which is a list, not a map: *Dashboard*, *Invoices*, *Statements*, *Ledger*,
 * *Reconciliation*, *Payments*, *Accounts*, *Agents*, *Payouts* — nine screens of equal weight in one row, with no
 * hint that the first four are the desk's daily work and the last five are its reference — and a tenth link,
 * *Overview*, that pointed at **`/staff/dashboard`**, a different console. A finance officer who clicked it landed in
 * the staff desk, with the staff navigation, wondering what happened.
 *
 * Grouped by the question each screen answers: what came in, what it is made of, who we owe, and the books underneath
 * all three.
 */
export function financeNav(locale: string): readonly ConsoleNavGroup[] {
  const item = (key: TranslationKey, href: string, icon: IconName) => ({
    key,
    href: `/${locale}${href}`,
    icon,
  });

  return [
    {
      key: 'console.groupDesk',
      items: [item('financeNav.dashboard', '/finance/dashboard', 'spark')],
    },
    {
      key: 'console.groupIncoming',
      items: [
        item('financeNav.invoices', '/finance/invoices', 'ticket'),
        item('console.navFinancePayments', '/finance/payments', 'wallet'),
        item('financeNav.statements', '/finance/statements', 'price'),
      ],
    },
    {
      key: 'console.groupBooks',
      items: [
        item('financeNav.ledger', '/finance/ledger', 'route'),
        item('financeNav.reconciliation', '/finance/reconciliation', 'shield'),
        item('console.navFinanceAccounts', '/finance/accounts', 'inbox'),
      ],
    },
    {
      key: 'console.groupParties',
      items: [
        item('console.navFinanceAgents', '/finance/agents', 'users'),
        item('console.navFinancePayouts', '/finance/payouts', 'bus'),
      ],
    },
  ];
}
