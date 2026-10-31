/**
 * Vehicle operations reads — health, the fleet rollup, and the thresholds behind both.
 *
 * These go through the session-bound wrappers (`fleet_summary`, `vehicle_health`) rather than SQL joins,
 * for one reason: the numbers on this screen must be the same numbers the trip gate and the reminder job
 * use. A page that sums `fuel_logs` itself is a second implementation of consumption, and the acceptance
 * criterion for Phase 8 is that the rollup *reconciles* with the logs.
 *
 * Everything is a preview shape when the database is not configured, so the preview environment shows a
 * working screen instead of an empty one — the same convention as `loadFleet`.
 */

import type { FleetExportRow } from '@maak/core';

import { getServerClient } from './supabase/server';
import type { AccountContext } from './account';

export type MaintenanceState = 'ok' | 'due_soon' | 'overdue';

export interface MaintenanceScheduleRow {
  readonly id: string;
  readonly kind: string;
  readonly intervalKm: number | null;
  readonly intervalDays: number | null;
  readonly lastDoneKm: number | null;
  readonly lastDoneOn: string | null;
  readonly dueKm: number | null;
  readonly dueOn: string | null;
  readonly state: MaintenanceState;
}

export interface MaintenanceRecordRow {
  readonly id: string;
  readonly scheduleId: string | null;
  readonly kind: string;
  readonly performedOn: string;
  readonly odometerKm: number | null;
  readonly costYer: number;
  readonly vendor: string | null;
  readonly note: string | null;
}

export interface FuelSegmentRow {
  readonly fromKm: number;
  readonly toKm: number;
  readonly distanceKm: number;
  readonly litres: number;
  readonly costYer: number;
  readonly lPer100Km: number | null;
  readonly costPerKmYer: number | null;
  readonly filledAt: string;
}

export interface VehicleHealth {
  readonly vehicle: {
    readonly id: string;
    readonly ownerUserId: string | null;
    readonly ownerOrgId: string | null;
    readonly make: string;
    readonly model: string;
    readonly plateNumber: string;
    readonly fuelType: string;
    readonly tankLitres: number | null;
    readonly odometerKm: number;
    readonly status: string;
    readonly verificationStatus: string;
  };
  readonly maintenance: {
    readonly state: MaintenanceState;
    readonly nextDueKm: number | null;
    readonly nextDueOn: string | null;
    readonly dueCount: number;
    readonly overdueCount: number;
    readonly schedules: readonly MaintenanceScheduleRow[];
    readonly recentRecords: readonly MaintenanceRecordRow[];
    readonly computedAt: string | null;
  };
  readonly fuel: {
    readonly lastLog: {
      readonly id: string;
      readonly filledAt: string;
      readonly odometerKm: number;
      readonly litres: number;
      readonly pricePerLitreYer: number;
      readonly totalCostYer: number;
      readonly isFullTank: boolean;
      readonly stationName: string | null;
    } | null;
    readonly recentLPer100Km: number | null;
    readonly lifetimeLPer100Km: number | null;
    readonly lifetimeCostYer: number;
    readonly lifetimeDistanceKm: number;
    readonly costPerKmYer: number | null;
    readonly segments: readonly FuelSegmentRow[];
  };
  readonly expenses: {
    readonly monthTotalYer: number;
    readonly byCategory: Readonly<Record<string, number>>;
  };
  readonly thresholds: FleetThresholds;
}

export interface FleetThresholds {
  readonly remindKm: number;
  readonly remindDays: number;
  readonly blockOverdueAssignment: boolean;
  readonly fuelAnomalyPercent: number;
}

export interface FleetSummaryRow {
  readonly id: string;
  readonly make: string;
  readonly model: string;
  readonly plateNumber: string;
  readonly status: string;
  readonly verificationStatus: string;
  readonly odometerKm: number;
  readonly maintenanceState: MaintenanceState;
  readonly dueCount: number;
  readonly overdueCount: number;
  readonly nextDueKm: number | null;
  readonly nextDueOn: string | null;
  readonly recentLPer100Km: number | null;
  readonly monthFuelYer: number;
  readonly monthMaintenanceYer: number;
}

export interface FleetSummary {
  readonly configured: boolean;
  readonly vehicles: readonly FleetSummaryRow[];
  readonly totals: {
    readonly vehicles: number;
    readonly active: number;
    readonly dueSoon: number;
    readonly overdue: number;
    readonly monthFuelYer: number;
    readonly monthMaintenanceYer: number;
  };
}

const EMPTY_TOTALS = {
  vehicles: 0,
  active: 0,
  dueSoon: 0,
  overdue: 0,
  monthFuelYer: 0,
  monthMaintenanceYer: 0,
} as const;

export const EMPTY_SUMMARY: FleetSummary = {
  configured: true,
  vehicles: [],
  totals: EMPTY_TOTALS,
};

