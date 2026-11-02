import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  departureLabel,
  formatDateTime,
  isLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { Icon } from '@/components/ui/Icon';
import { loadAccountContext } from '@/lib/account';
import { loadTripRequests } from '@/lib/bookings';
import { loadFleet } from '@/lib/fleet';
import { loadPaymentIntents } from '@/lib/payments';
import { loadTrips } from '@/lib/trips';

export const dynamic = 'force-dynamic';

/**
 * The operator's overview.
 *
 * It was five identical tiles with an "Open" button each: a menu with nothing to say, on the one screen an operator
 * opens on a phone between two trips. It answered "what screens exist", which the sidebar already answers.
 *
 * Now it answers the two questions an operator actually has: **what needs me before I go out again**, and **what am I
 * running next**. Both are read from the same loaders the queue pages use, so a number here and a number there cannot
 * drift apart — and each figure is a door to the queue that produced it, so "2" is one tap from the two things.
 *
 * Scope: everything this account can act on — the trips it owns personally **and** the ones owned by the companies it
 * belongs to. `/operator/trips` makes you choose a context (personal by default, `?org=` for a company), which is
 * right for a *list you are editing* and wrong for a summary: a screen that says "nothing is waiting" while a company
 * trip has three requests is worse than no summary at all. When the account has company trips, each departure names
 * which company it belongs to rather than making the reader guess.
 */
