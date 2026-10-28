import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DOCUMENT_MIME,
  canDecideVerification,
  canInOrg,
  canInvite,
  canManageMember,
  canManagePlatformRoles,
  canRemoveMember,
  diffFields,
  editsInvalidateVerification,
  effectivePlan,
  inviteExpiry,
  inviteUsable,
  isValidInviteTokenFormat,
  isValidNationalId,
  isValidYemeniPhone,
  maskIdNumber,
  memberRank,
  missingIndividualFields,
  missingOrganizationFields,
  nextOnboardingStep,
  nextVerificationStatus,
  normalizeEmail,
  normalizeYemeniPhone,
  onboardingProgress,
  orgPermissions,
  orgRoleOf,
  planAllows,
  planLimit,
  REJECTION_REASON_MIN_LENGTH,
  validateDocuments,
  validateRejectionReason,
} from '../src/domain/identity';
import { can } from '../src/domain/policy';
import type { Actor, Role } from '../src/domain/policy';

const actor = (roles: Role[], verification: Actor['verification'] = 'unverified'): Actor => ({
  userId: 'user-1',
  roles,
  verification,
  plan: 'basic',
});

describe('phone and e-mail normalisation', () => {
  it('accepts the three common Yemeni formats', () => {
    expect(normalizeYemeniPhone('+967 733 123 456')).toBe('+967733123456');
    expect(normalizeYemeniPhone('733123456')).toBe('+967733123456');
    expect(normalizeYemeniPhone('00967-733-123-456')).toBe('+967733123456');
    expect(normalizeYemeniPhone('967733123456')).toBe('+967733123456');
  });

  it('rejects landlines, short numbers and foreign prefixes', () => {
    expect(normalizeYemeniPhone('0123456')).toBeNull();
    expect(normalizeYemeniPhone('73312345')).toBeNull();
    expect(normalizeYemeniPhone('+971733123456')).toBeNull();
    expect(isValidYemeniPhone('not a phone')).toBe(false);
  });

  it('lowercases and rejects e-mails without a real domain', () => {
    expect(normalizeEmail('  Fares@Maak.YE ')).toBe('fares@maak.ye');
    expect(normalizeEmail('fares@localhost')).toBeNull();
    expect(normalizeEmail('fares maak.ye')).toBeNull();
  });
});

describe('identity document rules', () => {
  it('validates the Yemeni national ID shape (12 digits)', () => {
    expect(isValidNationalId('national_id', '123456789012')).toBe(true);
    expect(isValidNationalId('national_id', '1234-5678-9012')).toBe(true);
    expect(isValidNationalId('national_id', '12345')).toBe(false);
  });

  it('validates passports and residence permits', () => {
    expect(isValidNationalId('passport', 'A1234567')).toBe(true);
    expect(isValidNationalId('passport', 'A1')).toBe(false);
    expect(isValidNationalId('residence', 'RES12345')).toBe(true);
    expect(isValidNationalId('unknown', 'A1234567')).toBe(false);
  });

  it('masks an ID number for display without hiding its edges', () => {
    expect(maskIdNumber('123456789012')).toBe('12••••••••12');
    expect(maskIdNumber('1234')).toBe('••••');
    expect(maskIdNumber(null)).toBe('');
  });
});

describe('required fields per subject', () => {
  it('lists every missing individual field', () => {
    expect(missingIndividualFields({})).toEqual([
      'fullName',
      'phone',
      'nationalIdType',
      'nationalIdNumber',
      'birthPlace',
    ]);
    expect(
      missingIndividualFields({
        fullName: 'فارس',
        phone: '733123456',
        nationalIdType: 'national_id',
        nationalIdNumber: '123456789012',
        birthPlace: 'عدن',
      }),
    ).toEqual([]);
  });

  it('treats whitespace as missing', () => {
    expect(missingIndividualFields({ fullName: '   ', phone: '  ' })).toContain('fullName');
  });

  it('requires a valid phone for a company, not just any string', () => {
    expect(missingOrganizationFields({ name: 'شركة معك', registrationNo: 'CR-1' })).toEqual([
      'phone',
    ]);
    expect(
      missingOrganizationFields({
        name: 'شركة معك',
        registrationNo: 'CR-100',
        phone: '+967733123456',
      }),
    ).toEqual([]);
  });
});

