import type { ConsoleNavGroup } from '@/components/ConsoleShell';
import type { IconName } from '@/components/ui/Icon';
import type { TranslationKey } from '@maak/core';

/**
 * The operator console's navigation, in one place.
 *
 * It was re-declared in about ten pages, and no two agreed. The overview listed seven destinations; trips listed
 * eight including the calendar and the staff desk; vehicles listed six; fleet listed five; drivers three; payments
 * four; billing, expenses, payouts, team and settings each their own handful. So the console changed shape as the
 * operator moved through it, and the shortcuts that mattered — the calendar from a trip, payouts from payments —
 * appeared and vanished depending on which screen you were already on. Two of those lists also reached into *staff*
 * territory, offering a destination the signed-in operator often could not open.
 *
 * One list now, grouped the way an operator's week is: the trips being run, the fleet that runs them, the money they
 * make, and the organisation behind all three.
 *
 * The staff desk is still reachable — but from the trip *list*, where a staff member with operator rights actually
 * looks for a queue, rather than as a permanent tab in a console that is not theirs.
 */
export function operatorNav(locale: string): readonly ConsoleNavGroup[] {
  const item = (key: TranslationKey, href: string, icon: IconName) => ({
    key,
    href: `/${locale}${href}`,
    icon,
  });

  return [
    {
      key: 'console.groupWork',
      items: [
        item('console.navOverview', '/operator', 'spark'),
        item('console.navTrips', '/operator/trips', 'route'),
        item('trips.calendar', '/operator/trips/calendar', 'calendar'),
      ],
    },
    {
      key: 'console.groupFleet',
      items: [
        item('console.navVehicles', '/operator/vehicles', 'bus'),
        item('console.navDrivers', '/operator/drivers', 'users'),
        item('console.navFleet', '/operator/fleet', 'shield'),
      ],
    },
    {
      key: 'console.groupMoney',
      items: [
        item('console.navPayments', '/operator/payments', 'wallet'),
        item('console.navPayouts', '/operator/payouts', 'ticket'),
        item('financeNav.billing', '/operator/billing', 'price'),
        item('financeNav.expenses', '/operator/expenses', 'inbox'),
      ],
    },
    {
      key: 'console.groupOrg',
      items: [
        item('org.team', '/operator/team', 'users'),
        item('org.settings', '/operator/settings', 'filter'),
      ],
    },
  ];
}

/**
 * The money pages' own grouping: the same console, narrowed to the four screens that touch cash.
 *
 * This is not a second navigation — it is `operatorNav` with the two groups an operator on a payment screen still
 * needs to reach, so the bar above *Payments* is the same bar as everywhere else rather than a four-link subset that
 * drops the trip they were checking.
 */
export function operatorMoneyNav(locale: string): readonly ConsoleNavGroup[] {
  return operatorNav(locale).filter((group) =>
    ['console.groupWork', 'console.groupMoney'].includes(group.key),
  );
}
