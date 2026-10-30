import { describe, expect, it } from 'vitest';
import {
  assignSupervisorSchema,
  createPlaceSchema,
  decidePlaceSchema,
  geoActionSchema,
  geoCommandArgs,
  importGeoSchema,
  searchPlacesInputSchema,
  toPlaceSearchResult,
  upsertRegionSchema,
} from '../src/api/geography';
import { can, type Actor } from '../src/domain/policy';

const ADMIN: Actor = {
  userId: '11111111-1111-4111-8111-111111111111',
  roles: ['platform_admin'],
  verification: 'verified',
  plan: 'business',
};
const VERIFIED_OWNER: Actor = {
  userId: '22222222-2222-4222-8222-222222222222',
  roles: ['individual'],
  verification: 'verified',
  plan: 'basic',
};
const PASSENGER: Actor = {
  userId: '33333333-3333-4333-8333-333333333333',
  roles: ['passenger'],
  verification: 'unverified',
  plan: 'basic',
};

const GOV = 'aaaaaaaa-0000-4000-8000-000000000001';
const GOV2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const DISTRICT = 'bbbbbbbb-0000-4000-8000-000000000001';
const USER = 'cccccccc-0000-4000-8000-000000000001';
const PLACE = 'dddddddd-0000-4000-8000-000000000001';

const audit = { p_request_id: 'req-1', p_ip: null };