describe('verification state machine', () => {
  it('moves unverified → pending → verified', () => {
    expect(nextVerificationStatus('unverified', 'submit')).toBe('pending');
    expect(nextVerificationStatus('pending', 'approve')).toBe('verified');
    expect(nextVerificationStatus('pending', 'reject')).toBe('rejected');
  });

  it('lets a rejected subject try again', () => {
    expect(nextVerificationStatus('rejected', 'submit')).toBe('pending');
    expect(nextVerificationStatus('rejected', 'approve')).toBe('rejected');
  });

  it('is idempotent: submitting twice does not skip review', () => {
    expect(nextVerificationStatus('pending', 'submit')).toBe('pending');
    expect(nextVerificationStatus('verified', 'submit')).toBe('verified');
  });

  it('withdraws back to unverified and revokes a verified subject', () => {
    expect(nextVerificationStatus('pending', 'withdraw')).toBe('unverified');
    expect(nextVerificationStatus('verified', 'revoke')).toBe('unverified');
    expect(nextVerificationStatus('unverified', 'revoke')).toBe('unverified');
  });
});

describe('separation of duties', () => {
  const request = { requestedBy: 'someone-else', status: 'pending' as const };

  it('lets staff decide a request they did not submit', () => {
    expect(canDecideVerification(actor(['platform_staff']), request)).toBe(true);
  });

  it('never lets the submitter decide their own request', () => {
    expect(
      canDecideVerification(actor(['platform_staff']), { ...request, requestedBy: 'user-1' }),
    ).toBe(false);
  });

  it('rejects non-staff, already-decided requests and anonymous actors', () => {
    expect(canDecideVerification(actor(['individual']), request)).toBe(false);
    expect(
      canDecideVerification(actor(['platform_admin']), { ...request, status: 'approved' }),
    ).toBe(false);
    expect(canDecideVerification({ userId: null, roles: ['platform_admin'] }, request)).toBe(false);
  });

  it('requires a substantive rejection reason', () => {
    expect(validateRejectionReason('forged')).toBe(false);
    expect(validateRejectionReason('  ' + 'x'.repeat(REJECTION_REASON_MIN_LENGTH))).toBe(true);
    expect(validateRejectionReason(null)).toBe(false);
  });
});

describe('document validation', () => {
  const owner = '5b0f0a3e-0000-4000-8000-000000000000';
  const docs = [
    { kind: 'national_id_front' as const, path: `${owner}/front.jpg`, mime: 'image/jpeg' },
    { kind: 'national_id_back' as const, path: `${owner}/back.jpg`, mime: 'image/jpeg' },
  ];

  it('accepts a complete, owned document set', () => {
    expect(validateDocuments('individual', docs, owner)).toEqual({ ok: true });
  });

  it('rejects a missing document by kind', () => {
    const result = validateDocuments('individual', [docs[0]!], owner);
    expect(result).toMatchObject({ ok: false, code: 'MISSING_DOCUMENT' });
  });

  it('rejects documents that live outside the submitter prefix', () => {
    const stolen = [{ ...docs[0]!, path: 'other-user/front.jpg' }, docs[1]!];
    expect(validateDocuments('individual', stolen, owner)).toMatchObject({
      ok: false,
      code: 'BAD_DOCUMENT',
    });
  });

  it('rejects traversal, absolute paths, oversized files and exotic mime types', () => {
    const bad = (path: string) => [{ ...docs[0]!, path }, docs[1]!];
    expect(validateDocuments('individual', bad(`${owner}/../x.jpg`), owner)).toMatchObject({
      code: 'BAD_DOCUMENT',
    });
    expect(validateDocuments('individual', bad(`/${owner}/x.jpg`), owner)).toMatchObject({
      code: 'BAD_DOCUMENT',
    });
    expect(
      validateDocuments(
        'individual',
        [{ ...docs[0]!, sizeBytes: 11 * 1024 * 1024 }, docs[1]!],
        owner,
      ),
    ).toMatchObject({ code: 'BAD_DOCUMENT' });
    expect(
      validateDocuments('individual', [{ ...docs[0]!, mime: 'text/html' }, docs[1]!], owner),
    ).toMatchObject({ code: 'BAD_DOCUMENT' });
    expect(ALLOWED_DOCUMENT_MIME).toContain('application/pdf');
  });

  it('requires a commercial registration for an organization', () => {
    expect(validateDocuments('organization', [docs[0]!, docs[1]!], owner)).toMatchObject({
      ok: false,
      code: 'MISSING_DOCUMENT',
    });
  });
});

