/**
 * identity — every Phase 1 write (profile, organization, membership, verification, roles).
 *
 * One function, one `action` discriminator, and exactly one `cmd_*` call per request: the union
 * below is the whole write surface, which is far easier to audit than a dozen endpoints.
 *
 * Authorisation is checked twice on purpose: here with the shared policy matrix (so the client gets
 * a clean 403 without touching the database) and again inside the SQL command (so a compromised
 * gateway cannot skip it).
 */

import {
  can,
  identityActionSchema,
  normalizeYemeniPhone,
  requirePolicy,
  validateDocuments,
} from '@maak/core';
import { defineCommand } from '../_shared/handler.ts';
import { createDb } from '../_shared/db.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';
import { ApiError, forbidden, invalid } from '../_shared/errors.ts';

const schema = identityActionSchema;

export default defineCommand({ schema }, async (ctx) => {
  const { actor, orgIds } = ctx.resolved;
  const actorId = actor.userId as string;
  const db = createDb({ requestId: ctx.requestId });

  // A single `rpc` call site keeps the "one write per command" rule visible (and lintable).
  const run = (fn: string, args: Record<string, unknown>) =>
    db.rpc<Record<string, unknown>>(fn, args);

  const audit = { p_request_id: ctx.requestId, p_ip: ctx.ip };
  const input = ctx.input;

  switch (input.action) {
    case 'profile.setLocale': {
      const result = await run('cmd_set_preferred_locale', {
        p_actor: actorId,
        p_locale: input.locale,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'profile.update': {
      if (input.avatarPath && !input.avatarPath.startsWith(`${actorId}/`)) {
        throw invalid({ avatarPath: 'must live under your own folder' });
      }
      const result = await run('cmd_update_profile', {
        p_actor: actorId,
        p_full_name: input.fullName ?? null,
        p_national_id_type: input.nationalIdType ?? null,
        p_national_id_number: input.nationalIdNumber ?? null,
        p_birth_place: input.birthPlace ?? null,
        p_date_of_birth: input.dateOfBirth ?? null,
        p_avatar_path: input.avatarPath ?? null,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'organization.create': {
      requirePolicy(actor, 'org.create');
      const phone = input.phone ? normalizeYemeniPhone(input.phone) : null;
      if (input.phone && !phone) throw invalid({ phone: 'not a Yemeni mobile number' });

      const result = await run('cmd_create_organization', {
        p_actor: actorId,
        p_name: input.name,
        p_name_en: input.nameEn ?? null,
        p_kind: input.kind,
        p_registration_no: input.registrationNo ?? null,
        p_phone: phone,
        p_email: input.email ?? null,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'organization.update': {
      if (!orgIds.includes(input.orgId)) throw forbidden('Not a member of this organization');
      requirePolicy(actor, 'org.update', { isOrgMember: true });

      const phone = input.phone ? normalizeYemeniPhone(input.phone) : null;
      if (input.phone && !phone) throw invalid({ phone: 'not a Yemeni mobile number' });

      const result = await run('cmd_update_organization', {
        p_actor: actorId,
        p_org_id: input.orgId,
        p_name: input.name ?? null,
        p_name_en: input.nameEn ?? null,
        p_phone: phone,
        p_email: input.email ?? null,
        p_registration_no: input.registrationNo ?? null,
        p_tax_no: input.taxNo ?? null,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'member.invite': {
      if (!orgIds.includes(input.orgId)) throw forbidden('Not a member of this organization');
      requirePolicy(actor, 'member.invite', { isOrgMember: true });
      if (!can(actor, 'member.invite', { isOrgMember: true })) throw forbidden();

      const phone = input.phone ? normalizeYemeniPhone(input.phone) : null;
      if (input.phone && !phone) throw invalid({ phone: 'not a Yemeni mobile number' });

      // The raw token is generated here and returned once; only its hash reaches the database.
      const token = randomHex(32);
      const tokenHash = await sha256Hex(token);
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

      await enforceRateLimit(actorId, 'member.invite');

      const result = await run('cmd_invite_member', {
        p_actor: actorId,
        p_org_id: input.orgId,
        p_role: input.role,
        p_email: input.email ?? null,
        p_phone: phone,
        p_token_hash: tokenHash,
        p_expires_at: expiresAt,
        ...audit,
      });

      return {
        ...result,
        // Shown to the inviter once, so they can share the link on WhatsApp.
        inviteToken: token,
        requestId: ctx.requestId,
      };
    }

    case 'member.accept': {
      await enforceRateLimit(actorId, 'member.accept');
      const result = await run('cmd_accept_invite', {
        p_actor: actorId,
        p_member_id: input.memberId,
        p_token: input.token,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'member.remove': {
      requirePolicy(actor, 'member.remove');
      await enforceRateLimit(actorId, 'member.remove');
      const result = await run('cmd_remove_member', {
        p_actor: actorId,
        p_member_id: input.memberId,
        p_reason: input.reason ?? null,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'organization.transferOwnership': {
      if (!orgIds.includes(input.orgId)) throw forbidden('Not a member of this organization');
      await enforceRateLimit(actorId, 'organization.transferOwnership');
      const result = await run('cmd_transfer_ownership', {
        p_actor: actorId,
        p_org_id: input.orgId,
        p_member_id: input.memberId,
        p_reason: input.reason ?? null,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'member.leave': {
      if (!orgIds.includes(input.orgId)) throw forbidden('Not a member of this organization');
      const result = await run('cmd_leave_organization', {
        p_actor: actorId,
        p_org_id: input.orgId,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'account.requestDeletion': {
      await enforceRateLimit(actorId, 'account.requestDeletion', {
        limit: 3,
        windowSeconds: 86400,
      });
      const result = await run('cmd_request_account_deletion', {
        p_actor: actorId,
        p_reason: input.reason ?? null,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'account.cancelDeletion': {
      const result = await run('cmd_cancel_account_deletion', {
        p_actor: actorId,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'account.delete': {
      // `platform_admin` only, and `cmd_delete_account` refuses the actor's own account on top of that: the
      // clean 403 here is for the client, the rule is the one in SQL.
      requirePolicy(actor, 'account.delete');
      await enforceRateLimit(actorId, 'account.delete');
      const result = await run('cmd_delete_account', {
        p_actor: actorId,
        p_user_id: input.userId,
        p_reason: input.reason,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'verification.submit': {
      requirePolicy(actor, 'verification.submit');

      if (input.subjectType === 'individual') {
        if (input.subjectId !== actorId)
          throw forbidden('You may only submit your own verification');
      } else if (!orgIds.includes(input.subjectId)) {
        throw forbidden('Not a member of this organization');
      }

      // Cheap, deterministic checks before the database: missing documents are a 400, not a 500.
      const check = validateDocuments(input.subjectType, input.documents, actorId);
      if (!check.ok) {
        throw new ApiError(
          400,
          check.code === 'MISSING_DOCUMENT' ? 'MISSING_DOCUMENT' : 'VALIDATION_FAILED',
          check.detail,
        );
      }

      await enforceRateLimit(actorId, 'verification.submit', { limit: 5, windowSeconds: 3600 });

      const result = await run('cmd_submit_verification', {
        p_actor: actorId,
        p_subject_type: input.subjectType,
        p_subject_id: input.subjectId,
        p_documents: input.documents,
        p_snapshot: input.snapshot ?? {},
        p_note: input.note ?? null,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'verification.decide': {
      requirePolicy(actor, 'verification.decide');

      if (input.outcome === 'reject' && (input.reason ?? '').trim().length < 10) {
        throw invalid({ reason: 'a rejection needs at least 10 characters' });
      }

      await enforceRateLimit(actorId, 'verification.decide');

      const result = await run('cmd_decide_verification', {
        p_actor: actorId,
        p_verification_id: input.requestId,
        p_outcome: input.outcome,
        p_reason: input.reason ?? null,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'role.grant': {
      requirePolicy(actor, 'role.manage');
      await enforceRateLimit(actorId, 'role.grant');
      const result = await run('cmd_grant_role', {
        p_actor: actorId,
        p_target: input.userId,
        p_role: input.role,
        p_reason: input.reason ?? null,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'role.revoke': {
      requirePolicy(actor, 'role.manage');
      await enforceRateLimit(actorId, 'role.revoke');
      const result = await run('cmd_revoke_role', {
        p_actor: actorId,
        p_target: input.userId,
        p_role: input.role,
        p_reason: input.reason ?? null,
        ...audit,
      });
      return { ...result, requestId: ctx.requestId };
    }

    case 'notification.read': {
      requirePolicy(actor, 'notification.read');
      const result = await run('cmd_mark_notifications_read', {
        p_actor: actorId,
        p_ids: input.ids ?? null,
        p_request_id: ctx.requestId,
      });
      return { ...result, requestId: ctx.requestId };
    }

    default:
      // Unreachable: the discriminated union and this switch are checked together by `tsc`.
      throw invalid({ action: 'unsupported' });
  }
});

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
