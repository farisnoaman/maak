import { notFound, redirect } from 'next/navigation';
import {
  isLocale,
  isoToAdenLocal,
  translate,
  tripStatusKey,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import Link from 'next/link';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { Badge } from '@/components/ui/Feedback';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import { loadTrips } from '@/lib/trips';

const MONTHS_AR = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
];

/** `YYYY-MM` for the month a trip departs in, in Aden time — not in the server's timezone. */
function monthKey(departureAt: string): string {
  return isoToAdenLocal(departureAt).slice(0, 7);
}

function localDate(departureAt: string): string {
  return isoToAdenLocal(departureAt).slice(0, 10);
}

/**
 * The operator's calendar.
 *
 * A month of departures, not of bookings (that is Phase 5): the question this answers is "what am I
 * committing a vehicle to, and when". It is a server-rendered grid — no client calendar library, no
 * drag-and-drop — because the two things that break in a calendar widget are timezones and mobile, and
 * both are avoided by rendering Aden-local dates on the server.
 */
export default async function OperatorTripsCalendarPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/trips/calendar`);
  }

  const query = await searchParams;
  // Personal is the default context; an organization is shown only when the URL asks for it. Defaulting
  // to the company made every personal trip invisible the moment an owner joined one.
  const org = loaded.configured
    ? typeof query.org === 'string'
      ? activeOrganization(loaded, query.org)
      : null
    : null;

  const data = await loadTrips(loaded);
  const mine = data.trips.filter((trip) =>
    org ? trip.ownerOrgId === org.id : trip.ownerUserId === loaded.user?.id,
  );

  const requested = typeof query.month === 'string' ? query.month : '';
  const month = /^\d{4}-\d{2}$/.test(requested)
    ? requested
    : (monthKey(mine[0]?.departureAt ?? new Date().toISOString()) as string);

  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  // Monday-first grid, matching the Arabic convention used elsewhere in the console.
  const leading = (first.getUTCDay() + 6) % 7;

  const byDay = new Map<string, typeof mine>();
  for (const trip of mine) {
    if (monthKey(trip.departureAt) !== month) continue;
    const day = localDate(trip.departureAt);
    byDay.set(day, [...(byDay.get(day) ?? []), trip]);
  }

  const previous = new Date(Date.UTC(year, monthIndex - 1, 1));
  const next = new Date(Date.UTC(year, monthIndex + 1, 1));
  const monthParam = (date: Date) =>
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const suffix = org ? `&org=${org.id}` : '';

  const monthLabel =
    locale === 'ar'
      ? `${MONTHS_AR[monthIndex] ?? ''} ${year}`
      : `${first.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${year}`;

  const nav = [
    { key: 'console.navOverview' as TranslationKey, href: `/${locale}/operator` },
    { key: 'console.navTrips' as TranslationKey, href: `/${locale}/operator/trips` },
    { key: 'trips.calendar' as TranslationKey, href: `/${locale}/operator/trips/calendar` },
    { key: 'console.navVehicles' as TranslationKey, href: `/${locale}/operator/vehicles` },

    { key: 'console.navFleet' as TranslationKey, href: `/${locale}/operator/fleet` },
    { key: 'console.navDrivers' as TranslationKey, href: `/${locale}/operator/drivers` },
  ];

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/trips" />
      <ConsoleShell
        locale={locale}
        title="trips.calendar"
        subtitle="trips.calendarHint"
        phase="4"
        items={nav}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        {loaded.organizations.filter((row) => row.status === 'active').length > 0 ? (
          <nav className="fleet-context" aria-label={t('fleet.context')}>
            <a href={`/${locale}/operator/trips/calendar`} aria-current={org ? undefined : 'page'}>
              {t('fleet.personalOwner')}
            </a>
            {loaded.organizations
              .filter((row) => row.status === 'active')
              .map((row) => (
                <a
                  key={row.id}
                  href={`/${locale}/operator/trips/calendar?org=${row.id}`}
                  aria-current={org?.id === row.id ? 'page' : undefined}
                >
                  {row.name}
                </a>
              ))}
          </nav>
        ) : null}

        <div className="trip-calendar__bar">
          <Link
            className="ui-btn ui-btn--ghost"
            href={`/${locale}/operator/trips/calendar?month=${monthParam(previous)}${suffix}`}
          >
            ← {t('trips.calendarPrev')}
          </Link>
          <p className="trip-calendar__month">{monthLabel}</p>
          <Link
            className="ui-btn ui-btn--ghost"
            href={`/${locale}/operator/trips/calendar?month=${monthParam(next)}${suffix}`}
          >
            {t('trips.calendarNext')} →
          </Link>
        </div>

        {mine.length === 0 ? (
          <EmptyState
            title={t('trips.empty')}
            description={t('trips.emptyHint')}
            action={
              <Link className="btn btn--primary" href={`/${locale}/operator/trips/new`}>
                {t('trips.new')}
              </Link>
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="trip-calendar">
              <caption className="sr-only">{monthLabel}</caption>
              <thead>
                <tr>
                  {[1, 2, 3, 4, 5, 6, 7].map((weekday) => (
                    <th scope="col" key={weekday}>
                      {t(`trips.weekday.${weekday}` as TranslationKey)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: Math.ceil((leading + daysInMonth) / 7) }, (_, row) => (
                  <tr key={row}>
                    {Array.from({ length: 7 }, (_, column) => {
                      const dayNumber = row * 7 + column - leading + 1;
                      if (dayNumber < 1 || dayNumber > daysInMonth) {
                        return <td key={column} className="trip-calendar__empty" />;
                      }
                      const date = `${month}-${String(dayNumber).padStart(2, '0')}`;
                      const trips = byDay.get(date) ?? [];
                      return (
                        <td
                          key={column}
                          aria-current={
                            date === localDate(new Date().toISOString()) ? 'date' : undefined
                          }
                        >
                          <span className="trip-calendar__day">{dayNumber}</span>
                          <ul className="trip-calendar__list">
                            {trips.map((trip) => (
                              <li key={trip.id}>
                                <Link href={`/${locale}/operator/trips/${trip.id}`}>
                                  <bdi>{isoToAdenLocal(trip.departureAt).slice(11, 16)}</bdi>{' '}
                                  {trip.origin.nameAr} ← {trip.destination.nameAr}
                                </Link>
                                <Badge
                                  tone={
                                    trip.status === 'published'
                                      ? 'success'
                                      : trip.status === 'cancelled'
                                        ? 'danger'
                                        : 'neutral'
                                  }
                                >
                                  {t(tripStatusKey(trip.status))}
                                </Badge>
                              </li>
                            ))}
                          </ul>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ConsoleShell>
    </>
  );
}
