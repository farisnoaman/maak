/**
 * Quota errors, parsed once.
 *
 * `app.assert_quota()` raises `QUOTA_EXCEEDED: metric=vehicles limit=1 used=1`. The number is only
 * useful if a screen can turn it into "Your plan allows 1 vehicle — upgrade to add more", so the parse
 * lives here rather than in each caller's `if (code === 'QUOTA_EXCEEDED')` branch.
 */

import type { ApiFailure } from './errors';
import type { TranslationKey } from '../i18n/dictionaries';

export interface QuotaContext {
  readonly metric: string;
  /** null = unlimited (the column is nullable, and 0 is a real limit). */
  readonly limit: number | null;
  readonly used: number | null;
}

const METRIC_PATTERN = /metric=([a-z_]+)/i;
const LIMIT_PATTERN = /limit=(\d+|null)/i;
const USED_PATTERN = /used=(\d+)/i;

function toNumber(value: string | undefined): number | null {
  if (!value || value.toLowerCase() === 'null') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reads the machine detail out of the raised message. Pure, so it is unit-tested directly. */
export function parseQuotaDetail(detail: string | undefined): QuotaContext | null {
  if (!detail) return null;
  const metric = METRIC_PATTERN.exec(detail)?.[1];
  if (!metric) return null;
  return {
    metric: metric.toLowerCase(),
    limit: toNumber(LIMIT_PATTERN.exec(detail)?.[1]),
    used: toNumber(USED_PATTERN.exec(detail)?.[1]),
  };
}

/**
 * The quota facts for a failure, from whichever source survived the trip.
 *
 * The structured `context` wins when present (a future gateway may send it); the message detail is the
 * fallback that works today.
 */
export function quotaOf(failure: ApiFailure): QuotaContext | null {
  if (failure.code !== 'QUOTA_EXCEEDED') return null;

  const context = failure.context;
  if (context && typeof context.metric === 'string') {
    return {
      metric: context.metric,
      limit: typeof context.limit === 'number' ? context.limit : null,
      used: typeof context.used === 'number' ? context.used : null,
    };
  }
  return parseQuotaDetail(failure.detail);
}

/** Keys mirror the `metric` values `plan_limits` accepts, plus the two Phase-4/5 metrics. */
export const QUOTA_METRIC_KEY: Record<string, TranslationKey> = {
  vehicles: 'fleet.metricVehicles',
  drivers: 'fleet.metricDrivers',
  trips: 'fleet.metricTrips',
  staff: 'fleet.metricStaff',
  active_trips: 'fleet.metricActiveTrips',
  featured_listings: 'fleet.metricFeaturedListings',
};

export function quotaMetricKey(metric: string): TranslationKey {
  return QUOTA_METRIC_KEY[metric] ?? 'fleet.metricOther';
}
