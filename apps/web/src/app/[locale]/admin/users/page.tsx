import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { RoleConsole } from '@/components/admin/RoleConsole';
import { loadAccountContext } from '@/lib/account';
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

  const users = preview
    ? previewUsers.map((user) => ({ ...user, roles: [...user.roles] }))
    : [
        {
          id: data.user?.id ?? '',
          name: data.profile?.fullName ?? null,
          email: data.user?.email ?? null,
          verification: data.profile?.verificationStatus ?? 'unverified',
          roles: [...data.roles],
        },
      ];

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/users" />
      <ConsoleShell
        locale={locale}
        title="admin.title"
        subtitle="admin.subtitle"
        phase="1"
        items={[
          { key: 'console.navOverview', href: `/${locale}/admin` },
          { key: 'nav.roles', href: `/${locale}/admin/users` },
          { key: 'nav.account', href: `/${locale}/account` },
        ]}
      >
        {preview ? <PreviewBanner locale={locale} /> : null}
        <RoleConsole locale={locale} users={users} configured={!preview} />
      </ConsoleShell>
    </>
  );
}
