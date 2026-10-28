/**
 * Identity, accounts and verification — the pure rules (Phase 1).
 *
 * Everything here is a function of values, so the same decisions are made by:
 *   · the edge gateway (before it calls a command),
 *   · the SQL commands (`cmd_*` re-assert them — defence in depth),
 *   · the web/mobile UI (to disable buttons and explain *why*).
 *
 * If a rule lives only in a React component, it is not a rule.
 */

import type { PlanCode } from './finance';
import type { Actor, Role, VerificationStatus } from './policy';

export type OrgKind = 'company' | 'agency';
export type MemberRole = 'owner' | 'manager' | 'accountant' | 'dispatcher';
export type MemberStatus = 'invited' | 'active' | 'suspended' | 'removed';
export type VerificationSubject = 'individual' | 'organization';
export type VerificationRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type VerificationOutcome = 'approve' | 'reject';

export type DocumentKind =
  | 'national_id_front'
  | 'national_id_back'
  | 'passport'
  | 'commercial_registration'
  | 'tax_card'
  | 'selfie'
  | 'other';

export interface VerificationDocumentInput {
  readonly kind: DocumentKind;
  /** Storage object path; must live under the submitter's own prefix. */
  readonly path: string;
  readonly mime?: string;
  readonly sizeBytes?: number;
}

export interface VerificationRequestView {
  readonly id: string;
  readonly subjectType: VerificationSubject;
  readonly subjectId: string;
  readonly status: VerificationRequestStatus;
  readonly requestedBy: string;
  readonly note?: string | null;
  readonly decisionReason?: string | null;
  readonly decidedBy?: string | null;
  readonly decidedAt?: string | null;
  readonly createdAt: string;
  readonly documents?: readonly VerificationDocumentInput[];
}

/** Fields that must be captured before an individual can be verified (specs.md §4.2). */
export const INDIVIDUAL_REQUIRED_FIELDS = [
  'fullName',
  'phone',
  'nationalIdType',
  'nationalIdNumber',
  'birthPlace',
] as const;

export type IndividualField = (typeof INDIVIDUAL_REQUIRED_FIELDS)[number];

export interface IndividualProfileInput {
  readonly fullName?: string | null;
  readonly phone?: string | null;
  readonly nationalIdType?: string | null;
  readonly nationalIdNumber?: string | null;
  readonly birthPlace?: string | null;
}

export interface OrganizationInput {
  readonly name?: string | null;
  readonly registrationNo?: string | null;
  readonly phone?: string | null;
  readonly contactEmail?: string | null;
}

/**
 * Documents the *submitter* must attach. Staff may ask for more, but the command rejects a
 * submission that is missing these — otherwise the queue fills with undecidable requests.
 */
export const REQUIRED_DOCUMENTS: Record<VerificationSubject, readonly DocumentKind[]> = {
  individual: ['national_id_front', 'national_id_back'],
  organization: ['commercial_registration'],
};

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const ALLOWED_DOCUMENT_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export function missingIndividualFields(profile: IndividualProfileInput): IndividualField[] {
  return INDIVIDUAL_REQUIRED_FIELDS.filter((field) => {
    const value = profile[field];
    return typeof value !== 'string' || value.trim().length < 2;
  });
}

export function missingOrganizationFields(org: OrganizationInput): string[] {
  const missing: string[] = [];
  if (!org.name || org.name.trim().length < 2) missing.push('name');
  if (!org.registrationNo || org.registrationNo.trim().length < 3) missing.push('registrationNo');
  if (!org.phone || !isValidYemeniPhone(org.phone)) missing.push('phone');
  return missing;
}

/**
 * Yemeni mobile numbers: `+9677xxxxxxxx` / `7xxxxxxxx` / `00967…`.
 * Returns E.164 (`+9677…`) or null when the input cannot be a Yemeni mobile.
 */
export function normalizeYemeniPhone(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, '');
  let local = digits;
  if (local.startsWith('+967')) local = local.slice(4);
  else if (local.startsWith('00967')) local = local.slice(5);
  else if (local.startsWith('967') && local.length === 12) local = local.slice(3);

  // Local mobile numbers are 9 digits and start with 7 (70–78).
  if (!/^7[0-9]{8}$/.test(local)) return null;
  return `+967${local}`;
}

