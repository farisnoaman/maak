import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { EmptyState } from '@/components/ui/Feedback';
import { AcceptInvite } from '@/components/account/AcceptInvite';
import { loadAccountContext } from '@/lib/account';

export default async function InvitationsPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/account/invitations`);
  }

  const query = await searchParams;
  const memberId = typeof query.member === 'string' ? query.member : '';
  const token = typeof query.token === 'string' ? query.token : '';

  return (
    <>
      <SiteHeader locale={locale} pathname="/account/invitations" />
      <main id="main" className="shell section">
        <h1>{t('account.invitations')}</h1>
        <p className="form-hint">{t('org.inviteCreated')}</p>
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        {memberId && token ? (
          <AcceptInvite
            locale={locale}
            memberId={memberId}
            token={token}
            configured={loaded.configured}
          />
        ) : (
          <EmptyState title={t('account.noNotifications')} description={t('account.invitations')} />
        )}
      </main>
    </>
  );
}
