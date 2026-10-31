import { describe, expect, it } from 'vitest';

import {
  TRIP_PROGRESS_STALE_SECONDS,
  formatEta,
  isProgressStale,
  liveEtaSeconds,
  progressLine,
  progressPercent,
  stopName,
  type TripProgressSnapshot,
} from '../src/domain/tracking';

const NOW = new Date('2026-11-02T09:00:00Z');

function snapshot(overrides: Partial<TripProgressSnapshot> = {}): TripProgressSnapshot {
  return {
    trip: {
      id: 'trip-1',
      code: 'AD-SA-2C62',
      status: 'in_progress',
      departureAt: '2026-11-02T08:00:00Z',
      arriveEstimateMinutes: 480,
      startedAt: '2026-11-02T08:05:00Z',
      lastStopSeq: 1,
    },
    position: { lat: 13.55, lng: 44.05, accuracyM: 8, at: '2026-11-02T08:59:00Z' },
    nextStop: { seq: 2, nameAr: 'تعز', nameEn: 'Taiz', distanceKm: 24, etaSeconds: 1800 },
    destination: { seq: 3, nameAr: 'صنعاء', nameEn: 'Sanaa', distanceKm: 137, etaSeconds: 8100 },
    progressPct: 41.4,
    distanceRemainingKm: 137,
    speedKmh: 60,
    stale: false,
    staleAfterSeconds: TRIP_PROGRESS_STALE_SECONDS,
    lastPingAt: '2026-11-02T08:59:00Z',
    updatedAt: '2026-11-02T08:59:01Z',
    stops: [
      { seq: 1, nameAr: 'عدن', nameEn: 'Aden', lat: 12.7855, lng: 45.0187, reached: true },
      { seq: 2, nameAr: 'تعز', nameEn: 'Taiz', lat: 13.5795, lng: 44.0209, reached: false },
      { seq: 3, nameAr: 'صنعاء', nameEn: 'Sanaa', lat: 15.3694, lng: 44.191, reached: false },
    ],
    route: [],
    ...overrides,
  };
}

describe('staleness', () => {
  it('gives up on a position after 21 minutes', () => {
    const fresh = '2026-11-02T08:59:00Z';
    expect(isProgressStale(fresh, NOW)).toBe(false);
    expect(isProgressStale('2026-11-02T08:40:00Z', NOW)).toBe(false); // 20 minutes
    expect(isProgressStale('2026-11-02T08:39:00Z', NOW)).toBe(true); // 21 minutes
  });

  it('treats a trip with no ping at all as stale, not as fresh', () => {
    // The dangerous default: `null` read as zero is how a screen says "live" about a vehicle whose
    // phone never reported.
    expect(isProgressStale(null, NOW)).toBe(true);
    expect(isProgressStale('not a date', NOW)).toBe(true);
  });

  it('moves the badge as the page ages, without a new response', () => {
    const payload = snapshot({ lastPingAt: '2026-11-02T08:59:00Z' });
    const early = progressLine(payload, 'en', new Date('2026-11-02T09:05:00Z'));
    const later = progressLine(payload, 'en', new Date('2026-11-02T09:30:00Z'));
    expect(early.stale).toBe(false);
    expect(later.stale).toBe(true);
  });
});

describe('progressLine', () => {
  it('says where the vehicle is, how far the next stop is, and how far the destination is', () => {
    const line = progressLine(snapshot(), 'en', NOW);
    expect(line.current).toBe('Taiz');
    expect(line.nextStop).toBe('24 km');
    expect(line.destination).toBe('137 km · Sanaa');
    expect(line.percent).toBe(41);
  });

  it('speaks Arabic when asked, with Latin digits', () => {
    const line = progressLine(snapshot(), 'ar', NOW);
    expect(line.current).toBe('تعز');
    expect(line.nextStop).toBe('24 كم');
  });

  it('falls back to the stop it announced when there is no next stop', () => {
    const line = progressLine(snapshot({ nextStop: null, destination: null }), 'en', NOW);
    expect(line.current).toBe('Aden');
    expect(line.nextStop).toBeNull();
    expect(line.destination).toBeNull();
  });

  it('refuses to report more than 100 per cent', () => {
    expect(progressPercent(103.2)).toBe(100);
    expect(progressPercent(-1)).toBe(0);
    expect(progressPercent(null)).toBe(0);
  });
});

describe('formatEta', () => {
  it('rounds to five minutes inside the hour', () => {
    expect(formatEta(0, 'en')).toBe('now');
    expect(formatEta(200, 'en')).toBe('5 min');
    expect(formatEta(1800, 'en')).toBe('30 min');
    expect(formatEta(1800, 'ar')).toBe('30 د');
  });

  it('splits into hours and tens of minutes above an hour', () => {
    expect(formatEta(8100, 'en')).toBe('2 h 20 min');
    expect(formatEta(7200, 'en')).toBe('2 h');
    expect(formatEta(7200, 'ar')).toBe('2 س');
  });

  it('has nothing to say about a negative or missing estimate', () => {
    expect(formatEta(null, 'en')).toBe('');
    expect(formatEta(-60, 'en')).toBe('');
  });
});

describe('liveEtaSeconds', () => {
  it('believes the server while the snapshot is warm', () => {
    expect(liveEtaSeconds(snapshot(), 'next', new Date('2026-11-02T09:02:00Z'))).toBe(1800);
  });

  it('re-derives from the last speed once the snapshot is old', () => {
    // 24 km at 60 km/h is 24 minutes, not the half hour computed before the traffic jam cleared.
    const timeworn = snapshot({
      lastPingAt: '2026-11-02T08:40:00Z',
      nextStop: { seq: 2, nameAr: 'تعز', nameEn: 'Taiz', distanceKm: 24, etaSeconds: 3600 },
    });
    expect(liveEtaSeconds(timeworn, 'next', NOW)).toBe(1440);
  });

  it('keeps the server figure when there is no speed to extrapolate', () => {
    const parked = snapshot({
      speedKmh: 0,
      lastPingAt: '2026-11-02T08:00:00Z',
      nextStop: { seq: 2, nameAr: 'تعز', nameEn: 'Taiz', distanceKm: 24, etaSeconds: 3600 },
    });
    expect(liveEtaSeconds(parked, 'next', NOW)).toBe(3600);
  });

  it('returns nothing for a stop that is not there', () => {
    expect(liveEtaSeconds(snapshot({ nextStop: null }), 'next', NOW)).toBeNull();
  });
});

describe('stopName', () => {
  it('prefers the reader’s language and falls back to the other one', () => {
    expect(stopName({ nameAr: 'تعز', nameEn: 'Taiz' }, 'ar')).toBe('تعز');
    expect(stopName({ nameAr: 'تعز', nameEn: 'Taiz' }, 'en')).toBe('Taiz');
    expect(stopName({ nameAr: 'قرية', nameEn: null }, 'en')).toBe('قرية');
    expect(stopName({ nameAr: null, nameEn: null }, 'ar')).toBe('');
  });
});
