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
