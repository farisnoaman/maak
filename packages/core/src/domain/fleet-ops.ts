/**
 * Vehicle operations: the arithmetic a screen does, and the file it produces.
 *
 * The *decisions* live in SQL — whether a vehicle is due, whether a fill is an anomaly, whether the
 * odometer may go backwards — because the trip gate and the reminder job have to make the same call
 * without a browser. What lives here is the mirror a screen needs to *explain* a decision: the same
 * division, the same reminder window, the same day in Aden. Both are tested (Vitest here, pgTAP there)
 * so the two cannot quietly disagree.
 */

import type { TranslationKey } from '../i18n/dictionaries';
import type { Locale } from '../i18n/locale';

/**
 * Litres per 100 km — the figure the plan's acceptance criterion is stated in.
 *
 * `null` rather than `NaN`/`Infinity` when there is no distance: a segment of 0 km is not "infinitely
 * thirsty", it is a fill-up at the same pump, and a card showing `∞ L/100km` would be a bug report.
 */
export function lPer100Km(litres: number, distanceKm: number): number | null {
  if (!Number.isFinite(litres) || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  return round2((litres * 100) / distanceKm);
}

/** Kilometres per litre — the unit Yemeni owners actually quote. */
export function kmPerLitre(distanceKm: number, litres: number): number | null {
  if (!Number.isFinite(litres) || !Number.isFinite(distanceKm) || litres <= 0) return null;
  return round2(distanceKm / litres);
}

/** Fils per kilometre, for comparing a van against the cost of hiring one. */
export function costPerKm(costYer: number, distanceKm: number): number | null {
  if (!Number.isFinite(costYer) || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  return round2(costYer / distanceKm);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Is this tank-to-tank figure far enough above the average to be worth asking about?
 *
 * Mirrors `app.fleet_thresholds(...).fuel_anomaly_percent` handling in `cmd_log_fuel`: strictly above
 * baseline × (1 + pct/100). A van at 8.4 that suddenly drinks 12 is usually a soft tyre or a leak, and
 * the point is to ask, not to refuse the receipt.
 */
export function isFuelAnomaly(
  newestLPer100Km: number | null,
  baselineLPer100Km: number | null,
  percent = 25,
): boolean {
  if (newestLPer100Km == null || baselineLPer100Km == null) return false;
  if (baselineLPer100Km <= 0) return false;
  return newestLPer100Km > baselineLPer100Km * (1 + percent / 100);
}

/** Today's date in Aden as `YYYY-MM-DD`. Yemen has no DST, but "today" must not be UTC's today. */
export function todayInAden(now: Date = new Date()): string {
  // `en-CA` formats as YYYY-MM-DD, which is the shape every `<input type="date">` wants.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Aden' }).format(now);
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative when `to` is in the past. */
export function daysBetween(from: string, to: string): number | null {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Parses `YYYY-MM-DD` as UTC midnight — a calendar day, not an instant in the viewer's zone. */
function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * How many kilometres until the schedule is due. Negative once overdue, `null` for a date-only rule.
 *
 * Used for the "in 400 km" line under a badge; the badge itself comes from the server's state.
 */
export function kmUntilDue(dueKm: number | null, odometerKm: number): number | null {
  if (dueKm == null) return null;
  return dueKm - odometerKm;
}

/**
 * A due point computed the way the generated column does: last done + interval.
 *
 * Exported for the schedule form's live preview. The database re-computes it, so a client that gets
 * this wrong cannot corrupt a row — it just shows the wrong "will be due at" until it saves.
 */
export function nextDueKm(lastDoneKm: number | null, intervalKm: number | null): number | null {
  if (lastDoneKm == null || intervalKm == null) return null;
  return lastDoneKm + intervalKm;
}

/** One row of the fleet export. Deliberately flat: a spreadsheet is not a JSON viewer. */
export interface FleetExportRow {
  readonly plateNumber: string;
  readonly make: string;
  readonly model: string;
  readonly odometerKm: number;
  readonly state: string;
  readonly nextDueKm: number | null;
  readonly nextDueOn: string | null;
  readonly recentLPer100Km: number | null;
  readonly monthFuelYer: number;
  readonly monthMaintenanceYer: number;
}

function cell(value: string | number | null): string {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * The fleet rollup as CSV.
 *
 * Same three concessions as the manifest (`manifestCsv`): a UTF-8 BOM so Windows Excel does not open
 * Arabic as mojibake, CRLF, and every cell quoted so a plate like `5-9001` and a phone-like code stay
 * text. The numeric columns stay unformatted — a spreadsheet wants `8.44`, not `8.44 L/100km`.
 */
export function fleetCsv(rows: readonly FleetExportRow[], locale: Locale): string {
  const headers =
    locale === 'ar'
      ? [
          'اللوحة',
          'الصنع',
          'الطراز',
          'العداد (كم)',
          'حالة الصيانة',
          'الاستحقاق (كم)',
          'الاستحقاق (تاريخ)',
          'الاستهلاك (ل/100كم)',
          'وقود الشهر (ر.ي)',
          'صيانة الشهر (ر.ي)',
        ]
      : [
          'Plate',
          'Make',
          'Model',
          'Odometer (km)',
          'Maintenance',
          'Due (km)',
          'Due (date)',
          'Consumption (L/100km)',
          'Fuel this month (YER)',
          'Maintenance this month (YER)',
        ];

  const state =
    locale === 'ar'
      ? { ok: 'سليمة', due_soon: 'قريبة', overdue: 'متأخرة' }
      : { ok: 'ok', due_soon: 'due soon', overdue: 'overdue' };

  const body = rows.map((row) =>
    [
      cell(row.plateNumber),
      cell(row.make),
      cell(row.model),
      cell(row.odometerKm),
      cell(state[row.state as keyof typeof state] ?? row.state),
      cell(row.nextDueKm),
      cell(row.nextDueOn),
      cell(row.recentLPer100Km),
      cell(row.monthFuelYer),
      cell(row.monthMaintenanceYer),
    ].join(','),
  );

  return ['\ufeff' + headers.map(cell).join(','), ...body].join('\r\n');
}

/** A filename that survives every OS and does not need the locale in it. */
export function fleetFilename(stamp: string): string {
  return `fleet-${stamp}`.replaceAll(/[^A-Za-z0-9._-]/g, '-') + '.csv';
}

/**
 * Labels for the enums the database owns.
 *
 * `Record<string, TranslationKey>` rather than a union: the web app receives `kind` as a string from
 * `jsonb`, and a lookup that has to be narrowed first is a lookup somebody forgets to narrow. An
 * unrecognised value falls through to the raw code, which is ugly but not wrong.
 */
export const MAINTENANCE_KIND_KEY: Record<string, TranslationKey> = {
  oil_change: 'fleetOps.kind.oil',
  oil_filter: 'fleetOps.kind.oilFilter',
  air_filter: 'fleetOps.kind.airFilter',
  fuel_filter: 'fleetOps.kind.fuelFilter',
  cabin_filter: 'fleetOps.kind.cabinFilter',
  tyres: 'fleetOps.kind.tyres',
  brakes: 'fleetOps.kind.brakes',
  battery: 'fleetOps.kind.battery',
  timing_belt: 'fleetOps.kind.timingBelt',
  coolant: 'fleetOps.kind.coolant',
  transmission: 'fleetOps.kind.transmission',
  suspension: 'fleetOps.kind.suspension',
  electrical: 'fleetOps.kind.electrical',
  bodywork: 'fleetOps.kind.bodywork',
  inspection: 'fleetOps.kind.inspection',
  other: 'fleetOps.kind.other',
};

export const MAINTENANCE_STATE_KEY: Record<string, TranslationKey> = {
  ok: 'fleetOps.stateOk',
  due_soon: 'fleetOps.stateDueSoon',
  overdue: 'fleetOps.stateOverdue',
};

export const EXPENSE_CATEGORY_KEY: Record<string, TranslationKey> = {
  fuel: 'fleetOps.category.fuel',
  maintenance: 'fleetOps.category.maintenance',
  insurance: 'fleetOps.category.insurance',
  registration: 'fleetOps.category.registration',
  permit: 'fleetOps.category.permit',
  salary: 'fleetOps.category.salary',
  toll: 'fleetOps.category.toll',
  parking: 'fleetOps.category.parking',
  fine: 'fleetOps.category.fine',
  other: 'fleetOps.category.other',
};
