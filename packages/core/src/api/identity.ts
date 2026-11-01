/**
 * Identity commands — the shared contract between UI, edge function and tests (Phase 1).
 *
 * One edge function (`identity`) dispatches on `action`. Each branch is validated by the same
 * schema here, and each branch calls exactly one `cmd_*` function: one command, one transaction.
 */

import { z } from 'zod';

const uuid = z.string().uuid();
const locale = z.enum(['ar', 'en']);
const memberRole = z.enum(['manager', 'accountant', 'dispatcher']);
const platformRole = z.enum([
  'platform_admin',
  'platform_staff',
  'finance_officer',
  'geo_supervisor',
]);
const documentKind = z.enum([
  'national_id_front',
  'national_id_back',
  'passport',
  'commercial_registration',
  'tax_card',
  'selfie',
  'other',
]);

export const verificationDocumentSchema = z.object({
  kind: documentKind,
  /** Path inside the private bucket; must start with the submitter's uuid. */
  path: z.string().min(3).max(512),
  mime: z.string().max(120).optional(),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024)
    .optional(),
});

export const updateProfileSchema = z.object({
  action: z.literal('profile.update'),
  fullName: z.string().trim().min(2).max(120).optional(),
  nationalIdType: z.enum(['national_id', 'passport', 'residence']).optional(),
  nationalIdNumber: z.string().trim().min(4).max(32).optional(),
  birthPlace: z.string().trim().min(2).max(120).optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  avatarPath: z.string().max(512).optional(),
});

export const setLocaleSchema = z.object({
  action: z.literal('profile.setLocale'),
  locale,
});

export const createOrganizationSchema = z.object({
  action: z.literal('organization.create'),
  name: z.string().trim().min(2).max(120),
  nameEn: z.string().trim().min(2).max(120).optional(),
  kind: z.enum(['company', 'agency']).default('company'),
  registrationNo: z.string().trim().min(3).max(40).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().max(160).optional(),
});

export const updateOrganizationSchema = z.object({
  action: z.literal('organization.update'),
  orgId: uuid,
  name: z.string().trim().min(2).max(120).optional(),
  nameEn: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().max(160).optional(),
  registrationNo: z.string().trim().min(3).max(40).optional(),
  taxNo: z.string().trim().max(40).optional(),
});

export const inviteMemberSchema = z
  .object({
    action: z.literal('member.invite'),
    orgId: uuid,
    role: memberRole,
    email: z.string().trim().email().max(160).optional(),
    phone: z.string().trim().max(20).optional(),
  })
  .refine((value) => Boolean(value.email || value.phone), {
    message: 'email or phone is required',
    path: ['email'],
  });

export const acceptInviteSchema = z.object({
  action: z.literal('member.accept'),
  memberId: uuid,
  token: z.string().regex(/^[a-f0-9]{64}$/),
});

export const removeMemberSchema = z.object({
  action: z.literal('member.remove'),
  memberId: uuid,
  reason: z.string().trim().max(500).optional(),
});

export const transferOwnershipSchema = z.object({
  action: z.literal('organization.transferOwnership'),
  orgId: uuid,
  memberId: uuid,
  reason: z.string().trim().max(500).optional(),
});

export const leaveOrganizationSchema = z.object({
  action: z.literal('member.leave'),
  orgId: uuid,
});

export const requestDeletionSchema = z.object({
  action: z.literal('account.requestDeletion'),
  reason: z.string().trim().max(500).optional(),
});

export const cancelDeletionSchema = z.object({
  action: z.literal('account.cancelDeletion'),
});

/**
 * The staff action the request always implied (00039). `userId` is the account being erased, never the actor:
 * the SQL command refuses self-service, so this payload cannot be used as a delete-my-own-account shortcut.
 */
export const deleteAccountSchema = z.object({
  action: z.literal('account.delete'),
  userId: uuid,
  reason: z.string().trim().min(1).max(500),
});

export const submitVerificationSchema = z.object({
  action: z.literal('verification.submit'),
  subjectType: z.enum(['individual', 'organization']),
  subjectId: uuid,
  documents: z.array(verificationDocumentSchema).min(1).max(10),
  note: z.string().trim().max(2000).optional(),
  snapshot: z.record(z.string(), z.unknown()).optional(),
});

export const decideVerificationSchema = z.object({
  action: z.literal('verification.decide'),
  requestId: uuid,
  outcome: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(2000).optional(),
});

export const grantRoleSchema = z.object({
  action: z.literal('role.grant'),
  userId: uuid,
  role: platformRole,
  reason: z.string().trim().max(500).optional(),
});

export const revokeRoleSchema = z.object({
  action: z.literal('role.revoke'),
  userId: uuid,
  role: platformRole,
  reason: z.string().trim().max(500).optional(),
});

export const markNotificationsReadSchema = z.object({
  action: z.literal('notification.read'),
  ids: z.array(uuid).max(200).optional(),
});

export const identityActionSchema = z.discriminatedUnion('action', [
  updateProfileSchema,
  setLocaleSchema,
  createOrganizationSchema,
  updateOrganizationSchema,
  inviteMemberSchema,
  acceptInviteSchema,
  removeMemberSchema,
  transferOwnershipSchema,
  leaveOrganizationSchema,
  requestDeletionSchema,
  cancelDeletionSchema,
  deleteAccountSchema,
  submitVerificationSchema,
  decideVerificationSchema,
  grantRoleSchema,
  revokeRoleSchema,
  markNotificationsReadSchema,
]);

export type IdentityAction = z.infer<typeof identityActionSchema>;
export type IdentityActionName = IdentityAction['action'];

/**
 * Results are deliberately open: every command returns a small object, and the client reads only
 * the fields it asked for. `requestId` is always appended by the gateway.
 */
export const identityResultSchema = z.looseObject({ requestId: z.string().optional() });

export type IdentityResult = z.infer<typeof identityResultSchema>;

export const identityCommandSpec = {
  path: 'identity',
  input: identityActionSchema,
  output: identityResultSchema,
  mutating: true,
} as const;

/** Read model for the staff verification queue. */
export const verificationQueueSchema = z.object({
  action: z.literal('queue.list'),
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
  subjectType: z.enum(['individual', 'organization', 'all']).default('all'),
  limit: z.number().int().min(1).max(100).default(25),
});

export type VerificationQueueInput = z.infer<typeof verificationQueueSchema>;

export interface VerificationQueueItem {
  readonly id: string;
  readonly subjectType: 'individual' | 'organization';
  readonly subjectId: string;
  readonly requestedBy: string;
  readonly subjectName: string | null;
  readonly status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  readonly createdAt: string;
  readonly note: string | null;
  readonly snapshot: Record<string, unknown>;
  readonly documents: readonly { id: string; kind: string; url: string | null }[];
}
