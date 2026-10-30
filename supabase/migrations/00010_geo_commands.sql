-- 00010 — Phase 2 commands: regions, coverage, supervisors, places, imports
--
-- Same contract as every other command: the actor is passed in (never read from the client), the
-- permission is re-checked here, one audit row is written in the same transaction, and the function is
-- executable by service_role only.
--
-- The scope rules that matter:
--   · a region may contain whole governorates AND hand-picked districts from anywhere;
--   · a supervisor's coverage is the union of districts of every region (and sub-region) they hold;
--   · revoking an assignment takes effect immediately (nothing is cached, no token claims).

-- ---------------------------------------------------------------------------
-- Regions
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

-- ---------------------------------------------------------------------------
-- Supervisor assignments
-- ---------------------------------------------------------------------------

create or replace function public.cmd_assign_geo_supervisor(
  p_actor uuid,
  p_user_id uuid,
  p_region_ids uuid[],
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
  v_region uuid;
  v_added int := 0;
  v_removed int := 0;
  v_scope int;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_admin(p_actor) then
    raise exception 'FORBIDDEN: geo.assignSupervisor' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'NOT_FOUND: user' using errcode = 'P0002';
  end if;
  if coalesce(array_length(p_region_ids, 1), 0) = 0 then
    raise exception 'VALIDATION_FAILED: at least one region is required' using errcode = '22023';
  end if;

  foreach v_region in array p_region_ids loop
    if not exists (select 1 from public.regions where id = v_region) then
      raise exception 'VALIDATION_FAILED: unknown region %', v_region using errcode = '22023';
    end if;
  end loop;

  -- Reconcile: assignments not in the new list are revoked, new ones are granted. Revocation is a
  -- soft delete so the audit trail keeps who had what, and when.
  update public.geo_assignments
  set revoked_at = now(), revoked_by = p_actor,
      reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), reason)
  where user_id = p_user_id
    and revoked_at is null
    and region_id <> all (p_region_ids);
  get diagnostics v_removed = row_count;

  insert into public.geo_assignments (user_id, region_id, granted_by, reason)
  select p_user_id, unnest(p_region_ids), p_actor, nullif(btrim(coalesce(p_reason, '')), '')
  on conflict (user_id, region_id) where revoked_at is null do nothing;
  get diagnostics v_added = row_count;

  -- Re-activating a previously revoked pair is a new grant, not an update of the old row.
  insert into public.geo_assignments (user_id, region_id, granted_by, reason)
  select p_user_id, r.id, p_actor, nullif(btrim(coalesce(p_reason, '')), '')
  from public.regions r
  where r.id = any (p_region_ids)
    and not exists (
      select 1 from public.geo_assignments ga
      where ga.user_id = p_user_id and ga.region_id = r.id and ga.revoked_at is null
    );

  select app.geo_scope_size(p_user_id) into v_scope;

  -- A supervisor without a geo role cannot do anything with the scope: grant it once, idempotently.
  if not app.has_role('geo_supervisor', p_user_id) then
    insert into public.user_roles (user_id, role, granted_by, reason)
    values (p_user_id, 'geo_supervisor', p_actor, 'assigned to a region');
  end if;

  perform app.notify(
    p_user_id, 'role_granted', 'notifications.geoAssigned',
    jsonb_build_object('regions', coalesce(array_length(p_region_ids, 1), 0), 'districts', v_scope),
    '/staff'
  );

  perform app.write_audit(
    p_actor, 'geo.assign', 'geo_assignment', p_user_id::text,
    jsonb_build_object('revoked', v_removed),
    jsonb_build_object('regions', to_jsonb(p_region_ids), 'districts_in_scope', v_scope),
    p_reason, p_request_id, p_ip
  );

  return jsonb_build_object(
    'userId', p_user_id,
    'regionIds', to_jsonb(p_region_ids),
    'districtCount', v_scope,
    'granted', v_added,
    'revoked', v_removed
  );
