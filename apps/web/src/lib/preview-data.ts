/**
 * Preview fixtures — used **only** when no Supabase project is configured.
 *
 * Why this exists: the UI must be reviewable (in both directions, on a fresh clone, in a hosted
 * preview) without a database. Every screen that consumes this data renders a visible
 * "preview mode" banner, and no preview value is ever written anywhere.
 */

import type {
  AccountContext,
  AccountMember,
  AccountNotification,
  AccountOrganization,
  AccountProfile,
} from './account';
import type { VerificationQueueItem } from '@maak/core';
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

export const PREVIEW_USER_ID = '11111111-1111-4111-8111-111111111111';

const profile: AccountProfile = {
  id: PREVIEW_USER_ID,
  fullName: 'فارس نعمان',
  phone: '+967733111111',
  email: 'fares@example.test',
  verificationStatus: 'rejected',
  verificationNote: 'صورة الهوية غير واضحة، أعد التصوير في إضاءة جيدة.',
  nationalIdType: 'national_id',
  birthPlace: 'عدن',
  avatarPath: null,
  deletionRequestedAt: null,
};

const organizations: AccountOrganization[] = [
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    name: 'شركة معك للنقل',
    nameEn: 'Maak Transport',
    role: 'owner',
    status: 'active',
    verificationStatus: 'verified',
    plan: 'basic',
    registrationNo: 'CR-100200',
    phone: '+967733222222',
    email: 'ops@maak.test',
    taxNo: null,
    kind: 'company',
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000002',
    name: 'وكالة عدن للسفر',
    nameEn: 'Aden Travel Agency',
    role: 'manager',
    status: 'active',
    verificationStatus: 'pending',
    plan: 'pro',
    registrationNo: 'CR-778899',
    phone: '+967733333333',
    email: null,
    taxNo: null,
    kind: 'agency',
  },
];

const members: AccountMember[] = [
  {
    id: 'bbbbbbbb-0000-4000-8000-000000000001',
    orgId: organizations[0]!.id,
    userId: PREVIEW_USER_ID,
    role: 'owner',
    status: 'active',
    email: 'fares@example.test',
    phone: '+967733111111',
    joinedAt: '2026-09-01T08:00:00.000Z',
  },
  {
    id: 'bbbbbbbb-0000-4000-8000-000000000002',
    orgId: organizations[0]!.id,
    userId: null,
    role: 'manager',
    status: 'invited',
    email: 'manager@example.test',
    phone: null,
    joinedAt: null,
  },
  {
    id: 'bbbbbbbb-0000-4000-8000-000000000003',
    orgId: organizations[0]!.id,
    userId: 'eeeeeeee-0000-4000-8000-000000000001',
    role: 'accountant',
    status: 'active',
    email: 'accountant@example.test',
    phone: '+967733444444',
    joinedAt: '2026-09-12T10:30:00.000Z',
  },
];

const notifications: AccountNotification[] = [
  {
    id: 'n1',
    titleKey: 'notifications.verificationSubmitted',
    params: {},
    link: '/staff/verifications',
    readAt: null,
    createdAt: '2026-10-27T09:12:00.000Z',
  },
  {
    id: 'n2',
    titleKey: 'notifications.memberJoined',
    params: {},
    link: '/operator/team',
    readAt: null,
    createdAt: '2026-10-26T14:05:00.000Z',
  },
  {
    id: 'n3',
    titleKey: 'notifications.verificationApproved',
    params: {},
    link: '/account/verification',
    readAt: '2026-10-20T07:40:00.000Z',
    createdAt: '2026-10-20T07:40:00.000Z',
  },
];

export const previewAccount: AccountContext = {
  configured: false,
  user: { id: PREVIEW_USER_ID, email: 'fares@example.test' },
  profile,
  organizations,
  members,
  notifications,
  roles: ['platform_staff'],
};

