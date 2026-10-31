import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { TripDetail } from '@/components/trips/TripDetail';
import { loadAccountContext } from '@/lib/account';
import { loadTrip, loadTripOptions } from '@/lib/trips';

export default async function OperatorTripPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/trips/${id}`);
  }

  const [detail, options] = await Promise.all([loadTrip(id), loadTripOptions(loaded)]);
  const nav = [
    { key: 'console.navOverview' as TranslationKey, href: `/${locale}/operator` },
    { key: 'console.navTrips' as TranslationKey, href: `/${locale}/operator/trips` },
    { key: 'console.navVehicles' as TranslationKey, href: `/${locale}/operator/vehicles` },
    { key: 'console.navDrivers' as TranslationKey, href: `/${locale}/operator/drivers` },
  ];

  // RLS already hides another owner's trip; this is the readable half of that refusal.
  if (!detail) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/operator/trips" />
        <ConsoleShell
          locale={locale}
          title="trips.title"
          subtitle="trips.subtitle"
          phase="4"
          items={nav}
        >
          <EmptyState title={t('errors.NOT_FOUND')} />
        </ConsoleShell>
      </>
    );
  }

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/trips" />
      <ConsoleShell
        locale={locale}
        title="trips.title"
        subtitle="trips.subtitle"
        phase="4"
        items={nav}
      >
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}
        <a className="trip-back" href={`/${locale}/operator/trips`}>
          ← {t('common.back')}
        </a>
        {/* The inbox is where the money and the seats are, so it is one tap from the trip, not buried in
            a menu that an operator has to learn. */}
        <p>
          <a
            className="ui-btn ui-btn--primary ui-btn--md"
            href={`/${locale}/operator/trips/${id}/bookings`}
          >
            {t('bookings.inboxTitle')}
          </a>
        </p>
        <TripDetail
          locale={locale}
          trip={detail.trip}
          stops={detail.stops}
          events={detail.events}
          options={options}
          canManage={!loaded.configured || loaded.user !== null}
        />
      </ConsoleShell>
    </>
  );
}