describe('legal-identity edits invalidate a verification', () => {
  it('flags a changed national ID or legal name', () => {
    expect(
      editsInvalidateVerification([{ field: 'nationalIdNumber', before: '1', after: '2' }]),
    ).toBe(true);
    expect(editsInvalidateVerification([{ field: 'name', before: 'A', after: 'B' }])).toBe(true);
  });

  it('ignores cosmetic and non-identity edits', () => {
    // Whitespace-only edits must not cost the user a re-verification.
    expect(
      editsInvalidateVerification([{ field: 'nationalIdNumber', before: '1', after: ' 1 ' }]),
    ).toBe(false);
    expect(editsInvalidateVerification([{ field: 'phone', before: '1', after: '2' }])).toBe(false);
    expect(editsInvalidateVerification([{ field: 'avatarPath', before: 'a', after: 'b' }])).toBe(
      false,
    );
  });

  it('diffs only the fields that were provided', () => {
    const changes = diffFields({ name: 'A', phone: '1' }, { name: 'B', phone: '1' });
    expect(changes).toEqual([{ field: 'name', before: 'A', after: 'B' }]);
  });
});

describe('organization membership', () => {
  it('ranks owner above manager above staff roles', () => {
    expect(memberRank('owner')).toBeGreaterThan(memberRank('manager'));
    expect(memberRank('manager')).toBeGreaterThan(memberRank('accountant'));
    expect(memberRank('dispatcher')).toBe(memberRank('accountant'));
  });

  it('only lets owners and managers act downwards', () => {
    expect(canManageMember('owner', 'manager')).toBe(true);
    expect(canManageMember('manager', 'owner')).toBe(false);
    expect(canManageMember('accountant', 'manager')).toBe(false);
  });

  it('never allows inviting an owner, and restricts who a manager may invite', () => {
    expect(canInvite('owner', 'owner')).toBe(false);
    expect(canInvite('owner', 'manager')).toBe(true);
    expect(canInvite('manager', 'manager')).toBe(true);
    expect(canInvite('manager', 'owner')).toBe(false);
    expect(canInvite('accountant', 'dispatcher')).toBe(false);
  });

  it('protects the owner and yourself from removal', () => {
    expect(canRemoveMember('owner', 'owner', false)).toBe(false);
    expect(canRemoveMember('owner', 'manager', false)).toBe(true);
    expect(canRemoveMember('owner', 'manager', true)).toBe(false);
    expect(canRemoveMember('manager', 'manager', false)).toBe(false);
  });

  it('maps roles to org permissions', () => {
    expect(canInOrg('owner', 'member.remove')).toBe(true);
    expect(canInOrg('manager', 'member.remove')).toBe(false);
    expect(canInOrg('accountant', 'finance.view')).toBe(true);
    expect(canInOrg('accountant', 'member.invite')).toBe(false);
    expect(orgPermissions(null)).toEqual([]);
  });

  it('resolves a membership role and ignores non-active rows', () => {
    const members = [
      { userId: 'u1', orgId: 'o1', role: 'manager' as const, status: 'active' as const },
      { userId: 'u2', orgId: 'o1', role: 'owner' as const, status: 'removed' as const },
    ];
    expect(orgRoleOf('u1', members, 'o1')).toBe('manager');
    expect(orgRoleOf('u2', members, 'o1')).toBeNull();
    expect(orgRoleOf(null, members, 'o1')).toBeNull();
    expect(orgRoleOf('u1', members, 'o2')).toBeNull();
  });
});

describe('invites', () => {
  const now = new Date('2026-10-28T12:00:00Z');

  it('expires three days out', () => {
    expect(inviteExpiry(now).toISOString()).toBe('2026-10-31T12:00:00.000Z');
  });

  it('is usable only while invited and unexpired', () => {
    expect(inviteUsable({ status: 'invited', expiresAt: '2026-10-29T00:00:00Z' }, now)).toBe(true);
    expect(inviteUsable({ status: 'invited', expiresAt: '2026-10-27T00:00:00Z' }, now)).toBe(false);
    expect(inviteUsable({ status: 'active', expiresAt: '2026-10-29T00:00:00Z' }, now)).toBe(false);
    expect(inviteUsable({ status: 'invited', expiresAt: null }, now)).toBe(false);
  });

  it('accepts only 32-byte hex tokens', () => {
    expect(isValidInviteTokenFormat('a'.repeat(64))).toBe(true);
    expect(isValidInviteTokenFormat('A'.repeat(64))).toBe(false);
    expect(isValidInviteTokenFormat('a'.repeat(63))).toBe(false);
  });
});

