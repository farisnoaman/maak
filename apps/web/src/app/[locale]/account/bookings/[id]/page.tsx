import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  BOOKING_STATUS_KEY,
  bookingTone,
  departureLabel,
  formatMinor,
  isLocale,
  isPassengerCancellable,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { Badge } from '@/components/ui/Feedback';
import { IdentityForm, PassengerBookingActions } from '@/components/bookings/BookingActions';
import { TicketQr } from '@/components/bookings/TicketQr';
import { loadAccountContext } from '@/lib/account';
import { loadBooking, logDocumentAccess, passengerIdSignedUrl } from '@/lib/bookings';
import { SITE_URL } from '@/lib/seo';

/**
 * One booking, from the passenger's side.
 *
 * The identity card is here because a seat is not really booked until the operator can see who is in it —
 * and the image is only ever linked through the authenticated storage proxy, after the page has written
 * the access row that says this account looked at it.
 */
export const dynamic = 'force-dynamic';

export default async function BookingDetailPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/account/bookings/${id}`);
  }

  const booking = await loadBooking(id);
  if (!booking) notFound();

  // The audit row is written *before* the URL exists, so "this account looked" cannot be skipped by a
  // failed signature.
  if (booking.document) await logDocumentAccess(booking.id);
  const photoUrl = booking.document?.photoPath
    ? await passengerIdSignedUrl(booking.document.photoPath)
    : null;

  const when = booking.trip ? departureLabel(booking.trip.departureAt, locale) : null;
  const live = booking.status === 'pending' || booking.status === 'accepted';

  return (
    <>
      <SiteHeader locale={locale} pathname="/account" />
      <main id="main" className="shell section">
        <Link className="trip-back" href={`/${locale}/account/bookings`}>
          ← {t('bookings.myTitle')}
        </Link>
        <h1>
          {booking.trip
            ? `${booking.trip.originName ?? ''} ← ${booking.trip.destinationName ?? ''}`
            : booking.code}
        </h1>
        <div className="booking-detail__badges">
          <Badge tone={bookingTone(booking.status)}>
            {t(
              BOOKING_STATUS_KEY[booking.status as keyof typeof BOOKING_STATUS_KEY] ??
                'bookings.status.pending',
            )}
          </Badge>
          <span className="trip-form__hint" dir="ltr">
            {booking.code}
          </span>
        </div>

        {live ? (
          <TicketQr
            value={`${SITE_URL}/${locale}/account/bookings/${booking.id}`}
            caption={t('bookings.ticketHint')}
          />
        ) : null}

        {booking.status === 'pending' && booking.holdExpiresAt ? (
          <p className="ui-alert" role="status">
            {t('bookings.holdUntil', {
              time: new Date(booking.holdExpiresAt).toLocaleTimeString(
                locale === 'ar' ? 'ar-YE' : 'en-GB',
                {
                  hour: '2-digit',
                  minute: '2-digit',
                },
              ),
            })}
          </p>
        ) : null}

        {booking.rejectReason ? (
          <p className="ui-alert ui-alert--error">
            {t('bookings.rejectedReason')}: {booking.rejectReason}
          </p>
        ) : null}
        {booking.cancelReason ? (
          <p className="trip-form__hint">
            {t('bookings.cancelReason')}: {booking.cancelReason}
          </p>
        ) : null}
        {booking.refundYer > 0 ? (
          <p className="ui-alert" role="status">
            {t('bookings.refundDue', { amount: formatMinor(booking.refundYer, 'YER', { locale }) })}
          </p>
        ) : null}

        <dl className="trip-summary">
          <div className="trip-summary__row">
            <dt>{t('bookings.departure')}</dt>
            <dd>{when ? `${when.date} · ${when.time}` : '—'}</dd>
          </div>
          <div className="trip-summary__row">
            <dt>{t('bookings.seats')}</dt>
            <dd>{booking.seats}</dd>
          </div>
          <div className="trip-summary__row">
            <dt>{t('bookings.passenger')}</dt>
            <dd>
              {booking.contactName} · <bdi dir="ltr">{booking.contactPhone}</bdi>
            </dd>
          </div>
          <div className="trip-summary__row trip-summary__row--total">
            <dt>{t('bookings.total')}</dt>
            <dd>{formatMinor(booking.totalYer, 'YER', { locale })}</dd>
          </div>
          <div className="trip-summary__row">
            <dt>{t('bookings.paymentStatus')}</dt>
            <dd>{t(`bookings.payment.${booking.paymentStatus}` as TranslationKey)}</dd>
          </div>
        </dl>

        {live ? (
          <PassengerBookingActions
            locale={locale}
            bookingId={booking.id}
            cancellable={isPassengerCancellable(booking.status)}
          />
        ) : null}

        {live ? (
          <>
            <h2>{t('bookings.identityTitle')}</h2>
            <p className="form-hint">{t('bookings.identityHint')}</p>
            <IdentityForm
              locale={locale}
              booking={{ id: booking.id, document: booking.document }}
            />
            {booking.document?.photoPath ? (
              <p>
                <a href={photoUrl ?? '#'} target="_blank" rel="noreferrer">
                  {t('bookings.viewIdPhoto')}
                </a>
              </p>
            ) : null}
          </>
        ) : null}

        {booking.trip ? (
          <p>
            <Link href={`/${locale}/trips/${booking.trip.code}`}>{t('bookings.viewTrip')}</Link>
          </p>
        ) : null}

        {/* A cancelled or finished booking is a dead end unless it leads somewhere: the trip it was
            for is still on sale, and the passenger has already typed this journey once. */}
        {!live && booking.trip && new Date(booking.trip.departureAt) > new Date() ? (
          <p>
            <Link
              className="ui-btn ui-btn--primary ui-btn--md"
              href={`/${locale}/trips/${booking.trip.code}/book`}
            >
              {t('bookings.rebook')}
            </Link>
          </p>
        ) : null}
      </main>
    </>
  );
}