/** `jsonb` numbers arrive as numbers, but a `numeric` column can arrive as a string. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: unknown, fallback = 0): number {
  return num(value) ?? fallback;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The preview fleet — one healthy van, one that needs attention.
 *
 * Written out rather than generated so the screen shows the *shape* of the feature in the preview
 * environment: the badges, the reconciliation line and the drill-down all render.
 */
function previewSummary(): FleetSummary {
  return {
    configured: false,
    vehicles: [
      {
        id: 'preview-vehicle-1',
        make: 'Toyota',
        model: 'Hiace',
        plateNumber: '5-9001',
        status: 'active',
        verificationStatus: 'verified',
        odometerKm: 125_300,
        maintenanceState: 'overdue',
        dueCount: 0,
        overdueCount: 1,
        nextDueKm: 125_000,
        nextDueOn: null,
        recentLPer100Km: 8.44,
        monthFuelYer: 38_000,
        monthMaintenanceYer: 4_500,
      },
      {
        id: 'preview-vehicle-2',
        make: 'Hyundai',
        model: 'County',
        plateNumber: '2-4417',
        status: 'active',
        verificationStatus: 'verified',
        odometerKm: 88_120,
        maintenanceState: 'ok',
        dueCount: 0,
        overdueCount: 0,
        nextDueKm: 90_000,
        nextDueOn: null,
        recentLPer100Km: 11.2,
        monthFuelYer: 21_500,
        monthMaintenanceYer: 0,
      },
    ],
    totals: {
      vehicles: 2,
      active: 2,
      dueSoon: 0,
      overdue: 1,
      monthFuelYer: 59_500,
      monthMaintenanceYer: 4_500,
    },
  };
}

function parseSummary(payload: unknown, configured: boolean): FleetSummary {
  const body = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(body.vehicles) ? body.vehicles : [];
  const vehicles: FleetSummaryRow[] = rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      make: String(row.make ?? ''),
      model: String(row.model ?? ''),
      plateNumber: String(row.plateNumber ?? ''),
      status: String(row.status ?? ''),
      verificationStatus: String(row.verificationStatus ?? ''),
      odometerKm: int(row.odometerKm),
      maintenanceState: (row.maintenanceState as MaintenanceState) ?? 'ok',
      dueCount: int(row.dueCount),
      overdueCount: int(row.overdueCount),
      nextDueKm: num(row.nextDueKm),
      nextDueOn: str(row.nextDueOn),
      recentLPer100Km: num(row.recentLPer100Km),
      monthFuelYer: int(row.monthFuelYer),
      monthMaintenanceYer: int(row.monthMaintenanceYer),
    };
  });

  const totals = (body.totals ?? {}) as Record<string, unknown>;
  return {
    configured,
    vehicles,
    totals: {
      vehicles: int(totals.vehicles, vehicles.length),
      active: int(totals.active),
      dueSoon: int(totals.dueSoon),
      overdue: int(totals.overdue),
      monthFuelYer: int(totals.monthFuelYer),
      monthMaintenanceYer: int(totals.monthMaintenanceYer),
    },
  };
}

/** The rollup for one context: the actor's own vehicles, or one organization's. */
export async function loadFleetSummary(
  context: AccountContext,
  orgId: string | null,
): Promise<FleetSummary> {
  if (!context.configured) return previewSummary();
  if (!context.user) return EMPTY_SUMMARY;

  const client = await getServerClient();
  if (!client) return EMPTY_SUMMARY;

  const { data, error } = await client.rpc('fleet_summary', { p_org_id: orgId });
  if (error || !data) return EMPTY_SUMMARY;
  return parseSummary(data, true);
}