export const previewQueue: readonly VerificationQueueItem[] = [
  {
    id: 'cccccccc-0000-4000-8000-000000000001',
    subjectType: 'individual',
    subjectId: 'dddddddd-0000-4000-8000-000000000001',
    requestedBy: 'dddddddd-0000-4000-8000-000000000001',
    subjectName: 'سالم العولقي',
    status: 'pending',
    createdAt: '2026-10-27T10:15:00.000Z',
    note: 'سائق بين عدن والمكلا',
    snapshot: { nationalIdType: 'national_id', birthPlace: 'المكلا' },
    documents: [
      { id: 'doc1', kind: 'national_id_front', url: null },
      { id: 'doc2', kind: 'national_id_back', url: null },
    ],
  },
  {
    id: 'cccccccc-0000-4000-8000-000000000002',
    subjectType: 'organization',
    subjectId: 'aaaaaaaa-0000-4000-8000-000000000002',
    requestedBy: 'eeeeeeee-0000-4000-8000-000000000002',
    subjectName: 'وكالة عدن للسفر',
    status: 'pending',
    createdAt: '2026-10-26T08:00:00.000Z',
    note: null,
    snapshot: { registrationNo: 'CR-778899' },
    documents: [{ id: 'doc3', kind: 'commercial_registration', url: null }],
  },
  {
    id: 'cccccccc-0000-4000-8000-000000000003',
    subjectType: 'individual',
    subjectId: 'ffffffff-0000-4000-8000-000000000003',
    requestedBy: 'ffffffff-0000-4000-8000-000000000003',
    subjectName: 'أمل قاسم',
    status: 'approved',
    createdAt: '2026-10-24T12:00:00.000Z',
    note: null,
    snapshot: {},
    documents: [],
  },
];

export const previewUsers: readonly {
  id: string;
  name: string;
  email: string;
  verification: string;
  roles: readonly string[];
}[] = [
  {
    id: PREVIEW_USER_ID,
    name: 'فارس نعمان',
    email: 'fares@example.test',
    verification: 'verified',
    roles: ['platform_admin'],
  },
  {
    id: 'cccccccc-0000-4000-8000-000000000009',
    name: 'هناء صالح',
    email: 'hana@example.test',
    verification: 'verified',
    roles: ['platform_staff'],
  },
  {
    id: 'dddddddd-0000-4000-8000-000000000001',
    name: 'سالم العولقي',
    email: 'salem@example.test',
    verification: 'pending',
    roles: [],
  },
  {
    id: 'eeeeeeee-0000-4000-8000-000000000001',
    name: 'أحمد الشامي',
    email: 'ahmed@example.test',
    verification: 'verified',
    roles: ['finance_officer'],
  },
];

// ---------------------------------------------------------------------------
// Phase 2 — geography (preview fixtures)
//
// A handful of real governorates and districts so the screens read like the product, not like a
// wireframe. The full reference set (22 governorates, 333 districts) is seeded by migration 00009
// and imported with `scripts/geo/import-districts.mjs`.
// ---------------------------------------------------------------------------

const g = (id: string, code: string, nameAr: string, nameEn: string, lat: number, lng: number) =>
  ({ id, code, nameAr, nameEn, centerLat: lat, centerLng: lng }) as const;

/**
 * Two deletion requests for the admin console's queue, in the shape `loadDeletionRequests()` returns.
 *
 * The second row has no reason and no email on purpose: real requests arrive that way, and a preview that
 * only shows complete rows hides the fallbacks the screen has to render.
 */
export const previewDeletionRequests: readonly {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  reason: string | null;
  requestedAt: string;
}[] = [
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'سالم بن عوض',
    phone: '+967711223344',
    email: 'salem@example.test',
    reason: 'لم أعد أستخدم المنصة ولا أحتاج الحساب.',
    requestedAt: '2026-10-28T09:12:00Z',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'منى عبدالله',
    phone: '+967733445566',
    email: null,
    reason: null,
    requestedAt: '2026-10-30T16:40:00Z',
  },
];

