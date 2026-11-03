import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminNav } from '@/components/admin/AdminNav';
import { EmptyState } from '@/components/ui/Feedback';
import { UserDirectory } from '@/components/admin/UserDirectory';
import { loadAccountContext } from '@/lib/account';
import { loadAdminUsers } from '@/lib/admin';
import { previewAccount, previewUsers } from '@/lib/preview-data';

export default async function AdminUsersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/users`);
  }

  const preview = !loaded.configured;
  const data = preview ? previewAccount : loaded;
  const isAdmin = preview || data.roles.includes('platform_admin');

  if (!isAdmin) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/admin/users" />
        <main id="main" className="shell section">
          <h1>{t('admin.title')}</h1>
          <EmptyState title={t('errors.FORBIDDEN')} description={t('admin.subtitle')} />
        </main>
      </>
    );
  }

  // The directory itself, not just the operator looking at it: `profiles_select_staff` and
  // `user_roles_select_staff` have always allowed this read, and until now nothing made it.
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

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/users" />
      <ConsoleShell
        consoleTitle="console.admin"
        pathname="/admin/users"
        locale={locale}
        title="console.navUsers"
        subtitle="admin.usersSubtitle"
        groups={adminNav(locale)}
        actions={
          <Link className="ui-btn ui-btn--primary ui-btn--sm" href={`/${locale}/admin/users/roles`}>
            {t('admin.manageRoles')}
          </Link>
        }
      >
        {preview ? <PreviewBanner locale={locale} /> : null}
        <UserDirectory locale={locale} users={directory.users} truncated={directory.truncated} />
      </ConsoleShell>
    </>
  );
}
