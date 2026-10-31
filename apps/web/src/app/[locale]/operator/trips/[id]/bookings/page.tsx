import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  BOOKING_STATUS_KEY,
  ID_TYPE_KEY,
  bookingTone,
  formatMinor,
  isLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { Badge, EmptyState } from '@/components/ui/Feedback';
import { BulkAccept, OperatorBookingActions } from '@/components/bookings/BookingActions';
import { loadAccountContext } from '@/lib/account';
import { loadTripBookings } from '@/lib/bookings';
import { loadTrip } from '@/lib/trips';

/**
 * The operator's inbox for one trip: every request, who is in the vehicle, and what has to be paid.
 *
 * It is one page rather than two because the questions are the same question — "who is on this trip and
 * what do I have to do about them?" — asked about requests and about passengers.
 */
export const dynamic = 'force-dynamic';

export default async function TripBookingsPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: raw, id } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/trips/${id}/bookings`);
  }

  const trip = await loadTrip(id);
  if (!trip) notFound();

  const bookings = await loadTripBookings(id);
  const pending = bookings.filter((booking) => booking.status === 'pending');
  const accepted = bookings.filter((booking) => booking.status === 'accepted');
  const closed = bookings.filter(
    (booking) => booking.status !== 'pending' && booking.status !== 'accepted',
  );
  const seatsSold = accepted.reduce((total, booking) => total + booking.seats, 0);

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator" />
      <main id="main" className="shell section">
        <Link className="trip-back" href={`/${locale}/operator/trips/${id}`}>
          ← {t('trips.title')}
        </Link>
        <h1>{t('bookings.inboxTitle')}</h1>
        <p className="trip-form__hint">
          <bdi dir="ltr">{trip.trip.code}</bdi> ·{' '}
          {t('bookings.inboxSummary', { sold: seatsSold, total: trip.trip.seatsTotal })}
        </p>
        {!loaded.configured ? null : null}

        <BulkAccept locale={locale} bookingIds={pending.map((booking) => booking.id)} />

        <h2>{t('bookings.pendingTitle')}</h2>
        {pending.length === 0 ? (
          <p className="form-hint">{t('bookings.noPending')}</p>
        ) : (
          <ul className="booking-list">
            {pending.map((booking) => (
              <li key={booking.id} className="booking-card">
                <div className="booking-card__head">
                  <strong>{booking.contactName}</strong>
                  <span className="booking-card__code" dir="ltr">
                    {booking.code}
                  </span>
                  <Badge tone={bookingTone(booking.status)}>{t(BOOKING_STATUS_KEY.pending)}</Badge>
                </div>
                <p className="booking-card__meta">
                  <bdi dir="ltr">{booking.contactPhone}</bdi> ·{' '}
                  {t('bookings.seatsCount', { count: booking.seats })} ·{' '}
                  {formatMinor(booking.totalYer, 'YER', { locale })}
                </p>
                {booking.holdExpiresAt ? (
                  <p className="booking-card__meta">
                    {t('bookings.holdUntil', {
                      time: new Date(booking.holdExpiresAt).toLocaleTimeString(
                        locale === 'ar' ? 'ar-YE' : 'en-GB',
                        { hour: '2-digit', minute: '2-digit' },
                      ),
                    })}
                  </p>
                ) : null}
                <OperatorBookingActions
                  locale={locale}
                  bookingId={booking.id}
                  status={booking.status}
                />
              </li>
            ))}
          </ul>
        )}

        <h2>{t('bookings.passengersTitle')}</h2>
        {accepted.length === 0 ? (
          <p className="form-hint">{t('bookings.noPassengers')}</p>
        ) : (
          <div className="table-scroll">
            <table className="booking-manifest">
              <caption className="form-hint">{t('bookings.manifestHint')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('bookings.passenger')}</th>
                  <th scope="col">{t('bookings.seats')}</th>
                  <th scope="col">{t('bookings.identityTitle')}</th>
                  <th scope="col">{t('bookings.total')}</th>
                  <th scope="col">{t('bookings.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {accepted.map((booking) => (
                  <tr key={booking.id}>
                    <td>
                      <Link href={`/${locale}/account/bookings/${booking.id}`}>
                        {booking.contactName}
                      </Link>
                      <div className="booking-card__meta">
                        <bdi dir="ltr">{booking.code}</bdi>
                      </div>
                      <div className="booking-card__meta" dir="ltr">
                        {booking.contactPhone}
                      </div>
                    </td>
                    <td>{booking.seats}</td>
                    <td>
                      {booking.document
                        ? `${t(ID_TYPE_KEY[booking.document.idType] ?? 'bookings.id.other')} · ${booking.document.idNumber}`
                        : t('bookings.noIdentity')}
                    </td>
                    <td>
                      {formatMinor(booking.totalYer, 'YER', { locale })}
                      <div className="booking-card__meta">
                        {t(`bookings.payment.${booking.paymentStatus}` as TranslationKey)}
                      </div>
                    </td>
                    <td>
                      <OperatorBookingActions
                        locale={locale}
                        bookingId={booking.id}
                        status={booking.status}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {closed.length > 0 ? (
          <>
            <h2>{t('bookings.closedTitleList')}</h2>
            <ul className="booking-list">
              {closed.map((booking) => (
                <li key={booking.id} className="booking-card">
                  <div className="booking-card__head">
                    <strong>{booking.contactName}</strong>
                    <Badge tone={bookingTone(booking.status)}>
                      {t(
                        BOOKING_STATUS_KEY[booking.status as keyof typeof BOOKING_STATUS_KEY] ??
                          'bookings.status.rejected',
                      )}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {bookings.length === 0 ? (
          <EmptyState title={t('bookings.noRequests')} description={t('bookings.noRequestsHint')} />
        ) : null}
      </main>
    </>
  );
}
