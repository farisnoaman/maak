import Link from 'next/link';
import {
  departureLabel,
  formatMinor,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import type { PublicTripSummary } from '@/lib/trips';

/**
 * A marketplace card.
 *
 * Built from `PublicTripSummary` — the shape `search_public_trips` returns — rather than from a table
 * row, because the function has already decided what the public may see (no owner ids, no plate
 * numbers, no drafts). A card cannot leak what it was never given.
 */
export function PublicTripCard({
  locale,
  trip,
  href,
  highlight,
}: {
  readonly locale: Locale;
  readonly trip: PublicTripSummary;
  readonly href: string;
  readonly highlight?: readonly string[];
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const when = departureLabel(trip.departureAt, locale);
  const highlighted = new Set(highlight ?? []);

  return (
    <article className="card trip-card">
      <div className="trip-badges">
        {trip.isFeatured ? <Badge tone="info">{t('trips.badgeFeatured')}</Badge> : null}
        {trip.seatsAvailable > 0 && trip.seatsAvailable <= 2 ? (
          <Badge tone="warning">{t('trips.badgeLastSeats')}</Badge>
        ) : null}
        {trip.genderPolicy !== 'any' ? (
          <Badge tone="neutral">{t(`trips.gender.${trip.genderPolicy}` as TranslationKey)}</Badge>
        ) : null}
        {trip.stopCount === 0 ? <Badge tone="success">{t('trips.search.direct')}</Badge> : null}
      </div>

      <h3 className="trip-card__route">
        <span className={highlighted.has(trip.origin.code) ? 'trip-match' : undefined}>
          {trip.origin.name}
        </span>
        <span className="trip-card__arrow" aria-hidden="true">
          →
        </span>
        <span className={highlighted.has(trip.destination.code) ? 'trip-match' : undefined}>
          {trip.destination.name}
        </span>
      </h3>

      <div className="trip-card__meta">
        <span>
          {when.date} · <bdi>{when.time}</bdi>
        </span>
        <span>{t('trips.seatsAvailable', { count: trip.seatsAvailable })}</span>
        {trip.operatorName ? <span>{trip.operatorName}</span> : null}
      </div>

      <div className="trip-card__footer">
        <p className="trip-price">
          {trip.priceFromYer == null ? '—' : formatMinor(trip.priceFromYer, 'YER', { locale })}{' '}
          <small>{t('trips.pricePerSeat')}</small>
        </p>
        <Link className="btn btn--primary" href={href}>
          {t('trips.view')}
        </Link>
      </div>
    </article>
  );
}
