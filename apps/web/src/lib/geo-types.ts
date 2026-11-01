/**
 * Geography shapes shared by server loaders, preview fixtures and client components.
 *
 * Kept separate from `lib/geo.ts` on purpose: this file has no server imports, so a client
 * component can use the types without pulling `next/headers` into the browser bundle.
 */

import type { RegionKind } from '@maak/core';

export interface GeoGovernorate {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly centerLat: number | null;
  readonly centerLng: number | null;
}

export interface GeoDistrict {
  readonly id: string;
  readonly governorateId: string;
  readonly nameAr: string;
  readonly nameEn: string;
}

export interface GeoRegion {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: RegionKind;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly governorateIds: readonly string[];
  readonly districtIds: readonly string[];
  /** Retired regions stay listed so they can be reactivated; they contribute no scope. */
  readonly isActive: boolean;
}

export interface GeoPendingPlace {
  readonly id: string;
  readonly kind: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly governorateName: string | null;
  readonly districtName: string | null;
  readonly submittedBy: string | null;
  /** The submitter's name when it could be resolved; the page falls back to a short id, never a raw UUID. */
  readonly submittedByName: string | null;
  readonly createdAt: string;
  readonly lat: number | null;
  readonly lng: number | null;
}

export interface GeoPlaceOption {
  readonly id: string;
  readonly kind: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly governorateId: string | null;
  readonly districtId: string | null;
  readonly aliasesAr: readonly string[];
  readonly aliasesEn: readonly string[];
  readonly lat: number | null;
  readonly lng: number | null;
  readonly isPublic: boolean;
}

export interface GeoSupervisor {
  readonly userId: string;
  readonly name: string | null;
  readonly regionIds: readonly string[];
  /** Districts covered after expanding the assigned regions (computed with @maak/core). */
  readonly districtCount: number;
}

export interface GeoUserOption {
  readonly id: string;
  readonly name: string | null;
}

export interface GeoDirectory {
  /** false when there is no Supabase project: every screen then renders preview fixtures. */
  readonly configured: boolean;
  readonly governorates: readonly GeoGovernorate[];
  readonly districts: readonly GeoDistrict[];
  readonly regions: readonly GeoRegion[];
  /** Searchable places (the reference set plus anything the caller may see). */
  readonly places: readonly GeoPlaceOption[];
  readonly pendingPlaces: readonly GeoPendingPlace[];
  readonly supervisors: readonly GeoSupervisor[];
  readonly users: readonly GeoUserOption[];
}
