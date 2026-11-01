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
import { loadGovernorateOptions } from '@/lib/staff-ops';
import { staffNav } from '@/components/staff/StaffNav';

const STATUSES = ['draft', 'pending', 'published', 'cancelled', 'completed'] as const;
const VERIFICATIONS = ['pending', 'verified', 'unverified', 'rejected'] as const;

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

  // Phase 7: a geo supervisor searches their own patch. Widening the door is safe because the
  // function behind it is the thing that filters; a role check here only decides whether to show it.
  const isStaff =
    !loaded.configured ||
    loaded.roles.includes('platform_staff') ||
    loaded.roles.includes('platform_admin') ||
    loaded.roles.includes('geo_supervisor');

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
  const from =
    typeof query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? query.from : '';
  const to = typeof query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.to) ? query.to : '';
  const gov = typeof query.gov === 'string' && query.gov !== '' ? query.gov : '';
  const verification = (
    Array.isArray(query.verification)
      ? query.verification
      : typeof query.verification === 'string'
        ? [query.verification]
        : []
  ).filter((value): value is 'unverified' | 'pending' | 'verified' | 'rejected' =>
    ['unverified', 'pending', 'verified', 'rejected'].includes(value),
  );
  const searching =
    q !== '' ||
    requested.length > 0 ||
    from !== '' ||
    to !== '' ||
    gov !== '' ||
    verification.length > 0;
  // The language switch keeps the investigation: a staff member reading `?q=SA&status=cancelled` in
  // Arabic must land on the same search in English, not on the empty queue.
  const suffix = searchSuffix(query, ['st']);

  // The export link carries exactly the filters the table used, minus the UI's own `st` toggle.
  const exportQuery = new URLSearchParams();
  exportQuery.set('locale', locale);
  if (q) exportQuery.set('q', q);
  for (const status of requested) exportQuery.append('status', status);
  for (const status of verification) exportQuery.append('verification', status);
  if (from) exportQuery.set('from', from);
  if (to) exportQuery.set('to', to);
  if (gov) exportQuery.set('gov', gov);

  if (!isStaff) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/staff/trips" search={suffix} />
        <ConsoleShell
          locale={locale}
          title="staff.trips.title"
          consoleTitle="console.staff"
          subtitle="staff.trips.subtitle"
          pathname="/staff/trips"
          groups={staffNav(locale)}
        >
          <EmptyState title={t('errors.FORBIDDEN')} />
        </ConsoleShell>
      </>
    );
  }

  const [queue, search, governorates] = await Promise.all([
    searching ? Promise.resolve(null) : loadTrips(loaded),
    searching
      ? loadStaffTrips(loaded.user?.id ?? '', {
          status: requested,
          verificationStatus: verification,
          q: q || undefined,
          from: from || undefined,
          to: to || undefined,
          governorateId: gov || undefined,
        })
      : Promise.resolve(null),
    loadGovernorateOptions(),
  ]);

  return (
    <>
      <SiteHeader locale={locale} pathname="/staff/trips" search={suffix} />
      <ConsoleShell
        locale={locale}
        title="staff.trips.title"
        consoleTitle="console.staff"
        subtitle="staff.trips.subtitle"
        pathname="/staff/trips"
        groups={staffNav(locale)}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        {/* The filters used to be a bare grid between the panel edge and the results, with no title and no
            boundary — it read as page furniture rather than as the tool that decides what the table shows. */}
        <section className="card ops-filters" aria-labelledby="staff-search">
          <h2 id="staff-search">{t('staff.trips.find')}</h2>
          <p className="form-hint">{t('staff.trips.searchHint')}</p>
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

            <fieldset className="trip-filters__group">
              <legend>{t('ops.history')}</legend>
              <div className="trip-filters__options trip-filters__options--dates">
                <label>
                  <span>{t('ops.filterFrom')}</span>
                  <input type="date" name="from" defaultValue={from} className="ui-input" />
                </label>
                <label>
                  <span>{t('ops.filterTo')}</span>
                  <input type="date" name="to" defaultValue={to} className="ui-input" />
                </label>
                <label>
                  <span>{t('ops.filterGovernorate')}</span>
                  <select name="gov" defaultValue={gov} className="ui-input">
                    <option value="">{t('ops.filterAny')}</option>
                    {governorates.map((governorate) => (
                      <option key={governorate.id} value={governorate.id}>
                        {locale === 'ar'
                          ? governorate.nameAr
                          : (governorate.nameEn ?? governorate.nameAr)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="trip-filters__options">
                {VERIFICATIONS.map((status) => (
                  <label className="trip-filters__option" key={status}>
                    <input
                      type="checkbox"
                      name="verification"
                      value={status}
                      defaultChecked={verification.includes(status)}
                    />
                    <span>{t(tripVerificationKey(status))}</span>
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
        </section>

        {searching ? (
          <section aria-live="polite" aria-atomic="true">
            <p role="status" className="trip-form__hint">
              {t('staff.trips.results', { count: search?.items.length ?? 0 })}
            </p>

            {search?.error ? (
              <p className="fleet-error" role="alert">
                {t('errors.FORBIDDEN')}
              </p>
            ) : null}

            {(search?.items.length ?? 0) > 0 ? (
              <p>
                <a
                  className="ui-btn ui-btn--ghost"
                  href={`/api/staff/trips/export?${exportQuery.toString()}`}
                  download
                >
                  {t('ops.exportCsv')}
                </a>
              </p>
            ) : null}

            {(search?.items.length ?? 0) === 0 ? (
              <EmptyState
                title={t('console.emptyTrips')}
                description={t('console.emptyTripsBody')}
                action={
                  <Link className="btn btn--ghost" href={`/${locale}/staff/trips`}>
                    {t('trips.search.clear')}
                  </Link>
                }
              />
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
                      <th scope="col">{t('ops.actions')}</th>
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
                          <td data-label={t('ops.actions')}>
                            <Link
                              className="ui-btn ui-btn--ghost"
                              href={`/${locale}/staff/trips/${row.id}/manifest`}
                            >
                              {t('ops.manifest')}
                            </Link>
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
            {/* The count is only worth a line when there is a count; at zero the panel below says it better. */}
            {(queue?.pending.length ?? 0) > 0 ? (
              <p className="trip-form__hint">
                {t('staff.trips.waiting', { count: queue?.pending.length ?? 0 })}
              </p>
            ) : null}
            <StaffTripReview locale={locale} trips={queue?.pending ?? []} />
          </>
        )}
      </ConsoleShell>
    </>
  );
}