export const previewGovernorates: readonly GeoGovernorate[] = [
  g('10000000-0000-4000-8000-000000000001', 'YE-AD', 'عدن', 'Aden', 12.7855, 45.0187),
  g('10000000-0000-4000-8000-000000000002', 'YE-SA', 'صنعاء', "Sana'a", 15.3694, 44.191),
  g('10000000-0000-4000-8000-000000000003', 'YE-LA', 'لحج', 'Lahij', 13.0583, 44.8833),
  g('10000000-0000-4000-8000-000000000004', 'YE-TA', 'تعز', 'Taiz', 13.5795, 44.0209),
  g('10000000-0000-4000-8000-000000000005', 'YE-HD', 'حضرموت', 'Hadramaut', 15.95, 48.8),
  g('10000000-0000-4000-8000-000000000006', 'YE-HJ', 'حجة', 'Hajjah', 15.6943, 43.6012),
  g('10000000-0000-4000-8000-000000000007', 'YE-IB', 'إب', 'Ibb', 13.9667, 44.1667),
  g('10000000-0000-4000-8000-000000000008', 'YE-MR', 'مأرب', 'Marib', 15.4622, 45.3258),
];

const d = (id: string, governorateId: string, nameAr: string, nameEn: string) =>
  ({ id, governorateId, nameAr, nameEn }) as const;

export const previewDistricts: readonly GeoDistrict[] = [
  d('20000000-0000-4000-8000-000000000001', previewGovernorates[0]!.id, 'كريتر', 'Crater'),
  d('20000000-0000-4000-8000-000000000002', previewGovernorates[0]!.id, 'المعلا', 'Al Mualla'),
  d('20000000-0000-4000-8000-000000000003', previewGovernorates[0]!.id, 'خور مكسر', 'Khormaksar'),
  d('20000000-0000-4000-8000-000000000004', previewGovernorates[0]!.id, 'المنصورة', 'Al Mansura'),
  d(
    '20000000-0000-4000-8000-000000000005',
    previewGovernorates[0]!.id,
    'الشيخ عثمان',
    'Sheikh Othman',
  ),
  d('20000000-0000-4000-8000-000000000006', previewGovernorates[2]!.id, 'الحوطة', 'Al Hawtah'),
  d('20000000-0000-4000-8000-000000000007', previewGovernorates[2]!.id, 'تبن', 'Tuban'),
  d('20000000-0000-4000-8000-000000000008', previewGovernorates[3]!.id, 'صالة', 'Sala'),
  d('20000000-0000-4000-8000-000000000009', previewGovernorates[4]!.id, 'المكلا', 'Mukalla'),
  d('20000000-0000-4000-8000-00000000000a', previewGovernorates[4]!.id, 'سيئون', 'Sayun'),
  d(
    '20000000-0000-4000-8000-00000000000b',
    previewGovernorates[1]!.id,
    'صنعاء القديمة',
    "Old Sana'a",
  ),
];

export const previewRegions: readonly GeoRegion[] = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    parentId: null,
    kind: 'region',
    nameAr: 'إقليم عدن والساحل',
    nameEn: 'Aden & the Coast',
    governorateIds: [previewGovernorates[0]!.id, previewGovernorates[2]!.id],
    districtIds: [previewDistricts[8]!.id],
    isActive: true,
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    parentId: '30000000-0000-4000-8000-000000000001',
    kind: 'sub_region',
    nameAr: 'إقليم عدن الفرعي',
    nameEn: 'Aden Sub-region',
    governorateIds: [previewGovernorates[0]!.id],
    districtIds: [],
    isActive: true,
  },
  {
    id: '30000000-0000-4000-8000-000000000003',
    parentId: null,
    kind: 'region',
    nameAr: 'إقليم المرتفعات',
    nameEn: 'Highlands',
    governorateIds: [previewGovernorates[1]!.id],
    districtIds: [],
    isActive: true,
  },
];

export const previewPendingPlaces: readonly GeoPendingPlace[] = [
  {
    id: '40000000-0000-4000-8000-000000000001',
    kind: 'gathering_point',
    nameAr: 'نقطة تجمع الشارع الخامس',
    nameEn: 'Fifth Street gathering point',
    governorateName: 'عدن',
    districtName: 'كريتر',
    submittedBy: 'فارس نعمان',
    createdAt: '2026-10-28T07:20:00.000Z',
    lat: 12.7801,
    lng: 45.0302,
  },
  {
    id: '40000000-0000-4000-8000-000000000002',
    kind: 'landmark',
    nameAr: 'جولة القصر',
    nameEn: 'Al Qasr roundabout',
    governorateName: 'لحج',
    districtName: 'الحوطة',
    submittedBy: 'وكالة عدن للسفر',
    createdAt: '2026-10-29T05:40:00.000Z',
    lat: 13.0552,
    lng: 44.8801,
  },
  {
    id: '40000000-0000-4000-8000-000000000003',
    kind: 'gathering_point',
    nameAr: 'موقف المكلا الجديد',
    nameEn: null,
    governorateName: 'حضرموت',
    districtName: 'المكلا',
    submittedBy: 'شركة معك للنقل',
    createdAt: '2026-10-30T04:10:00.000Z',
    lat: 14.5421,
    lng: 49.1242,
  },
];

