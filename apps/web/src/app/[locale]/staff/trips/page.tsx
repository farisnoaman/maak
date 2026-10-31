import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import {
  departureLabel,
  formatMinor,
  isLocale,
  searchSuffix,
  translate,
  tripStatusKey,
  tripVerificationKey,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { Badge, EmptyState } from '@/components/ui/Feedback';
import { StaffTripReview } from '@/components/trips/StaffTripReview';
import { loadAccountContext } from '@/lib/account';
import { loadStaffTrips, loadTrips } from '@/lib/trips';

const STATUSES = ['draft', 'pending', 'published', 'cancelled', 'completed'] as const;

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  pending: 'warning',
  published: 'success',
  cancelled: 'danger',
  completed: 'neutral',
};

/**
 * Staff trip review and search.
 *
 * Two jobs in one screen, because they are two halves of the same question — "what is happening to
 * trips right now?":
 *
 *  - **without filters**: the verification queue, newest submissions first, with approve/reject;
 *  - **with `?q=` or `?status=`**: `staff_search_trips`, which deliberately includes drafts,
 *    cancellations and trips that have already departed. A staff member investigating a complaint needs
 *    to see the trip the marketplace hides.
 *
 * The search form is a plain GET form, so a filtered view has a URL that can be pasted into an incident
 * ticket.
 */
export default async function StaffTripsPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/staff/trips`);
  }

  const isStaff =
    !loaded.configured ||
    loaded.roles.includes('platform_staff') ||
    loaded.roles.includes('platform_admin');

  const nav = [
    { key: 'console.navOverview' as TranslationKey, href: `/${locale}/staff` },
    { key: 'staff.trips.title' as TranslationKey, href: `/${locale}/staff/trips` },
    { key: 'fleet.staffQueue' as TranslationKey, href: `/${locale}/staff/vehicles` },
  ];

  const query = await searchParams;
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  const requested = (
    Array.isArray(query.status)
      ? query.status
      : typeof query.status === 'string'
        ? [query.status]
        : []
  ).filter((value): value is (typeof STATUSES)[number] =>
    (STATUSES as readonly string[]).includes(value),
  );
  const searching = q !== '' || requested.length > 0;
  // The language switch keeps the investigation: a staff member reading `?q=SA&status=cancelled` in
  // Arabic must land on the same search in English, not on the empty queue.
  const suffix = searchSuffix(query, ['st']);

  if (!isStaff) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/staff/trips" search={suffix} />
        <ConsoleShell
          locale={locale}
          title="staff.trips.title"
          subtitle="staff.trips.subtitle"
          phase="4"
          items={nav}
        >
          <EmptyState title={t('errors.FORBIDDEN')} />
        </ConsoleShell>
      </>
    );
  }

  const [queue, search] = await Promise.all([
    searching ? Promise.resolve(null) : loadTrips(loaded),
    searching
      ? loadStaffTrips(loaded.user?.id ?? '', { status: requested, q: q || undefined })
      : Promise.resolve(null),
  ]);

  return (
    <>
      <SiteHeader locale={locale} pathname="/staff/trips" search={suffix} />
      <ConsoleShell
        locale={locale}
        title="staff.trips.title"
        subtitle="staff.trips.subtitle"
        phase="4"
        items={nav}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        <form method="get" action={`/${locale}/staff/trips`} className="trip-filters trip-search">
          <div className="trip-filters__group">
            <label htmlFor="staff-q">{t('trips.search.q')}</label>
            <input
              id="staff-q"
              name="q"
              type="search"
              defaultValue={q}
              className="ui-input"
              placeholder={t('trips.code')}
            />
          </div>

          <fieldset className="trip-filters__group">
            <legend>{t('trips.statusLabel')}</legend>
            <div className="trip-filters__options">
              {STATUSES.map((status) => (
                <label className="trip-filters__option" key={status}>
                  <input
                    type="checkbox"
                    name="status"
                    value={status}
                    defaultChecked={requested.includes(status)}
                  />
                  <span>{t(tripStatusKey(status))}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="trip-filters__actions">
            <button type="submit" className="ui-btn ui-btn--primary">
              {t('staff.trips.search')}
            </button>
            <Link className="ui-btn ui-btn--ghost" href={`/${locale}/staff/trips`}>
              {t('trips.search.clear')}
            </Link>
          </div>
        </form>

        {searching ? (
          <section aria-live="polite" aria-atomic="true">
            <p className="trip-form__hint">{t('staff.trips.searchHint')}</p>
            <p role="status" className="trip-form__hint">
              {t('staff.trips.results', { count: search?.items.length ?? 0 })}
            </p>

            {search?.error ? (
              <p className="fleet-error" role="alert">
                {t('errors.FORBIDDEN')}
              </p>
            ) : null}

            {(search?.items.length ?? 0) === 0 ? (
              <EmptyState title={t('trips.search.noResults')} />
            ) : (
              <div className="table-scroll">
                <table className="trip-table table-cards">
                  <thead>
                    <tr>
                      <th scope="col">{t('trips.code')}</th>
                      <th scope="col">{t('trips.route')}</th>
                      <th scope="col">{t('trips.schedule')}</th>
                      <th scope="col">{t('staff.trips.operator')}</th>
                      <th scope="col">{t('trips.seats')}</th>
                      <th scope="col">{t('trips.statusLabel')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {search?.items.map((row) => {
                      const when = departureLabel(row.departureAt, locale);
                      return (
                        <tr key={row.id}>
                          <td data-label={t('trips.code')}>
                            <Link href={`/${locale}/staff/trips/${row.id}`}>{row.code}</Link>
                          </td>
                          <td data-label={t('trips.route')}>
                            {row.origin} ← {row.destination}
                            {row.cancelReason ? (
                              <span className="trip-form__hint"> · {row.cancelReason}</span>
                            ) : null}
                          </td>
                          <td data-label={t('trips.schedule')}>
                            {when.date} · <bdi>{when.time}</bdi>
                          </td>
                          <td data-label={t('staff.trips.operator')}>{row.operatorName ?? '—'}</td>
                          <td data-label={t('trips.seats')}>
                            {row.seatsAvailable}/{row.seatsTotal}
                            {row.priceFromYer != null ? (
                              <span className="trip-form__hint">
                                {' '}
                                · {formatMinor(row.priceFromYer, 'YER', { locale })}
                              </span>
                            ) : null}
                          </td>
                          <td data-label={t('trips.statusLabel')}>
                            <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>
                              {t(tripStatusKey(row.status))}
                            </Badge>{' '}
                            <Badge
                              tone={row.verificationStatus === 'verified' ? 'success' : 'neutral'}
                            >
                              {t(tripVerificationKey(row.verificationStatus))}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : (
          <>
            <p className="trip-form__hint">
              {t('staff.trips.waiting', { count: queue?.pending.length ?? 0 })}
            </p>
            <StaffTripReview locale={locale} trips={queue?.pending ?? []} />
          </>
        )}
      </ConsoleShell>
    </>
  );
}
