import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { DirectionalIcon } from '@/components/ui/DirectionalIcon';
import { staffNav } from '@/components/staff/StaffNav';
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
    loaded.roles.includes('platform_admin') ||
    loaded.roles.includes('geo_supervisor');

  if (!isStaff) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/staff/trips" />
        <ConsoleShell
          consoleTitle="console.staff"
          pathname="/staff/trips"
          locale={locale}
          title="staff.trips.title"
          subtitle="staff.trips.subtitle"
          groups={staffNav(locale)}
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
          groups={staffNav(locale)}
        >
          <EmptyState title={t('errors.NOT_FOUND')} />
        </ConsoleShell>
      </>
    );
  }

  return (
    <>
      <SiteHeader locale={locale} pathname="/staff/trips" />
      <ConsoleShell
        locale={locale}
        title="staff.trips.title"
        subtitle="staff.trips.subtitle"
        pathname="/staff/trips"
        groups={staffNav(locale)}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        {/*
          One identity, stated once.
          The page used to print the back arrow, then the trip code and departure as loose hint text, then the
          review buttons, then the trip again inside `TripDetail` — three statements of the same fact before any
          content. The way back is a link with the product's own chevron, and the trip's identity and its two doors
          are the head of the trip itself.
        */}
        <Link className="detail-back" href={`/${locale}/staff/trips`}>
          <DirectionalIcon direction="back" size={16} />
          {t('staff.trips.title')}
        </Link>

        <TripDetail
          locale={locale}
          trip={detail.trip}
          stops={detail.stops}
          events={detail.events}
          options={options}
          canManage={false}
          actions={
            <>
              <Link
                className="ui-btn ui-btn--primary ui-btn--sm"
                href={`/${locale}/staff/trips/${id}/manifest`}
              >
                {t('ops.manifest')}
              </Link>
              <Link className="ui-btn ui-btn--ghost ui-btn--sm" href={`/${locale}/staff/scan`}>
                {t('ops.scan')}
              </Link>
            </>
          }
        />

        {detail.trip.verificationStatus === 'pending' ? (
          <section className="console-section" aria-labelledby="staff-decision">
            <h2 id="staff-decision">{t('staff.trips.decision')}</h2>
            <StaffTripReview locale={locale} trips={[detail.trip]} variant="panel" />
          </section>
        ) : null}
      </ConsoleShell>
    </>
  );
}
