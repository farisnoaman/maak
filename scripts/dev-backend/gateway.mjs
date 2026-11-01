/**
 * `/functions/v1/*` for the dev stack.
 *
 * In production these are Deno edge functions (`supabase/functions/*`). This is a Node stand-in that
 * keeps the two properties that actually matter:
 *
 *   1. **one command per request** — every branch maps to exactly one `cmd_*` call;
 *   2. **the same contract** — schemas, command→argument mapping and the policy matrix are imported
 *      from `@maak/core` (bundled at startup), not re-written here.
 *
 * The `identity` branch mirrors `supabase/functions/identity/index.ts` argument for argument. Where
 * the edge function does something Deno-only (signed storage URLs, invite tokens, rate limiting) the
 * dev stack either does the Node equivalent or says so in the response.
 */

/**
 * Postgres exception → the client error contract.
 *
 * The status table and the prefix parser come from `@maak/core`, shared with the production gateway.
 * They used to be duplicated here, and the copies disagreed: a code the real gateway knew was
 * `INTERNAL` locally, so a defect that only showed up in dev could not be reproduced in production.
 */
export function mapDbError(error, core) {
  const message = String(error?.message ?? error);
  const code = core.errorCodeFromMessage(message);
  if (code) {
    return {
      status: core.HTTP_STATUS_BY_CODE[code] ?? 409,
      body: {
        code,
        detail: message.replace(new RegExp(`^\\s*${code}\\s*:?\\s*`), '').trim() || code,
      },
    };
  }
  // No prefix: the database refused on its own. A unique violation is the one a person can fix.
  if (error?.code === '23505') {
    return {
      status: 409,
      body: { code: 'DUPLICATE_REFERENCE', detail: 'That entry already exists' },
    };
  }
  if (error?.code === '42501') {
    return { status: 403, body: { code: 'FORBIDDEN', detail: message } };
  }
  return { status: 500, body: { code: 'INTERNAL', detail: message } };
}

/**
 * The actor shape the policy matrix expects, resolved from the database on every request.
 * Roles are never read from the token (see `supabase/functions/_shared/actor.ts`).
 */
export async function resolveActor(client, userId) {
  // Sequential on purpose: these share one connection, and overlapping `query()` calls on a single
  // pg client are deprecated (and would interleave inside the request's transaction).
  const profile = await client.query(
    'select verification_status, preferred_language from public.profiles where id = $1',
    [userId],
  );
  const roles = await client.query(
    'select role from public.user_roles where user_id = $1 and revoked_at is null',
    [userId],
  );
  const memberships = await client.query(
    `select org_id, role from public.organization_members where user_id = $1 and status = 'active'`,
    [userId],
  );
  const geo = await client.query(
    'select 1 from public.geo_assignments where user_id = $1 limit 1',
    [userId],
  );
  // `driver_profiles` only exists from Phase 3 onwards; ask the catalog before selecting from it.
  const driver = await client.query(
    `select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'driver_profiles'`,
  );

  if (!profile.rows[0]) throw new Error('INTERNAL: profile row missing for authenticated user');

  const ORG_ROLE_MAP = {
    owner: 'org_owner',
    manager: 'org_manager',
    accountant: 'org_accountant',
    dispatcher: 'org_manager',
  };

  const roleSet = ['passenger', 'individual', ...roles.rows.map((row) => row.role)];
  for (const membership of memberships.rows) {
    const mapped = ORG_ROLE_MAP[membership.role];
    if (mapped && !roleSet.includes(mapped)) roleSet.push(mapped);
  }
  const hasDriverTable = driver.rows.length > 0;
  if (hasDriverTable) {
    const driverRow = await client.query(
      'select 1 from public.driver_profiles where user_id = $1 and is_active limit 1',
      [userId],
    );
    if (driverRow.rows.length > 0) roleSet.push('driver');
  }

  return {
    actor: {
      userId,
      roles: roleSet,
      verification: profile.rows[0].verification_status,
      // Phase 0 default, exactly like `_shared/actor.ts`: Basic is the lowest plan, never unlimited.
      plan: 'basic',
      orgIds: memberships.rows.map((row) => row.org_id),
      hasGeoScope: geo.rows.length > 0,
    },
    orgIds: memberships.rows.map((row) => row.org_id),
    memberships: memberships.rows.map((row) => ({ orgId: row.org_id, role: row.role })),
    hasGeoScope: geo.rows.length > 0,
    preferredLanguage: profile.rows[0].preferred_language ?? 'ar',
  };
}