function parseHealth(payload: unknown): VehicleHealth {
  const body = (payload ?? {}) as Record<string, unknown>;
  const vehicle = (body.vehicle ?? {}) as Record<string, unknown>;
  const maintenance = (body.maintenance ?? {}) as Record<string, unknown>;
  const fuel = (body.fuel ?? {}) as Record<string, unknown>;
  const expenses = (body.expenses ?? {}) as Record<string, unknown>;
  const thresholds = (body.thresholds ?? {}) as Record<string, unknown>;

  const schedules = Array.isArray(maintenance.schedules) ? maintenance.schedules : [];
  const records = Array.isArray(maintenance.recentRecords) ? maintenance.recentRecords : [];
  const segments = Array.isArray(fuel.segments) ? fuel.segments : [];
  const lastLog = fuel.lastLog as Record<string, unknown> | null | undefined;
  const byCategory = (expenses.byCategory ?? {}) as Record<string, unknown>;

  return {
    vehicle: {
      id: String(vehicle.id ?? ''),
      ownerUserId: str(vehicle.ownerUserId),
      ownerOrgId: str(vehicle.ownerOrgId),
      make: String(vehicle.make ?? ''),
      model: String(vehicle.model ?? ''),
      plateNumber: String(vehicle.plateNumber ?? ''),
      fuelType: String(vehicle.fuelType ?? ''),
      tankLitres: num(vehicle.tankLitres),
      odometerKm: int(vehicle.odometerKm),
      status: String(vehicle.status ?? ''),
      verificationStatus: String(vehicle.verificationStatus ?? ''),
    },
    maintenance: {
      state: (maintenance.state as MaintenanceState) ?? 'ok',
      nextDueKm: num(maintenance.nextDueKm),
      nextDueOn: str(maintenance.nextDueOn),
      dueCount: int(maintenance.dueCount),
      overdueCount: int(maintenance.overdueCount),
      computedAt: str(maintenance.computedAt),
      schedules: schedules.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.id),
          kind: String(row.kind ?? ''),
          intervalKm: num(row.intervalKm),
          intervalDays: num(row.intervalDays),
          lastDoneKm: num(row.lastDoneKm),
          lastDoneOn: str(row.lastDoneOn),
          dueKm: num(row.dueKm),
          dueOn: str(row.dueOn),
          state: (row.state as MaintenanceState) ?? 'ok',
        };
      }),
      recentRecords: records.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.id),
          scheduleId: str(row.scheduleId),
          kind: String(row.kind ?? ''),
          performedOn: String(row.performedOn ?? ''),
          odometerKm: num(row.odometerKm),
          costYer: int(row.costYer),
          vendor: str(row.vendor),
          note: str(row.note),
        };
      }),
    },
    fuel: {
      lastLog: lastLog
        ? {
            id: String(lastLog.id),
            filledAt: String(lastLog.filledAt ?? ''),
            odometerKm: int(lastLog.odometerKm),
            litres: num(lastLog.litres) ?? 0,
            pricePerLitreYer: int(lastLog.pricePerLitreYer),
            totalCostYer: int(lastLog.totalCostYer),
            isFullTank: lastLog.isFullTank !== false,
            stationName: str(lastLog.stationName),
          }
        : null,
      recentLPer100Km: num(fuel.recentLPer100Km),
      lifetimeLPer100Km: num(fuel.lifetimeLPer100Km),
      lifetimeCostYer: int(fuel.lifetimeCostYer),
      lifetimeDistanceKm: int(fuel.lifetimeDistanceKm),
      costPerKmYer: num(fuel.costPerKmYer),
      segments: segments.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          fromKm: int(row.fromKm),
          toKm: int(row.toKm),
          distanceKm: int(row.distanceKm),
          litres: num(row.litres) ?? 0,
          costYer: int(row.costYer),
          lPer100Km: num(row.lPer100Km),
          costPerKmYer: num(row.costPerKmYer),
          filledAt: String(row.filledAt ?? ''),
        };
      }),
    },
    expenses: {
      monthTotalYer: int(expenses.monthTotalYer),
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([key, value]) => [key, int(value)]),
      ),
    },
    thresholds: {
      remindKm: int(thresholds.remindKm, 500),
      remindDays: int(thresholds.remindDays, 14),
      blockOverdueAssignment: thresholds.blockOverdueAssignment === true,
      fuelAnomalyPercent: int(thresholds.fuelAnomalyPercent, 25),
    },
  };
}

export async function loadVehicleHealth(vehicleId: string): Promise<VehicleHealth | null> {
  const client = await getServerClient();
  if (!client) return null;

  const { data, error } = await client.rpc('vehicle_health', { p_vehicle_id: vehicleId });
  if (error || !data) return null;
  return parseHealth(data);
}

/**
 * The settings row as stored, or the defaults.
 *
 * Read straight from the table rather than through a wrapper: thresholds are not a derived number, and
 * RLS already says only the owner sees their own row.
 */
export async function loadFleetSettings(
  orgId: string | null,
  userId: string | null,
): Promise<FleetThresholds> {
  const fallback: FleetThresholds = {
    remindKm: 500,
    remindDays: 14,
    blockOverdueAssignment: false,
    fuelAnomalyPercent: 25,
  };
  if (!userId && !orgId) return fallback;

  const client = await getServerClient();
  if (!client) return fallback;

  const query = client
    .from('fleet_settings')
    .select('remind_km, remind_days, block_overdue_assignment, fuel_anomaly_percent');
  const { data } = await (
    orgId ? query.eq('owner_org_id', orgId) : query.eq('owner_user_id', userId!)
  ).maybeSingle();

  const row = data as Record<string, unknown> | null;
  if (!row) return fallback;
  return {
    remindKm: int(row.remind_km, 500),
    remindDays: int(row.remind_days, 14),
    blockOverdueAssignment: row.block_overdue_assignment === true,
    fuelAnomalyPercent: int(row.fuel_anomaly_percent, 25),
  };
}

export function toExportRows(rows: readonly FleetSummaryRow[]): readonly FleetExportRow[] {
  return rows.map((row) => ({
    plateNumber: row.plateNumber,
    make: row.make,
    model: row.model,
    odometerKm: row.odometerKm,
    state: row.maintenanceState,
    nextDueKm: row.nextDueKm,
    nextDueOn: row.nextDueOn,
    recentLPer100Km: row.recentLPer100Km,
    monthFuelYer: row.monthFuelYer,
    monthMaintenanceYer: row.monthMaintenanceYer,
  }));
}
