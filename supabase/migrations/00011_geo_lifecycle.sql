-- 00011 — Retiring reference data (deactivate / reactivate)
--
-- Phase 2 could create and edit regions and places, but never take them out of service. That is a
-- dead end, not a nicety: `regions` is unique on (parent, normalised name), so a typo'd region
-- permanently occupies its name, and a place that turns out to be wrong stays in every picker.
--
-- Deletion is deliberately *not* offered:
--   · `geo_assignments` and future `trips` reference these rows; a hard delete either cascades
--     (destroying history) or is blocked (leaving the admin stuck);
--   · `is_active` is already honoured everywhere — `region_descendants()`, `search_places`,
--     `places_read_*` and the loaders all filter on it — so deactivation takes effect immediately
--     without rewriting a single read path.
--
-- Deactivating a region refuses while it still has active sub-regions: silently orphaning a
-- sub-region's scope would be a data bug that surfaces weeks later as "the supervisor sees nothing".

create or replace function public.cmd_set_region_active(
  p_actor uuid,
  p_region_id uuid,
  p_active boolean,
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
  v_region public.regions%rowtype;
  v_children int;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_admin(p_actor) then
    raise exception 'FORBIDDEN: geo.manage' using errcode = '42501';
  end if;

  select * into v_region from public.regions where id = p_region_id for update;
  if not found then
    raise exception 'NOT_FOUND: region' using errcode = 'P0002';
  end if;

  if v_region.is_active = p_active then
    -- Idempotent: a double-click is not an error, and reporting it as one trains people to ignore
    -- errors.
    return jsonb_build_object('regionId', p_region_id, 'isActive', p_active, 'changed', false);
  end if;

  if not p_active then
    select count(*)::int into v_children
    from public.regions
    where parent_id = p_region_id and is_active;

    if v_children > 0 then
      raise exception 'CONFLICT: % active sub-region(s) still depend on this region', v_children
        using errcode = '23505';
    end if;
  end if;

  update public.regions set is_active = p_active where id = p_region_id;

  -- A supervisor assigned to this region loses their whole scope, silently, the moment it is
  -- retired. Tell them why instead of letting their console quietly empty out.
  if not p_active then
    perform app.notify(
      ga.user_id, 'role_revoked', 'notifications.geoRegionRetired',
      jsonb_build_object('name', v_region.name_ar), null
    )
    from public.geo_assignments ga
    where ga.region_id = p_region_id and ga.revoked_at is null;
  end if;

  -- Scope is derived at read time, so nothing else has to change: assignments stay (they are the
  -- paper trail of who was responsible) but contribute nothing while the region is inactive.
  perform app.write_audit(
    p_actor, case when p_active then 'region.activate' else 'region.deactivate' end,
    'region', p_region_id::text,
    jsonb_build_object('is_active', v_region.is_active),
    jsonb_build_object('is_active', p_active),
    p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('regionId', p_region_id, 'isActive', p_active, 'changed', true);
end;
$$;

create or replace function public.cmd_set_place_active(
  p_actor uuid,
  p_place_id uuid,
  p_active boolean,
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

  select * into v_place from public.places where id = p_place_id for update;
  if not found then
    raise exception 'NOT_FOUND: place' using errcode = 'P0002';
  end if;

  -- Staff retire reference places. A user may retire *their own* pin (the address was wrong), but
  -- cannot touch anything public or anyone else's.
  if not app.is_platform_staff(p_actor) then
    if v_place.created_by is distinct from p_actor then
      raise exception 'FORBIDDEN: not your place' using errcode = '42501';
    end if;
    if p_active and v_place.is_public then
      raise exception 'FORBIDDEN: only staff can reactivate a reference place' using errcode = '42501';
    end if;
  end if;

  if v_place.is_active = p_active then
    return jsonb_build_object('placeId', p_place_id, 'isActive', p_active, 'changed', false);
  end if;

  update public.places set is_active = p_active where id = p_place_id;

  perform app.write_audit(
    p_actor, case when p_active then 'place.activate' else 'place.deactivate' end,
    'place', p_place_id::text,
    jsonb_build_object('is_active', v_place.is_active),
    jsonb_build_object('is_active', p_active),
    p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('placeId', p_place_id, 'isActive', p_active, 'changed', true);
end;
$$;

do $$
declare
  v_signature text;
begin
  for v_signature in
    select unnest(array[
      'public.cmd_set_region_active(uuid, uuid, boolean, text, text, inet)',
      'public.cmd_set_place_active(uuid, uuid, boolean, text, text, inet)'
    ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end
$$;
