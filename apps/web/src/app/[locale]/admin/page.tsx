import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminNav } from '@/components/admin/AdminNav';
import { loadAccountContext } from '@/lib/account';

/**
 * The admin console's front door.
 *
 * It used to be two bordered tiles inside a bordered panel, one of them reading "this screen is under
 * construction — you will see it working in the phase mentioned above", pointing at a phase badge that no longer
 * exists and at a plans screen that shipped two phases ago. A hub whose only two entries are a real link and an
 * apology is not an overview.
 *
 * Now it is an index: every destination in the console, grouped by the thing being administered, one row each —
 * name, what it is for, and the arrow. No cards, no padding spent on frames, and every row leads somewhere that
 * works.
 */
export default async function AdminConsolePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  const isAdmin = !loaded.configured || loaded.roles.includes('platform_admin');

  const groups: {
    key: TranslationKey;
    items: { key: TranslationKey; note: TranslationKey; href: string }[];
  }[] = [
    {
      key: 'console.groupGeography',
      items: [
        {
          key: 'nav.regions',
          note: 'geo.subtitle',
          href: `/${locale}/admin/regions`,
        },
        {
          key: 'nav.places',
          note: 'places.subtitle',
          href: `/${locale}/admin/places`,
        },
      ],
    },
    {
      key: 'console.groupPeople',
      items: [
        {
          key: 'console.navUsers',
          note: 'admin.subtitle',
          href: `/${locale}/admin/users`,
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
        },
        {
          key: 'financeNav.subscriptions',
          note: 'subs.subtitle',
          href: `/${locale}/admin/subscriptions`,
        },
      ],
    },
    {
      key: 'console.groupPlatform',
      items: [
        {
          key: 'catalogue.title',
          note: 'catalogue.subtitle',
          href: `/${locale}/admin/notifications`,
        },
      ],
    },
  ];

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin" />
      <ConsoleShell
        locale={locale}
        title="admin.hubTitle"
        consoleTitle="console.admin"
        subtitle="admin.hubSubtitle"
        pathname="/admin"
        groups={adminNav(locale)}
      >
        {!isAdmin ? (
          <p className="form-hint">{t('errors.FORBIDDEN')}</p>
        ) : (
          <div className="admin-index">
            {groups.map((group) => (
              <section className="admin-index__group" key={group.key}>
                <h2>{t(group.key)}</h2>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <Link href={item.href}>
                        <span className="admin-index__name">{t(item.key)}</span>
                        <span className="admin-index__note">{t(item.note)}</span>
                        <span className="admin-index__go" aria-hidden="true">
                          →
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </ConsoleShell>
    </>
  );
}
