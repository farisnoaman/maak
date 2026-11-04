import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminNav } from '@/components/admin/AdminNav';
import { EmptyState } from '@/components/ui/Feedback';
import { DeletionRequests } from '@/components/admin/DeletionRequests';
import { loadAccountContext } from '@/lib/account';
import { loadDeletionRequests } from '@/lib/admin';
import { previewAccount, previewDeletionRequests } from '@/lib/preview-data';

/**
 * `/admin/users/deletions` — the account-deletion queue.
 *
 * It sat at the bottom of the people-and-roles screen, under a directory that can be hundreds of rows long: the one
 * queue on that page a person must act on, below the one list they read. Same rule as the rest of the console — one
 * job per page, reached from the header of the page it belongs to.
 */
export const dynamic = 'force-dynamic';

export default async function AdminDeletionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/users/deletions`);
  }

  const preview = !loaded.configured;
  const data = preview ? previewAccount : loaded;
  const isAdmin = preview || data.roles.includes('platform_admin');

  if (!isAdmin) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/admin/users/deletions" />
        <main id="main" className="shell section">
          <h1>{t('admin.deletionTitle')}</h1>
          <EmptyState title={t('errors.FORBIDDEN')} description={t('admin.deletionHint')} />
        </main>
      </>
    );
  }

  const deletion = preview
    ? { configured: false, requests: previewDeletionRequests }
    : await loadDeletionRequests();

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/users/deletions" />
      <ConsoleShell
        consoleTitle="console.admin"
        pathname="/admin/users/deletions"
        locale={locale}
        title="admin.deletionTitle"
        subtitle="admin.deletionHint"
        groups={adminNav(locale)}
        facts={[{ label: t('admin.deletionWaiting'), value: String(deletion.requests.length) }]}
      >
        {preview ? <PreviewBanner locale={locale} /> : null}
        <DeletionRequests
          locale={locale}
          requests={deletion.requests}
          configured={deletion.configured}
        />
      </ConsoleShell>
    </>
  );
}
