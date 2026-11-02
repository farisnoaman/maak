import type { ConsoleNavGroup } from '@/components/ConsoleShell';

/**
 * The admin console's navigation, in one place.
 *
 * Five pages each carried a hand-written list and they disagreed: the overview listed five destinations, places
 * listed five *different* ones, users listed three, and plans/subscriptions swapped in `adminMoneyNav` — which sent
 * the reader to `/finance/invoices` and `/finance/payouts`, two screens that belong to a different console. Which
 * links you could see depended on which screen you were already on.
 *
 * Grouped by the thing being administered, in the order an administrator meets it: the patch (regions, places), the
 * people, the money, and the machinery that talks to both.
 */
export function adminNav(locale: string): readonly ConsoleNavGroup[] {
  return [
    {
      key: 'console.groupWorkspace',
      items: [{ key: 'console.navOverview', href: `/${locale}/admin` }],
    },
    {
      key: 'console.groupGeography',
      items: [
        { key: 'nav.regions', href: `/${locale}/admin/regions` },
        { key: 'nav.places', href: `/${locale}/admin/places` },
      ],
    },
    {
      key: 'console.groupPeople',
      items: [{ key: 'console.navUsers', href: `/${locale}/admin/users` }],
    },
    {
      key: 'console.groupMoney',
      items: [
        { key: 'financeNav.plans', href: `/${locale}/admin/plans` },
        { key: 'financeNav.subscriptions', href: `/${locale}/admin/subscriptions` },
      ],
    },
    {
      key: 'console.groupPlatform',
      items: [{ key: 'console.navTemplates', href: `/${locale}/admin/notifications` }],
    },
  ];
}
