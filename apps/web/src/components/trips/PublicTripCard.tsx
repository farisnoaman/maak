import Link from 'next/link';
import {
  departureLabel,
  formatMinor,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
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
      {/* A row, not a stack: the departure time gets its own edge the way a ticket has it, and everything else
          lines up beside it. As the first line of grey meta text the time was the third most prominent fact on
          the card, in a list sorted by it. */}
      <div className="trip-card__row">
        <p className="trip-card__when">
          <bdi className="trip-card__time num">{when.time}</bdi>
          <span className="trip-card__date">{when.date}</span>
        </p>

        <div className="trip-card__main">
          <div className="trip-badges">
            {trip.isFeatured ? <Badge tone="info">{t('trips.badgeFeatured')}</Badge> : null}
            {trip.seatsAvailable === 0 ? (
              // A sold-out trip stays in the list — it is evidence the route runs — but it must say so before the
              // price, or the card invites a tap that ends in a disabled button.
              <Badge tone="neutral">{t('trips.badgeSoldOut')}</Badge>
            ) : null}
            {trip.seatsAvailable > 0 && trip.seatsAvailable <= 2 ? (
              <Badge tone="warning">{t('trips.badgeLastSeats')}</Badge>
            ) : null}
            {trip.genderPolicy !== 'any' ? (
              <Badge tone="neutral">
                {t(`trips.gender.${trip.genderPolicy}` as TranslationKey)}
              </Badge>
            ) : null}
            {trip.stopCount === 0 ? <Badge tone="success">{t('trips.search.direct')}</Badge> : null}
          </div>

          {/* The route is the link. A card whose only tappable thing is a small button at the bottom asks a thumb
              to aim; the title is the largest target on it. The button stays for people who read to the end. */}
          <h3 className="trip-card__route">
            <Link className="trip-card__link" href={href}>
              <span className={highlighted.has(trip.origin.code) ? 'trip-match' : undefined}>
                {trip.origin.name}
              </span>
              {/* An arrow drawn as an arrow. The character `→` took the font's weight, sat on the text baseline and
                  changed shape with the fallback face; this one is stroked, centred, and flips with the document. */}
              <span className="trip-card__arrow" aria-hidden="true">
                <Icon name="arrow" size={16} />
              </span>
              <span className={highlighted.has(trip.destination.code) ? 'trip-match' : undefined}>
                {trip.destination.name}
              </span>
            </Link>
          </h3>

          <div className="trip-card__meta">
            <span>{t('trips.seatsAvailable', { count: trip.seatsAvailable })}</span>
            {trip.operatorName ? <span>{trip.operatorName}</span> : null}
          </div>
        </div>
      </div>

      <div className="trip-card__footer">
        <p className="trip-price">
          {trip.priceFromYer == null ? '—' : formatMinor(trip.priceFromYer, 'YER', { locale })}{' '}
          <small>{t('trips.pricePerSeat')}</small>
        </p>
        <Link
          className={trip.seatsAvailable === 0 ? 'btn btn--ghost' : 'btn btn--primary'}
          href={href}
        >
          {trip.seatsAvailable === 0 ? t('trips.badgeSoldOut') : t('trips.view')}
        </Link>
      </div>
    </article>
  );
}
