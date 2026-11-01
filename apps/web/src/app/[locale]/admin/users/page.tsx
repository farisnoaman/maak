import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminNav } from '@/components/admin/AdminNav';
import { EmptyState } from '@/components/ui/Feedback';
import { DeletionRequests } from '@/components/admin/DeletionRequests';
import { RoleConsole } from '@/components/admin/RoleConsole';
import { loadAccountContext } from '@/lib/account';
import { loadAdminUsers, loadDeletionRequests } from '@/lib/admin';
import { previewAccount, previewDeletionRequests, previewUsers } from '@/lib/preview-data';

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

  // The queue `cmd_delete_account` was always able to act on, and nobody could find: a read through RLS
  // (`profiles_select_staff`), so a passenger who reaches this page reads nothing.
  const deletion = preview
    ? { configured: false, requests: previewDeletionRequests }
    : await loadDeletionRequests();

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
        subtitle="admin.subtitle"
        groups={adminNav(locale)}
      >
        {preview ? <PreviewBanner locale={locale} /> : null}
        <RoleConsole
          locale={locale}
          users={directory.users}
          configured={!preview}
          truncated={directory.truncated}
        />
        <section>
          <h2>{t('admin.deletionTitle')}</h2>
          <DeletionRequests
            locale={locale}
            requests={deletion.requests}
            configured={deletion.configured}
          />
        </section>
      </ConsoleShell>
    </>
  );
}