/** Runs one command with the actor passed explicitly, inside the caller's transaction. */
async function runCommand(client, fn, args) {
  const entries = Object.entries(args);
  const call = entries.map(([key], index) => `${key} => $${index + 1}`).join(', ');
  const { rows } = await client.query(
    `select public.${fn}(${call}) as result`,
    entries.map(([, value]) => value),
  );
  return rows[0]?.result ?? {};
}

const GEO_CAPABILITY = {
  'region.upsert': 'geo.manage',
  'geo.assignSupervisor': 'geo.assignSupervisor',
  'geo.revokeSupervisor': 'geo.assignSupervisor',
  'geo.import': 'geo.manage',
  'place.create': 'place.create',
  'place.decide': 'place.decide',
  'region.setActive': 'geo.manage',
  'place.setActive': 'place.setActive',
};

const TRIPS_CAPABILITY = {
  'trip.create': 'trip.create',
  'trip.update': 'trip.update',
  'trip.setStops': 'trip.update',
  'trip.publish': 'trip.update',
  'trip.submitVerification': 'trip.update',
  'trip.decideVerification': 'trip.verify',
  'trip.cancel': 'trip.cancel',
  'trip.start': 'trip.start',
  'trip.stopReached': 'trip.start',
  'trip.end': 'trip.start',
  'trip.recordPing': 'trip.start',
  'trip.bulkVerify': 'trip.verify',
  'trip.rotateQr': 'trip.update',
};

const BOOKINGS_CAPABILITY = {
  'booking.create': 'booking.create',
  'booking.setDocument': 'booking.create',
  'booking.accept': 'booking.accept',
  'booking.bulkAccept': 'booking.accept',
  'booking.reject': 'booking.accept',
  'booking.cancelByPassenger': 'booking.cancelAsPassenger',
  'booking.cancelByOperator': 'booking.cancelAsOperator',
  'booking.markNoShow': 'booking.accept',
  'booking.shareLink': 'booking.create',
};

const PAYMENTS_CAPABILITY = {
  'payment.account.create': 'payment.account.manageOwn',
  'payment.account.verify': 'payment.account.managePlatform',
  'payment.account.archive': 'payment.account.manageOwn',
  'payment.intent.create': 'payment.submit',
  'payment.proof.submit': 'payment.submit',
  'payment.intent.cancel': 'payment.submit',
  'payment.confirm': 'payment.confirm',
  'payment.reject': 'payment.confirm',
  'refund.request': 'payment.submit',
  'refund.decide': 'refund.approve',
  'refund.pay': 'refund.approve',
  'agent.cashIn': 'payment.account.manageOwn',
  'payout.request': 'payout.request',
  'payout.approve': 'payout.approve',
  'payout.pay': 'payout.approve',
};

/**
 * Phase 10. The edge function upgrades three of these at runtime (`finance.viewAll` for a platform-wide
 * read, and the desk-only actions), and so does the branch below — the map is the *default*, which is why
 * both sides can be compared key by key by check-guards.
 */
const FINANCE_CAPABILITY = {
  'finance.journal.post': 'finance.adjust',
  'finance.journal.reverse': 'finance.adjust',
  'expense.record': 'expense.record',
  'expense.void': 'expense.void',
  'subscription.start': 'subscription.manage',
  'subscription.changePlan': 'subscription.manage',
  'subscription.cancel': 'subscription.manage',
  'invoice.pay': 'invoice.manage',
  'invoice.void': 'invoice.manage',
  'finance.export': 'finance.viewOwn',
  'finance.reconciliation.import': 'reconciliation.manage',
  'finance.reconciliation.resolve': 'reconciliation.manage',
  'plan.update': 'plan.manage',
  'commission.rule.save': 'commission.manage',
  'quota.override.grant': 'quota.override',
  'quota.override.revoke': 'quota.override',
  'finance.dashboard': 'finance.viewOwn',
  'finance.statement': 'finance.viewOwn',
  'finance.job.run': 'finance.viewAll',
};

