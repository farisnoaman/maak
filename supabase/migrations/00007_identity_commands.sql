-- 00007 — Phase 1 commands (the only write path for identity, accounts and verification)
--
-- Every function here:
--   · takes the actor as p_actor (the edge gateway resolved it from the JWT, never the client),
--   · re-checks the permission in SQL (the TypeScript policy is a convenience, not the authority),
--   · writes exactly one audit row, and any notifications, in the SAME transaction,
--   · is executable by service_role only. Clients have no path to these functions (00003).
--
-- Errors are raised as `CODE: detail` so the edge gateway can map them onto the API contract
-- without leaking a stack trace or a row of another tenant.

-- ---------------------------------------------------------------------------
-- Preferences and profile
-- ---------------------------------------------------------------------------

create or replace function public.cmd_set_preferred_locale(
  p_actor uuid,
  p_locale text,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before text;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_locale is null or p_locale not in ('ar', 'en') then
    raise exception 'VALIDATION_FAILED: locale must be ar or en' using errcode = '22023';
  end if;

  select p.preferred_language into v_before from public.profiles p where p.id = p_actor;
  if v_before is null then
    raise exception 'NOT_FOUND: profile' using errcode = 'P0002';
  end if;

  update public.profiles set preferred_language = p_locale where id = p_actor;

  perform app.write_audit(
    p_actor, 'profile.locale', 'profile', p_actor::text,
    jsonb_build_object('preferred_language', v_before),
    jsonb_build_object('preferred_language', p_locale),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('preferredLanguage', p_locale);
end;
$$;

create or replace function public.cmd_update_profile(
  p_actor uuid,
  p_full_name text default null,
  p_national_id_type text default null,
  p_national_id_number text default null,
  p_birth_place text default null,
  p_date_of_birth date default null,
  p_avatar_path text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.profiles%rowtype;
  v_after public.profiles%rowtype;
  v_identity_changed boolean;
  v_status public.verification_status;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_before from public.profiles where id = p_actor;
  if not found then
    raise exception 'NOT_FOUND: profile' using errcode = 'P0002';
  end if;

  if p_national_id_type is not null
     and p_national_id_type not in ('national_id', 'passport', 'residence') then
    raise exception 'VALIDATION_FAILED: national_id_type' using errcode = '22023';
  end if;

  if p_avatar_path is not null
     and (p_avatar_path like '/%' or p_avatar_path like '%..%'
          or p_avatar_path not like p_actor::text || '/%') then
    raise exception 'VALIDATION_FAILED: avatar_path' using errcode = '22023';
  end if;

  update public.profiles
  set
    full_name         = coalesce(p_full_name, full_name),
    national_id_type  = coalesce(p_national_id_type, national_id_type),
    national_id_number = coalesce(p_national_id_number, national_id_number),
    birth_place       = coalesce(p_birth_place, birth_place),
    date_of_birth     = coalesce(p_date_of_birth, date_of_birth),
    avatar_path       = coalesce(p_avatar_path, avatar_path)
  where id = p_actor
  returning * into v_after;

  -- Legal identity edits invalidate an existing verification: a verified account cannot become
  -- a different legal person without a fresh review.
  v_identity_changed :=
       btrim(coalesce(v_before.full_name, '')) <> btrim(coalesce(v_after.full_name, ''))
    or btrim(coalesce(v_before.national_id_number, '')) <> btrim(coalesce(v_after.national_id_number, ''))
    or btrim(coalesce(v_before.birth_place, '')) <> btrim(coalesce(v_after.birth_place, ''))
    or coalesce(v_before.national_id_type, '') <> coalesce(v_after.national_id_type, '');

  v_status := v_after.verification_status;

  if v_identity_changed and v_after.verification_status = 'verified' then
    v_status := 'unverified';
    update public.profiles set verification_status = 'unverified' where id = p_actor;
    perform app.notify(
      p_actor, 'verification_invalidated', 'notifications.verificationInvalidated',
      '{}'::jsonb, '/account/verification'
    );
    perform app.write_audit(
      p_actor, 'profile.verification_invalidated', 'profile', p_actor::text,
      jsonb_build_object('verification_status', 'verified'),
      jsonb_build_object('verification_status', 'unverified'),
      'legal identity fields changed', p_request_id, p_ip
    );
  end if;

  if v_identity_changed and v_after.verification_status = 'pending' then
    -- An open request describes the old values; close it so staff never approve stale data.
    update public.verification_requests
    set status = 'withdrawn', decision_at = now(), decision_note = 'profile edited'
    where subject_type = 'individual' and subject_id = p_actor and status = 'pending';
    v_status := 'unverified';
    update public.profiles set verification_status = 'unverified' where id = p_actor;
  end if;

  perform app.write_audit(
    p_actor, 'profile.update', 'profile', p_actor::text,
    jsonb_build_object(
      'full_name', v_before.full_name,
      'national_id_type', v_before.national_id_type,
      'national_id_number', case when v_before.national_id_number is null then null else 'redacted' end,
      'birth_place', v_before.birth_place,
      'avatar_path', v_before.avatar_path
    ),
    jsonb_build_object(
      'full_name', v_after.full_name,
      'national_id_type', v_after.national_id_type,
      'national_id_number', case when v_after.national_id_number is null then null else 'redacted' end,
      'birth_place', v_after.birth_place,
      'avatar_path', v_after.avatar_path
    ),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'profile', jsonb_build_object(
      'id', v_after.id,
      'fullName', v_after.full_name,
      'phone', v_after.phone,
      'nationalIdType', v_after.national_id_type,
      'birthPlace', v_after.birth_place,
      'avatarPath', v_after.avatar_path,
      'verificationStatus', v_status
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Organizations and membership
-- ---------------------------------------------------------------------------

create or replace function public.cmd_create_organization(
  p_actor uuid,
  p_name text,
  p_name_en text default null,
  p_kind public.org_kind default 'company',
  p_registration_no text default null,
  p_phone text default null,
  p_email text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations%rowtype;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_name is null or length(btrim(p_name)) < 2 then
    raise exception 'VALIDATION_FAILED: name' using errcode = '22023';
  end if;

  insert into public.organizations (kind, name, name_en, registration_no, phone, email, owner_id)
  values (
    coalesce(p_kind, 'company'),
    btrim(p_name),
    nullif(btrim(coalesce(p_name_en, '')), ''),
    nullif(btrim(coalesce(p_registration_no, '')), ''),
    nullif(btrim(coalesce(p_phone, '')), ''),
    nullif(btrim(coalesce(p_email, '')), ''),
    p_actor
  )
  returning * into v_org;

  insert into public.organization_members (org_id, user_id, role, status, joined_at)
  values (v_org.id, p_actor, 'owner', 'active', now());

  perform app.write_audit(
    p_actor, 'organization.create', 'organization', v_org.id::text,
    null,
    jsonb_build_object('name', v_org.name, 'kind', v_org.kind, 'owner_id', v_org.owner_id),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'organization', jsonb_build_object(
      'id', v_org.id,
      'name', v_org.name,
      'nameEn', v_org.name_en,
      'kind', v_org.kind,
      'verificationStatus', v_org.verification_status,
      'plan', v_org.plan,
      'role', 'owner'
    )
  );
end;
$$;

create or replace function public.cmd_update_organization(
  p_actor uuid,
  p_org_id uuid,
  p_name text default null,
  p_name_en text default null,
  p_phone text default null,
  p_email text default null,
  p_registration_no text default null,
  p_tax_no text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.member_role;
  v_before public.organizations%rowtype;
  v_after public.organizations%rowtype;
  v_legal_changed boolean;
  v_status public.verification_status;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  v_role := app.org_role(p_org_id, p_actor);
  if not app.is_platform_admin(p_actor) and (v_role is null or v_role not in ('owner', 'manager')) then
    raise exception 'FORBIDDEN: organization.edit' using errcode = '42501';
  end if;

  select * into v_before from public.organizations where id = p_org_id;
  if not found then
    raise exception 'NOT_FOUND: organization' using errcode = 'P0002';
  end if;

  update public.organizations
  set
    name            = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
    name_en         = coalesce(nullif(btrim(coalesce(p_name_en, '')), ''), name_en),
    phone           = coalesce(nullif(btrim(coalesce(p_phone, '')), ''), phone),
    email           = coalesce(nullif(btrim(coalesce(p_email, '')), ''), email),
    registration_no = coalesce(nullif(btrim(coalesce(p_registration_no, '')), ''), registration_no),
    tax_no          = coalesce(nullif(btrim(coalesce(p_tax_no, '')), ''), tax_no)
  where id = p_org_id
  returning * into v_after;

  v_legal_changed :=
       btrim(v_before.name) <> btrim(v_after.name)
    or btrim(coalesce(v_before.registration_no, '')) <> btrim(coalesce(v_after.registration_no, ''))
    or btrim(coalesce(v_before.tax_no, '')) <> btrim(coalesce(v_after.tax_no, ''));

  v_status := v_after.verification_status;

  if v_legal_changed and v_before.verification_status in ('verified', 'pending') then
    v_status := 'unverified';
    update public.organizations set verification_status = 'unverified' where id = p_org_id;
    update public.verification_requests
    set status = 'withdrawn', decision_at = now(), decision_note = 'organization edited'
    where subject_type = 'organization' and subject_id = p_org_id and status = 'pending';

    perform app.notify(
      v_before.owner_id, 'verification_invalidated', 'notifications.organizationInvalidated',
      jsonb_build_object('name', v_after.name), '/operator/settings'
    );
    perform app.write_audit(
      p_actor, 'organization.verification_invalidated', 'organization', p_org_id::text,
      jsonb_build_object('verification_status', v_before.verification_status),
      jsonb_build_object('verification_status', 'unverified'),
      'legal identity fields changed', p_request_id, p_ip
    );
  end if;

  perform app.write_audit(
    p_actor, 'organization.update', 'organization', p_org_id::text,
    to_jsonb(v_before) - 'created_at' - 'updated_at',
    to_jsonb(v_after) - 'created_at' - 'updated_at',
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'organization', jsonb_build_object(
      'id', v_after.id,
      'name', v_after.name,
      'nameEn', v_after.name_en,
      'phone', v_after.phone,
      'email', v_after.email,
      'registrationNo', v_after.registration_no,
      'taxNo', v_after.tax_no,
      'verificationStatus', v_status,
      'plan', v_after.plan
    )
  );
end;
$$;

create or replace function public.cmd_invite_member(
  p_actor uuid,
  p_org_id uuid,
  p_role public.member_role,
  p_email text default null,
  p_phone text default null,
  p_token_hash text default null,
  p_expires_at timestamptz default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.member_role;
  v_member public.organization_members%rowtype;
  v_target uuid;
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_role is null or p_role = 'owner' then
    raise exception 'VALIDATION_FAILED: role' using errcode = '22023';
  end if;
  if v_email is null and v_phone is null then
    raise exception 'VALIDATION_FAILED: contact' using errcode = '22023';
  end if;
  if p_token_hash is null or length(p_token_hash) <> 64 then
    raise exception 'VALIDATION_FAILED: token' using errcode = '22023';
  end if;

  v_actor_role := app.org_role(p_org_id, p_actor);
  if v_actor_role is null then
    raise exception 'FORBIDDEN: not a member' using errcode = '42501';
  end if;
  -- Owners may invite managers and below; managers may invite managers and below.
  if v_actor_role = 'manager' and p_role not in ('manager', 'accountant', 'dispatcher') then
    raise exception 'FORBIDDEN: role' using errcode = '42501';
  elsif v_actor_role not in ('owner', 'manager') then
    raise exception 'FORBIDDEN: invite' using errcode = '42501';
  end if;

  -- If the invitee already has an account, link the row so their notification is actionable.
  select p.id into v_target
  from public.profiles p
  where (v_phone is not null and p.phone = v_phone)
     or (v_email is not null and lower(p.email) = v_email)
  limit 1;

  insert into public.organization_members (
    org_id, user_id, role, status, invited_by, invited_email, invited_phone,
    invite_token_hash, invite_expires_at
  )
  values (
    p_org_id, v_target, p_role, 'invited', p_actor, v_email, v_phone,
    p_token_hash, coalesce(p_expires_at, now() + interval '72 hours')
  )
  returning * into v_member;

  if v_target is not null then
    perform app.notify(
      v_target, 'member_invited', 'notifications.memberInvited',
      jsonb_build_object('orgId', p_org_id), '/account/invitations'
    );
  end if;

  perform app.write_audit(
    p_actor, 'member.invite', 'organization_member', v_member.id::text,
    null,
    jsonb_build_object('org_id', p_org_id, 'role', p_role, 'email', v_email, 'phone', v_phone),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'memberId', v_member.id,
    'role', v_member.role,
    'status', v_member.status,
    'expiresAt', v_member.invite_expires_at
  );
end;
$$;

create or replace function public.cmd_accept_invite(
  p_actor uuid,
  p_member_id uuid,
  p_token text,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.organization_members%rowtype;
  v_profile public.profiles%rowtype;
  v_org public.organizations%rowtype;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_token is null or length(p_token) <> 64 then
    raise exception 'INVITE_INVALID: token' using errcode = '22023';
  end if;

  select * into v_member from public.organization_members where id = p_member_id for update;
  if not found or v_member.status <> 'invited' then
    raise exception 'INVITE_INVALID: not pending' using errcode = 'P0002';
  end if;
  if v_member.invite_expires_at is null or v_member.invite_expires_at < now() then
    raise exception 'INVITE_EXPIRED: expired' using errcode = 'P0001';
  end if;
  if v_member.invite_token_hash is distinct from encode(digest(p_token, 'sha256'), 'hex') then
    raise exception 'INVITE_INVALID: token mismatch' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles where id = p_actor;
  if not found then
    raise exception 'NOT_FOUND: profile' using errcode = 'P0002';
  end if;

  -- The invite is bound to a contact: someone who merely holds the link cannot join a company.
  if v_member.invited_phone is not null and v_profile.phone is distinct from v_member.invited_phone then
    raise exception 'INVITE_INVALID: wrong recipient' using errcode = '42501';
  end if;
  if v_member.invited_email is not null
     and lower(coalesce(v_profile.email, '')) <> lower(v_member.invited_email) then
    raise exception 'INVITE_INVALID: wrong recipient' using errcode = '42501';
  end if;

  update public.organization_members
  set user_id = p_actor,
      status = 'active',
      joined_at = now(),
      invite_token_hash = null,
      invite_expires_at = null
  where id = p_member_id
  returning * into v_member;

  select * into v_org from public.organizations where id = v_member.org_id;

  perform app.notify(
    v_org.owner_id, 'member_joined', 'notifications.memberJoined',
    jsonb_build_object('memberId', p_actor), '/operator/team'
  );

  perform app.write_audit(
    p_actor, 'member.accept', 'organization_member', p_member_id::text,
    jsonb_build_object('status', 'invited'),
    jsonb_build_object('status', 'active', 'org_id', v_member.org_id, 'role', v_member.role),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'orgId', v_member.org_id,
    'role', v_member.role,
    'status', v_member.status
  );
end;
$$;

create or replace function public.cmd_remove_member(
  p_actor uuid,
  p_member_id uuid,
  p_reason text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.organization_members%rowtype;
  v_actor_role public.member_role;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_member from public.organization_members where id = p_member_id for update;
  if not found then
    raise exception 'NOT_FOUND: member' using errcode = 'P0002';
  end if;

  v_actor_role := app.org_role(v_member.org_id, p_actor);
  if not app.is_platform_admin(p_actor) then
    if v_actor_role is distinct from 'owner' then
      raise exception 'FORBIDDEN: member.remove' using errcode = '42501';
    end if;
    if v_member.role = 'owner' then
      raise exception 'FORBIDDEN: cannot remove the owner' using errcode = '42501';
    end if;
    if v_member.user_id = p_actor then
      raise exception 'FORBIDDEN: cannot remove yourself' using errcode = '42501';
    end if;
  end if;

  update public.organization_members
  set status = 'removed', removed_at = now(), removed_by = p_actor,
      invite_token_hash = null, invite_expires_at = null
  where id = p_member_id;

  if v_member.user_id is not null then
    perform app.notify(
      v_member.user_id, 'member_removed', 'notifications.memberRemoved',
      jsonb_build_object('orgId', v_member.org_id), null
    );
  end if;

  perform app.write_audit(
    p_actor, 'member.remove', 'organization_member', p_member_id::text,
    jsonb_build_object('status', v_member.status, 'role', v_member.role),
    jsonb_build_object('status', 'removed'),
    p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('memberId', p_member_id, 'status', 'removed');
end;
$$;

-- ---------------------------------------------------------------------------
-- Verification queue
-- ---------------------------------------------------------------------------

create or replace function public.cmd_submit_verification(
  p_actor uuid,
  p_subject_type public.verification_subject,
  p_subject_id uuid,
  p_documents jsonb,
  p_snapshot jsonb default '{}'::jsonb,
  p_note text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.verification_requests%rowtype;
  v_kind text;
  v_path text;
  v_required text[];
  v_ok text[];
  v_staff record;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_documents is null or jsonb_typeof(p_documents) <> 'array' or jsonb_array_length(p_documents) = 0 then
    raise exception 'MISSING_DOCUMENT: none attached' using errcode = '22023';
  end if;

  if p_subject_type = 'individual' then
    if p_subject_id is distinct from p_actor then
      raise exception 'FORBIDDEN: individual subject' using errcode = '42501';
    end if;
    v_required := array['national_id_front', 'national_id_back'];
  else
    if not app.is_platform_admin(p_actor)
       and coalesce(app.org_role(p_subject_id, p_actor)::text, '') not in ('owner', 'manager') then
      raise exception 'FORBIDDEN: organization subject' using errcode = '42501';
    end if;
    v_required := array['commercial_registration'];
  end if;

  -- Every document must live under the submitter's own prefix: a client cannot attach another
  -- user's upload by guessing its path.
  select array_agg(d ->> 'kind') into v_ok
  from jsonb_array_elements(p_documents) d
  where (d ->> 'path') like p_actor::text || '/%'
    and (d ->> 'path') not like '/%'
    and (d ->> 'path') not like '%..%';

  if v_ok is null then
    raise exception 'MISSING_DOCUMENT: unreadable attachments' using errcode = '22023';
  end if;

  if not (v_required <@ v_ok) then
    raise exception 'MISSING_DOCUMENT: %', array_to_string(v_required, ',') using errcode = '22023';
  end if;

  if exists (
    select 1 from public.verification_requests r
    where r.subject_type = p_subject_type and r.subject_id = p_subject_id and r.status = 'pending'
  ) then
    raise exception 'CONFLICT: request already pending' using errcode = '23505';
  end if;

  if p_subject_type = 'individual' then
    if exists (select 1 from public.profiles p where p.id = p_actor and p.verification_status = 'verified') then
      raise exception 'CONFLICT: already verified' using errcode = '23505';
    end if;
    update public.profiles set verification_status = 'pending' where id = p_actor;
  else
    if app.org_is_verified(p_subject_id) then
      raise exception 'CONFLICT: already verified' using errcode = '23505';
    end if;
    update public.organizations set verification_status = 'pending' where id = p_subject_id;
  end if;

  insert into public.verification_requests (subject_type, subject_id, requested_by, note, snapshot)
  values (p_subject_type, p_subject_id, p_actor, nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_snapshot, '{}'::jsonb))
  returning * into v_request;

  insert into public.verification_documents (request_id, kind, storage_path, mime, size_bytes)
  select
    v_request.id,
    d ->> 'kind',
    d ->> 'path',
    nullif(d ->> 'mime', ''),
    nullif(d ->> 'sizeBytes', '')::integer
  from jsonb_array_elements(p_documents) d
  where (d ->> 'path') like p_actor::text || '/%';

  -- Tell the queue owners. One row per staff member keeps the notification model trivial.
  for v_staff in
    select distinct ur.user_id
    from public.user_roles ur
    where ur.role in ('platform_staff', 'platform_admin') and ur.revoked_at is null
  loop
    perform app.notify(
      v_staff.user_id, 'verification_submitted', 'notifications.verificationSubmitted',
      jsonb_build_object('subjectType', p_subject_type, 'requestId', v_request.id),
      '/staff/verifications'
    );
  end loop;

  perform app.write_audit(
    p_actor, 'verification.submit', p_subject_type::text, p_subject_id::text,
    null,
    jsonb_build_object('request_id', v_request.id, 'documents', jsonb_array_length(p_documents)),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'requestId', v_request.id,
    'status', v_request.status,
    'subjectType', v_request.subject_type,
    'subjectId', v_request.subject_id
  );
end;
$$;

create or replace function public.cmd_decide_verification(
  p_actor uuid,
  p_verification_id uuid,
  p_outcome public.verification_outcome,
  p_reason text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.verification_requests%rowtype;
  v_status public.verification_request_status;
  v_new_status public.verification_status;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_staff(p_actor) then
    raise exception 'FORBIDDEN: verification.decide' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('approve', 'reject') then
    raise exception 'VALIDATION_FAILED: outcome' using errcode = '22023';
  end if;
  if p_outcome = 'reject' and (p_reason is null or length(btrim(p_reason)) < 10) then
    raise exception 'VALIDATION_FAILED: reason too short' using errcode = '22023';
  end if;

  select * into v_request from public.verification_requests where id = p_verification_id for update;
  if not found then
    raise exception 'NOT_FOUND: request' using errcode = 'P0002';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'CONFLICT: already decided' using errcode = '23505';
  end if;
  -- Separation of duties: nobody decides their own request, however senior.
  if v_request.requested_by = p_actor then
    raise exception 'FORBIDDEN: own request' using errcode = '42501';
  end if;

  v_status := case when p_outcome = 'approve' then 'approved' else 'rejected' end;
  v_new_status := case when p_outcome = 'approve' then 'verified' else 'rejected' end;

  update public.verification_requests
  set status = v_status,
      decision_by = p_actor,
      decision_at = now(),
      decision_note = nullif(btrim(coalesce(p_reason, '')), '')
  where id = p_verification_id;

  if v_request.subject_type = 'individual' then
    update public.profiles
    set verification_status = v_new_status,
        verification_note = case when p_outcome = 'reject' then p_reason else null end
    where id = v_request.subject_id;
  else
    update public.organizations
    set verification_status = v_new_status
    where id = v_request.subject_id;
  end if;

  perform app.notify(
    v_request.requested_by,
    case when p_outcome = 'approve' then 'verification_approved' else 'verification_rejected' end::public.notification_kind,
    case when p_outcome = 'approve' then 'notifications.verificationApproved' else 'notifications.verificationRejected' end,
    jsonb_build_object('requestId', p_verification_id, 'reason', p_reason),
    '/account/verification'
  );

  perform app.write_audit(
    p_actor, 'verification.decide', v_request.subject_type::text, v_request.subject_id::text,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', v_status, 'request_id', p_verification_id),
    p_reason, p_request_id, p_ip
  );

  return jsonb_build_object(
    'requestId', p_verification_id,
    'status', v_status,
    'subjectStatus', v_new_status
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Platform roles (admin only)
-- ---------------------------------------------------------------------------

create or replace function public.cmd_grant_role(
  p_actor uuid,
  p_target uuid,
  p_role public.platform_role,
  p_reason text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_admin(p_actor) then
    raise exception 'FORBIDDEN: role.manage' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_target) then
    raise exception 'NOT_FOUND: user' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.user_roles
    where user_id = p_target and role = p_role and revoked_at is null
  ) then
    raise exception 'CONFLICT: role already granted' using errcode = '23505';
  end if;

  insert into public.user_roles (user_id, role, granted_by, reason)
  values (p_target, p_role, p_actor, nullif(btrim(coalesce(p_reason, '')), ''))
  returning id into v_id;

  perform app.notify(
    p_target, 'role_granted', 'notifications.roleGranted',
    jsonb_build_object('role', p_role), null
  );

  perform app.write_audit(
    p_actor, 'role.grant', 'user_role', v_id::text, null,
    jsonb_build_object('user_id', p_target, 'role', p_role),
    p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('roleId', v_id, 'userId', p_target, 'role', p_role);
end;
$$;

create or replace function public.cmd_revoke_role(
  p_actor uuid,
  p_target uuid,
  p_role public.platform_role,
  p_reason text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_admins int;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_admin(p_actor) then
    raise exception 'FORBIDDEN: role.manage' using errcode = '42501';
  end if;

  if p_role = 'platform_admin' and p_target = p_actor then
    select count(*) into v_active_admins
    from public.user_roles
    where role = 'platform_admin' and revoked_at is null;
    if v_active_admins <= 1 then
      raise exception 'SELF_LOCKOUT: last admin' using errcode = '42501';
    end if;
  end if;

  update public.user_roles
  set revoked_at = now(), revoked_by = p_actor,
      reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), reason)
  where user_id = p_target and role = p_role and revoked_at is null;

  if not found then
    raise exception 'NOT_FOUND: role assignment' using errcode = 'P0002';
  end if;

  perform app.notify(
    p_target, 'role_revoked', 'notifications.roleRevoked',
    jsonb_build_object('role', p_role), null
  );

  perform app.write_audit(
    p_actor, 'role.revoke', 'user_role', p_target::text,
    jsonb_build_object('role', p_role, 'revoked_at', null),
    jsonb_build_object('role', p_role, 'revoked_at', now()),
    p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('userId', p_target, 'role', p_role, 'revoked', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

create or replace function public.cmd_mark_notifications_read(
  p_actor uuid,
  p_ids uuid[] default null,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  update public.notifications
  set read_at = now()
  where user_id = p_actor
    and read_at is null
    and (p_ids is null or id = any(p_ids));

  get diagnostics v_count = row_count;

  return jsonb_build_object('marked', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: service_role only
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  for v_signature in
    select unnest(array[
    'public.cmd_set_preferred_locale(uuid, text, text, inet)',
    'public.cmd_update_profile(uuid, text, text, text, text, date, text, text, inet)',
    'public.cmd_create_organization(uuid, text, text, public.org_kind, text, text, text, text, inet)',
    'public.cmd_update_organization(uuid, uuid, text, text, text, text, text, text, text, inet)',
    'public.cmd_invite_member(uuid, uuid, public.member_role, text, text, text, timestamptz, text, inet)',
    'public.cmd_accept_invite(uuid, uuid, text, text, inet)',
    'public.cmd_remove_member(uuid, uuid, text, text, inet)',
    'public.cmd_submit_verification(uuid, public.verification_subject, uuid, jsonb, jsonb, text, text, inet)',
    'public.cmd_decide_verification(uuid, uuid, public.verification_outcome, text, text, inet)',
    'public.cmd_grant_role(uuid, uuid, public.platform_role, text, text, inet)',
    'public.cmd_revoke_role(uuid, uuid, public.platform_role, text, text, inet)',
      'public.cmd_mark_notifications_read(uuid, uuid[], text)'
    ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
