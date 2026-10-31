import { describe, expect, it } from 'vitest';

import {
  costPerKm,
  daysBetween,
  fleetCsv,
  fleetFilename,
  isFuelAnomaly,
  kmPerLitre,
  kmUntilDue,
  lPer100Km,
  nextDueKm,
  todayInAden,
} from '../src/domain/fleet-ops';

/**
 * The plan states Phase 8's acceptance criteria as numbers: 450 km on 38 litres is 8.44 L/100km, and oil
 * every 5 000 km from 120 000 is due at 125 000. Those are asserted here in the pure functions the
 * screens use, and in pgTAP against the SQL that decides. If the two ever disagree, one of these fails.
 */
describe('consumption', () => {
  it('computes 8.44 L/100km for 450 km on 38 litres', () => {
    expect(lPer100Km(38, 450)).toBe(8.44);
  });

  it('quotes the same tank as 11.84 km per litre', () => {
    expect(kmPerLitre(450, 38)).toBe(11.84);
  });

  it('turns a 19 000 riyal tank into 42.22 fils per kilometre', () => {
    expect(costPerKm(19_000, 450)).toBe(42.22);
  });

  it('returns null instead of dividing by zero distance', () => {
    expect(lPer100Km(38, 0)).toBeNull();
    expect(costPerKm(19_000, 0)).toBeNull();
    expect(kmPerLitre(0, 0)).toBeNull();
  });

  it('rounds to two places, not to a float artefact', () => {
    expect(lPer100Km(40, 450)).toBe(8.89);
  });
});

describe('anomaly detection', () => {
  it('flags a fill 30% above the baseline at the default threshold', () => {
    expect(isFuelAnomaly(11, 8.44)).toBe(true);
  });

  it('does not flag a fill inside the window', () => {
    // 8.44 × 1.25 = 10.55
    expect(isFuelAnomaly(10.5, 8.44)).toBe(false);
  });

  it('respects a stricter threshold the owner chose', () => {
    expect(isFuelAnomaly(9, 8.44, 5)).toBe(true);
    expect(isFuelAnomaly(9, 8.44, 25)).toBe(false);
  });

  it('stays quiet when there is no baseline yet', () => {
    expect(isFuelAnomaly(12, null)).toBe(false);
    expect(isFuelAnomaly(null, 8.44)).toBe(false);
  });
});

describe('due points', () => {
  it('adds the interval to the last completion: 120 000 + 5 000', () => {
    expect(nextDueKm(120_000, 5_000)).toBe(125_000);
  });

  it('reports the distance left, negative once past it', () => {
    expect(kmUntilDue(125_000, 124_600)).toBe(400);
    expect(kmUntilDue(125_000, 125_300)).toBe(-300);
  });

  it('says nothing for a date-only rule', () => {
    expect(kmUntilDue(null, 124_600)).toBeNull();
  });
});

describe('dates in Aden', () => {
  it('is the 31st in Aden when UTC has not turned over', () => {
    // 21:30 UTC on the 30th is 00:30 on the 31st in Aden (UTC+3).
    expect(todayInAden(new Date('2026-10-30T21:30:00Z'))).toBe('2026-10-31');
  });

  it('is still the 30th in Aden just before midnight there', () => {
    expect(todayInAden(new Date('2026-10-30T20:59:00Z'))).toBe('2026-10-30');
  });

  it('counts whole days between calendar dates', () => {
    expect(daysBetween('2026-10-01', '2026-10-14')).toBe(13);
    expect(daysBetween('2026-10-14', '2026-10-01')).toBe(-13);
  });

  it('does not drift across a month boundary', () => {
    expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1);
  });
});

describe('the export file', () => {
  const rows = [
    {
      plateNumber: '5-9001',
      make: 'Toyota',
      model: 'Hiace',
      odometerKm: 125_300,
      state: 'overdue',
      nextDueKm: 125_000,
      nextDueOn: null,
      recentLPer100Km: 8.44,
      monthFuelYer: 38_000,
      monthMaintenanceYer: 4_500,
    },
  ];

  it('starts with a byte-order mark so Excel opens Arabic', () => {
    expect(fleetCsv(rows, 'ar').startsWith('\ufeff')).toBe(true);
  });

  it('uses CRLF, which is what a CSV consumer expects', () => {
    const csv = fleetCsv(rows, 'en');
    expect(csv).toContain('\r\n');
    expect(csv.split('\r\n')).toHaveLength(2);
  });

  it('quotes a plate so it cannot be read as a formula or a date', () => {
    expect(fleetCsv(rows, 'en')).toContain('"5-9001"');
  });

  it('localises the maintenance state but keeps the numbers raw', () => {
    expect(fleetCsv(rows, 'ar')).toContain('"متأخرة"');
    expect(fleetCsv(rows, 'en')).toContain('"8.44"');
  });

  it('leaves an empty cell for a value that is not there', () => {
    expect(fleetCsv(rows, 'en')).toContain('"Toyota","Hiace","125300","overdue","125000",""');
  });

  it('names the file without anything an OS dislikes', () => {
    expect(fleetFilename('2026-10-31')).toBe('fleet-2026-10-31.csv');
  });
});
