import { notFound, redirect } from 'next/navigation';
import { can, isLocale, translate, type Locale, type Role, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { VerificationQueue } from '@/components/staff/VerificationQueue';
import { loadAccountContext } from '@/lib/account';
import { callGateway } from '@/lib/gateway';
import { previewAccount, previewQueue } from '@/lib/preview-data';

export default async function StaffVerificationsPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/staff/verifications`);
  }

  const preview = !loaded.configured;
  const data = preview ? previewAccount : loaded;
  const roles = (preview ? ['platform_staff'] : data.roles) as Role[];

  // Server-side gate. The command refuses a non-staff caller anyway; this just avoids rendering a
  // queue the visitor could never act on.
  const allowed = can(
    { userId: data.user?.id ?? null, roles, verification: 'verified', plan: 'basic' },
    'verification.decide',
  );
  if (data.configured && !allowed) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/staff/verifications" />
        <main id="main" className="shell section">
          <h1>{t('staff.title')}</h1>
          <EmptyState title={t('errors.FORBIDDEN')} description={t('staff.subtitle')} />
        </main>
      </>
    );
  }

  let items = preview ? previewQueue : [];
  if (!preview) {
    const queue = await callGateway<{ items: typeof previewQueue }>('verification-queue', {
      action: 'queue.list',
      status: 'pending',
      subjectType: 'all',
      limit: 50,
    });
    items = queue.ok ? queue.data.items : [];
  }

  return (
    <>
      <SiteHeader locale={locale} pathname="/staff/verifications" />
      <ConsoleShell
        locale={locale}
        title="staff.title"
        subtitle="staff.subtitle"
        phase="1"
        items={[
          { key: 'staff.title', href: `/${locale}/staff/verifications` },
          { key: 'nav.account', href: `/${locale}/account` },
        ]}
      >
        {preview ? <PreviewBanner locale={locale} /> : null}
        {items.length === 0 ? (
          <EmptyState title={t('staff.empty')} description={t('staff.subtitle')} />
        ) : (
          <VerificationQueue
            locale={locale}
            items={items}
            actorId={data.user?.id ?? null}
            actorRoles={roles}
            configured={!preview}
          />
        )}
      </ConsoleShell>
    </>
  );
}
