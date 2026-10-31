import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { NotificationPanel } from '@/components/account/NotificationPanel';
import { CreateOrganizationForm } from '@/components/account/CreateOrganizationForm';
import { DeletionPanel } from '@/components/account/DeletionPanel';
import { AccountNav } from '@/components/account/AccountNav';
import { activeOrganization, loadAccountContext, type AccountContext } from '@/lib/account';
import { previewAccount } from '@/lib/preview-data';

const STATUS_TONE = {
  unverified: 'neutral',
  pending: 'warning',
  verified: 'success',
  rejected: 'danger',
} as const;

const STATUS_LABEL: Record<keyof typeof STATUS_TONE, TranslationKey> = {
  unverified: 'verification.status.unverified',
  pending: 'verification.status.pending',
  verified: 'verification.status.verified',
  rejected: 'verification.status.rejected',
};

export default async function AccountPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/account`);
  }

  const preview = !loaded.configured;
  const data: AccountContext = preview ? previewAccount : loaded;
  const query = await searchParams;
  const requestedOrg = typeof query.org === 'string' ? query.org : undefined;
  const current = activeOrganization(data, requestedOrg);
  const profile = data.profile;

  return (
    <>
      <SiteHeader locale={locale} pathname="/account" />
      <main id="main" className="shell section account-page">
        <header className="account-head">
          <h1>{t('account.title')}</h1>
          <p className="form-hint">{t('account.subtitle')}</p>
        </header>

        <AccountNav locale={locale} current="/account" />

        {preview ? <PreviewBanner locale={locale} /> : null}

        <section className="card account-card" aria-labelledby="account-profile-title">
          <div className="panel-head">
            <div>
              <p className="account-name" id="account-profile-title">
                {profile?.fullName ?? t('account.personal')}
              </p>
              <p className="form-hint" dir="ltr">
                {data.user?.email ?? profile?.phone ?? ''}
              </p>
            </div>
            <Badge tone={STATUS_TONE[profile?.verificationStatus ?? 'unverified']}>
              {t(STATUS_LABEL[profile?.verificationStatus ?? 'unverified'])}
            </Badge>
          </div>

          <p className="form-hint">
            {profile?.nationalIdType
              ? `${t('verification.nationalIdType')}: ${profile.nationalIdType}`
              : t('verification.subtitle')}
          </p>

          <div className="form-actions">
            <Link
              className="ui-btn ui-btn--primary ui-btn--md"
              href={`/${locale}/account/verification`}
            >
              {t('nav.verification')}
            </Link>
            {/* A booking is the thing a passenger comes back to check, so it is the second action and not
                a link buried in a list of doorways. */}
            <Link
              className="ui-btn ui-btn--primary ui-btn--md"
              href={`/${locale}/account/bookings`}
            >
              {t('bookings.myTitle')}
            </Link>
            {/* A driver's licence is a document about the person, so it lives with the account — and it
                must be reachable from the account, or the only way to add one is to know the URL. */}
            <Link className="ui-btn ui-btn--ghost ui-btn--md" href={`/${locale}/account/licence`}>
              {t('fleet.accountLicence')}
            </Link>
          </div>
        </section>

        {/* The consoles belong to other audiences, but a driver who is never shown the door will drive
            without logging the trip. They are doorways, so they look like doorways — one size, one grid. */}
        <section className="account-section" aria-labelledby="account-links-title">
          <h2 id="account-links-title">{t('account.quickLinks')}</h2>
          <div className="account-links">
            <Link className="ui-btn ui-btn--subtle ui-btn--md" href={`/${locale}/driver`}>
              {t('driver.title')}
            </Link>
            <Link
              className="ui-btn ui-btn--subtle ui-btn--md"
              href={`/${locale}/staff/verifications`}
            >
              {t('nav.verificationQueue')}
            </Link>
            <Link className="ui-btn ui-btn--subtle ui-btn--md" href={`/${locale}/admin/users`}>
              {t('nav.roles')}
            </Link>
          </div>
        </section>

        <section className="account-section" aria-labelledby="account-orgs-title">
          <h2 id="account-orgs-title">{t('account.organizations')}</h2>
          {data.organizations.length === 0 ? (
            <p className="form-hint">{t('account.noOrganizations')}</p>
          ) : (
            <div className="account-orgs">
              {data.organizations.map((org) => (
                <article
                  key={org.id}
                  className={`account-org${org.id === current?.id ? ' account-org--active' : ''}`}
                >
                  <div className="panel-head">
                    <p className="account-name">{org.name}</p>
                    <Badge tone={STATUS_TONE[org.verificationStatus]}>
                      {t(STATUS_LABEL[org.verificationStatus])}
                    </Badge>
                  </div>
                  <p className="form-hint">
                    {t(`org.role.${org.role}` as TranslationKey)} · {org.plan}
                  </p>
                  <div className="form-actions">
                    <Link
                      className="ui-btn ui-btn--subtle ui-btn--sm"
                      href={`/${locale}/operator/settings?org=${org.id}`}
                    >
                      {t('org.settings')}
                    </Link>
                    <Link
                      className="ui-btn ui-btn--subtle ui-btn--sm"
                      href={`/${locale}/operator/team?org=${org.id}`}
                    >
                      {t('org.team')}
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}

          <CreateOrganizationForm locale={locale} configured={!preview} />
        </section>

        <section className="account-section" aria-labelledby="account-notifications-title">
          <h2 id="account-notifications-title">{t('account.notifications')}</h2>
          <NotificationPanel
            locale={locale}
            configured={!preview}
            items={data.notifications.map((item) => ({
              id: item.id,
              titleKey: item.titleKey,
              params: item.params,
              link: item.link,
              readAt: item.readAt,
              createdAt: item.createdAt,
            }))}
          />
        </section>

        <section className="account-section" aria-labelledby="account-deletion-title">
          <h2 id="account-deletion-title">{t('account.deletion')}</h2>
          <DeletionPanel
            locale={locale}
            configured={!preview}
            pending={Boolean(profile?.deletionRequestedAt)}
          />
        </section>

        {/* Signing out is not one of the actions of this page; it ends the session. Below a rule, on its
            own, with the sentence that says so. Signing out is a POST because the session lives in an
            httpOnly cookie, and a GET must never change state. */}
        <div className="account-signout">
          <form method="post" action="/api/auth/sign-out">
            <input type="hidden" name="locale" value={locale} />
            <Button type="submit" variant="subtle">
              {t('nav.signOut')}
            </Button>
          </form>
          <p className="form-hint">{t('account.signOutHint')}</p>
        </div>
      </main>
    </>
  );
}
