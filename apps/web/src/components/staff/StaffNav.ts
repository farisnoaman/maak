import type { ConsoleNavGroup } from '@/components/ConsoleShell';

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
  return [
    {
      key: 'console.groupWork',
      items: [
        { key: 'console.navOverview', href: `/${locale}/staff` },
        { key: 'ops.dashboard', href: `/${locale}/staff/dashboard` },
        { key: 'ops.scan', href: `/${locale}/staff/scan` },
      ],
    },
    {
      key: 'console.groupReview',
      items: [
        { key: 'staff.trips.title', href: `/${locale}/staff/trips` },
        { key: 'console.navVerifications', href: `/${locale}/staff/verifications` },
        { key: 'fleet.staffQueue', href: `/${locale}/staff/vehicles` },
      ],
    },
    {
      key: 'console.groupReference',
      items: [{ key: 'nav.places', href: `/${locale}/admin/places` }],
    },
  ];
}
