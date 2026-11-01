import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { TeamPanel } from '@/components/account/TeamPanel';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import { previewAccount } from '@/lib/preview-data';

export default async function OperatorTeamPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/team`);
  }

  const preview = !loaded.configured;
  const data = preview ? previewAccount : loaded;
  const query = await searchParams;
  const org = activeOrganization(data, typeof query.org === 'string' ? query.org : undefined);
  const members = data.members.filter((member) => member.orgId === org?.id);

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/team" />
      <ConsoleShell
        consoleTitle="console.operator"
        pathname="/operator/team"
        locale={locale}
        title="org.team"
        subtitle="console.subtitle.operator"
        items={[
          { key: 'console.navOverview', href: `/${locale}/operator` },
          { key: 'org.settings', href: `/${locale}/operator/settings` },
          { key: 'org.team', href: `/${locale}/operator/team` },
          { key: 'nav.account', href: `/${locale}/account` },
        ]}
      >
        {preview ? <PreviewBanner locale={locale} /> : null}
        {org ? (
          <TeamPanel
            locale={locale}
            orgId={org.id}
            orgName={org.name}
            actorRole={org.role}
            actorId={data.user?.id ?? null}
            configured={!preview}
            initialMembers={members.map((member) => ({
              id: member.id,
              userId: member.userId,
              role: member.role,
              status: member.status,
              email: member.email,
              phone: member.phone,
            }))}
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
