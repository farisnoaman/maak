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
import { Icon } from '@/components/ui/Icon';
import { loadPublicTrip } from '@/lib/trips';
import { isSupabaseConfigured } from '@/lib/supabase/config';
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

  /**
   * A stop is stored as "minutes after departure", which is the only form that survives a rescheduled trip — but it is
   * not what a passenger reads. The clock time is derived here from the departure the payload already carries, through
   * the same `departureLabel` the rest of the page uses, so the itinerary and the header can never disagree about which
   * day it is or which timezone it is in.
   */
  const at = (minutesAfterStart: number): { date: string; time: string } | null => {
    if (!trip) return null;
    const start = new Date(trip.departureAt).getTime();
    if (Number.isNaN(start)) return null;
    return departureLabel(new Date(start + minutesAfterStart * 60_000).toISOString(), locale);
  };
  const arrivesAt = trip && trip.arriveEstimateMinutes > 0 ? at(trip.arriveEstimateMinutes) : null;

  const policyRows = describePolicies(trip?.policies, locale);

  return (
    <>
      <SiteHeader locale={locale} pathname="/trips" />
      <main id="main" className="shell">
        {!isSupabaseConfigured() ? <PreviewBanner locale={locale} /> : null}

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
            <nav className="trip-detail__back" aria-label={t('trips.search.title')}>
              <Link href={`/${locale}/trips`}>
                <Icon name="chevron" size={16} className="trip-detail__back-icon" />
                {t('trips.search.title')}
              </Link>
            </nav>
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
                  <span className="route-arrow" aria-hidden="true">
                    <Icon name="arrow" size={20} />
                  </span>
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

            {/* Two columns from 940px: what the trip *is* on one side, what it *costs* and how to take it on
                the other. The fare used to sit at the bottom of a twelve-row table, under the luggage allowance
                and the payment policy — the one number a passenger came for, last. */}
            <div className="trip-detail__body">
              <div className="trip-detail__main">
                <dl className="trip-summary">
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
                </dl>

                {/* Two cards on one row: who is driving, and who is running the trip. Each answers a question a
                    passenger actually opens this page to ask, so each gets its own surface instead of both being
                    another grey heading in one long column. */}
                <div className="trip-cards trip-cards--pair">
                  <section className="trip-card" aria-labelledby="crew-title">
                    <header className="trip-card__head">
                      <span className="trip-card__icon" aria-hidden="true">
                        <Icon name="users" size={18} />
                      </span>
                      <h2 id="crew-title">{t('trips.detail.crew')}</h2>
                    </header>
                    <div className="trip-crew__grid">
                      <div className="trip-crew__driver">
                        <span className="trip-crew__avatar" aria-hidden="true">
                          <Icon name="users" size={20} />
                        </span>
                        <div>
                          <p className="trip-crew__label">{t('trips.detail.driver')}</p>
                          {trip.driver?.name ? (
                            <p className="trip-crew__name">
                              {trip.driver.name}
                              {trip.driver.verified ? (
                                <span className="trip-crew__verified">
                                  <Icon name="shield" size={13} />
                                  {t('trips.detail.driverVerified')}
                                </span>
                              ) : null}
                            </p>
                          ) : (
                            <p className="trip-crew__name trip-crew__name--empty">
                              {t('trips.detail.driverUnknown')}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="trip-crew__vehicle">
                        <p className="trip-crew__label">{t('trips.vehicle')}</p>
                        <p className="trip-crew__name">
                          {trip.vehicle?.label ?? '—'}
                          {trip.vehicle?.seatsTotal ? (
                            <span className="trip-crew__seats">
                              <Icon name="seat" size={13} />
                              {t('trips.detail.seatsOnBoard', { count: trip.vehicle.seatsTotal })}
                            </span>
                          ) : null}
                        </p>
                        {/* Only the amenities the vehicle actually declares: an un-checked box is not a feature,
                          and a row of four greyed-out chips says less than no row at all. */}
                        {trip.vehicle &&
                        (trip.vehicle.airConditioning ||
                          trip.vehicle.wifi ||
                          trip.vehicle.usbCharging) ? (
                          <ul
                            className="trip-crew__amenities"
                            aria-label={t('trips.detail.amenities')}
                          >
                            {trip.vehicle.airConditioning ? (
                              <li>
                                <Icon name="spark" size={13} />
                                {t('trips.amenity.ac')}
                              </li>
                            ) : null}
                            {trip.vehicle.wifi ? (
                              <li>
                                <Icon name="spark" size={13} />
                                {t('trips.amenity.wifi')}
                              </li>
                            ) : null}
                            {trip.vehicle.usbCharging ? (
                              <li>
                                <Icon name="spark" size={13} />
                                {t('trips.amenity.usb')}
                              </li>
                            ) : null}
                          </ul>
                        ) : null}
                      </div>
                    </div>
                  </section>

                  <section className="trip-card" aria-labelledby="operator-title">
                    <header className="trip-card__head">
                      <span className="trip-card__icon" aria-hidden="true">
                        <Icon name="bus" size={18} />
                      </span>
                      <h2 id="operator-title">{t('trips.detail.operator')}</h2>
                    </header>
                    <p className="trip-operator__name">{trip.operator?.name ?? '—'}</p>
                    {trip.operator?.verified ? (
                      <p className="trip-operator__meta">
                        <Icon name="shield" size={14} />
                        {t('trips.detail.operatorVerified')}
                      </p>
                    ) : null}
                  </section>
                </div>

                {/*
                  The itinerary, as a card of stops rather than a list that floats in the column.

                  Each row is one stop with the three things a passenger reads it for in the same three places every
                  time: the clock time on the leading edge, the name, and the fare from the origin on the trailing
                  edge. The old list put the time inside a sentence under the name, so comparing two stops meant
                  reading two sentences; the numbers line up now, in both directions.
                */}
                <section className="trip-card" aria-labelledby="itinerary-title">
                  <header className="trip-card__head">
                    <span className="trip-card__icon" aria-hidden="true">
                      <Icon name="route" size={18} />
                    </span>
                    <div>
                      <h2 id="itinerary-title">{t('trips.detail.itinerary')}</h2>
                      <p className="trip-card__hint">{t('trips.detail.itineraryHint')}</p>
                    </div>
                  </header>

                  <ol className="route-list">
                    <li className="route-stop route-stop--start">
                      <span className="route-stop__time num">{when ? when.time : '—'}</span>
                      <span className="route-stop__dot" aria-hidden="true" />
                      <span className="route-stop__text">
                        <span className="route-stop__name">{trip.origin.name}</span>
                        <span className="route-stop__meta">
                          {t('trips.detail.departs')}
                          {when ? ` · ${when.date}` : null}
                        </span>
                      </span>
                    </li>

                    {trip.stops.length === 0 ? (
                      <li className="route-stop route-stop--empty">
                        <span className="route-stop__time" aria-hidden="true" />
                        <span className="route-stop__dot" aria-hidden="true" />
                        <span className="route-stop__text">
                          <span className="route-stop__meta">{t('trips.detail.noStops')}</span>
                        </span>
                      </li>
                    ) : (
                      trip.stops.map((stop) => {
                        const arrives = at(stop.arriveOffsetMinutes);
                        return (
                          <li className="route-stop" key={`${stop.seq}-${stop.name}`}>
                            <span className="route-stop__time num">
                              {arrives ? arrives.time : '—'}
                            </span>
                            <span className="route-stop__dot num" aria-hidden="true">
                              {stop.seq}
                            </span>
                            <span className="route-stop__text">
                              <span className="route-stop__name">{stop.name}</span>
                            </span>
                            {stop.priceFromOriginYer != null ? (
                              <span className="route-stop__fare num">
                                {formatMinor(stop.priceFromOriginYer, 'YER', { locale })}
                              </span>
                            ) : (
                              <span className="route-stop__fare" aria-hidden="true" />
                            )}
                          </li>
                        );
                      })
                    )}

                    <li className="route-stop route-stop--end">
                      <span className="route-stop__time num">
                        {arrivesAt ? arrivesAt.time : '—'}
                      </span>
                      <span className="route-stop__dot" aria-hidden="true" />
                      <span className="route-stop__text">
                        <span className="route-stop__name">{trip.destination.name}</span>
                        <span className="route-stop__meta">
                          {t('trips.detail.arrives')}
                          {arrivesAt ? ` · ${arrivesAt.date}` : null}
                        </span>
                      </span>
                    </li>
                  </ol>
                </section>

                {/* What the operator promises, and what they want you to know — two small cards under the route,
                    each with its own edge, so a paragraph of notes is a thing rather than the last grey line of a
                    long column. */}
                {policyRows.length > 0 || trip.notes ? (
                  <div className="trip-cards trip-cards--trio">
                    {policyRows.length > 0 ? (
                      <section className="trip-card" aria-labelledby="policies-title">
                        <header className="trip-card__head">
                          <span className="trip-card__icon" aria-hidden="true">
                            <Icon name="shield" size={18} />
                          </span>
                          <h2 id="policies-title">{t('trips.detail.policies')}</h2>
                        </header>
                        {/* Policies are free-form key/value pairs the operator chose; nothing is invented for a
                            key we do not know, and nothing is hidden for a key we do. */}
                        <dl className="trip-facts">
                          {policyRows.map(([key, value]) => (
                            <div className="trip-facts__row" key={key}>
                              <dt>{key}</dt>
                              <dd>{value}</dd>
                            </div>
                          ))}
                        </dl>
                      </section>
                    ) : null}

                    {trip.notes ? (
                      <section className="trip-card" aria-labelledby="notes-title">
                        <header className="trip-card__head">
                          <span className="trip-card__icon" aria-hidden="true">
                            <Icon name="inbox" size={18} />
                          </span>
                          <h2 id="notes-title">{t('trips.notes')}</h2>
                        </header>
                        <p className="trip-notes">{trip.notes}</p>
                      </section>
                    ) : null}
                  </div>
                ) : null}

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

              <aside className="trip-book" aria-labelledby="trip-book-title">
                <h2 id="trip-book-title">{t('trips.detail.fare')}</h2>
                {trip.fare ? (
                  <>
                    <p className="trip-book__price num">
                      {formatMinor(trip.fare.totalMinor, 'YER', { locale })}
                    </p>
                    <p className="trip-book__per">
                      {trip.bookingMode === 'whole_trip'
                        ? t('trips.wholePrice')
                        : t('trips.pricePerSeat')}
                    </p>
                    <dl className="trip-book__breakdown">
                      <div>
                        <dt>{t('trips.perSeatFare')}</dt>
                        <dd className="num">
                          {formatMinor(trip.fare.unitFareMinor, 'YER', { locale })}
                        </dd>
                      </div>
                      {trip.fare.discountMinor > 0 ? (
                        <>
                          <div>
                            <dt>{t('trips.subtotal')}</dt>
                            <dd className="num">
                              {formatMinor(trip.fare.subtotalMinor, 'YER', { locale })}
                            </dd>
                          </div>
                          <div>
                            <dt>{t('trips.discount')}</dt>
                            <dd className="num">
                              − {formatMinor(trip.fare.discountMinor, 'YER', { locale })}
                            </dd>
                          </div>
                        </>
                      ) : null}
                    </dl>
                  </>
                ) : (
                  <p className="trip-form__hint">{t('trips.detail.fareUnavailable')}</p>
                )}

                <p className="trip-book__seats">
                  <Icon name="seat" size={15} />
                  {trip.seatsAvailable > 0
                    ? t('trips.seatsAvailable', { count: trip.seatsAvailable })
                    : t('trips.badgeSoldOut')}
                </p>

                {/* One primary action, and only when it can actually work: a departed trip or a full one
                    shows the reason instead of a button that leads to a closed form. */}
                {trip.hasDeparted || trip.seatsAvailable < 1 ? (
                  <p className="trip-form__hint">
                    {trip.hasDeparted
                      ? t('trips.detail.hasDeparted')
                      : t('trips.detail.bookingSoon')}
                  </p>
                ) : (
                  <Link
                    className="btn btn--primary trip-book__cta"
                    href={`/${locale}/trips/${trip.code}/book`}
                  >
                    {t('bookings.reserve')}
                  </Link>
                )}
                <p className="trip-book__trust">{t('trips.detail.fareNote')}</p>
              </aside>
            </div>
          </article>
        )}
      </main>
    </>
  );
}
