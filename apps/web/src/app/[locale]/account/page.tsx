import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  BOOKING_STATUS_KEY,
  bookingTone,
  departureLabel,
  formatMinor,
  isLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { Badge } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
import { Button } from '@/components/ui/Button';
import { NotificationPanel } from '@/components/account/NotificationPanel';
import { CreateOrganizationForm } from '@/components/account/CreateOrganizationForm';
import { DeletionPanel } from '@/components/account/DeletionPanel';
import { AccountNav } from '@/components/account/AccountNav';
import { loadMyBookings } from '@/lib/bookings';
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
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

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

  /**
   * The journey this person is most likely here to check.
   *
   * The hub listed the profile, the organisations, the notifications and the delete button — everything about the
   * account and nothing about the trip. A passenger opens this page to look up a departure, a code and a seat count,
   * which meant a second click into bookings every time. The soonest booking that has not left yet is the answer, so
   * it is the first block on the page.
   */
  const bookings = await loadMyBookings();
  const now = Date.now();
  const nextJourney =
    bookings
      .filter(
        (booking) =>
          booking.trip != null &&
          new Date(booking.trip.departureAt).getTime() > now &&
          (booking.status === 'pending' || booking.status === 'accepted'),
      )
      .sort(
        (a, b) =>
          new Date(a.trip?.departureAt ?? 0).getTime() -
          new Date(b.trip?.departureAt ?? 0).getTime(),
      )[0] ?? null;
  const nextWhen = nextJourney?.trip ? departureLabel(nextJourney.trip.departureAt, locale) : null;

  /**
   * Which consoles this person may actually open.
   *
   * The hub offered *everybody* a link to the verification queue and to the roles screen — doors that answer 403 to a
   * passenger. A doorway that opens onto a refusal is worse than no doorway: it tells a person they have access they
   * do not. The list is built from the roles the session already carries.
   */
  const isStaff = data.roles.includes('platform_staff') || data.roles.includes('platform_admin');
  const isAdmin = data.roles.includes('platform_admin');
  const hasOperator = data.organizations.length > 0;
  const consoles: {
    key: TranslationKey;
    href: string;
    icon: 'users' | 'shield' | 'wallet' | 'bus';
  }[] = [
    ...(hasOperator
      ? ([{ key: 'console.operator', href: '/operator', icon: 'bus' }] as const)
      : []),
    ...(isStaff ? ([{ key: 'console.staff', href: '/staff', icon: 'shield' }] as const) : []),
    ...(isAdmin ? ([{ key: 'console.admin', href: '/admin', icon: 'users' }] as const) : []),
    ...(isStaff || isAdmin
      ? ([{ key: 'console.finance', href: '/finance', icon: 'wallet' }] as const)
      : []),
  ];

  return (
    <>
      <SiteHeader locale={locale} pathname="/account" />
      <main id="main" className="shell section account-page">
        <header className="account-head">
          <div>
            <h1>{t('account.title')}</h1>
            <p className="form-hint">{t('account.subtitle')}</p>
          </div>
          <Badge tone={STATUS_TONE[profile?.verificationStatus ?? 'unverified']}>
            {t(STATUS_LABEL[profile?.verificationStatus ?? 'unverified'])}
          </Badge>
        </header>

        <AccountNav locale={locale} current="/account" />

        {preview ? <PreviewBanner locale={locale} /> : null}

        {/* Who this is: a band, not a card with a badge and three buttons in it. */}
        <section className="account-identity" aria-labelledby="account-profile-title">
          <span className="account-identity__avatar" aria-hidden="true">
            {(profile?.fullName ?? t('account.personal')).slice(0, 1)}
          </span>
          <div className="account-identity__body">
            <h2 className="account-identity__name" id="account-profile-title">
              {profile?.fullName ?? t('account.personal')}
            </h2>
            <p className="account-identity__contact" dir="ltr">
              {data.user?.email ?? profile?.phone ?? ''}
            </p>
            <p className="account-identity__meta">
              {profile?.nationalIdType
                ? `${t('verification.nationalIdType')}: ${profile.nationalIdType}`
                : t('verification.subtitle')}
            </p>
          </div>
          <div className="account-identity__actions">
            <Link
              className="ui-btn ui-btn--ghost ui-btn--md"
              href={`/${locale}/account/verification`}
            >
              {t('nav.verification')}
            </Link>
            {/* A driver's licence is a document about the person, so it lives with the account — and it
                must be reachable from the account, or the only way to add one is to know the URL. */}
            <Link className="ui-btn ui-btn--ghost ui-btn--md" href={`/${locale}/account/licence`}>
              {t('fleet.accountLicence')}
            </Link>
          </div>
        </section>

        {/* First, because it is what the page is opened for. Everything below is about the account; this is about
            the trip. */}
        <section className="account-next" aria-labelledby="account-next-title">
          <div className="account-section__head">
            <h2 id="account-next-title">{t('account.nextJourney')}</h2>
            <Link className="link-more" href={`/${locale}/account/bookings`}>
              {t('account.allBookings')}
            </Link>
          </div>

          {nextJourney && nextJourney.trip ? (
            <article className="journey">
              <p className="journey__route">
                <span>{nextJourney.trip.originName ?? '—'}</span>
                <span className="journey__arrow" aria-hidden="true">
                  <Icon name="arrow" size={16} />
                </span>
                <span>{nextJourney.trip.destinationName ?? '—'}</span>
              </p>
              <p className="journey__when">
                {t('account.departs')}
                {nextWhen ? (
                  <>
                    {' · '}
                    {nextWhen.date} · <bdi className="num">{nextWhen.time}</bdi>
                  </>
                ) : null}
              </p>
              <dl className="journey__facts">
                <div>
                  <dt>{t('bookings.myTitle')}</dt>
                  <dd>
                    <bdi dir="ltr">{nextJourney.code}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{t('trips.seats')}</dt>
                  <dd>{nextJourney.seats}</dd>
                </div>
                <div>
                  <dt>{t('bookings.total')}</dt>
                  <dd className="num">{formatMinor(nextJourney.totalYer, 'YER', { locale })}</dd>
                </div>
              </dl>
              <div className="journey__actions">
                <Badge tone={bookingTone(nextJourney.status)}>
                  {t(
                    BOOKING_STATUS_KEY[nextJourney.status as keyof typeof BOOKING_STATUS_KEY] ??
                      'bookings.status.pending',
                  )}
                </Badge>
                <Link
                  className="btn btn--primary"
                  href={`/${locale}/account/bookings/${nextJourney.id}`}
                >
                  {t('account.viewBooking')}
                </Link>
              </div>
            </article>
          ) : (
            <div className="account-next__empty">
              <p className="account-next__empty-title">{t('account.noJourney')}</p>
              <p className="form-hint">{t('account.noJourneyBody')}</p>
              <Link className="btn btn--primary" href={`/${locale}/trips`}>
                {t('account.findTrip')}
              </Link>
            </div>
          )}
        </section>

        <section className="account-section" aria-labelledby="account-orgs-title">
          <div className="account-section__head">
            <h2 id="account-orgs-title">{t('account.organizations')}</h2>
          </div>
          {data.organizations.length === 0 ? (
            <p className="form-hint">{t('account.noOrganizations')}</p>
          ) : (
            <ul className="account-orgs">
              {data.organizations.map((org) => (
                <li
                  key={org.id}
                  className={`account-org${org.id === current?.id ? ' account-org--active' : ''}`}
                >
                  <span className="account-org__mark" aria-hidden="true">
                    {org.name.slice(0, 1)}
                  </span>
                  <div className="account-org__body">
                    <p className="account-org__name">
                      {org.name}
                      {org.id === current?.id ? (
                        <span className="account-org__current">{t('account.current')}</span>
                      ) : null}
                    </p>
                    <p className="account-org__meta">
                      {t(`org.role.${org.role}` as TranslationKey)} · {org.plan}
                    </p>
                  </div>
                  {/* Only an unverified company earns a badge here: a row that says "verified" on every visit
                      is decoration, a row that says "pending" is something to act on. */}
                  {org.verificationStatus !== 'verified' ? (
                    <Badge tone={STATUS_TONE[org.verificationStatus]}>
                      {t(STATUS_LABEL[org.verificationStatus])}
                    </Badge>
                  ) : null}
                  <div className="account-org__actions">
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
                </li>
              ))}
            </ul>
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

        {/* The consoles, and only the ones this session can actually open. The page used to show everybody the
            verification queue and the roles screen; both answer 403 to a passenger, and a door that opens onto a
            refusal is worse than no door. */}
        {consoles.length > 0 ? (
          <section className="account-section" aria-labelledby="account-consoles-title">
            <div className="account-section__head">
              <h2 id="account-consoles-title">{t('account.consoles')}</h2>
              <p className="form-hint">{t('account.consolesHint')}</p>
            </div>
            <ul className="doorlist">
              {consoles.map((item) => (
                <li key={item.href}>
                  <Link className="door" href={`/${locale}${item.href}`}>
                    <span className="door__icon" aria-hidden="true">
                      <Icon name={item.icon} size={18} />
                    </span>
                    <span className="door__label">{t(item.key)}</span>
                    <Icon name="chevron" size={15} className="door__go" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

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
