/**
 * Geography commands — the shared contract between UI, edge function and tests (Phase 2).
 *
 * One edge function (`geography`) dispatches on `action`. Every branch below maps to exactly one
 * `cmd_*` function in migration 00010, so the write surface is still one call per request.
 *
 * `searchPlacesInputSchema` is the *read* side: it talks to the `search_places` RPC, which is the
 * only geography function a client may execute directly.
 */

import { z } from 'zod';

const uuid = z.string().uuid();

export const regionKindSchema = z.enum(['region', 'sub_region']);

export const placeKindSchema = z.enum([
  'city',
  'town',
  'village',
  'district_centre',
  'landmark',
  'station',
  'airport',
  'port',
  'border_crossing',
  'market',
  'hospital',
  'gathering_point',
  'other',
]);

export const upsertRegionSchema = z
  .object({
    action: z.literal('region.upsert'),
    /** Absent = create. Present = replace the region and its whole coverage. */
    regionId: uuid.optional(),
    parentId: uuid.nullish(),
    kind: regionKindSchema.default('region'),
    nameAr: z.string().trim().min(2).max(120),
    nameEn: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).optional(),
    governorateIds: z.array(uuid).max(22).default([]),
    districtIds: z.array(uuid).max(333).default([]),
  })
  .refine((value) => value.governorateIds.length + value.districtIds.length > 0, {
    message: 'a region must cover at least one governorate or district',
    path: ['governorateIds'],
  });

export const assignSupervisorSchema = z.object({
  action: z.literal('geo.assignSupervisor'),
  userId: uuid,
  /** The complete list: anything not listed is revoked. */
  regionIds: z.array(uuid).min(1).max(50),
  reason: z.string().trim().max(500).optional(),
});

export const revokeSupervisorSchema = z.object({
  action: z.literal('geo.revokeSupervisor'),
  userId: uuid,
  reason: z.string().trim().max(500).optional(),
});

export const importGeoRowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

export const importGeoSchema = z.object({
  action: z.literal('geo.import'),
  kind: z.enum(['governorates', 'districts']),
  /** Defaults to true: an import that writes by default is a foot-gun. */
  dryRun: z.boolean().default(true),
  rows: z.array(importGeoRowSchema).min(1).max(2000),
});

export const createPlaceSchema = z
  .object({
    action: z.literal('place.create'),
    kind: placeKindSchema,
    nameAr: z.string().trim().min(3).max(120),
    nameEn: z.string().trim().min(2).max(120).optional(),
    governorateId: uuid.nullish(),
    districtId: uuid.nullish(),
    lat: z.number().min(-90).max(90).nullish(),
    lng: z.number().min(-180).max(180).nullish(),
    aliasesAr: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
    aliasesEn: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
    /** Set for a company-owned gathering point; ignored for staff-created reference places. */
    orgId: uuid.nullish(),
  })
  .refine((value) => (value.lat == null) === (value.lng == null), {
    message: 'latitude and longitude must be given together',
    path: ['lat'],
  });

