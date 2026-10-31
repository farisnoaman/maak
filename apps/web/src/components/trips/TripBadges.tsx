import { translate, tripBadges, type Locale, type TripLike } from '@maak/core';
import { Badge, type BadgeTone } from '@/components/ui/Feedback';

const TONE: Record<'ok' | 'warn' | 'bad' | 'neutral', BadgeTone> = {
  ok: 'success',
  warn: 'warning',
  bad: 'danger',
  neutral: 'neutral',
};

/**
 * The badges a trip carries, from `tripBadges()` in @maak/core.
 *
 * The rule set lives in the domain module (and is unit-tested there) so the operator console, the
 * marketplace and the mobile app cannot disagree about what "featured" or "last seats" means.
 */
export function TripBadges({ locale, trip }: { readonly locale: Locale; readonly trip: TripLike }) {
  const badges = tripBadges(trip);
  if (badges.length === 0) return null;
  return (
    <div className="trip-badges">
      {badges.map((badge) => (
        <Badge key={`${badge.code}-${badge.labelKey}`} tone={TONE[badge.tone]}>
          {translate(locale, badge.labelKey)}
        </Badge>
      ))}
    </div>
  );
}
