import {
  vehicleBadges,
  translate,
  type BadgeTone as CoreTone,
  type Locale,
  type VehicleLike,
} from '@maak/core';
import { Badge, type BadgeTone } from '@/components/ui/Feedback';

const TONE: Record<CoreTone, BadgeTone> = {
  ok: 'success',
  warn: 'warning',
  bad: 'danger',
  neutral: 'neutral',
};

/**
 * The vehicle's status, as badges.
 *
 * The decision of *which* badges a vehicle deserves — verified vs pending, an expired document vs one
 * expiring next week — lives in `vehicleBadges()` in `@maak/core`, so the mobile app shows the identical
 * set. This file only paints them.
 */
export function VehicleBadges({
  locale,
  vehicle,
  limit,
}: {
  readonly locale: Locale;
  readonly vehicle: VehicleLike;
  /** Cards show the three most important badges; a detail page shows them all. */
  readonly limit?: number;
}) {
  const badges = vehicleBadges(vehicle);
  const shown = limit ? badges.slice(0, limit) : badges;

  return (
    <span className="fleet-badges">
      {shown.map((badge) => (
        <Badge key={`${badge.code}-${badge.days ?? ''}`} tone={TONE[badge.tone]}>
          {translate(
            locale,
            badge.labelKey,
            badge.days === undefined ? undefined : { days: Math.abs(badge.days) },
          )}
        </Badge>
      ))}
    </span>
  );
}
