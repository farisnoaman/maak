/**
 * Geography and place search — the pure rules (Phase 2).
 *
 * Two decisions worth stating up front, because they shape everything else:
 *
 *  1. **Scope is relational, not geometric.** A geo supervisor's scope is a *set of districts*
 *     (expanded from the regions they are assigned to). That is an indexed join, it is trivial to
 *     test, and it cannot be defeated by a bad polygon. Geometry is for maps and distance, and lands
 *     with live tracking (Phase 6).
 *  2. **Arabic is normalised before it is compared.** «عدن» / «عَدَن» / «عدن» with a stray alef
 *     variant must be the same string. The same function is mirrored in SQL
 *     (`app.normalize_arabic`), and a test pins both to the same expectations.
 */

/** Diacritics (harakat), tatweel and the alef/teh-marbuta/alef-maqsura variants. */
type Replacement = string | ((match: string) => string);

const ARABIC_MAP: ReadonlyArray<readonly [RegExp, Replacement]> = [
  [/[\u0623\u0625\u0622\u0671]/g, '\u0627'], // أ إ آ ٱ → ا
  [/\u0629/g, '\u0647'], // ة → ه
  [/[\u0649\u064A]/g, '\u064A'], // ى → ي (also folds ي to itself)
  [/\u0624/g, '\u0648'], // ؤ → و
  [/\u0626/g, '\u064A'], // ئ → ي
  [/[\u064B-\u0652]/g, ''], // harakat
  [/\u0640/g, ''], // tatweel
  [/[\u0660-\u0669]/g, (match) => String(match.charCodeAt(0) - 0x0660)], // ٠١٢… → 012…
  [/[\u06F0-\u06F9]/g, (match) => String(match.charCodeAt(0) - 0x06f0)], // ۰۱۲… → 012…
];

/**
 * Folds Arabic text to a comparison key: no diacritics, unified alef/teh-marbuta/alef-maqsura,
 * Western digits, single spaces, lower-case Latin.
 *
 * This must stay byte-for-byte compatible with `app.normalize_arabic` in migration 00008.
 */
export function normalizeArabic(input: string | null | undefined): string {
  if (!input) return '';
  let text = input.trim().toLowerCase();
  for (const [pattern, replacement] of ARABIC_MAP) {
    text =
      typeof replacement === 'string'
        ? text.replace(pattern, replacement)
        : text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, ' ').trim();
}

export type RegionKind = 'region' | 'sub_region';

export type PlaceKind =
  | 'city'
  | 'town'
  | 'village'
  | 'district_centre'
  | 'landmark'
  | 'station'
  | 'airport'
  | 'port'
  | 'border_crossing'
  | 'market'
  | 'hospital'
  | 'gathering_point'
  | 'other';

/** Kinds an ordinary user may create (they become a *custom gathering point*, pending review). */
export const USER_CREATABLE_KINDS: readonly PlaceKind[] = ['gathering_point', 'landmark', 'other'];

export interface GovernorateRef {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly centerLat?: number | null;
  readonly centerLng?: number | null;
}

export interface DistrictRef {
  readonly id: string;
  readonly governorateId: string;
  readonly pcode?: string | null;
  readonly nameAr: string;
  readonly nameEn: string;
}

export interface PlaceRef {
  readonly id: string;
  readonly kind: PlaceKind;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly aliasesAr?: readonly string[];
  readonly aliasesEn?: readonly string[];
  readonly governorateId: string | null;
  readonly districtId: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly isPublic: boolean;
  readonly createdBy?: string | null;
}

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

/**
 * Match quality, 0–100. Deterministic and shared by the SQL planner and the client, so a list does
 * not reorder itself between the optimistic render and the server answer.
 */
export function scorePlace(query: string, place: PlaceRef): number {
  const q = normalizeArabic(query);
  if (!q) return 0;

  const candidates = [
    place.nameAr,
    place.nameEn ?? '',
    ...(place.aliasesAr ?? []),
    ...(place.aliasesEn ?? []),
  ]
    .map(normalizeArabic)
    .filter(Boolean);

  let best = 0;
  for (const candidate of candidates) {
    if (candidate === q) best = Math.max(best, 100);
    else if (candidate.startsWith(q)) best = Math.max(best, 80);
    else if (candidate.includes(q)) best = Math.max(best, 60);
    else if (q.length >= 3 && trigramSimilarity(candidate, q) >= 0.4) {
      best = Math.max(best, Math.round(trigramSimilarity(candidate, q) * 55));
    }
  }

  // A city beats a bus stop at equal text quality: it is what people mean most of the time.
  const KIND_WEIGHT: Partial<Record<PlaceKind, number>> = {
    city: 6,
    district_centre: 4,
    town: 3,
    landmark: 2,
    station: 1,
    airport: 1,
    port: 1,
    border_crossing: 1,
    market: 1,
    hospital: 1,
  };
  // The kind weight is added *after* capping the text score, so it can never be swallowed by the
  // 100 ceiling — otherwise a city and a bus stop with the same name would tie.
  return best === 0 ? 0 : best + (KIND_WEIGHT[place.kind] ?? 0);
}

