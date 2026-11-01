import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, tripStatusKey, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { TripBadges } from '@/components/trips/TripBadges';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import { loadTrips } from '@/lib/trips';
import { formatMinor, departureLabel, tripPriceFrom } from '@maak/core';
import Link from 'next/link';

const STATUSES = ['all', 'draft', 'pending', 'published', 'cancelled'] as const;
type StatusFilter = (typeof STATUSES)[number];

/**
 * The operator's trips.
 *
 * The list is the *whole* list — drafts included — because an operator who cannot see the trip they
 * are half-way through creating will create it twice. The status tabs are links, not client state: a
 * filtered list has a URL, so it can be shared, bookmarked and rendered on the server.
 */
export default async function OperatorTripsPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/trips`);
  }

  const query = await searchParams;
  // Personal is the default context; an organization is shown only when the URL asks for it. Defaulting
  // to the company made every personal trip invisible the moment an owner joined one.
  const org = loaded.configured
    ? typeof query.org === 'string'
      ? activeOrganization(loaded, query.org)
      : null
    : null;
  const requested = typeof query.status === 'string' ? query.status : 'all';
  const status: StatusFilter = (STATUSES as readonly string[]).includes(requested)
    ? (requested as StatusFilter)
    : 'all';

  const data = await loadTrips(loaded);

  // Owned personally or by the organization in scope — the same split the fleet screen uses, so
  // switching context never appears to lose half the trips.
  const mine = data.trips.filter((trip) =>
    org ? trip.ownerOrgId === org.id : trip.ownerUserId === loaded.user?.id,
  );
  const visible = status === 'all' ? mine : mine.filter((trip) => trip.status === status);
  const isStaff =
    !loaded.configured ||
    loaded.roles.includes('platform_staff') ||
    loaded.roles.includes('platform_admin');

  const nav = [
    { key: 'console.navOverview' as TranslationKey, href: `/${locale}/operator` },
    { key: 'console.navTrips' as TranslationKey, href: `/${locale}/operator/trips` },
    { key: 'trips.calendar' as TranslationKey, href: `/${locale}/operator/trips/calendar` },
    { key: 'console.navVehicles' as TranslationKey, href: `/${locale}/operator/vehicles` },

    { key: 'console.navFleet' as TranslationKey, href: `/${locale}/operator/fleet` },
    { key: 'console.navDrivers' as TranslationKey, href: `/${locale}/operator/drivers` },
    { key: 'org.team' as TranslationKey, href: `/${locale}/operator/team` },
    ...(isStaff
      ? [{ key: 'staff.trips.title' as TranslationKey, href: `/${locale}/staff/trips` }]
      : []),
  ];

  const contextQuery = org ? `org=${org.id}` : '';

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/trips" />
      <ConsoleShell
        consoleTitle="console.operator"
        pathname="/operator/trips"
        locale={locale}
        title="trips.title"
        subtitle="trips.subtitle"
        items={nav}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        <div className="fleet-toolbar">
          <p>
            {t('trips.count', { count: mine.length })}
            {org ? ` · ${org.name}` : ` · ${t('fleet.personalOwner')}`}
          </p>
          <div className="trip-form__actions">
            <Link
              className="btn btn--ghost"
              href={`/${locale}/operator/trips/calendar${org ? `?org=${org.id}` : ''}`}
            >
              {t('trips.calendar')}
            </Link>
            <Link
              className="btn btn--primary"
              href={`/${locale}/operator/trips/new${org ? `?org=${org.id}` : ''}`}
            >
              {t('trips.new')}
            </Link>
          </div>
        </div>

        {loaded.organizations.filter((row) => row.status === 'active').length > 0 ? (
          <nav className="fleet-context" aria-label={t('fleet.context')}>
            <a href={`/${locale}/operator/trips`} aria-current={org ? undefined : 'page'}>
              {t('fleet.personalOwner')}
            </a>
            {loaded.organizations
              .filter((row) => row.status === 'active')
              .map((row) => (
                <a
                  key={row.id}
                  href={`/${locale}/operator/trips?org=${row.id}`}
                  aria-current={org?.id === row.id ? 'page' : undefined}
                >
                  {row.name}
                </a>
              ))}
          </nav>
        ) : null}

        {isStaff && data.pending.length > 0 ? (
          <p className="trip-note" role="status">
            {t('staff.trips.waiting', { count: data.pending.length })}{' '}
            <Link href={`/${locale}/staff/trips`}>{t('staff.trips.title')}</Link>
          </p>
        ) : null}

        <nav className="trip-tabs" aria-label={t('trips.title')}>
          {STATUSES.map((name) => {
            const count =
              name === 'all' ? mine.length : mine.filter((trip) => trip.status === name).length;
            const search = new URLSearchParams();
            if (name !== 'all') search.set('status', name);
            if (contextQuery) search.set('org', org?.id ?? '');
            return (
              <Link
                key={name}
                href={`/${locale}/operator/trips${search.size > 0 ? `?${search.toString()}` : ''}`}
                aria-current={name === status ? 'page' : undefined}
              >
                {name === 'all' ? t('trips.filterAll') : t(tripStatusKey(name))}
                <span className="trip-tabs__count">{count}</span>
              </Link>
            );
          })}
        </nav>

        {visible.length === 0 ? (
          <EmptyState
            title={t('trips.empty')}
            description={t('trips.emptyHint')}
            action={
              <Link
                className="btn btn--primary"
                href={`/${locale}/operator/trips/new${org ? `?org=${org.id}` : ''}`}
              >
                {t('trips.new')}
              </Link>
            }
          />
        ) : (
          <div className="trips-grid">
            {visible.map((trip) => {
              const fare = tripPriceFrom(
                trip,
                data.stops.filter((stop) => stop.tripId === trip.id),
              );
              const when = departureLabel(trip.departureAt, locale);
              return (
                <article className="card trip-card" key={trip.id}>
                  <TripBadges locale={locale} trip={trip} />
                  <h3 className="trip-card__route">
                    <span>{trip.origin.nameAr}</span>
                    <span className="trip-card__arrow" aria-hidden="true">
                      ←
                    </span>
                    <span>{trip.destination.nameAr}</span>
                  </h3>
                  <div className="trip-card__meta">
                    <span>
                      {when.date} · <bdi>{when.time}</bdi>
                    </span>
                    <span>{t('trips.seatsAvailable', { count: trip.seatsAvailable })}</span>
                    <span>
                      {t('trips.vehicle')}: {trip.vehicleLabel}
                    </span>
                    <span>{trip.code}</span>
                  </div>
                  <div className="trip-card__footer">
                    <p className="trip-price">
                      {fare == null ? '—' : formatMinor(fare, 'YER', { locale })}{' '}
                      <small>{t('trips.pricePerSeat')}</small>
                    </p>
                    <Link className="btn btn--ghost" href={`/${locale}/operator/trips/${trip.id}`}>
                      {t('trips.view')}
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </ConsoleShell>
    </>
  );
}
