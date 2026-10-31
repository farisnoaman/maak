import { notFound, redirect } from 'next/navigation';
import { departureLabel, isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { TripDetail } from '@/components/trips/TripDetail';
import { StaffTripReview } from '@/components/trips/StaffTripReview';
import { loadAccountContext } from '@/lib/account';
import { loadTrip, loadTripOptions } from '@/lib/trips';

/**
 * One trip, as staff see it.
 *
 * The search on `/staff/trips` deliberately reaches drafts and cancellations, and a result that cannot be
 * opened is a dead end: a complaint arrives with a trip code, and "I can see the row but not the trip" is
 * not an answer. Staff read the trip through the same RLS policy as the operator (`is_platform_staff` is
 * one of its clauses), so this page adds no new access — only a door.
 *
 * The page is read-only. The one action staff own is the verification decision, and it is rendered by the
 * same component as the queue, so a decision cannot behave differently depending on where it was made.
 */
export default async function StaffTripPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: raw, id } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/staff/trips/${id}`);
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

  if (!isStaff) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/staff/trips" />
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

  const [detail, options] = await Promise.all([loadTrip(id), loadTripOptions(loaded)]);

  if (!detail) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/staff/trips" />
        <ConsoleShell
          locale={locale}
          title="staff.trips.title"
          subtitle="staff.trips.subtitle"
          phase="4"
          items={nav}
        >
          <EmptyState title={t('errors.NOT_FOUND')} />
        </ConsoleShell>
      </>
    );
  }

  const when = departureLabel(detail.trip.departureAt, locale);

  return (
    <>
      <SiteHeader locale={locale} pathname="/staff/trips" />
      <ConsoleShell
        locale={locale}
        title="staff.trips.title"
        subtitle="staff.trips.subtitle"
        phase="4"
        items={nav}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        <a className="trip-back" href={`/${locale}/staff/trips`}>
          ← {t('common.back')}
        </a>

        <p className="trip-form__hint">
          {detail.trip.code} · {when.date} · <bdi>{when.time}</bdi>
        </p>

        {detail.trip.verificationStatus === 'pending' ? (
          <StaffTripReview locale={locale} trips={[detail.trip]} />
        ) : null}

        <TripDetail
          locale={locale}
          trip={detail.trip}
          stops={detail.stops}
          events={detail.events}
          options={options}
          canManage={false}
        />
      </ConsoleShell>
    </>
  );
}