/**
 * Phase 11. One map, one capability per action. The worker actions are staff-only: claiming the delivery
 * queue reads other people's notifications, which is exactly why the cron is not a client.
 */
const NOTIFICATION_CAPABILITY = {
  'notifications.list': 'notification.read',
  'notifications.read': 'notification.read',
  'notifications.settings': 'notification.preferences',
  'notifications.preference.set': 'notification.preferences',
  'notifications.preference.reset': 'notification.preferences',
  'notifications.settings.update': 'notification.preferences',
  'notifications.device.register': 'notification.preferences',
  'notifications.device.revoke': 'notification.preferences',
  'notifications.health': 'notification.health',
  'search.save': 'notification.savedSearch',
  'search.list': 'notification.savedSearch',
  'search.update': 'notification.savedSearch',
  'search.delete': 'notification.savedSearch',
  'notifications.dispatch': 'notification.dispatch',
  'notifications.delivery.record': 'notification.dispatch',
  'notifications.job.run': 'notification.dispatch',
};

/** Finance-desk work, whatever scope it is called with. Mirrors `PLATFORM_ONLY` in the edge function. */
const FINANCE_PLATFORM_ONLY = new Set([
  'finance.journal.post',
  'finance.journal.reverse',
  'invoice.pay',
  'invoice.void',
  'finance.reconciliation.import',
  'finance.reconciliation.resolve',
  'finance.job.run',
]);

const FLEET_CAPABILITY = {
  'vehicle.create': 'vehicle.create',
  'vehicle.update': 'vehicle.update',
  'vehicle.submitVerification': 'vehicle.update',
  'vehicle.decide': 'vehicle.verify',
  'vehicle.setStatus': 'vehicle.setStatus',
  'vehicle.setPhotos': 'vehicle.update',
  'driver.invite': 'driver.invite',
  'driver.accept': 'driver.accept',
  'driver.setLicence': 'driver.setLicence',
  'driver.verify': 'driver.verify',
  'driver.assign': 'driver.assign',
  'driver.unassign': 'driver.assign',
  'fuel.log': 'fuel.log',
  'odometer.record': 'odometer.record',
  'maintenance.log': 'maintenance.log',
  'maintenance.schedule': 'maintenance.schedule',
  'maintenance.done': 'maintenance.complete',
  'fleet.settings': 'fleet.settings',
};

function invalid(fields) {
  return { status: 422, body: { code: 'VALIDATION_FAILED', fields } };
}

function mapZod(error) {
  const fields = {};
  for (const issue of error.issues) fields[issue.path.join('.') || '_'] = issue.message;
  return invalid(fields);
}

/**
 * Dispatches a gateway call. `core` is the bundle of `@maak/core`; `client` is the privileged
 * Postgres connection (the analogue of the edge function's service-role client).
 */