/** Jaccard similarity over character trigrams — the same shape as pg_trgm's `similarity()`. */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (value: string): Set<string> => {
    const padded = `  ${normalizeArabic(value)} `;
    const set = new Set<string>();
    for (let i = 0; i < padded.length - 2; i += 1) set.add(padded.slice(i, i + 3));
    return set;
  };
  const left = grams(a);
  const right = grams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export interface SearchFilters {
  readonly governorateId?: string | null;
  readonly districtId?: string | null;
  readonly kind?: PlaceKind | null;
  readonly limit?: number;
}

/**
 * Applies the filters the picker offers, then ranks. Mirrors `public.search_places` so the same
 * ordering can be asserted on both sides.
 */
export function rankPlaces(
  query: string,
  places: readonly PlaceRef[],
  filters: SearchFilters = {},
): PlaceRef[] {
  const limit = filters.limit ?? 20;
  return places
    .filter((place) => {
      if (filters.governorateId && place.governorateId !== filters.governorateId) return false;
      if (filters.districtId && place.districtId !== filters.districtId) return false;
      if (filters.kind && place.kind !== filters.kind) return false;
      return true;
    })
    .map((place) => ({ place, score: scorePlace(query, place) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        normalizeArabic(a.place.nameAr).localeCompare(normalizeArabic(b.place.nameAr), 'ar'),
    )
    .slice(0, limit)
    .map((entry) => entry.place);
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371.0088;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance. Used for «now at X, 12 km from the nearest stop» (Phase 6). */
export function haversineKm(from: GeoPoint, to: GeoPoint): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isValidLatitude(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

/** Rough bounding box for Yemen — a sanity check against swapped lat/lng and stray zeros. */
export const YEMEN_BOUNDS = {
  minLat: 12.0,
  maxLat: 19.1,
  minLng: 41.5,
  maxLng: 54.6,
} as const;

export function isWithinYemen(point: GeoPoint): boolean {
  return (
    point.lat >= YEMEN_BOUNDS.minLat &&
    point.lat <= YEMEN_BOUNDS.maxLat &&
    point.lng >= YEMEN_BOUNDS.minLng &&
    point.lng <= YEMEN_BOUNDS.maxLng
  );
}

/** 「١٤ كم」 / 「14 km」 — one decimal below 10 km, whole numbers above. */
export function formatDistanceKm(km: number, locale: 'ar' | 'en'): string {
  const rounded = km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
  const value = new Intl.NumberFormat(locale === 'ar' ? 'ar-YE-u-nu-latn' : 'en-US', {
    maximumFractionDigits: km < 10 ? 1 : 0,
  }).format(rounded);
  return locale === 'ar' ? `${value} كم` : `${value} km`;
}

// ---------------------------------------------------------------------------
// Regions and coverage
// ---------------------------------------------------------------------------

export interface RegionCoverage {
  readonly governorateIds: readonly string[];
  readonly districtIds: readonly string[];
}

export type CoverageProblem =
  | { readonly code: 'EMPTY'; readonly message: string }
  | { readonly code: 'UNKNOWN_GOVERNORATE'; readonly id: string }
  | { readonly code: 'UNKNOWN_DISTRICT'; readonly id: string }
  | { readonly code: 'DISTRICT_OUTSIDE_GOVERNORATE'; readonly id: string };

/**
 * A region may hold whole governorates **and** hand-picked districts from other governorates
 * (specs §: «إقليم المرتفعات» = 6 governorates + 4 extra districts). Duplicates are not an error —
 * they are collapsed — but an unknown or misplaced district is.
 */
export function validateCoverage(
  coverage: RegionCoverage,
  governorates: readonly GovernorateRef[],
  districts: readonly DistrictRef[],
): CoverageProblem[] {
  const problems: CoverageProblem[] = [];
  if (coverage.governorateIds.length === 0 && coverage.districtIds.length === 0) {
    problems.push({
      code: 'EMPTY',
      message: 'a region must cover at least one governorate or district',
    });
    return problems;
  }

  const knownGovernorates = new Set(governorates.map((governorate) => governorate.id));
  const districtById = new Map(districts.map((district) => [district.id, district]));

  for (const id of coverage.governorateIds) {
    if (!knownGovernorates.has(id)) problems.push({ code: 'UNKNOWN_GOVERNORATE', id });
  }
  for (const id of coverage.districtIds) {
    const district = districtById.get(id);
    if (!district) problems.push({ code: 'UNKNOWN_DISTRICT', id });
    else if (!knownGovernorates.has(district.governorateId)) {
      problems.push({ code: 'DISTRICT_OUTSIDE_GOVERNORATE', id });
    }
  }
  return problems;
}

/** Every district a coverage implies: whole governorates expand to all their districts. */
export function expandCoverage(
  coverage: RegionCoverage,
  districts: readonly DistrictRef[],
): string[] {
  const selected = new Set(coverage.districtIds);
  const governorates = new Set(coverage.governorateIds);
  for (const district of districts) {
    if (governorates.has(district.governorateId)) selected.add(district.id);
  }
  return [...selected];
}

export interface RegionNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly kind: RegionKind;
  readonly coverage: RegionCoverage;
}

/**
 * A supervisor assigned to a region also covers its sub-regions (a tree, at most three levels).
 * Cycle-safe: a malformed `parent_id` must not hang a request.
 */
export function descendantRegionIds(regions: readonly RegionNode[], rootId: string): string[] {
  const byParent = new Map<string, RegionNode[]>();
  for (const region of regions) {
    if (!region.parentId) continue;
    const bucket = byParent.get(region.parentId) ?? [];
    bucket.push(region);
    byParent.set(region.parentId, bucket);
  }

  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current !== rootId) result.push(current);
    for (const child of byParent.get(current) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
    }
  }
  return result;
}

/** The districts a supervisor effectively covers, given their assigned regions. */
export function supervisorScope(
  regions: readonly RegionNode[],
  assignedRegionIds: readonly string[],
  districts: readonly DistrictRef[],
): string[] {
  const covered = new Set<string>();
  for (const rootId of assignedRegionIds) {
    const ids = [rootId, ...descendantRegionIds(regions, rootId)];
    for (const id of ids) {
      const region = regions.find((candidate) => candidate.id === id);
      if (!region) continue;
      for (const districtId of expandCoverage(region.coverage, districts)) covered.add(districtId);
    }
  }
  return [...covered];
}

export function inScope(districtId: string | null | undefined, scope: readonly string[]): boolean {
  if (!districtId) return false;
  return scope.includes(districtId);
}

/** Bounding box of a set of points — used to centre a map before a user picks anything. */
export function boundingBox(
  points: readonly GeoPoint[],
): { minLat: number; maxLat: number; minLng: number; maxLng: number } | null {
  const valid = points.filter((point) => isValidLatitude(point.lat) && isValidLongitude(point.lng));
  if (valid.length === 0) return null;
  return {
    minLat: Math.min(...valid.map((point) => point.lat)),
    maxLat: Math.max(...valid.map((point) => point.lat)),
    minLng: Math.min(...valid.map((point) => point.lng)),
    maxLng: Math.max(...valid.map((point) => point.lng)),
  };
}

// ---------------------------------------------------------------------------
// The picker's own state machine (shared by web and native so behaviour cannot drift)
// ---------------------------------------------------------------------------

export interface PickerSelection {
  readonly governorateId: string | null;
  readonly districtId: string | null;
  readonly placeId: string | null;
  readonly customName?: string | null;
}

export type PickerAction =
  | { readonly type: 'governorate'; readonly id: string | null }
  | { readonly type: 'district'; readonly id: string | null }
  | { readonly type: 'place'; readonly id: string | null }
  | { readonly type: 'custom'; readonly name: string }
  | { readonly type: 'reset' };

export const EMPTY_SELECTION: PickerSelection = {
  governorateId: null,
  districtId: null,
  placeId: null,
  customName: null,
};

/**
 * Choosing a governorate clears a district that does not belong to it, and choosing anything clears a
 * custom name — otherwise a stale value could be submitted as the destination.
 */
export function reducePicker(state: PickerSelection, action: PickerAction): PickerSelection {
  switch (action.type) {
    case 'governorate':
      return {
        ...EMPTY_SELECTION,
        governorateId: action.id,
      };
    case 'district':
      return { ...state, districtId: action.id, placeId: null, customName: null };
    case 'place':
      return { ...state, placeId: action.id, customName: null };
    case 'custom':
      return { ...state, placeId: null, customName: action.name };
    case 'reset':
      return EMPTY_SELECTION;
    default:
      return state;
  }
}

/** A selection is submittable only when it names a real place or a non-trivial custom point. */
export function isSelectionComplete(selection: PickerSelection): boolean {
  if (selection.placeId) return true;
  return Boolean(selection.customName && selection.customName.trim().length >= 3);
}
