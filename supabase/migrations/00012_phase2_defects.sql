/**
 * Phase 2 review — three defects that survived the first pass.
 *
 * 1. `cmd_decide_place` decided a place that had already been decided. Approving twice is audited
 *    twice and notifies twice; approving a *rejected* place silently resurrects it with no record of
 *    why. `cmd_decide_verification` has refused this since Phase 1 — the place command was missing the
 *    same guard.
 *
 * 2. A duplicate name surfaced as `INTERNAL` with a raw Postgres constraint string. `regions` is unique
 *    on (parent, normalised name), and `districts` on (governorate, normalised name), so a typo or a
 *    double submit reached the user as "duplicate key value violates unique constraint
 *    regions_name_unique". A field the form can fix deserves an error the form can explain.
 *
 * 3. Organization verification was ignored where an organization *owns* something. `cmd_create_place`
 *    checked that the actor belongs to the org and never that the org is verified, so an unverified —
 *    even rejected — company could own reference data that the picker treats as legitimate.
 *
 * Fixes 1 and 2 also apply to `cmd_create_place`, because "the same pin twice" is the same class of
 * mistake as "the same region twice", and it was previously silent.
 */

-- ---------------------------------------------------------------------------
-- A. Is this actor allowed to act *for* this organization?
-- ---------------------------------------------------------------------------

/**
 * Membership **and** the organization's own verification.
 *
 * `app.is_verified_actor()` answers "may this person act at all?" using the best signal available: their
 * own verification, or an active membership in *any* verified organization. It is deliberately global,
 * because Phase 1 has no notion of which organization a request is about.
 *
 * The moment an organization owns a row, that is no longer enough: being verified through company A must
 * not let you create assets for unverified company B. This helper is the scoped question, and it is what
 * every org-owned write should call.
 */
create or replace function app.org_can_own(p_org uuid, p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_org is not null
    and p_uid is not null
    and app.is_org_member(p_org, p_uid)
    and app.org_is_verified(p_org),
    false
  );
$$;

comment on function app.org_can_own(uuid, uuid) is
  'Active membership in a *verified* organization. Use for every org-owned write; is_verified_actor() is the global gate.';

revoke all on function app.org_can_own(uuid, uuid) from public, anon, authenticated;
grant execute on function app.org_can_own(uuid, uuid) to service_role;


-- ---------------------------------------------------------------------------
-- B. cmd_create_place — org verification, and duplicate pins
-- ---------------------------------------------------------------------------

