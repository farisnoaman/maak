import { describe, expect, it } from 'vitest';
import {
  adenIso,
  manifestColumns,
  manifestCsv,
  manifestFilename,
  staffTripsCsv,
  type ManifestRow,
} from '../src/domain/manifest';

const passenger = (index: number, overrides: Partial<ManifestRow> = {}): ManifestRow => ({
  code: `BK-MAAK${String(index).padStart(4, '0')}`,
  name: `مسافر ${index}`,
  phone: `+9677338${String(index).padStart(5, '0')}`,
  seats: 1,
  status: 'accepted',
  paymentStatus: 'cash',
  totalYer: 5000,
  note: null,
  ...overrides,
});

const fourteen = Array.from({ length: 14 }, (_, index) => passenger(index + 1));
const thirty = Array.from({ length: 30 }, (_, index) => passenger(index + 1));

describe('manifestCsv', () => {
  it('starts with a UTF-8 BOM and uses CRLF line endings', () => {
    const csv = manifestCsv(fourteen, 'ar');
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv).toContain('\r\n');
    // BOM + header + 14 rows.
    expect(csv.split('\r\n')).toHaveLength(15);
  });

  it('writes Arabic headers for ar and Latin headers for en', () => {
    expect(manifestCsv([], 'ar')).toContain('"الاسم"');
    expect(manifestCsv([], 'en')).toContain('"Name"');
    expect(manifestCsv([], 'en')).not.toContain('"الاسم"');
  });

  it('quotes every field and doubles internal quotes', () => {
    const csv = manifestCsv([passenger(1, { name: 'سالم "أبو علي"' })], 'ar');
    expect(csv).toContain('"سالم ""أبو علي"""');
  });

  it('keeps a leading plus sign on the phone number (Excel would eat it)', () => {
    expect(manifestCsv([passenger(1)], 'ar')).toContain('"+967733800001"');
  });

  it('renders one row per passenger, in booking order', () => {
    const rows = manifestCsv(thirty, 'en').split('\r\n').slice(1);
    expect(rows).toHaveLength(30);
    expect(rows[0]?.startsWith('"BK-MAAK0001"')).toBe(true);
    expect(rows[29]?.startsWith('"BK-MAAK0030"')).toBe(true);
  });

  it('writes an empty note as an empty cell, not the string "null"', () => {
    const row = manifestCsv([passenger(1, { note: null })], 'en').split('\r\n')[1] ?? '';
    expect(row.endsWith(',""')).toBe(true);
    expect(row).not.toContain('"null"');
  });
});

describe('manifestFilename', () => {
  it('names the file by trip code and locale', () => {
    expect(manifestFilename('AD-SA-478B', 'ar')).toBe('manifest-AD-SA-478B-ar.csv');
  });

  it('strips anything an OS could object to', () => {
    expect(manifestFilename('AD/SA 478:B', 'en')).toBe('manifest-AD-SA-478-B-en.csv');
  });
});

describe('manifestColumns', () => {
  it('keeps a 14-passenger manifest on one column — and therefore one page', () => {
    const columns = manifestColumns(fourteen);
    expect(columns).toHaveLength(1);
    expect(columns[0]).toHaveLength(14);
  });

  it('splits thirty passengers into two columns of 28 and 2, preserving order', () => {
    const columns = manifestColumns(thirty);
    expect(columns.map((column) => column.length)).toEqual([28, 2]);
    expect(columns[0]?.[0]?.code).toBe('BK-MAAK0001');
    expect(columns[1]?.[0]?.code).toBe('BK-MAAK0029');
  });

  it('handles an empty manifest without inventing a column', () => {
    expect(manifestColumns([])).toEqual([[]]);
  });

  it('honours a smaller page budget', () => {
    expect(manifestColumns(fourteen, 10).map((column) => column.length)).toEqual([10, 4]);
  });
});

describe('staffTripsCsv', () => {
  const row = {
    code: 'AD-SA-478B',
    departureAt: '2026-11-02T06:30:00+03:00',
    origin: 'عدن',
    destination: 'صنعاء',
    operatorName: 'شركة النقل',
    seatsAvailable: 3,
    seatsTotal: 14,
    status: 'published',
    verificationStatus: 'verified',
  } as const;

  it('exports the same columns in both locales, with a BOM', () => {
    const ar = staffTripsCsv([row], 'ar');
    const en = staffTripsCsv([row], 'en');
    expect(ar.startsWith('\ufeff')).toBe(true);
    expect(ar).toContain('"رمز الرحلة"');
    expect(en).toContain('"Trip code"');
    // Same number of fields on every line: the file opens as a grid, not as one wide column.
    for (const line of en.split('\r\n')) {
      expect(line.split('","')).toHaveLength(9);
    }
  });

  it('writes departure in Aden time with its offset, so the day cannot drift', () => {
    expect(staffTripsCsv([row], 'en')).toContain('"2026-11-02T06:30:00+03:00"');
  });

  it('converts a UTC instant into the local departure time the table shows', () => {
    // 07:38Z is 10:38 in Aden — the time the driver reads on the manifest, not the one in the database.
    expect(adenIso('2026-11-02T07:38:22.922+00:00')).toBe('2026-11-02T10:38:22+03:00');
  });

  it('leaves an unparseable timestamp alone rather than inventing one', () => {
    expect(adenIso('not a date')).toBe('not a date');
  });
});