export default async function OperatorOverviewPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator`);
  }
  const query = await searchParams;
  const requestedOrg = typeof query.org === 'string' ? query.org : undefined;

  const [data, fleet, receipts] = await Promise.all([
    loadTrips(loaded),
    loadFleet(loaded),
    loadPaymentIntents(['awaiting_confirmation'], 50),
  ]);

  const userId = loaded.user?.id ?? null;
  const orgIds = new Set(loaded.organizations.map((org) => org.id));

  /** Trips this account may act on, with the name of whoever owns them. */
  const scoped = data.trips
    .filter(
      (trip) =>
        (userId !== null && trip.ownerUserId === userId) ||
        (trip.ownerOrgId !== null && orgIds.has(trip.ownerOrgId)),
    )
    .map((trip) => ({
      trip,
      owner:
        trip.ownerOrgId === null
          ? t('account.personal')
          : (loaded.organizations.find((org) => org.id === trip.ownerOrgId)?.name ??
            t('account.personal')),
    }));

  const now = Date.now();
  const upcoming = scoped
    .filter(
      (item) => item.trip.status === 'published' && new Date(item.trip.departureAt).getTime() > now,
    )
    .sort(
      (a, b) => new Date(a.trip.departureAt).getTime() - new Date(b.trip.departureAt).getTime(),
    );

  /**
   * Requests are counted across **every** upcoming trip, not only the four that fit on the screen: the figure is a
   * claim about the whole account, so it must be the whole account.
   */
  const requests = await loadTripRequests(upcoming.map((item) => item.trip.id));
  const requestByTrip = new Map(requests.map((row) => [row.tripId, row]));
  const totalRequests = requests.reduce((sum, row) => sum + row.requests, 0);
  const firstWaiting = upcoming.find((item) => requestByTrip.has(item.trip.id));

  const inScope = (ownerUserId: string | null, ownerOrgId: string | null) =>
    (userId !== null && ownerUserId === userId) || (ownerOrgId !== null && orgIds.has(ownerOrgId));

  const pendingVehicles = fleet.vehicles.filter(
    (vehicle) =>
      vehicle.verificationStatus === 'pending' && inScope(vehicle.ownerUserId, vehicle.ownerOrgId),
  ).length;
  /**
   * Drivers: the company's, plus the ones invited by phone (no org, no account of their own yet). Explicitly **not**
   * the signed-in person's own driver profile — a driver whose licence is in review does not have a queue item to
   * act on, they have a wait, and counting it here put a "1" in front of somebody who could do nothing about it.
   */
  const pendingDrivers = fleet.drivers.filter(
    (driver) =>
      driver.verificationStatus === 'pending' &&
      driver.userId !== userId &&
      (driver.orgId === null || orgIds.has(driver.orgId)),
  ).length;

  const receiptsCount = receipts.length;

  /**
   * The four figures, each a door. A zero still renders: "0 receipts" is an answer, and it is the one that lets an
   * operator stop looking. What is *not* rendered is a figure nobody can act on.
   */
  const figures: {
    key: TranslationKey;
    value: number;
    href: string;
    note?: string;
    tone?: 'warning';
  }[] = [
    {
      key: 'operatorHome.requests',
      value: totalRequests,
      href: firstWaiting
        ? `/${locale}/operator/trips/${firstWaiting.trip.id}/bookings`
        : `/${locale}/operator/trips`,
      // The trip the requests are on, not a sentence: the label above already says what the number is, and a code
      // inside a translated string would be re-ordered by the bidi algorithm in Arabic.
      note: totalRequests > 0 && firstWaiting ? firstWaiting.trip.code : undefined,
      tone: totalRequests > 0 ? 'warning' : undefined,
    },
    {
      key: 'operatorHome.receipts',
      value: receiptsCount,
      href: `/${locale}/operator/payments`,
      tone: receiptsCount > 0 ? 'warning' : undefined,
    },
    {
      key: 'operatorHome.pendingVehicles',
      value: pendingVehicles,
      href: `/${locale}/operator/vehicles`,
      tone: pendingVehicles > 0 ? 'warning' : undefined,
    },
    {
      key: 'operatorHome.pendingDrivers',
      value: pendingDrivers,
      href: `/${locale}/operator/drivers`,
      tone: pendingDrivers > 0 ? 'warning' : undefined,
    },
  ];

  const waitingCount = totalRequests + receiptsCount + pendingVehicles + pendingDrivers;
  /** One company on the list reads the name once; a mixed list names the owner on every row. */
  const owners = [...new Set(upcoming.map((item) => item.owner))];
  const withOrg = requestedOrg ? `?org=${encodeURIComponent(requestedOrg)}` : '';

  const nav: { key: TranslationKey; href: string }[] = [
    { key: 'console.navOverview', href: `/${locale}/operator` },
    { key: 'console.navTrips', href: `/${locale}/operator/trips` },
    { key: 'console.navVehicles', href: `/${locale}/operator/vehicles` },
    { key: 'console.navFleet', href: `/${locale}/operator/fleet` },
    { key: 'console.navDrivers', href: `/${locale}/operator/drivers` },
    { key: 'console.navPayments', href: `/${locale}/operator/payments` },
    { key: 'console.navPayouts', href: `/${locale}/operator/payouts` },
  ];

  /** Where the overview can go. Icons describe the screen, not the verb — a wallet is payments at any size. */
  const doors: {
    key: TranslationKey;
    note: TranslationKey;
    href: string;
    icon: Parameters<typeof Icon>[0]['name'];
  }[] = [
    {
      key: 'console.navTrips',
      note: 'operatorHome.tripsNote',
      href: `/${locale}/operator/trips`,
      icon: 'route',
    },
    {
      key: 'console.navVehicles',
      note: 'console.tileVehicles',
      href: `/${locale}/operator/vehicles`,
      icon: 'bus',
    },
    {
      key: 'console.navDrivers',
      note: 'console.tileDrivers',
      href: `/${locale}/operator/drivers`,
      icon: 'users',
    },
    {
      key: 'console.navFleet',
      note: 'fleetOps.fleetSubtitle',
      href: `/${locale}/operator/fleet`,
      icon: 'spark',
    },
    {
      key: 'console.navPayments',
      note: 'console.tilePayments',
      href: `/${locale}/operator/payments`,
      icon: 'wallet',
    },
    {
      key: 'console.navPayouts',
      note: 'console.tilePayouts',
      href: `/${locale}/operator/payouts`,
      icon: 'ticket',
    },
    {
      key: 'org.team',
      note: 'operatorHome.teamNote',
      href: `/${locale}/operator/team`,
      icon: 'shield',
    },
  ];

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator" />
      <ConsoleShell
        locale={locale}
        title="console.operator"
        consoleTitle="console.operator"
        subtitle="console.subtitle.operator"
        pathname="/operator"
        items={nav}
        actions={
          <>
            <Link className="btn btn--primary" href={`/${locale}/operator/trips/new${withOrg}`}>
              {t('operatorHome.schedule')}
            </Link>
            {/* When the numbers were read. A count without a time is a count you cannot trust. */}
            <span className="console-head__stamp">
              {t('ops.asOf', { time: formatDateTime(new Date().toISOString(), { locale }) })}
            </span>
          </>
        }
      >
        {/* One answer, once. Four zeroes under a sentence that already says nothing is waiting is the same answer
            twice — so the figures appear only when at least one of them is worth acting on. */}
        {waitingCount === 0 ? (
          <p className="ops-clear" role="status">
            <span className="ops-clear__tick" aria-hidden="true">
              <Icon name="check" size={16} />
            </span>
            <span>
              <strong>{t('operatorHome.clear')}</strong> {t('operatorHome.clearBody')}
            </span>
          </p>
        ) : (
          <div className="stat-grid stat-grid--links">
            {figures.map((figure) => (
              <Link
                className={`stat stat--link${figure.tone ? ` stat--${figure.tone}` : ''}`}
                href={figure.href}
                key={figure.key}
              >
                <span className="stat__label">{t(figure.key)}</span>
                <strong className="stat__value">{figure.value}</strong>
                {figure.note ? (
                  <span className="stat__note">
                    <bdi dir="ltr">{figure.note}</bdi>
                  </span>
                ) : null}
                <span className="stat__go" aria-hidden="true">
                  <Icon name="chevron" size={14} />
                </span>
              </Link>
            ))}
          </div>
        )}

        <section className="ops-section" aria-labelledby="op-departures">
          <div className="ops-section__head">
            <h2 id="op-departures">
              {t('operatorHome.departures')}
              {owners.length === 1 ? <span className="ops-section__scope">{owners[0]}</span> : null}
            </h2>
            <Link className="link-more" href={`/${locale}/operator/trips?status=published`}>
              {t('operatorHome.allTrips')}
            </Link>
          </div>

          {upcoming.length === 0 ? (
            <div className="ops-empty">
              <p className="ops-empty__title">{t('operatorHome.noTrips')}</p>
              <p className="form-hint">{t('operatorHome.noTripsBody')}</p>
              <Link className="btn btn--primary" href={`/${locale}/operator/trips/new${withOrg}`}>
                {t('operatorHome.schedule')}
              </Link>
            </div>
          ) : (
            <ul className="departures">
              {upcoming.slice(0, 4).map(({ trip, owner }) => {
                const when = departureLabel(trip.departureAt, locale);
                const sold = Math.max(0, trip.seatsTotal - trip.seatsAvailable);
                const waiting = requestByTrip.get(trip.id);
                const fill = trip.seatsTotal > 0 ? Math.round((sold / trip.seatsTotal) * 100) : 0;
                return (
                  <li key={trip.id}>
                    {/* The whole row is the link: on a phone it is the only part worth aiming at. */}
                    <Link className="departure" href={`/${locale}/operator/trips/${trip.id}`}>
                      <span className="departure__when">
                        <bdi className="departure__time num">{when.time}</bdi>
                        <bdi className="departure__date">{when.date}</bdi>
                      </span>

                      <span className="departure__body">
                        <span className="departure__route">
                          <span>
                            {locale === 'ar'
                              ? trip.origin.nameAr
                              : (trip.origin.nameEn ?? trip.origin.nameAr)}
                          </span>
                          <span className="departure__arrow" aria-hidden="true">
                            <Icon name="arrow" size={14} />
                          </span>
                          <span>
                            {locale === 'ar'
                              ? trip.destination.nameAr
                              : (trip.destination.nameEn ?? trip.destination.nameAr)}
                          </span>
                        </span>
                        {/* The company a trip belongs to, because this screen is not scoped to one. */}
                        <span className="departure__meta">
                          {owners.length > 1 ? (
                            <>
                              <span>{owner}</span>
                              <span aria-hidden="true">·</span>
                            </>
                          ) : null}
                          <span>{trip.vehicleLabel}</span>
                          <span aria-hidden="true">·</span>
                          <bdi dir="ltr" className="departure__code">
                            {trip.code}
                          </bdi>
                        </span>
                      </span>

                      <span className="departure__seats">
                        <span className="departure__seats-label">
                          {t('operatorHome.seatsLabel')}
                        </span>
                        <span className="departure__seats-value num">
                          {t('operatorHome.seats', { sold, total: trip.seatsTotal })}
                        </span>
                        <span
                          className="departure__bar"
                          aria-hidden="true"
                          style={{ ['--fill' as string]: `${fill}%` }}
                        />
                      </span>

                      {waiting ? (
                        <span className="departure__flag">
                          {t('operatorHome.requestsFlag', { count: waiting.requests })}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="ops-section" aria-labelledby="op-screens">
          <div className="ops-section__head">
            <h2 id="op-screens">{t('operatorHome.screens')}</h2>
          </div>
          <ul className="doorlist">
            {doors.map((door) => (
              <li key={door.href}>
                <Link className="door" href={door.href}>
                  <span className="door__icon" aria-hidden="true">
                    <Icon name={door.icon} size={16} />
                  </span>
                  <span className="door__label">{t(door.key)}</span>
                  <span className="door__note">{t(door.note)}</span>
                  <Icon name="chevron" size={15} className="door__go" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </ConsoleShell>
    </>
  );
}
