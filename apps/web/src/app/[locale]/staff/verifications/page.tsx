import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { can, isLocale, translate, type Locale, type Role, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { VerificationQueue } from '@/components/staff/VerificationQueue';
import { staffNav } from '@/components/staff/StaffNav';
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
        <ConsoleShell
          locale={locale}
          title="console.navVerifications"
          consoleTitle="console.staff"
          subtitle="console.subtitle.verifications"
          pathname="/staff/verifications"
          groups={staffNav(locale)}
        >
          <EmptyState title={t('errors.FORBIDDEN')} description={t('ops.noSummaryBody')} />
        </ConsoleShell>
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
        title="console.navVerifications"
        consoleTitle="console.staff"
        subtitle="console.subtitle.verifications"
        pathname="/staff/verifications"
        groups={staffNav(locale)}
      >
        {preview ? <PreviewBanner locale={locale} /> : null}
        {items.length === 0 ? (
          /* The subtitle above already says what this queue is for; an empty state repeats nothing and offers
             the two things a supervisor might do instead of staring at it. */
          <EmptyState
            title={t('console.emptyVerifications')}
            description={t('console.emptyVerificationsBody')}
            action={
              <Link className="btn btn--ghost" href={`/${locale}/staff/dashboard`}>
                {t('ops.dashboardTitle')}
              </Link>
            }
          />
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
