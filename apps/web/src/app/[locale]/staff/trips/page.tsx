import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { StaffTripReview } from '@/components/trips/StaffTripReview';
import { loadAccountContext } from '@/lib/account';
import { loadTrips } from '@/lib/trips';

/**
 * Staff-only: the trip verification queue.
 *
 * Reads through RLS with the staff member's own session (`trips_select_staff`), so the queue is a
 * query, not a service-role list: a non-staff visitor sees nothing rather than everything.
 */
export default async function StaffTripsPage({ params }: { params: Promise<{ locale: string }> }) {
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

  const data = await loadTrips(loaded);

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
        <p className="trip-form__hint">
          {t('staff.trips.waiting', { count: data.pending.length })}
        </p>
        <StaffTripReview locale={locale} trips={data.pending} />
      </ConsoleShell>
    </>
  );
}