export const decidePlaceSchema = z
  .object({
    action: z.literal('place.decide'),
    placeId: uuid,
    outcome: z.enum(['approve', 'reject']),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((value) => value.outcome === 'approve' || (value.reason?.length ?? 0) >= 10, {
    message: 'a rejection needs a reason of at least 10 characters',
    path: ['reason'],
  });

export const setRegionActiveSchema = z.object({
  action: z.literal('region.setActive'),
  regionId: uuid,
  active: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

export const setPlaceActiveSchema = z.object({
  action: z.literal('place.setActive'),
  placeId: uuid,
  active: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

export const geoActionSchema = z.discriminatedUnion('action', [
  upsertRegionSchema,
  assignSupervisorSchema,
  revokeSupervisorSchema,
  importGeoSchema,
  createPlaceSchema,
  decidePlaceSchema,
  setRegionActiveSchema,
  setPlaceActiveSchema,
]);

export type GeoAction = z.infer<typeof geoActionSchema>;
export type GeoActionName = GeoAction['action'];
export type UpsertRegionInput = z.infer<typeof upsertRegionSchema>;
export type CreatePlaceInput = z.infer<typeof createPlaceSchema>;
export type DecidePlaceInput = z.infer<typeof decidePlaceSchema>;

export const geoResultSchema = z.looseObject({ requestId: z.string().optional() });
export type GeoResult = z.infer<typeof geoResultSchema>;

export const geoCommandSpec = {
  path: 'geography',
  input: geoActionSchema,
  output: geoResultSchema,
  mutating: true,
} as const;

/**
 * The read side. Mirrors `public.search_places` exactly (limit clamped 1–50, locale-aware names),
 * so a client-side validation failure never reaches the database.
 */
export const searchPlacesInputSchema = z.object({
  query: z.string().trim().max(120).default(''),
  locale: z.enum(['ar', 'en']).default('ar'),
  governorateId: uuid.nullish(),
  districtId: uuid.nullish(),
  kind: placeKindSchema.nullish(),
  limit: z.number().int().min(1).max(50).default(20),
});

export type SearchPlacesInput = z.infer<typeof searchPlacesInputSchema>;

export interface PlaceSearchResult {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly governorateId: string | null;
  readonly governorateName: string | null;
  readonly districtId: string | null;
  readonly districtName: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly isPublic: boolean;
  readonly score: number;
}

/** Shapes a PostgREST row from `search_places` into the client contract. */
export function toPlaceSearchResult(row: Record<string, unknown>): PlaceSearchResult {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const optional = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);

  return {
    id: text(row.id),
    kind: text(row.kind),
    name: text(row.name),
    nameAr: text(row.name_ar),
    nameEn: text(row.name_en),
    governorateId: optional(row.governorate_id),
    governorateName: optional(row.governorate_name),
    districtId: optional(row.district_id),
    districtName: optional(row.district_name),
    lat: num(row.lat),
    lng: num(row.lng),
    isPublic: row.is_public === true,
    score: num(row.score) ?? 0,
  };
}

/** Command → Postgres argument name map. Kept here so UI, edge and tests cannot drift. */
export function geoCommandArgs(
  action: GeoAction,
  actorId: string,
  audit: {
    readonly p_request_id: string;
    readonly p_ip: string | null;
  },
): { fn: string; args: Record<string, unknown> } {
  switch (action.action) {
    case 'region.upsert':
      return {
        fn: 'cmd_upsert_region',
        args: {
          p_actor: actorId,
          p_region_id: action.regionId ?? null,
          p_parent_id: action.parentId ?? null,
          p_kind: action.kind,
          p_name_ar: action.nameAr,
          p_name_en: action.nameEn,
          p_description: action.description ?? null,
          p_governorate_ids: action.governorateIds,
          p_district_ids: action.districtIds,
          ...audit,
        },
      };
    case 'geo.assignSupervisor':
      return {
        fn: 'cmd_assign_geo_supervisor',
        args: {
          p_actor: actorId,
          p_user_id: action.userId,
          p_region_ids: action.regionIds,
          p_reason: action.reason ?? null,
          ...audit,
        },
      };
    case 'geo.revokeSupervisor':
      return {
        fn: 'cmd_revoke_geo_supervisor',
        args: {
          p_actor: actorId,
          p_user_id: action.userId,
          p_reason: action.reason ?? null,
          ...audit,
        },
      };
    case 'geo.import':
      return {
        fn: 'cmd_import_geo',
        args: {
          p_actor: actorId,
          p_kind: action.kind,
          p_rows: action.rows,
          p_dry_run: action.dryRun,
          ...audit,
        },
      };
    case 'place.create':
      return {
        fn: 'cmd_create_place',
        args: {
          p_actor: actorId,
          p_kind: action.kind,
          p_name_ar: action.nameAr,
          p_name_en: action.nameEn ?? null,
          p_governorate_id: action.governorateId ?? null,
          p_district_id: action.districtId ?? null,
          p_lat: action.lat ?? null,
          p_lng: action.lng ?? null,
          p_aliases_ar: action.aliasesAr,
          p_aliases_en: action.aliasesEn,
          p_org_id: action.orgId ?? null,
          ...audit,
        },
      };
    case 'region.setActive':
      return {
        fn: 'cmd_set_region_active',
        args: {
          p_actor: actorId,
          p_region_id: action.regionId,
          p_active: action.active,
          p_reason: action.reason ?? null,
          ...audit,
        },
      };
    case 'place.setActive':
      return {
        fn: 'cmd_set_place_active',
        args: {
          p_actor: actorId,
          p_place_id: action.placeId,
          p_active: action.active,
          p_reason: action.reason ?? null,
          ...audit,
        },
      };
    case 'place.decide':
      return {
        fn: 'cmd_decide_place',
        args: {
          p_actor: actorId,
          p_place_id: action.placeId,
          p_outcome: action.outcome,
          p_reason: action.reason ?? null,
          ...audit,
        },
      };
  }
}