export const previewGeoUsers: readonly GeoUserOption[] = [
  { id: '50000000-0000-4000-8000-000000000001', name: 'سامي القباطي' },
  { id: '50000000-0000-4000-8000-000000000002', name: 'هدى باشراحيل' },
  { id: '50000000-0000-4000-8000-000000000003', name: 'عبدالله المخلافي' },
];

export const previewSupervisors: readonly GeoSupervisor[] = [
  {
    userId: previewGeoUsers[0]!.id,
    name: previewGeoUsers[0]!.name,
    regionIds: ['30000000-0000-4000-8000-000000000001'],
    districtCount: 8,
  },
];

const pl = (
  id: string,
  kind: string,
  nameAr: string,
  nameEn: string | null,
  governorateId: string | null,
  districtId: string | null,
  lat: number | null,
  lng: number | null,
  aliasesAr: readonly string[] = [],
) =>
  ({
    id,
    kind,
    nameAr,
    nameEn,
    governorateId,
    districtId,
    aliasesAr,
    aliasesEn: [] as readonly string[],
    lat,
    lng,
    isPublic: true,
  }) as const;

export const previewPlaces: readonly GeoPlaceOption[] = [
  pl(
    '60000000-0000-4000-8000-000000000001',
    'city',
    'عدن',
    'Aden',
    previewGovernorates[0]!.id,
    previewDistricts[0]!.id,
    12.7855,
    45.0187,
    ['عدن الصغرى'],
  ),
  pl(
    '60000000-0000-4000-8000-000000000002',
    'station',
    'موقف عدن المركزي',
    'Aden Central Station',
    previewGovernorates[0]!.id,
    previewDistricts[0]!.id,
    12.7799,
    45.0345,
  ),
  pl(
    '60000000-0000-4000-8000-000000000003',
    'city',
    'صنعاء',
    "Sana'a",
    previewGovernorates[1]!.id,
    previewDistricts[10]!.id,
    15.3694,
    44.191,
  ),
  pl(
    '60000000-0000-4000-8000-000000000004',
    'city',
    'المكلا',
    'Mukalla',
    previewGovernorates[4]!.id,
    previewDistricts[8]!.id,
    14.5421,
    49.1242,
  ),
  pl(
    '60000000-0000-4000-8000-000000000005',
    'city',
    'تعز',
    'Taiz',
    previewGovernorates[3]!.id,
    null,
    13.5795,
    44.0209,
  ),
  pl(
    '60000000-0000-4000-8000-000000000006',
    'city',
    'الحوطة',
    'Al Hawtah',
    previewGovernorates[2]!.id,
    previewDistricts[5]!.id,
    13.0583,
    44.8833,
  ),
  pl(
    '60000000-0000-4000-8000-000000000007',
    'airport',
    'مطار عدن الدولي',
    'Aden International Airport',
    previewGovernorates[0]!.id,
    previewDistricts[2]!.id,
    12.8295,
    45.0288,
  ),
  pl(
    '60000000-0000-4000-8000-000000000008',
    'market',
    'سوق المكلا',
    'Mukalla Market',
    previewGovernorates[4]!.id,
    previewDistricts[8]!.id,
    14.5333,
    49.1333,
  ),
];

export const previewDirectory: GeoDirectory = {
  configured: false,
  governorates: previewGovernorates,
  districts: previewDistricts,
  regions: previewRegions,
  places: previewPlaces,
  pendingPlaces: previewPendingPlaces,
  supervisors: previewSupervisors,
  users: previewGeoUsers,
};