export function isValidYemeniPhone(input: string): boolean {
  return normalizeYemeniPhone(input) !== null;
}

export function normalizeEmail(input: string): string | null {
  const value = input.trim().toLowerCase();
  // Deliberately narrow: we only need to reject obvious typos, not police RFC 5322.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? value : null;
}

/** Masks an ID number for display to anyone who is not the owner: `12****6789`. */
export function maskIdNumber(value: string | null | undefined): string {
  if (!value) return '';
  const clean = value.trim();
  if (clean.length <= 4) return '•'.repeat(clean.length);
  const head = clean.slice(0, 2);
  const tail = clean.slice(-2);
  return `${head}${'•'.repeat(Math.max(2, clean.length - 4))}${tail}`;
}

/** A Yemeni national ID is 12 digits; passports are alphanumeric, 6–12 chars. */
export function isValidNationalId(type: string | null | undefined, value: string): boolean {
  const clean = value.replace(/[\s-]/g, '');
  if (type === 'national_id') return /^[0-9]{12}$/.test(clean);
  if (type === 'passport') return /^[A-Za-z0-9]{6,12}$/.test(clean);
  if (type === 'residence') return /^[A-Za-z0-9]{6,15}$/.test(clean);
  return false;
}

/**
 * Verification is a small state machine, and it is the same one for profiles and organizations.
 * Legal-identity edits knock a verified subject back to `unverified` (see `editsInvalidate`).
 */
export function nextVerificationStatus(
  current: VerificationStatus,
  action: 'submit' | 'approve' | 'reject' | 'withdraw' | 'revoke',
): VerificationStatus {
  switch (action) {
    case 'submit':
      if (current === 'pending') return 'pending';
      if (current === 'verified') return 'verified';
      return 'pending';
    case 'approve':
      return current === 'pending' ? 'verified' : current;
    case 'reject':
      return current === 'pending' ? 'rejected' : current;
    case 'withdraw':
      return current === 'pending' ? 'unverified' : current;
    case 'revoke':
      return current === 'verified' ? 'unverified' : current;
    default:
      return current;
  }
}

export type IdentityFieldChange = {
  readonly field: string;
  readonly before?: string | null;
  readonly after?: string | null;
};

/** Fields whose change invalidates an existing verification. */
const IDENTITY_FIELDS = new Set([
  'fullName',
  'nationalIdType',
  'nationalIdNumber',
  'birthPlace',
  'name',
  'registrationNo',
  'taxNo',
]);

export function editsInvalidateVerification(changes: readonly IdentityFieldChange[]): boolean {
  return changes.some(
    (change) =>
      IDENTITY_FIELDS.has(change.field) &&
      (change.before ?? '').trim() !== (change.after ?? '').trim(),
  );
}

export function diffFields<T extends Record<string, string | null | undefined>>(
  before: T,
  after: Partial<T>,
): IdentityFieldChange[] {
  const changes: IdentityFieldChange[] = [];
  for (const key of Object.keys(after) as (keyof T)[]) {
    const next = after[key];
    if (next === undefined) continue;
    const previous = before[key];
    if ((previous ?? null) !== (next ?? null)) {
      changes.push({ field: String(key), before: previous ?? null, after: next ?? null });
    }
  }
  return changes;
}

/**
 * Separation of duties: the person who submitted a request may not decide it, however senior.
 * This is cheap to enforce now and prevents the "everyone verifies their friends" failure mode.
 */
export function canDecideVerification(
  actor: Pick<Actor, 'userId' | 'roles'>,
  request: Pick<VerificationRequestView, 'requestedBy' | 'status'>,
): boolean {
  if (!actor.userId) return false;
  const isStaff = actor.roles.includes('platform_staff') || actor.roles.includes('platform_admin');
  if (!isStaff) return false;
  if (request.status !== 'pending') return false;
  return request.requestedBy !== actor.userId;
}

export const REJECTION_REASON_MIN_LENGTH = 10;

