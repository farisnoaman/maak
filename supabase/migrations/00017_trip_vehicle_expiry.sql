-- ---------------------------------------------------------------------------
-- 00017 — an expired document grounds the vehicle
--
-- Phase 3 shipped the warning and left a promise in `cmd_assign_driver`:
--
--     -- Warnings, not blocks: assignment is reversible and Phase 4 gates the trip, not the roster.
--
-- Phase 4 did not keep it. `app.assert_trip_vehicle` checked ownership, verification and status, so a
-- verified van whose inspection ran out three months ago could still be scheduled and published — the
-- amber badge on the fleet screen was the only thing standing between a passenger and it.
--
-- The check lives in the same predicate that create, update and publish already call, so all three are
-- gated by construction rather than by three remembered `if`s. The roster keeps warning: a lapsed bus
-- can still be re-assigned to a garage driver while it waits for the workshop.
--
-- The three documents here are the three that `isVehicleOperational()` in `@maak/core` already treats as
-- disqualifying, so the disabled option in the wizard and the refusal from the RPC cannot disagree.
--
-- `NULL` stays allowed: "we do not know when it expires" is not the same as "it has expired", and a
-- vehicle registered before this rule existed must not silently become unschedulable.
-- ---------------------------------------------------------------------------

create or replace function app.assert_trip_vehicle(p_vehicle_id uuid, p_owner_user uuid, p_owner_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vehicle public.vehicles%rowtype;
begin
  select * into v_vehicle from public.vehicles v where v.id = p_vehicle_id;
  if not found then
    raise exception 'NOT_FOUND: vehicle' using errcode = 'P0002';
  end if;

  if not (
    (p_owner_org is not null and v_vehicle.owner_org_id = p_owner_org)
    or (p_owner_user is not null and v_vehicle.owner_user_id = p_owner_user)
  ) then
    raise exception 'FORBIDDEN: the vehicle belongs to another owner' using errcode = '42501';
  end if;

  if v_vehicle.verification_status <> 'verified' then
    raise exception 'NOT_VERIFIED: the vehicle is not verified' using errcode = '42501';
  end if;

  if v_vehicle.status <> 'active' or not v_vehicle.is_active then
    raise exception 'CONFLICT: the vehicle is % and cannot be scheduled', v_vehicle.status
      using errcode = '23505';
  end if;

  -- The trip's own gate, so a stale tab and a fresh one are refused by the same rule.
  if v_vehicle.inspection_expiry is not null and v_vehicle.inspection_expiry < current_date then
    raise exception 'CONFLICT: the vehicle inspection expired on %', v_vehicle.inspection_expiry
      using errcode = '23505';
  end if;

  if v_vehicle.insurance_expiry is not null and v_vehicle.insurance_expiry < current_date then
    raise exception 'CONFLICT: the vehicle insurance expired on %', v_vehicle.insurance_expiry
      using errcode = '23505';
  end if;

  if v_vehicle.registration_expiry is not null and v_vehicle.registration_expiry < current_date then
    raise exception 'CONFLICT: the vehicle registration expired on %', v_vehicle.registration_expiry
      using errcode = '23505';
  end if;
end;
$$;
