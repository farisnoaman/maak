import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminDestinations, adminNav } from '@/components/admin/AdminNav';
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

  /* One map, declared in `AdminNav` and rendered twice: as the rail, and as this index. */
  const groups = adminDestinations(locale);

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
                <h2>
                  <span>{t(group.key)}</span>
                  <span className="admin-index__count">{group.items.length}</span>
                </h2>
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
