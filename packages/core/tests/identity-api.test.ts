import { describe, expect, it } from 'vitest';
import {
  decideVerificationSchema,
  identityActionSchema,
  identityCommandSpec,
  inviteMemberSchema,
  submitVerificationSchema,
  transferOwnershipSchema,
  verificationDocumentSchema,
} from '../src/api/identity';

/**
 * The identity command contract is the boundary every client shares, so it gets the same treatment
 * as a domain rule: rejected inputs are named here, not discovered in production.
 */

const UUID = '11111111-1111-4111-8111-111111111111';

describe('identity action union', () => {
  it('accepts each supported action', () => {
    const valid = [
      { action: 'profile.setLocale', locale: 'ar' },
      { action: 'profile.update', fullName: 'فارس' },
      { action: 'organization.create', name: 'شركة معك' },
      { action: 'organization.update', orgId: UUID, name: 'اسم جديد' },
      { action: 'organization.transferOwnership', orgId: UUID, memberId: UUID },
      { action: 'member.invite', orgId: UUID, role: 'manager', email: 'a@b.test' },
      { action: 'member.accept', memberId: UUID, token: 'a'.repeat(64) },
      { action: 'member.remove', memberId: UUID },
      { action: 'member.leave', orgId: UUID },
      { action: 'account.requestDeletion', reason: 'leaving' },
      { action: 'account.cancelDeletion' },
      { action: 'account.delete', userId: UUID, reason: 'طلب المستخدم عبر الدعم' },
      { action: 'notification.read' },
    ];

    for (const input of valid) {
      expect(identityActionSchema.safeParse(input).success, JSON.stringify(input)).toBe(true);
    }
  });

  it('a staff deletion names the account and carries a reason', () => {
    // The reason is not decoration: `cmd_delete_account` refuses without one, because the audit row is the only
    // place a future reader can find out why an account was erased.
    expect(
      identityActionSchema.safeParse({ action: 'account.delete', userId: UUID, reason: '   ' })
        .success,
    ).toBe(false);
    expect(
      identityActionSchema.safeParse({ action: 'account.delete', userId: 'nope', reason: 'x' })
        .success,
    ).toBe(false);
    expect(identityActionSchema.safeParse({ action: 'account.delete', reason: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown action and a missing discriminator', () => {
    expect(identityActionSchema.safeParse({ action: 'profile.delete' }).success).toBe(false);
    expect(identityActionSchema.safeParse({}).success).toBe(false);
  });

  it('is the spec the client uses (one schema, one path)', () => {
    expect(identityCommandSpec.path).toBe('identity');
    expect(identityCommandSpec.mutating).toBe(true);
    expect(identityCommandSpec.input).toBe(identityActionSchema);
  });
});

describe('profile and organization payloads', () => {
  it('rejects a locale outside ar/en', () => {
    expect(
      identityActionSchema.safeParse({ action: 'profile.setLocale', locale: 'fr' }).success,
    ).toBe(false);
  });

  it('rejects a too-short name and a malformed date', () => {
    expect(
      identityActionSchema.safeParse({ action: 'organization.create', name: 'x' }).success,
    ).toBe(false);
    expect(
      identityActionSchema.safeParse({ action: 'profile.update', dateOfBirth: '28-10-2026' })
        .success,
    ).toBe(false);
  });

  it('requires a real uuid for ids', () => {
    expect(
      identityActionSchema.safeParse({ action: 'member.remove', memberId: 'not-a-uuid' }).success,
    ).toBe(false);
  });
});

describe('invitations', () => {
  const base = { action: 'member.invite' as const, orgId: UUID, role: 'manager' as const };

  it('accepts an e-mail, a phone, or both', () => {
    expect(inviteMemberSchema.safeParse({ ...base, email: 'a@b.test' }).success).toBe(true);
    expect(inviteMemberSchema.safeParse({ ...base, phone: '733123456' }).success).toBe(true);
    expect(
      inviteMemberSchema.safeParse({ ...base, email: 'a@b.test', phone: '733123456' }).success,
    ).toBe(true);
  });

  it('refuses an invitation with no contact at all', () => {
    const result = inviteMemberSchema.safeParse(base);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['email']);
    }
  });

  it('never lets an owner be invited through this command', () => {
    expect(
      inviteMemberSchema.safeParse({ ...base, role: 'owner', email: 'a@b.test' }).success,
    ).toBe(false);
  });

  it('requires a 64-hex token to accept', () => {
    const accept = (token: string) =>
      identityActionSchema.safeParse({ action: 'member.accept', memberId: UUID, token }).success;
    expect(accept('a'.repeat(64))).toBe(true);
    expect(accept('A'.repeat(64))).toBe(false);
    expect(accept('a'.repeat(63))).toBe(false);
  });
});

describe('verification submission', () => {
  const documents = [
    { kind: 'national_id_front', path: `${UUID}/front.jpg`, mime: 'image/jpeg', sizeBytes: 1024 },
    { kind: 'national_id_back', path: `${UUID}/back.jpg` },
  ];

  it('accepts a well-formed submission', () => {
    expect(
      submitVerificationSchema.safeParse({
        action: 'verification.submit',
        subjectType: 'individual',
        subjectId: UUID,
        documents,
      }).success,
    ).toBe(true);
  });

  it('requires at least one document and caps the list', () => {
    expect(
      submitVerificationSchema.safeParse({
        action: 'verification.submit',
        subjectType: 'individual',
        subjectId: UUID,
        documents: [],
      }).success,
    ).toBe(false);

    expect(
      submitVerificationSchema.safeParse({
        action: 'verification.submit',
        subjectType: 'organization',
        subjectId: UUID,
        documents: Array.from({ length: 11 }, () => documents[0]!),
      }).success,
    ).toBe(false);
  });

  it('caps a single document at 10 MB', () => {
    expect(
      verificationDocumentSchema.safeParse({
        ...documents[0],
        sizeBytes: 10 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown document kind', () => {
    expect(
      verificationDocumentSchema.safeParse({ kind: 'selfie_copy', path: `${UUID}/x.jpg` }).success,
    ).toBe(false);
  });

  it('cannot decide without an outcome, or approve a rejection code', () => {
    expect(
      decideVerificationSchema.safeParse({
        action: 'verification.decide',
        requestId: UUID,
        outcome: 'maybe',
      }).success,
    ).toBe(false);
    expect(
      decideVerificationSchema.safeParse({
        action: 'verification.decide',
        requestId: UUID,
        outcome: 'reject',
      }).success,
    ).toBe(true);
  });
});

describe('role and ownership payloads', () => {
  it('only accepts the four platform roles', () => {
    const grant = (role: string) =>
      identityActionSchema.safeParse({ action: 'role.grant', userId: UUID, role }).success;
    expect(grant('platform_staff')).toBe(true);
    expect(grant('platform_admin')).toBe(true);
    expect(grant('driver')).toBe(false);
  });

  it('requires both ids to transfer ownership', () => {
    expect(
      transferOwnershipSchema.safeParse({ action: 'organization.transferOwnership', orgId: UUID })
        .success,
    ).toBe(false);
  });
});