describe('region.upsert', () => {
  it('defaults the kind and accepts governorate-only coverage', () => {
    const parsed = upsertRegionSchema.parse({
      action: 'region.upsert',
      nameAr: 'إقليم عدن',
      nameEn: 'Aden Region',
      governorateIds: [GOV],
    });
    expect(parsed.kind).toBe('region');
    expect(parsed.districtIds).toEqual([]);
  });

  it('refuses a region that covers nothing', () => {
    const result = upsertRegionSchema.safeParse({
      action: 'region.upsert',
      nameAr: 'إقليم فارغ',
      nameEn: 'Empty Region',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('at least one governorate or district');
    }
  });

  it('rejects a non-uuid governorate id', () => {
    expect(
      upsertRegionSchema.safeParse({
        action: 'region.upsert',
        nameAr: 'إقليم',
        nameEn: 'Region',
        governorateIds: ['not-a-uuid'],
      }).success,
    ).toBe(false);
  });

  it('maps to cmd_upsert_region with snake_case arguments', () => {
    const action = geoActionSchema.parse({
      action: 'region.upsert',
      nameAr: 'إقليم عدن',
      nameEn: 'Aden Region',
      governorateIds: [GOV, GOV2],
      districtIds: [DISTRICT],
      description: 'الساحل',
    });
    const { fn, args } = geoCommandArgs(action, ADMIN.userId as string, audit);
    expect(fn).toBe('cmd_upsert_region');
    expect(args).toMatchObject({
      p_actor: ADMIN.userId,
      p_region_id: null,
      p_kind: 'region',
      p_governorate_ids: [GOV, GOV2],
      p_district_ids: [DISTRICT],
      p_request_id: 'req-1',
    });
  });
});

describe('supervisor assignment', () => {
  it('requires at least one region', () => {
    expect(
      assignSupervisorSchema.safeParse({
        action: 'geo.assignSupervisor',
        userId: USER,
        regionIds: [],
      }).success,
    ).toBe(false);
  });

  it('accepts a full replacement list and maps to the command', () => {
    const action = geoActionSchema.parse({
      action: 'geo.assignSupervisor',
      userId: USER,
      regionIds: [GOV],
      reason: 'تغطية عدن',
    });
    const { fn, args } = geoCommandArgs(action, ADMIN.userId as string, audit);
    expect(fn).toBe('cmd_assign_geo_supervisor');
    expect(args.p_region_ids).toEqual([GOV]);
    expect(args.p_user_id).toBe(USER);
  });
});

describe('place.create', () => {
  it('rejects coordinates given halfway', () => {
    const result = createPlaceSchema.safeParse({
      action: 'place.create',
      kind: 'gathering_point',
      nameAr: 'نقطة تجمع',
      lat: 12.8,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('together');
  });

  it('defaults alias lists and accepts a bare custom place', () => {
    const parsed = createPlaceSchema.parse({
      action: 'place.create',
      kind: 'landmark',
      nameAr: 'سوق عدن',
    });
    expect(parsed.aliasesAr).toEqual([]);
    expect(parsed.aliasesEn).toEqual([]);
    expect(parsed.governorateId).toBeUndefined();
  });

  it('refuses a name shorter than three characters', () => {
    expect(
      createPlaceSchema.safeParse({ action: 'place.create', kind: 'other', nameAr: 'عد' }).success,
    ).toBe(false);
  });

  it('maps org-scoped creation to cmd_create_place', () => {
    const action = geoActionSchema.parse({
      action: 'place.create',
      kind: 'gathering_point',
      nameAr: 'نقطة تجمع الشركة',
      governorateId: GOV,
      lat: 12.78,
      lng: 45.01,
      orgId: USER,
    });
    const { fn, args } = geoCommandArgs(action, VERIFIED_OWNER.userId as string, audit);
    expect(fn).toBe('cmd_create_place');
    expect(args).toMatchObject({
      p_org_id: USER,
      p_lat: 12.78,
      p_lng: 45.01,
      p_kind: 'gathering_point',
    });
  });
});

describe('place.decide', () => {
  it('requires a reason for a rejection', () => {
    expect(
      decidePlaceSchema.safeParse({
        action: 'place.decide',
        placeId: PLACE,
        outcome: 'reject',
        reason: 'short',
      }).success,
    ).toBe(false);
  });

  it('allows an approval without a reason', () => {
    expect(
      decidePlaceSchema.safeParse({ action: 'place.decide', placeId: PLACE, outcome: 'approve' })
        .success,
    ).toBe(true);
  });

  it('maps to cmd_decide_place', () => {
    const action = geoActionSchema.parse({
      action: 'place.decide',
      placeId: PLACE,
      outcome: 'reject',
      reason: 'المكان مكرر في المرجع',
    });
    const { fn, args } = geoCommandArgs(action, ADMIN.userId as string, audit);
    expect(fn).toBe('cmd_decide_place');
    expect(args.p_outcome).toBe('reject');
  });
});

describe('geo.import', () => {
  it('is a dry run unless told otherwise', () => {
    const parsed = importGeoSchema.parse({
      action: 'geo.import',
      kind: 'districts',
      rows: [{ governorate_code: 'YE-AD', name_ar: 'كريتر', name_en: 'Crater' }],
    });
    expect(parsed.dryRun).toBe(true);
  });

  it('refuses an empty row set', () => {
    expect(
      importGeoSchema.safeParse({ action: 'geo.import', kind: 'districts', rows: [] }).success,
    ).toBe(false);
  });
});

describe('search input', () => {
  it('clamps the limit and defaults the locale', () => {
    expect(searchPlacesInputSchema.safeParse({ limit: 51 }).success).toBe(false);
    const parsed = searchPlacesInputSchema.parse({});
    expect(parsed.locale).toBe('ar');
    expect(parsed.limit).toBe(20);
  });

  it('shapes a PostgREST row into the client contract', () => {
    const result = toPlaceSearchResult({
      id: PLACE,
      kind: 'city',
      name: 'عدن',
      name_ar: 'عدن',
      name_en: 'Aden',
      governorate_id: GOV,
      governorate_name: 'عدن',
      district_id: null,
      district_name: null,
      lat: 12.78,
      lng: 45.01,
      is_public: true,
      score: 106,
    });
    expect(result.governorateName).toBe('عدن');
    expect(result.districtId).toBeNull();
    expect(result.isPublic).toBe(true);
    expect(result.score).toBe(106);
  });
});

describe('the policy matrix guards geography', () => {
  it('lets admins manage regions and assign supervisors', () => {
    expect(can(ADMIN, 'geo.manage')).toBe(true);
    expect(can(ADMIN, 'geo.assignSupervisor')).toBe(true);
    expect(can(PASSENGER, 'geo.manage')).toBe(false);
  });

  it('lets verified operators create places, but not decide them', () => {
    expect(can(VERIFIED_OWNER, 'place.create')).toBe(true);
    expect(can(VERIFIED_OWNER, 'place.decide')).toBe(false);
    expect(can(ADMIN, 'place.decide')).toBe(true);
  });
});