export function validateRejectionReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.trim().length >= REJECTION_REASON_MIN_LENGTH;
}

/** Document attachment checks that do not need the storage backend. */
export function validateDocuments(
  subject: VerificationSubject,
  documents: readonly VerificationDocumentInput[],
  ownerId: string,
): { ok: true } | { ok: false; code: 'MISSING_DOCUMENT' | 'BAD_DOCUMENT'; detail: string } {
  const kinds = new Set(documents.map((doc) => doc.kind));
  const missing = REQUIRED_DOCUMENTS[subject].filter((kind) => !kinds.has(kind));
  if (missing.length > 0) {
    return { ok: false, code: 'MISSING_DOCUMENT', detail: missing.join(',') };
  }
  for (const doc of documents) {
    // A document must live under the submitter's own folder — a client cannot attach someone
    // else's upload by guessing its path.
    if (!doc.path.startsWith(`${ownerId}/`)) {
      return { ok: false, code: 'BAD_DOCUMENT', detail: `path not owned: ${doc.kind}` };
    }
    if (doc.path.includes('..') || doc.path.startsWith('/')) {
      return { ok: false, code: 'BAD_DOCUMENT', detail: `path not normalised: ${doc.kind}` };
    }
    if (doc.sizeBytes !== undefined && (doc.sizeBytes <= 0 || doc.sizeBytes > MAX_DOCUMENT_BYTES)) {
      return { ok: false, code: 'BAD_DOCUMENT', detail: `size out of range: ${doc.kind}` };
    }
    if (doc.mime !== undefined && !ALLOWED_DOCUMENT_MIME.includes(doc.mime)) {
      return { ok: false, code: 'BAD_DOCUMENT', detail: `mime not allowed: ${doc.mime}` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Organizations and membership
// ---------------------------------------------------------------------------

const RANK: Record<MemberRole, number> = {
  owner: 3,
  manager: 2,
  accountant: 1,
  dispatcher: 1,
};

export function memberRank(role: MemberRole): number {
  return RANK[role] ?? 0;
}

/** Owners outrank managers, managers outrank staff roles. Equal ranks may act on each other. */
export function canManageMember(actorRole: MemberRole, targetRole: MemberRole): boolean {
  return memberRank(actorRole) >= memberRank(targetRole);
}

export function canInvite(actorRole: MemberRole, invitedRole: MemberRole): boolean {
  if (invitedRole === 'owner') return false; // ownership transfer is its own flow
  if (actorRole === 'owner') return true;
  if (actorRole === 'manager') return memberRank(invitedRole) <= RANK.manager;
  return false;
}

export function canRemoveMember(
  actorRole: MemberRole,
  targetRole: MemberRole,
  isSelf: boolean,
): boolean {
  if (targetRole === 'owner') return false;
  if (isSelf) return false;
  return actorRole === 'owner' || memberRank(actorRole) > memberRank(targetRole);
}

export const INVITE_TTL_HOURS = 72;

export interface InviteLike {
  readonly status: MemberStatus;
  readonly expiresAt?: string | null;
}

export function inviteUsable(invite: InviteLike, now: Date = new Date()): boolean {
  if (invite.status !== 'invited') return false;
  if (!invite.expiresAt) return false;
  return new Date(invite.expiresAt).getTime() > now.getTime();
}

export function inviteExpiry(now: Date = new Date(), hours = INVITE_TTL_HOURS): Date {
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

/** Invite tokens are 32 random bytes, hex-encoded; only the hash is stored. */
export function isValidInviteTokenFormat(token: string): boolean {
  return /^[a-f0-9]{64}$/.test(token);
}

export type OrgPermission =
  | 'org.edit'
  | 'org.verify.submit'
  | 'member.invite'
  | 'member.remove'
  | 'finance.view'
  | 'trip.manage';

const ORG_PERMISSIONS: Record<MemberRole, readonly OrgPermission[]> = {
  owner: [
    'org.edit',
    'org.verify.submit',
    'member.invite',
    'member.remove',
    'finance.view',
    'trip.manage',
  ],
  manager: ['org.edit', 'org.verify.submit', 'member.invite', 'finance.view', 'trip.manage'],
  accountant: ['finance.view'],
  dispatcher: ['trip.manage', 'finance.view'],
};

export function orgPermissions(role: MemberRole | null | undefined): readonly OrgPermission[] {
  return role ? ORG_PERMISSIONS[role] : [];
}

export function canInOrg(role: MemberRole | null | undefined, permission: OrgPermission): boolean {
  return orgPermissions(role).includes(permission);
}

// ---------------------------------------------------------------------------
// Plans (Phase 1 stub, activated in Phase 10 — never a retrofit)
// ---------------------------------------------------------------------------

export const PLAN_LIMITS: Record<
  PlanCode,
  { vehicles: number; tripsPerMonth: number; staff: number; drivers: number }
> = {
  basic: { vehicles: 1, tripsPerMonth: 20, staff: 1, drivers: 2 },
  pro: { vehicles: 5, tripsPerMonth: 200, staff: 5, drivers: 10 },
  business: { vehicles: 25, tripsPerMonth: 2000, staff: 25, drivers: 50 },
};

export type PlanMetric = keyof (typeof PLAN_LIMITS)['basic'];

/** Always the LOWEST plan for now: a bug here under-grants, it never over-grants (BR-37). */
export function effectivePlan(): PlanCode {
  return 'basic';
}

export function planLimit(plan: PlanCode, metric: PlanMetric): number {
  return PLAN_LIMITS[plan][metric];
}

export function planAllows(plan: PlanCode, metric: PlanMetric, used: number): boolean {
  return used < planLimit(plan, metric);
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const PLATFORM_ROLES: readonly Role[] = [
  'platform_admin',
  'platform_staff',
  'finance_officer',
  'geo_supervisor',
];

/** Only an admin may grant or revoke platform roles, and an admin cannot demote their last admin. */
export function canManagePlatformRoles(
  actor: Pick<Actor, 'userId' | 'roles'>,
  targetUserId: string,
  role: Role,
  remainingAdmins: number,
): { ok: true } | { ok: false; reason: 'FORBIDDEN' | 'SELF_LOCKOUT' | 'UNKNOWN_ROLE' } {
  if (!actor.roles.includes('platform_admin')) return { ok: false, reason: 'FORBIDDEN' };
  if (!PLATFORM_ROLES.includes(role)) return { ok: false, reason: 'UNKNOWN_ROLE' };
  if (role === 'platform_admin' && targetUserId === actor.userId && remainingAdmins <= 1) {
    return { ok: false, reason: 'SELF_LOCKOUT' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Onboarding progress
// ---------------------------------------------------------------------------

export type OnboardingStep =
  'profile' | 'identity' | 'documents' | 'organization' | 'submit' | 'done';

export interface OnboardingState {
  readonly hasProfile: boolean;
  readonly identityComplete: boolean;
  readonly documentsComplete: boolean;
  readonly organizationChosen: boolean;
  readonly verificationStatus: VerificationStatus;
}

export function nextOnboardingStep(state: OnboardingState): OnboardingStep {
  if (!state.hasProfile || !state.identityComplete) return 'profile';
  if (state.verificationStatus === 'verified') return 'done';
  if (state.verificationStatus === 'pending') return 'submit';
  if (!state.documentsComplete) return 'documents';
  if (!state.organizationChosen) return 'organization';
  return 'submit';
}

export function onboardingProgress(state: OnboardingState): number {
  const step = nextOnboardingStep(state);
  const order: OnboardingStep[] = [
    'profile',
    'identity',
    'documents',
    'organization',
    'submit',
    'done',
  ];
  return Math.round((order.indexOf(step) / (order.length - 1)) * 100);
}

/**
 * What an actor may do with an organization they belong to. Kept next to the role matrix so a
 * screen never has to re-derive it from role strings.
 */
export function orgRoleOf(
  userId: string | null,
  members: readonly { userId: string; orgId: string; role: MemberRole; status: MemberStatus }[],
  orgId: string,
): MemberRole | null {
  if (!userId) return null;
  const membership = members.find(
    (m) => m.orgId === orgId && m.userId === userId && m.status === 'active',
  );
  return membership?.role ?? null;
}
