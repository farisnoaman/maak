import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { EmptyState } from '@/components/ui/Feedback';
import { BookingForm, type BookableStop } from '@/components/bookings/BookingForm';
import { loadAccountContext } from '@/lib/account';
import { loadMyBookings } from '@/lib/bookings';
import { getServerClient } from '@/lib/supabase/server';
import { loadPublicTrip } from '@/lib/trips';

/**
 * The booking page for one trip.
 *
 * The fare is computed on the server by `get_trip_public` (for the headline) and again in the form from
 * the same pricing engine, and once more inside `cmd_create_booking`. Three computations of one number
 * is deliberate: the first two are display, the last is the only one that can charge somebody.
 */
export const dynamic = 'force-dynamic';

export default async function BookTripPage({
  params,
}: {
  params: Promise<{ locale: string; code: string }>;
}) {
  const { locale: raw, code } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/trips/${code}/book`);
  }

  const trip = await loadPublicTrip(code, locale);
  if (!trip) notFound();

  // `get_trip_public` carries a stop's sequence and price but not its row id, because the marketplace
  // never needed one. A booking needs the id, so it is read from the (publicly readable) stops table.
  const client = await getServerClient();
  const stopsResult = client
    ? await client
        .from('trip_stops')
        .select('id, seq, name_ar, name_en, price_from_origin_yer')
        .eq('trip_id', trip.id)
        .order('seq')
    : { data: [] };
  const stops: BookableStop[] = ((stopsResult.data ?? []) as Record<string, unknown>[]).map(
    (row) => ({
      id: String(row.id),
      seq: Number(row.seq),
      name: String(
        (locale === 'en' ? row.name_en : row.name_ar) ?? row.name_en ?? row.name_ar ?? row.seq,
      ),
      priceFromOriginYer:
        row.price_from_origin_yer == null ? null : Number(row.price_from_origin_yer),
    }),
  );

  const closed = trip.hasDeparted || trip.seatsAvailable < 1 || trip.status !== 'published';

  // One live booking per passenger per trip is a database rule (`bookings_one_active_per_trip`). Asking
  // the question here means the passenger is never handed a form whose only possible answer is
  // `ALREADY_BOOKED` — the mistake stays a refusal in the API, but the page says it first, with the code
  // and a way into the booking they already have.
  const existing = loaded.user
    ? (await loadMyBookings()).find(
        (booking) =>
          booking.trip?.id === trip.id &&
          (booking.status === 'pending' || booking.status === 'accepted'),
      )
    : undefined;

  return (
    <>
      <SiteHeader locale={locale} pathname="/trips" />
      <main id="main" className="shell section">
        <Link className="trip-back" href={`/${locale}/trips/${trip.code}`}>
          ← {t('common.back')}
        </Link>
        <h1>{t('bookings.bookTitle', { code: trip.code })}</h1>
        <p className="trip-form__hint">{t('bookings.bookSubtitle')}</p>
        {!loaded.configured ? <PreviewBanner locale={locale} /> : null}

        {existing ? (
          <EmptyState
            title={t('errors.ALREADY_BOOKED')}
            description={t('bookings.holdExplain', { minutes: 30 })}
            action={
              <div className="form-actions">
                <Link
                  className="ui-btn ui-btn--primary ui-btn--md"
                  href={`/${locale}/account/bookings/${existing.id}`}
                >
                  {existing.code}
                </Link>
                <Link
                  className="ui-btn ui-btn--ghost ui-btn--md"
                  href={`/${locale}/account/bookings`}
                >
                  {t('bookings.myTitle')}
                </Link>
              </div>
            }
          />
        ) : closed ? (
          <EmptyState
            title={t('bookings.closedTitle')}
            description={t('bookings.closedBody')}
            action={
              <Link className="btn btn--primary" href={`/${locale}/trips`}>
                {t('trips.search.title')}
              </Link>
            }
          />
        ) : (
          <BookingForm
            locale={locale}
            trip={{
              id: trip.id,
              code: trip.code,
              currency: trip.currency,
              seatsAvailable: trip.seatsAvailable,
              seatsTotal: trip.seatsTotal,
              bookingMode: trip.bookingMode,
              pricingMode: trip.pricingMode,
              pricePerSeatYer: trip.pricePerSeatYer,
              wholeTripPriceYer: trip.wholeTripPriceYer,
              discount: trip.discount,
              genderPolicy: trip.genderPolicy,
            }}
            stops={stops}
          />
        )}
      </main>
    </>
  );
}