create or replace function public.cmd_create_place(
  p_actor uuid,
  p_kind text,
  p_name_ar text,
  p_name_en text default null,
  p_governorate_id uuid default null,
  p_district_id uuid default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_aliases_ar text[] default '{}',
  p_aliases_en text[] default '{}',
  p_org_id uuid default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_place public.places%rowtype;
  v_public boolean;
  v_status public.verification_status;
  v_duplicate uuid;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_kind is null or p_kind not in (
    'city', 'town', 'village', 'district_centre', 'landmark', 'station', 'airport', 'port',
    'border_crossing', 'market', 'hospital', 'gathering_point', 'other'
  ) then
    raise exception 'VALIDATION_FAILED: kind' using errcode = '22023';
  end if;
  if p_name_ar is null or length(btrim(p_name_ar)) < 3 then
    raise exception 'VALIDATION_FAILED: name_ar' using errcode = '22023';
  end if;
  if (p_lat is null) <> (p_lng is null) then
    raise exception 'VALIDATION_FAILED: lat and lng must be given together' using errcode = '22023';
  end if;
  if p_lat is not null and (p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180) then
    raise exception 'VALIDATION_FAILED: coordinates out of range' using errcode = '22023';
  end if;

  -- Who may create what: staff create reference places (public, verified); everybody else creates a
  -- private gathering point for their own trip, which staff can later promote.
  if app.is_platform_admin(p_actor) or app.is_platform_staff(p_actor) then
    v_public := true;
    v_status := 'verified';
  else
    if not app.is_verified_actor(p_actor) then
      raise exception 'NOT_VERIFIED: only verified accounts can add places' using errcode = '42501';
    end if;
    -- Verified accounts drop pins, they do not edit the reference: «مدينة» and «مطار» are staff
    -- decisions, otherwise the shared geography slowly fills with duplicates and wrong kinds.
    -- Keep in sync with USER_CREATABLE_KINDS in @maak/core (which the picker and the form use).
    if p_kind not in ('gathering_point', 'landmark', 'other') then
      raise exception 'FORBIDDEN: % is a reference kind; staff only', p_kind using errcode = '42501';
    end if;
    v_public := false;
    v_status := 'pending';
    if p_org_id is not null and not app.is_org_member(p_org_id, p_actor) then
      raise exception 'FORBIDDEN: not a member of this organization' using errcode = '42501';
    end if;
  end if;

  -- An organization that owns a place must itself be verified. Being verified *through* another
  -- company is not evidence about this one — see app.org_can_own.
  if p_org_id is not null and not v_public and not app.org_is_verified(p_org_id) then
    raise exception 'NOT_VERIFIED: this organization is not verified' using errcode = '42501';
  end if;

  -- The same pin twice: an identical active private place from the same owner is almost always a
  -- double submit or a forgotten pin, and two identical entries in a picker are worse than one.
  if not v_public then
    select p.id into v_duplicate
    from public.places p
    where p.is_active
      and not p.is_public
      and p.kind = p_kind
      and p.name_ar_norm = app.normalize_arabic(btrim(p_name_ar))
      and p.created_by = p_actor
      and p.created_by_org is not distinct from p_org_id
      and p.governorate_id is not distinct from p_governorate_id
      and p.district_id is not distinct from p_district_id
    limit 1;

    if v_duplicate is not null then
      raise exception 'DUPLICATE_REFERENCE: you already have a place with this name here'
        using errcode = '23505', detail = v_duplicate::text;
    end if;
  end if;

  insert into public.places (
    kind, name_ar, name_en, aliases_ar, aliases_en, governorate_id, district_id,
    lat, lng, is_public, created_by, created_by_org, verification_status
  )
  values (
    p_kind, btrim(p_name_ar), nullif(btrim(coalesce(p_name_en, '')), ''),
    coalesce(p_aliases_ar, '{}'), coalesce(p_aliases_en, '{}'),
    p_governorate_id, p_district_id, p_lat, p_lng, v_public,
    case when v_public then null else p_actor end,
    case when v_public then null else p_org_id end,
    v_status
  )
  returning * into v_place;

  if not v_public then
    perform app.notify(
      p_actor, 'verification_submitted', 'notifications.placePending',
      jsonb_build_object('name', v_place.name_ar), null
    );
  end if;

  perform app.write_audit(
    p_actor, 'place.create', 'place', v_place.id::text,
    null,
    jsonb_build_object('kind', v_place.kind, 'name_ar', v_place.name_ar, 'is_public', v_place.is_public),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'place', jsonb_build_object(
      'id', v_place.id,
      'kind', v_place.kind,
      'nameAr', v_place.name_ar,
      'nameEn', v_place.name_en,
      'governorateId', v_place.governorate_id,
      'districtId', v_place.district_id,
      'lat', v_place.lat,
      'lng', v_place.lng,
      'isPublic', v_place.is_public,
      'verificationStatus', v_place.verification_status
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- C. cmd_decide_place — only a pending place can be decided
-- ---------------------------------------------------------------------------

create or replace function public.cmd_decide_place(
  p_actor uuid,
  p_place_id uuid,
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
  v_place public.places%rowtype;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_staff(p_actor) then
    raise exception 'FORBIDDEN: staff only' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('approve', 'reject') then
    raise exception 'VALIDATION_FAILED: outcome' using errcode = '22023';
  end if;
  if p_outcome = 'reject' and (p_reason is null or length(btrim(p_reason)) < 10) then
    raise exception 'VALIDATION_FAILED: reason too short' using errcode = '22023';
  end if;

  select * into v_place from public.places where id = p_place_id for update;
  if not found then
    raise exception 'NOT_FOUND: place' using errcode = 'P0002';
  end if;

  -- A decision is a decision. Re-deciding doubles the audit trail, notifies the submitter twice, and
  -- would let a rejected place be resurrected with nobody noticing why. A rejected place that becomes
  -- acceptable is a new submission, not a second decision on the old one.
  if v_place.verification_status <> 'pending' then
    raise exception 'CONFLICT: place is already %, not awaiting review', v_place.verification_status
      using errcode = '23505';
  end if;

  update public.places
  set verification_status = (case when p_outcome = 'approve' then 'verified' else 'rejected' end)::public.verification_status,
      is_public = case when p_outcome = 'approve' then true else is_public end
  where id = p_place_id;

  if v_place.created_by is not null then
    perform app.notify(
      v_place.created_by,
      case when p_outcome = 'approve' then 'verification_approved' else 'verification_rejected' end::public.notification_kind,
      case when p_outcome = 'approve' then 'notifications.placeApproved' else 'notifications.placeRejected' end,
      jsonb_build_object('name', v_place.name_ar, 'reason', p_reason), null
    );
  end if;

  perform app.write_audit(
    p_actor, 'place.decide', 'place', p_place_id::text,
    jsonb_build_object('verification_status', v_place.verification_status),
    jsonb_build_object('verification_status', case when p_outcome = 'approve' then 'verified' else 'rejected' end),
    p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('placeId', p_place_id, 'outcome', p_outcome);
end;
$$;

-- ---------------------------------------------------------------------------
-- D. cmd_upsert_region — a duplicate name is a field error, not a 500
-- ---------------------------------------------------------------------------

create or replace function public.cmd_upsert_region(
  p_actor uuid,
  p_region_id uuid default null,
  p_parent_id uuid default null,
  p_kind public.region_kind default 'region',
  p_name_ar text default null,
  p_name_en text default null,
  p_description text default null,
  p_governorate_ids uuid[] default '{}',
  p_district_ids uuid[] default '{}',
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_region public.regions%rowtype;
  v_before jsonb;
  v_district uuid;
  v_gov uuid;
  v_conflict uuid;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_admin(p_actor) then
    raise exception 'FORBIDDEN: geo.manage' using errcode = '42501';
  end if;
  if p_name_ar is null or length(btrim(p_name_ar)) < 2 or p_name_en is null or length(btrim(p_name_en)) < 2 then
    raise exception 'VALIDATION_FAILED: name' using errcode = '22023';
  end if;
  if coalesce(array_length(p_governorate_ids, 1), 0) = 0 and coalesce(array_length(p_district_ids, 1), 0) = 0 then
    raise exception 'VALIDATION_FAILED: a region must cover something' using errcode = '22023';
  end if;

  -- Every district must exist, and every governorate must exist; unknown ids are a client bug, not a
  -- silent no-op.
  foreach v_gov in array coalesce(p_governorate_ids, '{}') loop
    if not exists (select 1 from public.governorates where id = v_gov) then
      raise exception 'VALIDATION_FAILED: unknown governorate %', v_gov using errcode = '22023';
    end if;
  end loop;
  foreach v_district in array coalesce(p_district_ids, '{}') loop
    if not exists (select 1 from public.districts where id = v_district) then
      raise exception 'VALIDATION_FAILED: unknown district %', v_district using errcode = '22023';
    end if;
  end loop;

  if p_region_id is not null then
    select to_jsonb(r) into v_before from public.regions r where r.id = p_region_id;
    if v_before is null then
      raise exception 'NOT_FOUND: region' using errcode = 'P0002';
    end if;
  end if;

  -- The unique index is on (parent, normalised name). Naming the clash here turns a raw 23505 into
  -- something a form can put next to the field, and names the existing region so the operator can open
  -- the one they meant instead of inventing a second name.
  select r.id into v_conflict
  from public.regions r
  where r.parent_id is not distinct from p_parent_id
    and r.name_ar_norm = app.normalize_arabic(btrim(p_name_ar))
    and (p_region_id is null or r.id <> p_region_id)
  limit 1;

  if v_conflict is not null then
    raise exception 'DUPLICATE_REFERENCE: an area with this name already exists here'
      using errcode = '23505', detail = v_conflict::text;
  end if;

  insert into public.regions (id, parent_id, kind, name_ar, name_en, description)
  values (
    coalesce(p_region_id, gen_random_uuid()), p_parent_id, coalesce(p_kind, 'region'),
    btrim(p_name_ar), btrim(p_name_en), nullif(btrim(coalesce(p_description, '')), '')
  )
  on conflict (id) do update
    set parent_id = excluded.parent_id,
        kind = excluded.kind,
        name_ar = excluded.name_ar,
        name_en = excluded.name_en,
        description = excluded.description
  returning * into v_region;

  -- Coverage is replaced wholesale: a partial update is how regions end up covering half a district.
  delete from public.region_governorates where region_id = v_region.id;
  delete from public.region_districts where region_id = v_region.id;

  insert into public.region_governorates (region_id, governorate_id)
  select v_region.id, unnest(coalesce(p_governorate_ids, '{}'))
  on conflict do nothing;

  insert into public.region_districts (region_id, district_id)
  select v_region.id, unnest(coalesce(p_district_ids, '{}'))
  on conflict do nothing;

  perform app.write_audit(
    p_actor, case when p_region_id is null then 'region.create' else 'region.update' end,
    'region', v_region.id::text,
    v_before,
    jsonb_build_object(
      'name_ar', v_region.name_ar,
      'parent_id', v_region.parent_id,
      'governorates', coalesce(array_length(p_governorate_ids, 1), 0),
      'districts', coalesce(array_length(p_district_ids, 1), 0)
    ),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'region', jsonb_build_object(
      'id', v_region.id,
      'parentId', v_region.parent_id,
      'kind', v_region.kind,
      'nameAr', v_region.name_ar,
      'nameEn', v_region.name_en,
      'governorateIds', to_jsonb(coalesce(p_governorate_ids, '{}')),
      'districtIds', to_jsonb(coalesce(p_district_ids, '{}'))
    )
  );
end;
$$;

-- Writes stay behind the gateway: service_role only, exactly as in 00010.
revoke all on function public.cmd_create_place(
  uuid, text, text, text, uuid, uuid, double precision, double precision, text[], text[], uuid, text, inet
) from public, anon, authenticated;
grant execute on function public.cmd_create_place(
  uuid, text, text, text, uuid, uuid, double precision, double precision, text[], text[], uuid, text, inet
) to service_role;

revoke all on function public.cmd_decide_place(
  uuid, uuid, public.verification_outcome, text, text, inet
) from public, anon, authenticated;
grant execute on function public.cmd_decide_place(
  uuid, uuid, public.verification_outcome, text, text, inet
) to service_role;

revoke all on function public.cmd_upsert_region(
  uuid, uuid, uuid, public.region_kind, text, text, text, uuid[], uuid[], text, inet
) from public, anon, authenticated;
grant execute on function public.cmd_upsert_region(
  uuid, uuid, uuid, public.region_kind, text, text, text, uuid[], uuid[], text, inet
) to service_role;
