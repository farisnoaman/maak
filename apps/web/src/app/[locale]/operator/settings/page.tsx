import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { OrganizationPanel } from '@/components/account/OrganizationPanel';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import { previewAccount } from '@/lib/preview-data';

export default async function OperatorSettingsPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/settings`);
  }

  const preview = !loaded.configured;
  const data = preview ? previewAccount : loaded;
  const query = await searchParams;
  const org = activeOrganization(data, typeof query.org === 'string' ? query.org : undefined);

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/settings" />
      <ConsoleShell
        locale={locale}
        title="org.settings"
        subtitle="console.subtitle.operator"
        phase="1"
        items={[
          { key: 'console.navOverview', href: `/${locale}/operator` },
          { key: 'org.settings', href: `/${locale}/operator/settings` },
          { key: 'org.team', href: `/${locale}/operator/team` },
          { key: 'nav.account', href: `/${locale}/account` },
        ]}
      >
        {preview ? <PreviewBanner locale={locale} /> : null}
        {org ? (
          <OrganizationPanel
            locale={locale}
            configured={!preview}
            organization={{
              id: org.id,
              name: org.name,
              nameEn: org.nameEn,
              registrationNo: org.registrationNo,
              taxNo: org.taxNo,
              phone: org.phone,
              email: org.email,
              kind: org.kind,
              verificationStatus: org.verificationStatus,
              role: org.role,
            }}
          />
        ) : (
          <EmptyState
            title={t('account.noOrganizations')}
            description={t('account.createOrganization')}
          />
        )}
      </ConsoleShell>
    </>
  );
}
