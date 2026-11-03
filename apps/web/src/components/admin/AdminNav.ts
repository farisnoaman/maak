import type { ConsoleNavGroup } from '@/components/ConsoleShell';
import type { IconName } from '@/components/ui/Icon';
import type { TranslationKey } from '@maak/core';

/**
 * Where the admin console goes, and why — one list, used twice.
 *
 * The sidebar and the overview index are two presentations of the same map: the rail is the map you can walk, the
 * index is the map you can read. They used to be two hand-written lists, and they disagreed — the index advertised
 * six destinations while the rail carried five, and neither showed the three screens that had been given pages of
 * their own (`/users/deletions`, `/plans/commissions`, `/subscriptions/overrides`) but were only reachable by a
 * button on their parent. A screen that exists and cannot be found from the console's own navigation is a screen
 * nobody uses.
 *
 * So each destination is declared once, with a note, and both surfaces derive from it. Grouped by the thing being
 * administered, in the order an administrator meets it: the patch (regions, places), the people who work it, the
 * money it earns, and the machinery that talks to both.
 *
 * **One job per page.** A destination is a screen that *manages* something — a list you can act from, a queue you
 * can empty, a set of rules you can edit. Creating, editing and inspecting a record are tasks *inside* a
 * destination (a region's detail page, a place's form) and belong to it, not beside it: the sidebar lists the
 * rooms, not every door in every room.
 */
export interface AdminDestination {
  readonly key: TranslationKey;
  readonly note: TranslationKey;
  readonly href: string;
  readonly icon: IconName;
}

export interface AdminDestinationGroup {
  readonly key: TranslationKey;
  readonly items: readonly AdminDestination[];
}

export function adminDestinations(locale: string): readonly AdminDestinationGroup[] {
  return [
    {
      key: 'console.groupWorkspace',
      items: [
        {
          key: 'console.navOverview',
          note: 'admin.hubSubtitle',
          href: `/${locale}/admin`,
          icon: 'spark',
        },
      ],
    },
    {
      key: 'console.groupGeography',
      items: [
        {
          key: 'nav.regions',
          note: 'geo.subtitle',
          href: `/${locale}/admin/regions`,
          icon: 'route',
        },
        {
          key: 'nav.places',
          note: 'places.subtitle',
          href: `/${locale}/admin/places`,
          icon: 'pin',
        },
      ],
    },
    {
      key: 'console.groupPeople',
      items: [
        {
          key: 'console.navUsers',
          note: 'admin.usersSubtitle',
          href: `/${locale}/admin/users`,
          icon: 'users',
        },
        {
          key: 'admin.navRoles',
          note: 'admin.rolesSubtitle',
          href: `/${locale}/admin/users/roles`,
          icon: 'shield',
        },
        {
          key: 'admin.deletionTitle',
          note: 'admin.deletionsSubtitle',
          href: `/${locale}/admin/users/deletions`,
          icon: 'inbox',
        },
      ],
    },
    {
      key: 'console.groupMoney',
      items: [
        {
          key: 'financeNav.plans',
          note: 'plans.subtitle',
          href: `/${locale}/admin/plans`,
          icon: 'price',
        },
        {
          key: 'plans.commissions',
          note: 'plans.commissionsSubtitle',
          href: `/${locale}/admin/plans/commissions`,
          icon: 'wallet',
        },
        {
          key: 'financeNav.subscriptions',
          note: 'subs.subtitle',
          href: `/${locale}/admin/subscriptions`,
          icon: 'ticket',
        },
        {
          key: 'subs.overrides',
          note: 'subs.overridesSubtitle',
          href: `/${locale}/admin/subscriptions/overrides`,
          icon: 'star',
        },
      ],
    },
    {
      key: 'console.groupPlatform',
      items: [
        {
          key: 'console.navTemplates',
          note: 'catalogue.subtitle',
          href: `/${locale}/admin/notifications`,
          icon: 'phone',
        },
      ],
    },
  ];
}

/** The same map, in the shape the rail takes: labels and links, no prose. */
export function adminNav(locale: string): readonly ConsoleNavGroup[] {
  return adminDestinations(locale).map((group) => ({
    key: group.key,
    items: group.items.map((item) => ({
      key: item.key,
      href: item.href,
      icon: item.icon,
    })),
  }));
}
