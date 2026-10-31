/**
 * The manifest as a file.
 *
 * The manifest exists in three places — a printed A4 sheet, a CSV an operator emails to a depot, and the
 * screen — and all three must agree row for row. Keeping the formatting here (pure, no React, no CSV
 * library) is what lets it be tested without a browser, and lets the mobile app reuse it later.
 */

/** The only fields a manifest file needs. A superset row can be passed; extra keys are ignored. */
export interface ManifestRow {
  readonly code: string;
  readonly name: string;
  readonly phone: string;
  readonly seats: number;
  readonly status: string;
  readonly paymentStatus: string;
  readonly totalYer: number;
  readonly note: string | null;
}

/**
 * RFC 4180 cell: always quoted, inner quotes doubled.
 *
 * Quoting everything rather than only-when-needed is deliberate — a phone number that starts with `+`
 * and a code that looks like a date both survive Excel only when they arrive as text.
 */
function cell(value: string | number | null): string {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * A CSV Excel will actually open in Arabic.
 *
 * Windows Excel reads UTF-8 as Latin-1 unless the file starts with a byte-order mark, so a manifest
 * without one opens as `Ù…Ø³Ø§ÙØ±`. The BOM, `CRLF` line endings and the quoting above are the three
 * concessions this format demands; they are not decoration.
 */
export function manifestCsv(rows: readonly ManifestRow[], locale: 'ar' | 'en'): string {
  const headers =
    locale === 'ar'
      ? ['الرمز', 'الاسم', 'الهاتف', 'المقاعد', 'الحالة', 'الدفع', 'الإجمالي', 'ملاحظة']
      : ['Code', 'Name', 'Phone', 'Seats', 'Status', 'Payment', 'Total', 'Note'];

  const body = rows.map((row) =>
    [
      row.code,
      row.name,
      row.phone,
      row.seats,
      row.status,
      row.paymentStatus,
      row.totalYer,
      row.note,
    ]
      .map(cell)
      .join(','),
  );

  return ['\ufeff' + headers.map(cell).join(','), ...body].join('\r\n');
}

/** The filename a browser will save, safe on every OS (no Arabic, no spaces, no colons). */
export function manifestFilename(code: string, locale: 'ar' | 'en'): string {
  return `manifest-${code}-${locale}.csv`.replaceAll(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * The manifest, split into columns that each fit an A4 page.
 *
 * A 14-passenger manifest is one table; a 30-passenger one is not, and shrinking the font until it fits
 * is how a driver ends up squinting at six-point text at a checkpoint. The split is by *rows*, so each
 * column reads top-to-bottom in booking order — the way a conductor walks the aisle.
 *
 * `perColumn` is page geometry, not a design opinion: 28 rows at this font and row height fill the
 * printable height of A4 once the header, the vehicle block and the footer are accounted for.
 */
export function manifestColumns<T>(rows: readonly T[], perColumn = 28): readonly (readonly T[])[] {
  if (rows.length <= perColumn) return [rows];
  const columns: T[][] = [];
  for (let index = 0; index < rows.length; index += perColumn) {
    columns.push(rows.slice(index, index + perColumn));
  }
  return columns;
}

/** A row of the staff search, reduced to what an export needs. */
export interface StaffTripExportRow {
  readonly code: string;
  readonly departureAt: string;
  readonly origin: string;
  readonly destination: string;
  readonly operatorName: string | null;
  readonly seatsAvailable: number;
  readonly seatsTotal: number;
  readonly status: string;
  readonly verificationStatus: string;
}

/**
 * An instant, written as local Aden time with its offset: `2026-11-02T10:38:22+03:00`.
 *
 * Yemen is UTC+03:00 all year — no daylight saving, no political shifts since 1993 — so the offset is a
 * constant rather than a database lookup, and `Intl` supplies the wall-clock parts. This is deliberate:
 * a bare ISO string from the database is UTC, and a spreadsheet will happily read `07:38Z` as a 07:38
 * departure in a country where the bus left at 10:38.
 */
export function adenIso(instant: string | Date): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) return typeof instant === 'string' ? instant : '';

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Aden',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '00';

  return `${part('year')}-${part('month')}-${part('day')}T${part('hour') === '24' ? '00' : part('hour')}:${part('minute')}:${part('second')}+03:00`;
}

/**
 * The history export.
 *
 * The promise is that the file matches the screen: same rows, same order, same scope. It is generated
 * from the same `staff_search_trips` result the page renders — a separate query for the export is how a
 * CSV ends up disagreeing with the table a supervisor just approved.
 *
 * Times are ISO-8601 with the Aden offset. A local-time string without an offset is ambiguous the moment
 * the file leaves Yemen, and Excel will happily reinterpret it into the wrong day.
 */
export function staffTripsCsv(rows: readonly StaffTripExportRow[], locale: 'ar' | 'en'): string {
  const headers =
    locale === 'ar'
      ? [
          'رمز الرحلة',
          'الانطلاق',
          'من',
          'إلى',
          'المشغّل',
          'المقاعد المتاحة',
          'إجمالي المقاعد',
          'الحالة',
          'التوثيق',
        ]
      : [
          'Trip code',
          'Departure',
          'From',
          'To',
          'Operator',
          'Seats available',
          'Seats total',
          'Status',
          'Verification',
        ];

  const body = rows.map((row) =>
    [
      row.code,
      adenIso(row.departureAt),
      row.origin,
      row.destination,
      row.operatorName,
      row.seatsAvailable,
      row.seatsTotal,
      row.status,
      row.verificationStatus,
    ]
      .map(cell)
      .join(','),
  );

  return ['\ufeff' + headers.map(cell).join(','), ...body].join('\r\n');
}