describe('plans are quota-only, never a permission', () => {
  it('defaults to the lowest plan so a bug under-grants', () => {
    expect(effectivePlan()).toBe('basic');
    expect(planLimit('basic', 'vehicles')).toBe(1);
  });

  it('counts usage strictly below the limit', () => {
    expect(planAllows('basic', 'vehicles', 0)).toBe(true);
    expect(planAllows('basic', 'vehicles', 1)).toBe(false);
  });

  it('never lets a plan change what an actor may do', () => {
    const basicActor = { ...actor(['individual'], 'verified'), plan: 'basic' as const };
    const businessActor = { ...basicActor, plan: 'business' as const };
    expect(can(basicActor, 'vehicle.create')).toBe(can(businessActor, 'vehicle.create'));
  });
});

describe('platform role administration', () => {
  it('is admin-only', () => {
    expect(canManagePlatformRoles(actor(['platform_staff']), 'u2', 'finance_officer', 1)).toEqual({
      ok: false,
      reason: 'FORBIDDEN',
    });
  });

  it('refuses to demote the last admin', () => {
    expect(
      canManagePlatformRoles(actor(['platform_admin']), 'user-1', 'platform_admin', 1),
    ).toEqual({ ok: false, reason: 'SELF_LOCKOUT' });
    expect(
      canManagePlatformRoles(actor(['platform_admin']), 'user-1', 'platform_admin', 2),
    ).toEqual({ ok: true });
  });

  it('rejects roles outside the platform set', () => {
    expect(
      canManagePlatformRoles(actor(['platform_admin']), 'u2', 'driver' as Role, 3),
    ).toMatchObject({ reason: 'UNKNOWN_ROLE' });
  });
});

describe('onboarding progress', () => {
  const base = {
    hasProfile: true,
    identityComplete: true,
    documentsComplete: false,
    organizationChosen: false,
    verificationStatus: 'unverified' as const,
  };

  it('walks the wizard in order', () => {
    expect(nextOnboardingStep({ ...base, hasProfile: false })).toBe('profile');
    expect(nextOnboardingStep(base)).toBe('documents');
    expect(nextOnboardingStep({ ...base, documentsComplete: true })).toBe('organization');
    expect(nextOnboardingStep({ ...base, documentsComplete: true, organizationChosen: true })).toBe(
      'submit',
    );
    expect(nextOnboardingStep({ ...base, verificationStatus: 'pending' })).toBe('submit');
    expect(nextOnboardingStep({ ...base, verificationStatus: 'verified' })).toBe('done');
  });

  it('reports a monotonic percentage', () => {
    expect(onboardingProgress({ ...base, hasProfile: false })).toBe(0);
    expect(onboardingProgress({ ...base, verificationStatus: 'verified' })).toBe(100);
    expect(onboardingProgress(base)).toBeGreaterThan(0);
  });
});

describe('phase 1 capabilities', () => {
  it('lets anyone submit verification but only staff decide it', () => {
    expect(can(actor(['passenger']), 'verification.submit')).toBe(true);
    expect(can(actor(['passenger']), 'verification.decide')).toBe(false);
    expect(can(actor(['platform_staff']), 'verification.decide')).toBe(true);
  });

  it('scopes membership management to the organization', () => {
    expect(can(actor(['org_owner']), 'member.invite', { isOrgMember: true })).toBe(true);
    expect(can(actor(['org_owner']), 'member.invite', { isOrgMember: false })).toBe(false);
    expect(can(actor(['passenger']), 'member.invite', { isOrgMember: true })).toBe(false);
  });

  it('keeps role administration to admins', () => {
    expect(can(actor(['platform_staff']), 'role.manage')).toBe(false);
    expect(can(actor(['platform_admin']), 'role.manage')).toBe(true);
  });
});
