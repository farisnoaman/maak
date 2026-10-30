/**
 * Server-side geography loader.
 *
 * Reads only through RLS with the visitor's own cookie; no service role. A non-staff visitor gets
 * the public directory (regions and governorates are reference data) and an empty queue, because
 * `places_read_staff` is the only policy that reveals pending submissions.
 *
 * Supervisor scope is computed here with `supervisorScope()` from @maak/core — the same function the
 * edge and the tests use — rather than with a second SQL join that could disagree.
 */

import { supervisorScope, type RegionNode } from '@maak/core';
import type { AccountContext } from './account';
import { previewDirectory } from './preview-data';
import { getServerClient } from './supabase/server';
import type {
  GeoDirectory,
  GeoDistrict,
  GeoGovernorate,
  GeoPendingPlace,
  GeoPlaceOption,
  GeoRegion,
  GeoSupervisor,
  GeoUserOption,
} from './geo-types';

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function rows(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

/** `select` returns related rows as arrays; a single relation may come back as an object. */
function related<T>(value: unknown, pick: (row: Record<string, unknown>) => T): T[] {
  if (Array.isArray(value)) return value.map((row) => pick(row as Record<string, unknown>));
  if (value && typeof value === 'object') return [pick(value as Record<string, unknown>)];
  return [];
}

export async function loadGeoDirectory(context: AccountContext): Promise<GeoDirectory> {
  if (!context.configured) return previewDirectory;

  const client = await getServerClient();
  if (!client) return { ...previewDirectory, configured: true, supervisors: [], users: [] };

  const [governorateResult, districtResult, regionResult, pendingResult, placeResult] =
    await Promise.all([
      client
        .from('governorates')
        .select('id, code, name_ar, name_en, center_lat, center_lng')
        .eq('is_active', true)
        .order('name_ar', { ascending: true }),
      client
        .from('districts')
        .select('id, governorate_id, name_ar, name_en')
        .eq('is_active', true)
        .order('name_ar', { ascending: true }),
      client
        .from('regions')
        .select(
          'id, parent_id, kind, name_ar, name_en, region_governorates(governorate_id), region_districts(district_id)',
        )
        .eq('is_active', true)
        .order('name_ar', { ascending: true }),
      client
        .from('places')
        .select(
          'id, kind, name_ar, name_en, created_at, created_by, lat, lng, governorates(name_ar), districts(name_ar)',
        )
        .eq('verification_status', 'pending')
        .order('created_at', { ascending: true })
        .limit(100),
      client
        .from('places')
        .select(
          'id, kind, name_ar, name_en, governorate_id, district_id, aliases_ar, aliases_en, lat, lng, is_public',
        )
        .eq('is_active', true)
        .order('name_ar', { ascending: true })
        .limit(300),
    ]);

  const governorates: GeoGovernorate[] = rows(governorateResult.data).map((row) => ({
    id: String(row.id),
    code: String(row.code),
    nameAr: String(row.name_ar),
    nameEn: String(row.name_en),
    centerLat: num(row.center_lat),
    centerLng: num(row.center_lng),
  }));

  const districts: GeoDistrict[] = rows(districtResult.data).map((row) => ({
    id: String(row.id),
    governorateId: String(row.governorate_id),
    nameAr: String(row.name_ar),
    nameEn: String(row.name_en),
  }));

  const regions: GeoRegion[] = rows(regionResult.data).map((row) => ({
    id: String(row.id),
    parentId: text(row.parent_id),
    kind: row.kind === 'sub_region' ? 'sub_region' : 'region',
    nameAr: String(row.name_ar),
    nameEn: String(row.name_en),
    governorateIds: related(row.region_governorates, (item) => String(item.governorate_id)),
    districtIds: related(row.region_districts, (item) => String(item.district_id)),
  }));

  const places: GeoPlaceOption[] = rows(placeResult.data).map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    nameAr: String(row.name_ar),
    nameEn: text(row.name_en),
    governorateId: text(row.governorate_id),
    districtId: text(row.district_id),
    aliasesAr: Array.isArray(row.aliases_ar) ? (row.aliases_ar as string[]) : [],
    aliasesEn: Array.isArray(row.aliases_en) ? (row.aliases_en as string[]) : [],
    lat: num(row.lat),
    lng: num(row.lng),
    isPublic: row.is_public === true,
  }));

  const pendingPlaces: GeoPendingPlace[] = rows(pendingResult.data).map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    nameAr: String(row.name_ar),
    nameEn: text(row.name_en),
    governorateName: text(related(row.governorates, (item) => item.name_ar)[0]),
    districtName: text(related(row.districts, (item) => item.name_ar)[0]),
    submittedBy: text(row.created_by),
    createdAt: String(row.created_at),
    lat: num(row.lat),
    lng: num(row.lng),
  }));

  const isStaff = context.roles.some(
    (role) => role === 'platform_staff' || role === 'platform_admin',
  );
  if (!isStaff) {
    return {
      configured: true,
      governorates,
      districts,
      regions,
      places,
      pendingPlaces: [],
      supervisors: [],
      users: [],
    };
  }

  const [assignmentResult, userResult] = await Promise.all([
    client.from('geo_assignments').select('user_id, region_id').is('revoked_at', null),
    client
      .from('profiles')
      .select('id, full_name')
      .order('full_name', { ascending: true })
      .limit(200),
  ]);

  const users: GeoUserOption[] = rows(userResult.data).map((row) => ({
    id: String(row.id),
    name: text(row.full_name),
  }));
  const nameById = new Map(users.map((user) => [user.id, user.name]));

  const nodes: RegionNode[] = regions.map((region) => ({
    id: region.id,
    parentId: region.parentId,
    nameAr: region.nameAr,
    nameEn: region.nameEn,
    kind: region.kind,
    coverage: { governorateIds: region.governorateIds, districtIds: region.districtIds },
  }));

  const byUser = new Map<string, string[]>();
  for (const row of rows(assignmentResult.data)) {
    const userId = String(row.user_id);
    byUser.set(userId, [...(byUser.get(userId) ?? []), String(row.region_id)]);
  }

  const supervisors: GeoSupervisor[] = [...byUser.entries()].map(([userId, regionIds]) => ({
    userId,
    name: nameById.get(userId) ?? null,
    regionIds,
    districtCount: supervisorScope(nodes, regionIds, districts).length,
  }));

  return {
    configured: true,
    governorates,
    districts,
    regions,
    places,
    pendingPlaces,
    supervisors,
    users,
  };
}
