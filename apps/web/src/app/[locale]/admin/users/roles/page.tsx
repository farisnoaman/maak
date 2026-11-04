import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminNav } from '@/components/admin/AdminNav';
import { EmptyState } from '@/components/ui/Feedback';
import { RoleGrants } from '@/components/admin/RoleGrants';
import { loadAccountContext } from '@/lib/account';
import { loadAdminUsers } from '@/lib/admin';
import { previewAccount, previewUsers } from '@/lib/preview-data';

/**
 * `/admin/users/roles` — who holds which platform role, and the lever that changes it.
 *
 * It was a fieldset under the directory table. Two jobs, one column: you opened the page to read who has an
 * account, and were handed a control that can revoke an admin's access on the way past — with the answer to the
 * question the control raises ("who else is an admin?") nowhere on the screen.
 *
 * Granting a role is a decision about a person, so it gets a page: the person you came from (`?user=`), the role,
 * the verb, and the ledger of holders beside it, read from the same directory the previous screen lists.
 */
export const dynamic = 'force-dynamic';

export default async function AdminRolesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/users/roles`);
  }

  const preview = !loaded.configured;
  const data = preview ? previewAccount : loaded;
  const isAdmin = preview || data.roles.includes('platform_admin');

  if (!isAdmin) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/admin/users/roles" />
        <ConsoleShell
          consoleTitle="console.admin"
          pathname="/admin/users/roles"
          locale={locale}
          title="admin.navRoles"
          subtitle="admin.rolesSubtitle"
          groups={adminNav(locale)}
        >
          <p className="form-hint">{t('errors.FORBIDDEN')}</p>
        </ConsoleShell>
      </>
    );
  }

  const directory = preview
    ? {
        configured: false,
        truncated: false,
        users: previewUsers.map((user) => ({
          ...user,
          phone: null,
          joinedAt: '',
          deletionPending: false,
          roles: [...user.roles],
        })),
      }
    : await loadAdminUsers();

  const query = await searchParams;
  const requested = typeof query.user === 'string' ? query.user : undefined;
  const admins = directory.users.filter((user) => user.roles.includes('platform_admin')).length;
  const unassigned = directory.users.filter((user) => user.roles.length === 0).length;

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/users/roles" />
      <ConsoleShell
        consoleTitle="console.admin"
        pathname="/admin/users/roles"
        locale={locale}
        title="admin.navRoles"
        subtitle="admin.rolesSubtitle"
        groups={adminNav(locale)}
        facts={[
          { label: t('admin.users'), value: String(directory.users.length) },
          { label: t('admin.role.platform_admin'), value: String(admins) },
          { label: t('admin.noRoleAccounts'), value: String(unassigned) },
        ]}
        actions={
          <Link className="ui-btn ui-btn--ghost ui-btn--sm" href={`/${locale}/admin/users`}>
            {t('admin.users')}
          </Link>
        }
      >
        {preview ? <PreviewBanner locale={locale} /> : null}
        {directory.users.length === 0 ? (
          <EmptyState
            title={t('admin.noUsers')}
            description={t('admin.rolesHeldHint')}
            icon="users"
          />
        ) : (
          <RoleGrants
            locale={locale}
            users={directory.users}
            configured={!preview}
            initialUserId={requested}
          />
        )}
      </ConsoleShell>
    </>
  );
}
