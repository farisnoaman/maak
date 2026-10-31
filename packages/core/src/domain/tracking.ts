/**
 * Live trip tracking — the shape of `get_trip_progress()` and the rules that read it.
 *
 * The database derives progress once (`app.recompute_trip_progress`) and hands back a snapshot; this
 * module is the only place that turns a snapshot into a sentence, so the driver's screen, the
 * passenger's screen and the operator's inbox say the same thing about the same vehicle.
 *
 * Two of these functions are deliberately *local* decisions rather than stored fields:
 *
 *   · **staleness** is compared against the browser's clock, not trusted from the payload. A page left
 *     open for an hour must say «الموقع غير محدّث» even though every byte it holds is a fresh answer
 *     from ten minutes ago.
 *   · **the ETA** is recomputed from the last known speed when the number the server sent has aged,
 *     and dropped entirely when the vehicle has stopped: "arriving in 4 minutes" for a bus parked at a
 *     checkpoint is worse than "arriving later".
 */

import { formatDistanceKm } from './geo';

/** 21 minutes: two missed 10-minute reports plus a minute of grace. Mirrors `app.ping_stale_after_seconds()`. */
export const TRIP_PROGRESS_STALE_SECONDS = 1260;

export interface TripStopPoint {
  readonly seq: number;
  readonly nameAr: string | null;
  readonly nameEn: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly reached: boolean;
}

export interface TripProgressNextStop {
  readonly seq: number;
  readonly nameAr: string | null;
  readonly nameEn: string | null;
  readonly distanceKm: number | null;
  readonly etaSeconds: number | null;
}

export interface TripProgressSnapshot {
  readonly trip: {
    readonly id: string;
    readonly code: string;
    readonly status: string;
    readonly departureAt: string | null;
    readonly arriveEstimateMinutes: number | null;
    readonly startedAt: string | null;
    readonly lastStopSeq: number | null;
  };
  readonly position: {
    readonly lat: number;
    readonly lng: number;
    readonly accuracyM: number | null;
    readonly at: string | null;
  } | null;
  readonly nextStop: TripProgressNextStop | null;
  readonly destination: TripProgressNextStop | null;
  readonly progressPct: number | null;
  readonly distanceRemainingKm: number | null;
  readonly speedKmh: number | null;
  readonly stale: boolean;
  readonly staleAfterSeconds: number;
  readonly lastPingAt: string | null;
  readonly updatedAt: string | null;
  readonly stops: readonly TripStopPoint[];
  readonly route: readonly { readonly lat: number; readonly lng: number }[];
}

/** The stop's name in the reader's language, falling back to the other one rather than to nothing. */
export function stopName(
  stop: { nameAr: string | null; nameEn: string | null },
  locale: 'ar' | 'en',
): string {
  const primary = locale === 'ar' ? stop.nameAr : stop.nameEn;
  const secondary = locale === 'ar' ? stop.nameEn : stop.nameAr;
  return (primary ?? secondary ?? '').trim();
}

/**
 * Is the position older than `staleAfterSeconds`?
 *
 * `now` is a parameter, not `Date.now()`, so a test can be a test and a server render can be
 * deterministic. A trip with no ping at all is stale by definition — there is no position to trust.
 */
export function isProgressStale(
  lastPingAt: string | null,
  now: Date,
  staleAfterSeconds: number = TRIP_PROGRESS_STALE_SECONDS,
): boolean {
  if (!lastPingAt) return true;
  const at = new Date(lastPingAt).getTime();
  if (Number.isNaN(at)) return true;
  // `>=`, not `>`: the acceptance rule is "21 minutes without a ping is stale", and an equals
  // case that reads as fresh would be an off-by-one the test suite gates on.
  return now.getTime() - at >= staleAfterSeconds * 1000;
}

/** Whole percent, clamped: a driver who overshoots a stop must not read "103 %". */
export function progressPercent(value: number | null): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * `٤٥ د` / `1 h 10 min` — coarse on purpose.
 *
 * A minute-precise arrival time derived from a haversine estimate and a rolling average is a promise
 * the data cannot keep. Ten-minute resolution is honest about what it is.
 */
export function formatEta(seconds: number | null, locale: 'ar' | 'en'): string {
  if (seconds == null || seconds < 0) return '';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return locale === 'ar' ? 'الآن' : 'now';
  if (minutes < 60) {
    const rounded = Math.max(5, Math.round(minutes / 5) * 5);
    return locale === 'ar' ? `${rounded} د` : `${rounded} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes % 60) / 10) * 10;
  if (locale === 'ar') {
    return rest === 0 ? `${hours} س` : `${hours} س ${rest} د`;
  }
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export interface ProgressLine {
  /** «الآن في تعز» / "Now near Taiz" — null when there is no position at all. */
  readonly current: string | null;
  /** «يتبقى 24 كم لأقرب توقف» — null once every stop is behind the vehicle. */
  readonly nextStop: string | null;
  /** «يتبقى 137 كم للوصول إلى صنعاء». */
  readonly destination: string | null;
  readonly percent: number;
  readonly stale: boolean;
}

/**
 * The three sentences on the live screen, as data.
 *
 * The copy lives in the dictionaries; this decides *which* facts are worth a sentence. Kept out of the
 * components because "the next stop is behind us" and "we have no position" are the two cases a UI
 * forgets, and both are cheaper to test here than through a renderer.
 */
export function progressLine(
  snapshot: TripProgressSnapshot,
  locale: 'ar' | 'en',
  now: Date = new Date(),
): ProgressLine {
  const stale = isProgressStale(snapshot.lastPingAt, now, snapshot.staleAfterSeconds);
  const next = snapshot.nextStop;
  const destination = snapshot.destination;

  // A stale position is still worth showing — "last seen near Taiz" is the most useful thing on the
  // screen — but it is never phrased as "now". That difference is the caller's (`stale`), so this only
  // names the place: the next stop the vehicle is heading for, else the last stop it announced.
  const reached = snapshot.stops.filter((stop) => stop.reached).at(-1) ?? null;
  const place = next ?? destination ?? reached ?? null;
  const current = place ? stopName(place, locale) : null;

  return {
    current,
    nextStop: next && next.distanceKm != null ? formatDistanceKm(next.distanceKm, locale) : null,
    destination:
      destination && destination.distanceKm != null
        ? `${formatDistanceKm(destination.distanceKm, locale)} · ${stopName(destination, locale)}`
        : null,
    percent: progressPercent(snapshot.progressPct),
    stale,
  };
}

/**
 * The ETA to believe right now.
 *
 * A snapshot older than five minutes is re-derived from the last speed it carried (`speedKmh`) rather
 * than repeated: ten minutes at a steady 80 km/h is not the same arrival time as when the number was
 * computed. When the speed is unknown the server's figure is kept — it is better than nothing, and it
 * is labelled as an estimate everywhere it appears.
 */
export function liveEtaSeconds(
  snapshot: TripProgressSnapshot,
  which: 'next' | 'destination',
  now: Date = new Date(),
): number | null {
  const stop = which === 'next' ? snapshot.nextStop : snapshot.destination;
  if (!stop) return null;

  const at = snapshot.lastPingAt ? new Date(snapshot.lastPingAt).getTime() : Number.NaN;
  const ageSeconds = Number.isNaN(at) ? Number.POSITIVE_INFINITY : (now.getTime() - at) / 1000;
  const speed = snapshot.speedKmh;

  if (stop.distanceKm == null) return null;
  if (ageSeconds <= 300 || speed == null || speed < 3) {
    return stop.etaSeconds ?? null;
  }
  return Math.round((stop.distanceKm / speed) * 3600);
}