export async function handleFunction({ name, body, userId, client, core, requestId }) {
  if (name === 'me') {
    const resolved = await resolveActor(client, userId);
    const contexts = core.capabilityContexts(resolved.actor, resolved.memberships);
    return {
      status: 200,
      body: {
        user: {
          id: userId,
          roles: resolved.actor.roles,
          verification: resolved.actor.verification,
          plan: resolved.actor.plan,
          preferredLanguage: resolved.preferredLanguage,
          organizations: resolved.orgIds,
          memberships: resolved.memberships,
          hasGeoScope: resolved.hasGeoScope,
        },
        contexts,
        capabilities: contexts[0]?.capabilities ?? [],
        flags: {
          isOperator: core.isOperator(resolved.actor),
          isStaff: core.isPlatformStaff(resolved.actor),
          canOperate: core.isOperator(resolved.actor) && resolved.actor.verification === 'verified',
        },
        requestId,
      },
    };
  }

  if (name === 'geography') {
    const parsed = core.geoActionSchema.safeParse(body);
    if (!parsed.success) return mapZod(parsed.error);

    const resolved = await resolveActor(client, userId);
    try {
      core.requirePolicy(resolved.actor, GEO_CAPABILITY[parsed.data.action]);
    } catch (error) {
      return { status: 403, body: { code: 'FORBIDDEN', detail: String(error.message) } };
    }

    const { fn, args } = core.geoCommandArgs(parsed.data, userId, {
      p_request_id: requestId,
      p_ip: null,
    });
    try {
      const result = await runCommand(client, fn, args);
      return { status: 200, body: { ...result, requestId } };
    } catch (error) {
      const mapped = mapDbError(error, core);
      return { ...mapped, body: { ...mapped.body, requestId } };
    }
  }

  if (name === 'fleet') {
    const parsed = core.fleetActionSchema.safeParse(body);
    if (!parsed.success) return mapZod(parsed.error);

    const resolved = await resolveActor(client, userId);
    const denial = core.policyDenial(
      resolved.actor,
      FLEET_CAPABILITY[parsed.data.action],
      core.fleetScope(parsed.data),
    );
    if (denial) {
      // The same code the SQL command raises, so the client's message is the same either way.
      return {
        status: denial === 'UNAUTHENTICATED' ? 401 : 403,
        body: {
          code: denial,
          detail:
            denial === 'NOT_VERIFIED'
              ? 'Account is not verified'
              : 'You do not have permission to perform this action',
        },
      };
    }

    const { fn, args } = core.fleetCommandArgs(parsed.data, userId, {
      p_request_id: requestId,
      p_ip: null,
    });
    try {
      const result = await runCommand(client, fn, args);
      return { status: 200, body: { ...result, requestId } };
    } catch (error) {
      const mapped = mapDbError(error, core);
      return { ...mapped, body: { ...mapped.body, requestId } };
    }
  }

  if (name === 'trips') {
    const parsed = core.tripsActionSchema.safeParse(body);
    if (!parsed.success) return mapZod(parsed.error);

    const resolved = await resolveActor(client, userId);
    const denial = core.policyDenial(
      resolved.actor,
      TRIPS_CAPABILITY[parsed.data.action],
      core.tripsScope(parsed.data),
    );
    if (denial) {
      return {
        status: denial === 'UNAUTHENTICATED' ? 401 : 403,
        body: {
          code: denial,
          detail:
            denial === 'NOT_VERIFIED'
              ? 'Account is not verified'
              : 'You do not have permission to perform this action',
        },
      };
    }

    const { fn, args } = core.tripsCommandArgs(parsed.data, userId, {
      p_request_id: requestId,
      p_ip: null,
    });
    try {
      const result = await runCommand(client, fn, args);
      return { status: 200, body: { ...result, requestId } };
    } catch (error) {
      const mapped = mapDbError(error, core);
      return { ...mapped, body: { ...mapped.body, requestId } };
    }
  }

  if (name === 'bookings') {
    const parsed = core.bookingsActionSchema.safeParse(body);
    if (!parsed.success) return mapZod(parsed.error);

    const resolved = await resolveActor(client, userId);
    const denial = core.policyDenial(
      resolved.actor,
      BOOKINGS_CAPABILITY[parsed.data.action],
      core.bookingsScope(parsed.data),
    );
    if (denial) {
      return {
        status: denial === 'UNAUTHENTICATED' ? 401 : 403,
        body: {
          code: denial,
          detail:
            denial === 'NOT_VERIFIED'
              ? 'Account is not verified'
              : 'You do not have permission to perform this action',
        },
      };
    }

    const { fn, args } = core.bookingsCommandArgs(parsed.data, userId, {
      p_request_id: requestId,
      p_ip: null,
    });
    try {
      const result = await runCommand(client, fn, args);
      return { status: 200, body: { ...result, requestId } };
    } catch (error) {
      const mapped = mapDbError(error, core);
      return { ...mapped, body: { ...mapped.body, requestId } };
    }
  }

  if (name === 'payments') {
    const parsed = core.paymentsActionSchema.safeParse(body);
    if (!parsed.success) return mapZod(parsed.error);

    const resolved = await resolveActor(client, userId);
    // One action's capability depends on its payload: a platform account is finance's to open.
    const capability =
      parsed.data.action === 'payment.account.create' && parsed.data.kind === 'platform'
        ? 'payment.account.managePlatform'
        : PAYMENTS_CAPABILITY[parsed.data.action];
    const denial = core.policyDenial(resolved.actor, capability, core.paymentsScope(parsed.data));
    if (denial) {
      return {
        status: denial === 'UNAUTHENTICATED' ? 401 : 403,
        body: {
          code: denial,
          detail:
            denial === 'NOT_VERIFIED'
              ? 'Account is not verified'
              : 'You do not have permission to perform this action',
        },
      };
    }

    const { fn, args } = core.paymentsCommandArgs(parsed.data, userId, {
      p_request_id: requestId,
      p_ip: null,
    });
    try {
      const result = await runCommand(client, fn, args);
      return { status: 200, body: { ...result, requestId } };
    } catch (error) {
      const mapped = mapDbError(error, core);
      return { ...mapped, body: { ...mapped.body, requestId } };
    }
  }

  if (name === 'finance') {
    const parsed = core.financeActionSchema.safeParse(body);
    if (!parsed.success) return mapZod(parsed.error);

    const input = parsed.data;
    const resolved = await resolveActor(client, userId);
    const capability = FINANCE_PLATFORM_ONLY.has(input.action)
      ? 'finance.viewAll'
      : input.action === 'finance.dashboard' || input.action === 'finance.statement'
        ? input.platform
          ? 'finance.viewAll'
          : 'finance.viewOwn'
        : FINANCE_CAPABILITY[input.action];
    const denial = core.policyDenial(resolved.actor, capability, core.financeScope(input));
    if (denial) {
      return {
        status: denial === 'UNAUTHENTICATED' ? 401 : 403,
        body: {
          code: denial,
          detail:
            denial === 'NOT_VERIFIED'
              ? 'Account is not verified'
              : 'You do not have permission to perform this action',
        },
      };
    }

    const { fn, args } = core.financeCommandArgs(input, userId, {
      p_request_id: requestId,
      p_ip: null,
    });
    try {
      const result = await runCommand(client, fn, args);
      return { status: 200, body: { ...result, requestId } };
    } catch (error) {
      const mapped = mapDbError(error, core);
      return { ...mapped, body: { ...mapped.body, requestId } };
    }
  }

  if (name === 'dispatch') {
    const parsed = core.notificationActionSchema.safeParse(body);
    if (!parsed.success) return mapZod(parsed.error);

    const input = parsed.data;
    const resolved = await resolveActor(client, userId);
    const denial = core.policyDenial(
      resolved.actor,
      NOTIFICATION_CAPABILITY[input.action],
      core.notificationScope(input),
    );
    if (denial) {
      return {
        status: denial === 'UNAUTHENTICATED' ? 401 : 403,
        body: {
          code: denial,
          detail:
            denial === 'NOT_VERIFIED'
              ? 'Account is not verified'
              : 'You do not have permission to perform this action',
        },
      };
    }

    const { fn, args } = core.notificationCommandArgs(input, userId, {
      p_request_id: requestId,
      p_ip: null,
    });
    try {
      const result = await runCommand(client, fn, args);
      return { status: 200, body: { ...result, requestId } };
    } catch (error) {
      const mapped = mapDbError(error, core);
      return { ...mapped, body: { ...mapped.body, requestId } };
    }
  }

  if (name === 'identity') {
    const parsed = core.identityActionSchema.safeParse(body);
    if (!parsed.success) return mapZod(parsed.error);

    const resolved = await resolveActor(client, userId);
    const actorId = userId;
    const orgIds = resolved.orgIds;
    const input = parsed.data;
    const audit = { p_request_id: requestId, p_ip: null };
    const forbidden = (detail) => ({ status: 403, body: { code: 'FORBIDDEN', detail } });
    const requirePolicy = (capability) => core.requirePolicy(resolved.actor, capability);

    let fn;
    let args;

    switch (input.action) {
      case 'profile.setLocale':
        fn = 'cmd_set_preferred_locale';
        args = { p_actor: actorId, p_locale: input.locale, ...audit };
        break;

      case 'profile.update':
        if (input.avatarPath && !input.avatarPath.startsWith(`${actorId}/`)) {
          return invalid({ avatarPath: 'must live under your own folder' });
        }
        fn = 'cmd_update_profile';
        args = {
          p_actor: actorId,
          p_full_name: input.fullName ?? null,
          p_national_id_type: input.nationalIdType ?? null,
          p_national_id_number: input.nationalIdNumber ?? null,
          p_birth_place: input.birthPlace ?? null,
          p_date_of_birth: input.dateOfBirth ?? null,
          p_avatar_path: input.avatarPath ?? null,
          ...audit,
        };
        break;

      case 'organization.create': {
        requirePolicy('org.create');
        const phone = input.phone ? core.normalizeYemeniPhone(input.phone) : null;
        if (input.phone && !phone) return invalid({ phone: 'not a Yemeni mobile number' });
        fn = 'cmd_create_organization';
        args = {
          p_actor: actorId,
          p_name: input.name,
          p_name_en: input.nameEn ?? null,
          p_kind: input.kind,
          p_registration_no: input.registrationNo ?? null,
          p_phone: phone,
          p_email: input.email ?? null,
          ...audit,
        };
        break;
      }

      case 'organization.update': {
        if (!orgIds.includes(input.orgId)) return forbidden('Not a member of this organization');
        requirePolicy('org.update');
        const phone = input.phone ? core.normalizeYemeniPhone(input.phone) : null;
        if (input.phone && !phone) return invalid({ phone: 'not a Yemeni mobile number' });
        fn = 'cmd_update_organization';
        args = {
          p_actor: actorId,
          p_org_id: input.orgId,
          p_name: input.name ?? null,
          p_name_en: input.nameEn ?? null,
          p_phone: phone,
          p_email: input.email ?? null,
          p_registration_no: input.registrationNo ?? null,
          p_tax_no: input.taxNo ?? null,
          ...audit,
        };
        break;
      }

      case 'member.invite': {
        if (!orgIds.includes(input.orgId)) return forbidden('Not a member of this organization');
        requirePolicy('member.invite');
        const phone = input.phone ? core.normalizeYemeniPhone(input.phone) : null;
        if (input.phone && !phone) return invalid({ phone: 'not a Yemeni mobile number' });
        const { randomBytes, createHash } = await import('node:crypto');
        const token = randomBytes(32).toString('hex');
        fn = 'cmd_invite_member';
        args = {
          p_actor: actorId,
          p_org_id: input.orgId,
          p_role: input.role,
          p_email: input.email ?? null,
          p_phone: phone,
          p_token_hash: createHash('sha256').update(token).digest('hex'),
          p_expires_at: new Date(Date.now() + 72 * 3600_000).toISOString(),
          ...audit,
        };
        break;
      }

      case 'member.accept':
        fn = 'cmd_accept_invite';
        args = { p_actor: actorId, p_member_id: input.memberId, p_token: input.token, ...audit };
        break;

      case 'member.remove':
        requirePolicy('member.remove');
        fn = 'cmd_remove_member';
        args = {
          p_actor: actorId,
          p_member_id: input.memberId,
          p_reason: input.reason ?? null,
          ...audit,
        };
        break;

      case 'organization.transferOwnership':
        if (!orgIds.includes(input.orgId)) return forbidden('Not a member of this organization');
        fn = 'cmd_transfer_ownership';
        args = {
          p_actor: actorId,
          p_org_id: input.orgId,
          p_member_id: input.memberId,
          p_reason: input.reason ?? null,
          ...audit,
        };
        break;

      case 'member.leave':
        if (!orgIds.includes(input.orgId)) return forbidden('Not a member of this organization');
        fn = 'cmd_leave_organization';
        args = { p_actor: actorId, p_org_id: input.orgId, ...audit };
        break;

      case 'account.requestDeletion':
        fn = 'cmd_request_account_deletion';
        args = { p_actor: actorId, p_reason: input.reason ?? null, ...audit };
        break;

      case 'account.cancelDeletion':
        fn = 'cmd_cancel_account_deletion';
        args = { p_actor: actorId, ...audit };
        break;

      case 'verification.submit': {
        requirePolicy('verification.submit');
        if (input.subjectType === 'individual') {
          if (input.subjectId !== actorId)
            return forbidden('You may only submit your own verification');
        } else if (!orgIds.includes(input.subjectId)) {
          return forbidden('Not a member of this organization');
        }
        const check = core.validateDocuments(input.subjectType, input.documents, actorId);
        if (!check.ok) {
          return {
            status: 400,
            body: {
              code: check.code === 'MISSING_DOCUMENT' ? 'MISSING_DOCUMENT' : 'VALIDATION_FAILED',
              detail: check.detail,
            },
          };
        }
        fn = 'cmd_submit_verification';
        args = {
          p_actor: actorId,
          p_subject_type: input.subjectType,
          p_subject_id: input.subjectId,
          p_documents: input.documents,
          p_snapshot: input.snapshot ?? {},
          p_note: input.note ?? null,
          ...audit,
        };
        break;
      }

      case 'verification.decide':
        requirePolicy('verification.decide');
        if (input.outcome === 'reject' && (input.reason ?? '').trim().length < 10) {
          return invalid({ reason: 'a rejection needs at least 10 characters' });
        }
        fn = 'cmd_decide_verification';
        args = {
          p_actor: actorId,
          p_verification_id: input.requestId,
          p_outcome: input.outcome,
          p_reason: input.reason ?? null,
          ...audit,
        };
        break;

      case 'role.grant':
        requirePolicy('role.manage');
        fn = 'cmd_grant_role';
        args = {
          p_actor: actorId,
          p_target: input.userId,
          p_role: input.role,
          p_reason: input.reason ?? null,
          ...audit,
        };
        break;

      case 'role.revoke':
        requirePolicy('role.manage');
        fn = 'cmd_revoke_role';
        args = {
          p_actor: actorId,
          p_target: input.userId,
          p_role: input.role,
          p_reason: input.reason ?? null,
          ...audit,
        };
        break;

      case 'notification.read':
        requirePolicy('notification.read');
        fn = 'cmd_mark_notifications_read';
        args = { p_actor: actorId, p_ids: input.ids ?? null, p_request_id: requestId };
        break;

      default:
        return {
          status: 422,
          body: { code: 'VALIDATION_FAILED', fields: { action: 'unsupported' } },
        };
    }

    try {
      const result = await runCommand(client, fn, args);
      return { status: 200, body: { ...result, requestId } };
    } catch (error) {
      if (error instanceof core.PolicyError) {
        return { status: 403, body: { code: 'FORBIDDEN', detail: error.message } };
      }
      const mapped = mapDbError(error, core);
      return { ...mapped, body: { ...mapped.body, requestId } };
    }
  }

  if (name === 'verification-queue') {
    // Read-only. The real function signs document URLs; the dev stack returns paths, no signatures.
    const status = body?.status ?? 'pending';
    const { rows } = await client.query(
      `select vr.id, vr.subject_type, vr.subject_id, vr.requested_by, vr.status, vr.created_at,
              vr.note, vr.snapshot, coalesce(p.full_name, o.name) as subject_name
         from public.verification_requests vr
         left join public.profiles p on vr.subject_type = 'individual' and p.id = vr.subject_id
         left join public.organizations o on vr.subject_type = 'organization' and o.id = vr.subject_id
        where ($1::text = 'all' or vr.status::text = $1)
        order by vr.created_at asc
        limit 50`,
      [status],
    );

    return {
      status: 200,
      body: {
        items: rows.map((row) => ({
          id: row.id,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          requestedBy: row.requested_by,
          subjectName: row.subject_name,
          status: row.status,
          createdAt: row.created_at,
          note: row.note,
          snapshot: row.snapshot,
          documents: [],
        })),
        requestId,
      },
    };
  }

  if (name === 'health') {
    const { rows } = await client.query('select 1 as ok');
    return { status: 200, body: { ok: rows[0].ok === 1, backend: 'dev', requestId } };
  }

  return { status: 404, body: { code: 'NOT_FOUND', detail: `unknown function ${name}` } };
}
