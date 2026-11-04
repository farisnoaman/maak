import type { ConsoleNavGroup } from '@/components/ConsoleShell';
import type { IconName } from '@/components/ui/Icon';
import type { TranslationKey } from '@maak/core';

/**
 * The staff console's navigation, in one place.
 *
 * Every staff page used to build its own `items` array, so the sidebar changed shape as you moved: `/staff` had
 * seven links, the dashboard and the scanner had four, trip review had three, and **verifications had two — one of
 * them "Account"**, which is not a staff destination at all. From vehicle review you could not reach verification
 * review without going back through the overview. That is what makes a console feel like five apps.
 *
 * Grouped the way a shift actually thinks: the work in front of me, the queues I decide, and the reference I look
 * things up in.
 */
export function staffNav(locale: string): readonly ConsoleNavGroup[] {
  const item = (key: TranslationKey, href: string, icon: IconName) => ({
    key,
    href: `/${locale}${href}`,
    icon,
  });

  return [
    {
      key: 'console.groupWork',
      items: [
        item('console.navOverview', '/staff', 'spark'),
        item('ops.dashboard', '/staff/dashboard', 'calendar'),
        item('ops.scan', '/staff/scan', 'ticket'),
      ],
    },
    {
      key: 'console.groupReview',
      items: [
        item('staff.trips.title', '/staff/trips', 'route'),
        item('console.navVerifications', '/staff/verifications', 'shield'),
        item('fleet.staffQueue', '/staff/vehicles', 'bus'),
      ],
    },
    {
      key: 'console.groupReference',
      items: [item('nav.places', '/admin/places', 'pin')],
    },
  ];
}
