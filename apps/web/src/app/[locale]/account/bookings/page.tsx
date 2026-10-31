import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  BOOKING_STATUS_KEY,
  bookingTone,
  formatMinor,
  isLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { Badge, EmptyState } from '@/components/ui/Feedback';
import { AccountNav } from '@/components/account/AccountNav';
import { loadAccountContext } from '@/lib/account';
import { loadMyBookings } from '@/lib/bookings';
import { departureLabel } from '@maak/core';

/**
 * My bookings.
 *
 * Two sections, because that is how a passenger thinks: what is still ahead of me, and what already
 * happened. A cancelled booking stays in the second list with its reason — deleting it would make the
 * refund history disappear exactly when somebody needs to quote it.
 */
export const dynamic = 'force-dynamic';

export default async function MyBookingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/account/bookings`);
  }

  const bookings = await loadMyBookings();
  const now = Date.now();
  const upcoming = bookings.filter(
    (booking) =>
      booking.trip != null &&
      new Date(booking.trip.departureAt).getTime() > now &&
      (booking.status === 'pending' || booking.status === 'accepted'),
  );
  const past = bookings.filter((booking) => !upcoming.includes(booking));

  const card = (booking: (typeof bookings)[number]) => {
    const when = booking.trip ? departureLabel(booking.trip.departureAt, locale) : null;
    return (
      <li key={booking.id} className="booking-card">
        <div className="booking-card__head">
          <Link href={`/${locale}/account/bookings/${booking.id}`} className="booking-card__code">
            {booking.trip ? (
              <>
                {booking.trip.originName ?? '—'}
                <span className="route-arrow" aria-hidden="true">
                  {' → '}
                </span>
                {booking.trip.destinationName ?? '—'}
              </>
            ) : (
              <bdi dir="ltr">{booking.code}</bdi>
            )}
          </Link>
          <Badge tone={bookingTone(booking.status)}>
            {t(
              BOOKING_STATUS_KEY[booking.status as keyof typeof BOOKING_STATUS_KEY] ??
                'bookings.status.pending',
            )}
          </Badge>
        </div>
        <p className="booking-card__meta">
          {when ? `${when.date} · ${when.time}` : '—'} ·{' '}
          {t('bookings.seatsCount', { count: booking.seats })}
        </p>
        <p className="booking-card__meta">
          {t('bookings.reference')}: <bdi dir="ltr">{booking.code}</bdi> ·{' '}
          {formatMinor(booking.totalYer, 'YER', { locale })}
        </p>
        {booking.status === 'pending' ? (
          <Link
            className="ui-btn ui-btn--ghost ui-btn--sm"
            href={`/${locale}/account/bookings/${booking.id}`}
          >
            {t('bookings.finishIdentity')}
          </Link>
        ) : null}
      </li>
    );
  };

  return (
    <>
      <SiteHeader locale={locale} pathname="/account" />
      <main id="main" className="shell section account-page">
        <header className="account-head">
          <h1>{t('bookings.myTitle')}</h1>
          <p className="form-hint">{t('bookings.mySubtitle')}</p>
        </header>

        <AccountNav locale={locale} current="/account/bookings" />

        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        {bookings.length === 0 ? (
          <EmptyState
            title={t('bookings.empty')}
            description={t('bookings.emptyHint')}
            action={
              <Link className="btn btn--primary" href={`/${locale}/trips`}>
                {t('trips.search.title')}
              </Link>
            }
          />
        ) : (
          <>
            <section className="account-section" aria-labelledby="bookings-upcoming-title">
              <h2 id="bookings-upcoming-title">{t('bookings.upcoming')}</h2>
              {upcoming.length === 0 ? (
                <p className="form-hint">{t('bookings.noUpcoming')}</p>
              ) : (
                <ul className="booking-list">{upcoming.map(card)}</ul>
              )}
            </section>
            <section className="account-section" aria-labelledby="bookings-past-title">
              <h2 id="bookings-past-title">{t('bookings.past')}</h2>
              {past.length === 0 ? (
                <p className="form-hint">{t('bookings.noPast')}</p>
              ) : (
                <ul className="booking-list">{past.map(card)}</ul>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
