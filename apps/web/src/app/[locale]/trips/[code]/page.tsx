import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  departureLabel,
  describePolicies,
  formatMinor,
  isLocale,
  translate,
  TRIP_BOOKING_KEY,
  TRIP_DISCOUNT_KIND_KEY,
  TRIP_GENDER_KEY,
  TRIP_PAYMENT_KEY,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { Badge, EmptyState } from '@/components/ui/Feedback';
import { loadPublicTrip } from '@/lib/trips';
import { ShareTrip } from '@/components/trips/ShareTrip';
import { tripJsonLd, tripMetadata } from '@/lib/seo';

/**
 * One published trip.
 *
 * The page is the passenger's view, so it holds three things and no more: when it leaves, what it
 * costs, and who is running it. Everything comes from `get_trip_public`, which returns `null` for a trip
 * that is not published, is cancelled or was rejected — a link to a withdrawn trip shows the not-found
 * state instead of a stale price, and the fare printed here is the one `app.trip_total()` computed, not a
 * second calculation in the browser.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; code: string }>;
}) {
  const { locale, code } = await params;
  if (!isLocale(locale)) return {};
  return tripMetadata(locale, await loadPublicTrip(code, locale));
}

export default async function PublicTripPage({
  params,
}: {
  params: Promise<{ locale: string; code: string }>;
}) {
  const { locale: raw, code } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const trip = await loadPublicTrip(code, locale);
  const when = trip ? departureLabel(trip.departureAt, locale) : null;

  const policyRows = describePolicies(trip?.policies, locale);

  return (
    <>
      <SiteHeader locale={locale} pathname="/trips" />
      <main id="main" className="shell">
        <PreviewBanner locale={locale} />

        {!trip ? (
          <EmptyState
            title={t('trips.detail.notFound')}
            description={t('trips.search.subtitle')}
            action={
              <Link className="btn btn--primary" href={`/${locale}/trips`}>
                {t('trips.search.title')}
              </Link>
            }
          />
        ) : (
          <article className="trip-detail">
            {/* The same facts the page shows, in the form a crawler reads. Rendered from one payload so
                the structured data cannot advertise a different price than the screen. */}
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: JSON.stringify(tripJsonLd(locale, trip)) }}
            />
            <header className="trip-detail__head">
              <div>
                <p className="trip-form__hint">{trip.code}</p>
                <h1>
                  {trip.origin.name}
                  <span aria-hidden="true"> ← </span>
                  {trip.destination.name}
                </h1>
                {when ? (
                  <p>
                    {when.date} · <bdi>{when.time}</bdi>
                  </p>
                ) : null}
              </div>
              <div className="trip-badges">
                {trip.isFeatured ? <Badge tone="info">{t('trips.badgeFeatured')}</Badge> : null}
                {trip.seatsAvailable > 0 && trip.seatsAvailable <= 2 ? (
                  <Badge tone="warning">{t('trips.badgeLastSeats')}</Badge>
                ) : null}
                {trip.stops.length === 0 ? (
                  <Badge tone="success">{t('trips.search.direct')}</Badge>
                ) : null}
              </div>
            </header>

            {trip.hasDeparted ? (
              <p className="fleet-warning" role="status">
                {t('trips.detail.hasDeparted')}
              </p>
            ) : null}

            <dl className="trip-summary">
              <div className="trip-summary__row">
                <dt>{t('trips.vehicle')}</dt>
                <dd>{trip.vehicle?.label ?? '—'}</dd>
              </div>
              <div className="trip-summary__row">
                <dt>{t('trips.seats')}</dt>
                <dd>{t('trips.seatsAvailable', { count: trip.seatsAvailable })}</dd>
              </div>
              <div className="trip-summary__row">
                <dt>{t('trips.bookingMode')}</dt>
                <dd>{t(TRIP_BOOKING_KEY[trip.bookingMode] ?? 'trips.booking.per_seat')}</dd>
              </div>
              <div className="trip-summary__row">
                <dt>{t('trips.genderPolicy')}</dt>
                <dd>{t(TRIP_GENDER_KEY[trip.genderPolicy] ?? 'trips.gender.any')}</dd>
              </div>
              <div className="trip-summary__row">
                <dt>{t('trips.paymentPolicy')}</dt>
                <dd>{t(TRIP_PAYMENT_KEY[trip.paymentPolicy] ?? 'trips.payment.cash')}</dd>
              </div>
              {trip.luggageAllowanceKg != null ? (
                <div className="trip-summary__row">
                  <dt>{t('trips.luggage')}</dt>
                  <dd>{trip.luggageAllowanceKg}</dd>
                </div>
              ) : null}
              {trip.arriveEstimateMinutes > 0 ? (
                <div className="trip-summary__row">
                  <dt>{t('trips.arriveEstimate')}</dt>
                  <dd>{t('trips.minutes', { count: trip.arriveEstimateMinutes })}</dd>
                </div>
              ) : null}
              {trip.discount.kind !== 'none' ? (
                <div className="trip-summary__row">
                  <dt>{t('trips.discount')}</dt>
                  <dd>
                    {t(TRIP_DISCOUNT_KIND_KEY[trip.discount.kind] ?? 'trips.discountKind.none')}
                    {trip.discount.kind === 'percent'
                      ? ` · ${trip.discount.value / 100}%`
                      : ` · ${formatMinor(trip.discount.value, 'YER', { locale })}`}
                  </dd>
                </div>
              ) : null}
              {trip.fare ? (
                <>
                  <div className="trip-summary__row">
                    <dt>{t('trips.perSeatFare')}</dt>
                    <dd>{formatMinor(trip.fare.unitFareMinor, 'YER', { locale })}</dd>
                  </div>
                  {trip.fare.discountMinor > 0 ? (
                    <div className="trip-summary__row">
                      <dt>{t('trips.subtotal')}</dt>
                      <dd>{formatMinor(trip.fare.subtotalMinor, 'YER', { locale })}</dd>
                    </div>
                  ) : null}
                  {trip.fare.discountMinor > 0 ? (
                    <div className="trip-summary__row">
                      <dt>{t('trips.discount')}</dt>
                      <dd>− {formatMinor(trip.fare.discountMinor, 'YER', { locale })}</dd>
                    </div>
                  ) : null}
                  <div className="trip-summary__row trip-summary__row--total">
                    <dt>
                      {trip.bookingMode === 'whole_trip'
                        ? t('trips.wholePrice')
                        : t('trips.pricePerSeat')}
                    </dt>
                    <dd>{formatMinor(trip.fare.totalMinor, 'YER', { locale })}</dd>
                  </div>
                </>
              ) : null}
            </dl>

            <h2>{t('trips.stops')}</h2>
            {trip.stops.length === 0 ? (
              <p className="trip-form__hint">{t('trips.search.direct')}</p>
            ) : (
              <ol className="trip-timeline">
                {trip.stops.map((stop) => (
                  <li key={`${stop.seq}-${stop.name}`}>
                    <span className="trip-timeline__marker" aria-hidden="true">
                      {stop.seq}
                    </span>
                    <span className="trip-timeline__name">{stop.name}</span>
                    <span className="trip-timeline__meta">
                      {t('trips.stopOffsetValue', { minutes: stop.arriveOffsetMinutes })}
                      {stop.priceFromOriginYer != null
                        ? ` · ${formatMinor(stop.priceFromOriginYer, 'YER', { locale })}`
                        : ''}
                    </span>
                  </li>
                ))}
              </ol>
            )}

            {policyRows.length > 0 ? (
              <section aria-labelledby="policies-title">
                <h2 id="policies-title">{t('trips.detail.policies')}</h2>
                {/* Policies are free-form key/value pairs the operator chose; nothing is invented for a
                    key we do not know, and nothing is hidden for a key we do. */}
                <dl className="trip-summary">
                  {policyRows.map(([key, value]) => (
                    <div className="trip-summary__row" key={key}>
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}

            {trip.notes ? (
              <section>
                <h2>{t('trips.notes')}</h2>
                <p>{trip.notes}</p>
              </section>
            ) : null}

            <section aria-labelledby="operator-title">
              <h2 id="operator-title">{t('trips.detail.operator')}</h2>
              <p>
                {trip.operator?.name ?? '—'}{' '}
                {trip.operator?.verified ? (
                  <Badge tone="success">{t('trips.detail.operatorVerified')}</Badge>
                ) : null}
              </p>
            </section>

            <div className="trip-cta">
              {/* One primary action, and only when it can actually work: a departed trip or a full one
                  shows the reason instead of a button that leads to a closed form. */}
              {trip.hasDeparted || trip.seatsAvailable < 1 ? (
                <p className="trip-form__hint">{t('trips.detail.bookingSoon')}</p>
              ) : (
                <Link className="btn btn--primary" href={`/${locale}/trips/${trip.code}/book`}>
                  {t('bookings.reserve')}
                </Link>
              )}
              <div className="trip-form__actions">
                <ShareTrip locale={locale} url={`/${locale}/trips/${trip.code}`} />
                <Link className="btn btn--ghost" href={`/${locale}/trips/${trip.code}/live`}>
                  {t('live.open')}
                </Link>
                <Link className="btn btn--ghost" href={`/${locale}/trips`}>
                  {t('trips.search.title')}
                </Link>
              </div>
            </div>
          </article>
        )}
      </main>
    </>
  );
}