end;
$$;

create or replace function public.cmd_revoke_geo_supervisor(
  p_actor uuid,
  p_user_id uuid,
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
  v_count int;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_admin(p_actor) then
    raise exception 'FORBIDDEN: geo.assignSupervisor' using errcode = '42501';
  end if;

  update public.geo_assignments
  set revoked_at = now(), revoked_by = p_actor,
      reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), reason)
  where user_id = p_user_id and revoked_at is null;
  get diagnostics v_count = row_count;

  if v_count = 0 then
    raise exception 'NOT_FOUND: no active assignment' using errcode = 'P0002';
  end if;

  -- Keep the role: it may be needed again, and it grants nothing without an assignment
  -- (`hasGeoScope` is derived from active assignments).
  perform app.write_audit(
    p_actor, 'geo.revoke', 'geo_assignment', p_user_id::text,
    jsonb_build_object('active', v_count),
    jsonb_build_object('active', 0),
    p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('userId', p_user_id, 'revoked', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- Places
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
    v_public := false;
    v_status := 'pending';
    if p_org_id is not null and not app.is_org_member(p_org_id, p_actor) then
      raise exception 'FORBIDDEN: not a member of this organization' using errcode = '42501';
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
-- Bulk import with a dry-run diff (CSV/GeoJSON rows arrive already parsed by the gateway)
-- ---------------------------------------------------------------------------

create or replace function public.cmd_import_geo(
  p_actor uuid,
  p_kind text,
  p_rows jsonb,
  p_dry_run boolean default true,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_gov uuid;
  v_existing uuid;
  v_added int := 0;
  v_updated int := 0;
  v_skipped int := 0;
  v_diff jsonb := '[]'::jsonb;
  v_governorates int := 0;
  v_districts int := 0;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_admin(p_actor) then
    raise exception 'FORBIDDEN: geo.manage' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('governorates', 'districts') then
    raise exception 'VALIDATION_FAILED: kind' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'VALIDATION_FAILED: rows' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'VALIDATION_FAILED: at most 2000 rows per import' using errcode = '22023';
  end if;

  for v_row in select jsonb_array_elements(p_rows) loop
    if p_kind = 'governorates' then
      if (v_row ->> 'code') is null or (v_row ->> 'name_ar') is null or (v_row ->> 'name_en') is null then
        v_skipped := v_skipped + 1;
        v_diff := v_diff || jsonb_build_object('action', 'skipped', 'reason', 'missing fields', 'row', v_row);
        continue;
      end if;

      select id into v_existing from public.governorates where code = v_row ->> 'code';
      if v_existing is null then
        v_added := v_added + 1;
        v_diff := v_diff || jsonb_build_object('action', 'add', 'code', v_row ->> 'code');
        if not p_dry_run then
          insert into public.governorates (code, name_ar, name_en, center_lat, center_lng)
          values (
            v_row ->> 'code', v_row ->> 'name_ar', v_row ->> 'name_en',
            (v_row ->> 'lat')::double precision, (v_row ->> 'lng')::double precision
          )
          on conflict (code) do nothing;
        end if;
      else
        v_updated := v_updated + 1;
        v_diff := v_diff || jsonb_build_object('action', 'update', 'code', v_row ->> 'code');
        if not p_dry_run then
          update public.governorates
          set name_ar = v_row ->> 'name_ar',
              name_en = v_row ->> 'name_en',
              center_lat = coalesce((v_row ->> 'lat')::double precision, center_lat),
              center_lng = coalesce((v_row ->> 'lng')::double precision, center_lng)
          where id = v_existing;
        end if;
      end if;
    else
      -- districts: the governorate is addressed by ISO code or by its Arabic name.
      select g.id into v_gov
      from public.governorates g
      where g.code = coalesce(v_row ->> 'governorate_code', '')
         or g.name_ar_norm = app.normalize_arabic(coalesce(v_row ->> 'governorate_ar', ''))
      limit 1;

      if v_gov is null or (v_row ->> 'name_ar') is null or (v_row ->> 'name_en') is null then
        v_skipped := v_skipped + 1;
        v_diff := v_diff || jsonb_build_object('action', 'skipped', 'reason', 'unknown governorate or missing name', 'row', v_row);
        continue;
      end if;

      select d.id into v_existing
      from public.districts d
      where d.governorate_id = v_gov and d.name_ar_norm = app.normalize_arabic(v_row ->> 'name_ar');

      if v_existing is null then
        v_added := v_added + 1;
        v_diff := v_diff || jsonb_build_object('action', 'add', 'name_ar', v_row ->> 'name_ar');
        if not p_dry_run then
          insert into public.districts (governorate_id, pcode, name_ar, name_en, center_lat, center_lng)
          values (
            v_gov, nullif(v_row ->> 'pcode', ''), v_row ->> 'name_ar', v_row ->> 'name_en',
            (v_row ->> 'lat')::double precision, (v_row ->> 'lng')::double precision
          )
          on conflict do nothing;
        end if;
      else
        v_updated := v_updated + 1;
        v_diff := v_diff || jsonb_build_object('action', 'update', 'name_ar', v_row ->> 'name_ar');
        if not p_dry_run then
          update public.districts
          set name_en = v_row ->> 'name_en',
              pcode = coalesce(nullif(v_row ->> 'pcode', ''), pcode),
              center_lat = coalesce((v_row ->> 'lat')::double precision, center_lat),
              center_lng = coalesce((v_row ->> 'lng')::double precision, center_lng)
          where id = v_existing;
        end if;
      end if;
    end if;
  end loop;

  if not p_dry_run then
    perform app.write_audit(
      p_actor, 'geo.import', p_kind, null,
      null,
      jsonb_build_object('added', v_added, 'updated', v_updated, 'skipped', v_skipped),
      null, p_request_id, p_ip
    );
  end if;

  return jsonb_build_object(
    'kind', p_kind,
    'dryRun', p_dry_run,
    'added', v_added,
    'updated', v_updated,
    'skipped', v_skipped,
    'diff', v_diff
  );
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
      'public.cmd_upsert_region(uuid, uuid, uuid, public.region_kind, text, text, text, uuid[], uuid[], text, inet)',
      'public.cmd_assign_geo_supervisor(uuid, uuid, uuid[], text, text, inet)',
      'public.cmd_revoke_geo_supervisor(uuid, uuid, text, text, inet)',
      'public.cmd_create_place(uuid, text, text, text, uuid, uuid, double precision, double precision, text[], text[], uuid, text, inet)',
      'public.cmd_decide_place(uuid, uuid, public.verification_outcome, text, text, inet)',
      'public.cmd_import_geo(uuid, text, jsonb, boolean, text, inet)'
    ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end
$$;

-- Staff need to see the queue of user-submitted places, with the submitter's name.
create or replace function public.staff_place_queue(p_limit int default 50)
returns table (
  id uuid,
  kind text,
  name_ar text,
  name_en text,
  governorate_name text,
  district_name text,
  lat double precision,
  lng double precision,
  created_at timestamptz,
  submitted_by uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select pl.id, pl.kind, pl.name_ar, coalesce(pl.name_en, ''), coalesce(g.name_ar, ''),
         coalesce(d.name_ar, ''), pl.lat, pl.lng, pl.created_at, pl.created_by
  from public.places pl
  left join public.governorates g on g.id = pl.governorate_id
  left join public.districts d on d.id = pl.district_id
  where pl.verification_status = 'pending'
    and app.is_platform_staff()
  order by pl.created_at asc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke all on function public.staff_place_queue(int) from public, anon, authenticated;
grant execute on function public.staff_place_queue(int) to service_role;
