-- ---------------------------------------------------------------------------
-- 00025 — Phase 7, part one: the trip's QR, the scan, and bulk verification
--
-- A supervisor on the road has a phone and a queue. This migration gives them the
-- three things that make that queue survivable:
--
--   1. **A trip has a token a camera can read.** Printed on the seating slip, stuck
--      to the windscreen, scanned at a checkpoint — the token identifies the trip,
--      not the passenger, so a scan reveals nothing until the server decides the
--      scanner is allowed to see it.
--   2. **Scope decides, every time.** A supervisor's coverage is the union of the
--      districts of the regions they hold (00008). A trip outside it is not "hidden
--      from the list", it is *refused* — `OUT_OF_SCOPE` — because "the trip is not
--      here" and "you may not see this trip" are different facts.
--   3. **Bulk verification is per-row.** Ten trips, one tap: nine verified, one
--      refused with a reason the supervisor can read. A bulk command that fails as
--      a whole teaches nobody anything and loses the nine.
--
-- Nothing here reads passenger identity data. The manifest has its own function and
-- its own audit row; a scan is a *permission question*, answered with a trimmed
-- view of the trip.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The token
-- ---------------------------------------------------------------------------

alter table public.trips
  add column if not exists qr_token text;

-- 24 hex characters: long enough to be unguessable at a checkpoint, short enough
-- for a QR at 3 cm and for a human to read out over the radio when the camera fails.
alter table public.trips
  drop constraint if exists trips_qr_token_shape;
alter table public.trips
  add constraint trips_qr_token_shape
  check (qr_token is null or qr_token ~ '^[0-9a-f]{24}$');

create unique index if not exists trips_qr_token_uq on public.trips (qr_token)
  where qr_token is not null;

/**
 * Issues a token for a trip if it has none.
 *
 * Idempotent, so the trigger below can call it on every publish, verification and
 * regeneration without a second thought. `md5(random())` rather than
 * `gen_random_bytes()`: the latter is pgcrypto and is not visible from a function
 * declared with an empty `search_path` (00003, and guard §12).
 */
create or replace function app.ensure_trip_qr_token(p_trip_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  select t.qr_token into v_token from public.trips t where t.id = p_trip_id for update;
  if v_token is not null then
    return v_token;
  end if;

  v_token := substr(md5(random()::text || clock_timestamp()::text || p_trip_id::text), 1, 24);
  update public.trips set qr_token = v_token where id = p_trip_id;
  return v_token;
end;
$$;

/**
 * Every trip that can be scanned gets a token, without a command having to remember.
 *
 * A trigger rather than a line in `cmd_decide_trip_verification`: the trip becomes
 * scannable at the moment it is *verified*, which happens from the verification
 * queue, the bulk command and the staff console alike. One rule, one place.
 */
create or replace function app.trip_qr_token_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.qr_token is null
     and (new.verification_status = 'verified' or new.status in ('published', 'in_progress', 'completed')) then
    new.qr_token := substr(md5(random()::text || clock_timestamp()::text || new.id::text), 1, 24);
  end if;
  return new;
end;
$$;

drop trigger if exists trip_qr_token on public.trips;
create trigger trip_qr_token
  before insert or update on public.trips
  for each row execute function app.trip_qr_token_trigger();

-- Backfill: a trip verified before this migration is already on somebody's windscreen.
update public.trips
set qr_token = substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 24)
where qr_token is null
  and (verification_status = 'verified' or status in ('published', 'in_progress', 'completed'));

-- ---------------------------------------------------------------------------
-- 2. The scan log
-- ---------------------------------------------------------------------------

create table if not exists public.trip_scan_log (
  id          bigint generated always as identity primary key,
  trip_id     uuid references public.trips (id) on delete set null,
  -- What was presented, kept even when it matched nothing: a run of misses is how
  -- a guessing attempt looks from this side of the door.
  token       text,
  actor_id    uuid references public.profiles (id) on delete set null,
  allowed     boolean not null,
  reason      text,
  created_at  timestamptz not null default now()
);

create index if not exists trip_scan_log_trip_idx on public.trip_scan_log (trip_id, created_at desc);
create index if not exists trip_scan_log_actor_idx on public.trip_scan_log (actor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Who counts as staff for these tools
-- ---------------------------------------------------------------------------

/**
 * Platform staff **and** geo-supervisors.
 *
 * `app.is_platform_staff()` answers a narrower question — "may this person see the whole platform?" —
 * and it is deliberately not widened here: a supervisor holding one region must not inherit the
 * platform's global read policies. This helper is the *ops* question ("may they use the staff tools?"),
 * and everything in this migration asks it instead.
 */
create or replace function app.is_ops_staff(p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    app.is_platform_staff(p_uid)
    or exists (
      select 1 from public.user_roles ur
      where ur.user_id = p_uid
        and ur.role = 'geo_supervisor'
        and ur.revoked_at is null
    ),
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Scope: is this trip inside the supervisor's patch?
-- ---------------------------------------------------------------------------

/**
 * The governorates a supervisor covers.
 *
 * **Both** roads into a governorate count:
 *
 *   · a region that names the governorate (`region_governorates`), and
 *   · a region that names districts of it (`region_districts`) — collapsed through `districts`,
 *     which is what `app.geo_scope_districts()` does.
 *
 * The first road is not a convenience. `geo_scope_districts()` reaches a governorate *only* through
 * its districts, so a governorate whose districts have not been imported yet gives a supervisor an
 * empty patch and a trip they are responsible for that they cannot see. The seed data has exactly
 * that shape today (Aden's districts are imported, most others are not), which is how this was found:
 * a Sanaa supervisor was told a Sanaa→Aden trip was out of scope.
 */
create or replace function app.staff_scope_governorates(p_uid uuid default app.uid())
returns table (governorate_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with assigned as (
    select ga.region_id
    from public.geo_assignments ga
    where ga.user_id = p_uid and ga.revoked_at is null
  ),
  covered as (
    select distinct r.region_id as id
    from assigned a
    cross join lateral app.region_descendants(a.region_id) r
  ),
  named as (
    select rg.governorate_id as id
    from public.region_governorates rg
    where rg.region_id in (select id from covered)
  ),
  by_district as (
    select d.governorate_id as id
    from app.geo_scope_districts(p_uid) scope
    join public.districts d on d.id = scope.district_id
  )
  select id from named
  union
  select id from by_district;
$$;

/**
 * May `p_actor` act on `p_trip_id` *as staff*, given their coverage?
 *
 * Three cases, and the middle one is the whole point:
 *
 *   · not staff at all → false, always;
 *   · staff with **no** geo assignment → global, true (platform staff and admins are
 *     not given a patch, and inventing one would lock them out of the queue);
 *   · staff **with** a patch → the trip has to touch it, by origin or destination.
 */
create or replace function app.staff_in_trip_scope(p_actor uuid, p_trip_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_scoped boolean;
begin
  if p_actor is null or not app.is_ops_staff(p_actor) then
    return false;
  end if;

  select * into v_trip from public.trips t where t.id = p_trip_id;
  if not found then
    return false;
  end if;

  select exists (
    select 1 from public.geo_assignments ga
    where ga.user_id = p_actor and ga.revoked_at is null
  ) into v_scoped;

  if not v_scoped then
    return true;
  end if;

  return exists (
    select 1 from app.staff_scope_governorates(p_actor) g
    where g.governorate_id in (v_trip.origin_governorate_id, v_trip.destination_governorate_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Bulk verification
-- ---------------------------------------------------------------------------

/**
 * Verify or reject a batch of trips, one row at a time.
 *
 * The shape of the answer is the feature: `{ results: [{ tripId, code, ok, error }],
 * verified, failed }`. A supervisor who selects ten and gets nine done needs to see
 * *which* one was refused and *why* — an all-or-nothing transaction would throw away
 * the nine and teach them nothing about the tenth.
 *
 * Each row goes through `cmd_decide_trip_verification`, so the events, the owner's
 * notification and the audit trail are exactly what a single decision produces. The
 * scope check happens here, first, because that is a property of the *scanner*, not
 * of the decision.
 */
create or replace function public.cmd_bulk_verify_trips(
  p_actor uuid,
  p_trip_ids uuid[],
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
  v_id uuid;
  v_code text;
  v_results jsonb := '[]'::jsonb;
  v_verified integer := 0;
  v_failed integer := 0;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_ops_staff(p_actor) then
    raise exception 'FORBIDDEN: staff only' using errcode = '42501';
  end if;
  if p_trip_ids is null or array_length(p_trip_ids, 1) is null then
    raise exception 'VALIDATION_FAILED: no trips selected' using errcode = '22023';
  end if;
  if array_length(p_trip_ids, 1) > 50 then
    raise exception 'VALIDATION_FAILED: at most 50 trips per batch' using errcode = '22023';
  end if;

  foreach v_id in array p_trip_ids loop
    v_code := null;
    begin
      select t.code into v_code from public.trips t where t.id = v_id;

      if v_code is null then
        v_results := v_results || jsonb_build_object('tripId', v_id, 'ok', false, 'error', 'NOT_FOUND');
        v_failed := v_failed + 1;
        continue;
      end if;

      if not app.staff_in_trip_scope(p_actor, v_id) then
        v_results := v_results || jsonb_build_object(
          'tripId', v_id, 'code', v_code, 'ok', false, 'error', 'OUT_OF_SCOPE'
        );
        v_failed := v_failed + 1;
        continue;
      end if;

      -- A nested block, so one bad row cannot abort the batch: `cmd_decide_…` raises
      -- for a trip in the wrong state, and that refusal belongs to this row only.
      begin
        perform public.cmd_decide_trip_verification(
          p_actor, v_id, p_outcome, p_reason, p_request_id, p_ip
        );
        v_results := v_results || jsonb_build_object('tripId', v_id, 'code', v_code, 'ok', true);
        v_verified := v_verified + 1;
      exception
        when others then
          v_results := v_results || jsonb_build_object(
            'tripId', v_id, 'code', v_code, 'ok', false,
            'error', split_part(sqlerrm, ':', 1),
            'detail', btrim(substr(sqlerrm, position(':' in sqlerrm) + 1))
          );
          v_failed := v_failed + 1;
      end;
    end;
  end loop;

  perform app.write_audit(
    p_actor, 'trip.bulkVerify', 'trip', null, null,
    jsonb_build_object(
      'outcome', p_outcome, 'requested', array_length(p_trip_ids, 1),
      'verified', v_verified, 'failed', v_failed
    ),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'results', v_results,
    'verified', v_verified,
    'failed', v_failed,
    'outcome', p_outcome
  );
end;
$$;

/** Re-issues a trip's token. The old sticker stops working the moment this returns. */
create or replace function public.cmd_rotate_trip_qr(
  p_actor uuid,
  p_trip_id uuid,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.staff_in_trip_scope(p_actor, p_trip_id)
     and not app.actor_can_manage_trip(p_actor, p_trip_id) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;

  v_token := substr(md5(random()::text || clock_timestamp()::text || p_trip_id::text), 1, 24);
  update public.trips set qr_token = v_token where id = p_trip_id;

  perform app.write_audit(
    p_actor, 'trip.rotateQr', 'trip', p_trip_id::text, null,
    jsonb_build_object('token', v_token), null, p_request_id, p_ip
  );

  return jsonb_build_object('qrToken', v_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5a. The decision itself, now that supervisors share it
-- ---------------------------------------------------------------------------

-- Re-created (not patched in place) so the widened gate is in the same file as the commands that
-- depend on it. The body is 00014's, with two changes: `is_platform_staff` became `is_ops_staff`, and
-- an out-of-patch decision is refused before anything is written.

create or replace function public.cmd_decide_trip_verification(
  p_actor uuid,
  p_trip_id uuid,
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
  v_trip public.trips%rowtype;
  v_new public.verification_status;
  v_owner uuid;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  -- Phase 7 widened this from "platform staff" to "ops staff": a geo-supervisor decides the queue in
  -- their patch, which is the entire reason their patch exists. Scope is re-checked here rather than
  -- trusted from the caller, because `cmd_bulk_verify_trips` is not the only caller.
  if not app.is_ops_staff(p_actor) then
    raise exception 'FORBIDDEN: staff only' using errcode = '42501';
  end if;
  if not app.staff_in_trip_scope(p_actor, p_trip_id) then
    raise exception 'FORBIDDEN: OUT_OF_SCOPE' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('approve', 'reject') then
    raise exception 'VALIDATION_FAILED: outcome' using errcode = '22023';
  end if;
  if p_outcome = 'reject' and (p_reason is null or length(btrim(p_reason)) < 10) then
    raise exception 'VALIDATION_FAILED: reason too short' using errcode = '22023';
  end if;

  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  if v_trip.verification_status <> 'pending' then
    raise exception 'CONFLICT: trip is already %, not awaiting review', v_trip.verification_status
      using errcode = '23505';
  end if;
  if v_trip.owner_user_id = p_actor then
    raise exception 'FORBIDDEN: own trip' using errcode = '42501';
  end if;

  v_new := case when p_outcome = 'approve' then 'verified' else 'rejected' end;

  update public.trips
  set verification_status = v_new,
      verified_by = p_actor,
      verified_at = now(),
      verification_note = nullif(btrim(coalesce(p_reason, '')), ''),
      -- A rejected trip leaves the marketplace in the same statement that rejects it.
      status = case when p_outcome = 'reject' and status = 'published' then 'draft' else status end,
      published_at = case when p_outcome = 'reject' then null else published_at end
  where id = p_trip_id
  returning * into v_trip;

  update public.trip_verifications
  set outcome = p_outcome, decided_by = p_actor, decided_at = now(),
      note = nullif(btrim(coalesce(p_reason, '')), '')
  where trip_id = p_trip_id and outcome is null;

  v_owner := coalesce(
    v_trip.owner_user_id,
    (select o.owner_id from public.organizations o where o.id = v_trip.owner_org_id)
  );

  perform app.notify(
    v_owner,
    case when p_outcome = 'approve' then 'verification_approved' else 'verification_rejected' end::public.notification_kind,
    case when p_outcome = 'approve' then 'notifications.tripApproved' else 'notifications.tripRejected' end,
    jsonb_build_object('code', v_trip.code, 'reason', p_reason),
    '/operator/trips'
  );

  insert into public.trip_events (trip_id, kind, actor_id, detail)
  values (p_trip_id,
          case when p_outcome = 'approve' then 'approved' else 'rejected' end::public.trip_event_kind,
          p_actor, jsonb_build_object('reason', p_reason));

  perform app.write_audit(
    p_actor, 'trip.decideVerification', 'trip', p_trip_id::text,
    jsonb_build_object('verification_status', 'pending'),
    jsonb_build_object('verification_status', v_new),
    p_reason, p_request_id, p_ip
  );

  select * into v_trip from public.trips t where t.id = p_trip_id;
  return jsonb_build_object('trip', to_jsonb(v_trip));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. What a scan is allowed to see
-- ---------------------------------------------------------------------------

/**
 * A token in, a trimmed trip out — and a row in the scan log either way.
 *
 * "Trimmed" is literal. A checkpoint needs: which trip, whose, when, how full, and
 * whether it is cleared to travel. It does **not** need names, phone numbers, ID
 * numbers or a photograph, and giving them to every scanner in the country would
 * make the QR a privacy hole with a nice print job.
 *
 * The refusals are distinguishable on purpose: `NOT_FOUND` for a token that matches
 * nothing, `OUT_OF_SCOPE` for a trip that exists and is not yours to inspect. The UI
 * shows «خارج نطاقك» for the second and «رمز غير معروف» for the first.
 *
 * A refusal is **returned**, not raised. Raising would roll back the `trip_scan_log`
 * row written a line earlier — so the one scan an investigator most wants to see, the
 * refused one, would be the only one that never happened. `allowed: false` with a
 * reason is the same answer to the UI, and it survives the transaction.
 */
create or replace function public.get_trip_for_staff(
  p_actor uuid,
  p_token text,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_scope boolean := false;
  v_rate jsonb;
  v_result jsonb;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_ops_staff(p_actor) then
    raise exception 'FORBIDDEN: staff only' using errcode = '42501';
  end if;

  -- A camera is a machine gun: hold the button and it reads twenty codes a second.
  -- `consume_rate_limit` returns the counter, not a verdict — the comparison belongs here.
  v_rate := app.consume_rate_limit(p_actor, 'staff.scan', 120, 60);
  if coalesce((v_rate ->> 'used')::int, 0) > 120 then
    insert into public.trip_scan_log (trip_id, token, actor_id, allowed, reason)
    values (null, left(p_token, 64), p_actor, false, 'RATE_LIMITED');
    return jsonb_build_object('allowed', false, 'reason', 'RATE_LIMITED', 'trip', null);
  end if;

  select * into v_trip
  from public.trips t
  where t.qr_token = lower(btrim(coalesce(p_token, '')))
  limit 1;

  if not found then
    insert into public.trip_scan_log (trip_id, token, actor_id, allowed, reason)
    values (null, left(p_token, 64), p_actor, false, 'NOT_FOUND');
    return jsonb_build_object('allowed', false, 'reason', 'NOT_FOUND', 'trip', null);
  end if;

  v_scope := app.staff_in_trip_scope(p_actor, v_trip.id);

  insert into public.trip_scan_log (trip_id, token, actor_id, allowed, reason)
  values (v_trip.id, left(p_token, 64), p_actor, v_scope, case when v_scope then null else 'OUT_OF_SCOPE' end);

  if not v_scope then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'OUT_OF_SCOPE',
      'trip', jsonb_build_object(
        'code', v_trip.code,
        'origin', (select g.name_ar from public.governorates g where g.id = v_trip.origin_governorate_id),
        'destination', (select g.name_ar from public.governorates g where g.id = v_trip.destination_governorate_id)
      )
    );
  end if;

  select jsonb_build_object(
    'trip', jsonb_build_object(
      'id', v_trip.id,
      'code', v_trip.code,
      'status', v_trip.status,
      'verificationStatus', v_trip.verification_status,
      'departureAt', v_trip.departure_at,
      'arriveEstimateMinutes', v_trip.arrive_estimate_minutes,
      'seatsTotal', v_trip.seats_total,
      'seatsAvailable', v_trip.seats_available,
      'bookedSeats', coalesce((
        select sum(b.seats)::int from public.bookings b
        where b.trip_id = v_trip.id and b.status in ('pending', 'accepted', 'completed')
      ), 0),
      'origin', (select g.name_ar from public.governorates g where g.id = v_trip.origin_governorate_id),
      'originEn', (select g.name_en from public.governorates g where g.id = v_trip.origin_governorate_id),
      'destination', (select g.name_ar from public.governorates g where g.id = v_trip.destination_governorate_id),
      'destinationEn', (select g.name_en from public.governorates g where g.id = v_trip.destination_governorate_id),
      'operatorName', case
        when v_trip.owner_org_id is not null then (select o.name from public.organizations o where o.id = v_trip.owner_org_id)
        else (select p.full_name from public.profiles p where p.id = v_trip.owner_user_id)
      end,
      'vehicleLabel', (
        select concat_ws(' ', v.make, v.model, v.plate_number)
        from public.vehicles v where v.id = v_trip.vehicle_id
      ),
      'driverName', (select d.full_name from public.driver_profiles d where d.id = v_trip.driver_id),
      'startedAt', v_trip.started_at,
      'lastPingAt', v_trip.last_ping_at
    ),
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'seq', s.seq,
        'nameAr', coalesce(p.name_ar, s.name_ar),
        'nameEn', coalesce(p.name_en, s.name_en),
        'arriveOffsetMinutes', s.arrive_offset_minutes,
        'reached', coalesce(v_trip.last_stop_seq, 0) >= s.seq
      ) order by s.seq)
      from public.trip_stops s
      left join public.places p on p.id = s.place_id
      where s.trip_id = v_trip.id
    ), '[]'::jsonb),
    -- The manifest exists, but reading it is a second, audited decision.
    'manifestAvailable', true,
    'scannedAt', now()
  ) into v_result;

  -- The trimmed view is the payload; `allowed` is how a caller knows to render it.
  v_result := v_result || jsonb_build_object('allowed', true, 'reason', null);

  return v_result;
end;
$$;

/**
 * The manifest, for an operator of the trip or a supervisor whose patch it is.
 *
 * Separate from `get_trip_for_staff` on purpose: a scan needs no passenger names, and
 * a manifest needs all of them. Two functions, two audits, two different questions.
 */
create or replace function public.get_trip_manifest(
  p_actor uuid,
  p_trip_id uuid,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_passengers jsonb;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_trip from public.trips t where t.id = p_trip_id;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  if not (app.actor_can_manage_trip(p_actor, p_trip_id) or app.staff_in_trip_scope(p_actor, p_trip_id)) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(item order by seat_seq), '[]'::jsonb) into v_passengers
  from (
    select
      row_number() over (order by b.accepted_at nulls last, b.created_at) as seat_seq,
      jsonb_build_object(
        'code', b.code,
        'seats', b.seats,
        'name', b.contact_name,
        'phone', b.contact_phone,
        'gender', b.passenger_gender,
        'status', b.status,
        'paymentStatus', b.payment_status,
        'totalYer', b.total_yer,
        'note', b.note
      ) as item
    from public.bookings b
    where b.trip_id = p_trip_id and b.status in ('accepted', 'completed')
  ) rows;

  -- Generation is audited: a printed manifest is a list of names and phone numbers
  -- leaving the building, and "who printed this" is a question with an answer.
  perform app.write_audit(
    p_actor, 'trip.manifest', 'trip', p_trip_id::text, null,
    jsonb_build_object('passengers', jsonb_array_length(v_passengers)), null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'trip', jsonb_build_object(
      'id', v_trip.id,
      'code', v_trip.code,
      'status', v_trip.status,
      'verificationStatus', v_trip.verification_status,
      'departureAt', v_trip.departure_at,
      'arriveEstimateMinutes', v_trip.arrive_estimate_minutes,
      'seatsTotal', v_trip.seats_total,
      'seatsAvailable', v_trip.seats_available,
      'origin', (select g.name_ar from public.governorates g where g.id = v_trip.origin_governorate_id),
      'originEn', (select g.name_en from public.governorates g where g.id = v_trip.origin_governorate_id),
      'destination', (select g.name_ar from public.governorates g where g.id = v_trip.destination_governorate_id),
      'destinationEn', (select g.name_en from public.governorates g where g.id = v_trip.destination_governorate_id),
      'operatorName', case
        when v_trip.owner_org_id is not null then (select o.name from public.organizations o where o.id = v_trip.owner_org_id)
        else (select p.full_name from public.profiles p where p.id = v_trip.owner_user_id)
      end,
      'vehicleLabel', (
        select concat_ws(' ', v.make, v.model, v.plate_number)
        from public.vehicles v where v.id = v_trip.vehicle_id
      ),
      'vehicleSeats', (select v.seats_passenger from public.vehicles v where v.id = v_trip.vehicle_id),
      'driverName', (select d.full_name from public.driver_profiles d where d.id = v_trip.driver_id),
      'driverPhone', (select d.invited_phone from public.driver_profiles d where d.id = v_trip.driver_id),
      'qrToken', v_trip.qr_token
    ),
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'seq', s.seq,
        'nameAr', coalesce(p.name_ar, s.name_ar),
        'nameEn', coalesce(p.name_en, s.name_en),
        'arriveOffsetMinutes', s.arrive_offset_minutes
      ) order by s.seq)
      from public.trip_stops s
      left join public.places p on p.id = s.place_id
      where s.trip_id = v_trip.id
    ), '[]'::jsonb),
    'passengers', v_passengers,
    'passengerCount', jsonb_array_length(v_passengers)
  );
end;
$$;

/**
 * The supervisor's dashboard: the queue in their patch, and what is moving.
 *
 * One call rather than four, because a dashboard that needs four round trips to
 * decide whether to render is a dashboard that renders half-filled.
 */
create or replace function public.staff_scope_summary(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_scoped boolean;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_ops_staff(p_actor) then
    raise exception 'FORBIDDEN: staff only' using errcode = '42501';
  end if;

  select exists (
    select 1 from public.geo_assignments ga
    where ga.user_id = p_actor and ga.revoked_at is null
  ) into v_scoped;

  return jsonb_build_object(
    'global', not v_scoped,
    'governorates', coalesce((
      select jsonb_agg(g.governorate_id) from app.staff_scope_governorates(p_actor) g
    ), '[]'::jsonb),
    'pendingTrips', (
      select count(*)::int from public.trips t
      where t.status = 'pending'
        and (not v_scoped or exists (
          select 1 from app.staff_scope_governorates(p_actor) g
          where g.governorate_id in (t.origin_governorate_id, t.destination_governorate_id)
        ))
    ),
    'liveTrips', (
      select count(*)::int from public.trips t
      where t.status = 'in_progress'
        and (not v_scoped or exists (
          select 1 from app.staff_scope_governorates(p_actor) g
          where g.governorate_id in (t.origin_governorate_id, t.destination_governorate_id)
        ))
    ),
    'staleTrips', (
      select count(*)::int from public.trips t
      where t.status = 'in_progress'
        and (t.last_ping_at is null or t.last_ping_at < now() - make_interval(secs => app.ping_stale_after_seconds()))
        and (not v_scoped or exists (
          select 1 from app.staff_scope_governorates(p_actor) g
          where g.governorate_id in (t.origin_governorate_id, t.destination_governorate_id)
        ))
    ),
    'recentScans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tripId', s.trip_id,
        'code', (select t.code from public.trips t where t.id = s.trip_id),
        'allowed', s.allowed,
        'reason', s.reason,
        'at', s.created_at
      ) order by s.created_at desc)
      from (
        select * from public.trip_scan_log l
        where l.actor_id = p_actor
        order by l.created_at desc
        limit 10
      ) s
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5b. Search, widened to the supervisor and narrowed to the patch
-- ---------------------------------------------------------------------------

/**
 * Re-created from 00014 (same signature, so 00016's grant still matches).
 *
 * Two changes. The gate is `app.is_ops_staff` rather than platform staff, because a supervisor
 * reviewing a checkpoint queue is exactly who searches for "the trip from yesterday that nobody
 * verified". And the rows are filtered by the same `app.staff_scope_governorates` the scan uses — a
 * search that returns trips you cannot then act on is worse than one that returns nothing.
 *
 * Filters: `status[]`, `verificationStatus[]`, `q` (code or governorate), `from` / `to` (departure
 * date, inclusive), `governorateId` (either end of the route). Dates are compared against the Aden
 * calendar day: `from` is `00:00` local and `to` is the *end* of its day, because "the 14th to the
 * 14th" means one day to a human and zero days to a naive comparison.
 */
create or replace function public.staff_search_trips(
  p_actor uuid,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_global boolean;
  v_from timestamptz;
  v_to timestamptz;
  v_governorate uuid;
  v_items jsonb;
begin
  if p_actor is null or not app.is_ops_staff(p_actor) then
    raise exception 'FORBIDDEN: staff only' using errcode = '42501';
  end if;

  -- No assignment at all means no patch, which for platform staff means the whole country.
  select not exists (
    select 1 from public.geo_assignments ga
    where ga.user_id = p_actor and ga.revoked_at is null
  ) into v_global;

  if v_filters ? 'from' and nullif(v_filters ->> 'from', '') is not null then
    v_from := ((v_filters ->> 'from')::date)::timestamp at time zone 'Asia/Aden';
  end if;
  if v_filters ? 'to' and nullif(v_filters ->> 'to', '') is not null then
    v_to := (((v_filters ->> 'to')::date + 1)::timestamp at time zone 'Asia/Aden');
  end if;
  if v_filters ? 'governorateId' and nullif(v_filters ->> 'governorateId', '') is not null then
    v_governorate := (v_filters ->> 'governorateId')::uuid;
  end if;

  select coalesce(jsonb_agg(item order by departure_at desc), '[]'::jsonb) into v_items
  from (
    select t.departure_at, jsonb_build_object(
      'id', t.id,
      'code', t.code,
      'status', t.status,
      'verificationStatus', t.verification_status,
      'departureAt', t.departure_at,
      'seatsAvailable', t.seats_available,
      'seatsTotal', t.seats_total,
      'priceFromYer', coalesce(app.trip_price_from(t.id), 0),
      'operatorName', case
        when t.owner_org_id is not null then (select o.name from public.organizations o where o.id = t.owner_org_id)
        else (select p.full_name from public.profiles p where p.id = t.owner_user_id)
      end,
      'cancelReason', t.cancel_reason,
      'originId', t.origin_governorate_id,
      'destinationId', t.destination_governorate_id,
      'qrToken', t.qr_token,
      'origin', (select g.name_ar from public.governorates g where g.id = t.origin_governorate_id),
      'destination', (select g.name_ar from public.governorates g where g.id = t.destination_governorate_id)
    ) as item
    from public.trips t
    where (
        not (v_filters ? 'status')
        or t.status::text in (select jsonb_array_elements_text(v_filters -> 'status'))
      )
      and (
        not (v_filters ? 'verificationStatus')
        or t.verification_status::text in (
          select jsonb_array_elements_text(v_filters -> 'verificationStatus')
        )
      )
      and (
        not (v_filters ? 'q')
        or v_filters ->> 'q' = ''
        or t.code ilike '%' || (v_filters ->> 'q') || '%'
        or exists (
          select 1 from public.governorates g
          where g.id in (t.origin_governorate_id, t.destination_governorate_id)
            and (g.name_ar ilike '%' || (v_filters ->> 'q') || '%'
              or g.name_en ilike '%' || (v_filters ->> 'q') || '%')
        )
      )
      and (v_from is null or t.departure_at >= v_from)
      and (v_to is null or t.departure_at < v_to)
      and (
        v_governorate is null
        or v_governorate in (t.origin_governorate_id, t.destination_governorate_id)
      )
      and (
        v_global
        or t.origin_governorate_id in (select g.governorate_id from app.staff_scope_governorates(p_actor) g)
        or t.destination_governorate_id in (select g.governorate_id from app.staff_scope_governorates(p_actor) g)
      )
    order by t.departure_at desc
    limit v_limit
  ) x;

  return jsonb_build_object('items', v_items, 'global', v_global);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Session-bound wrappers (what the web app actually calls)
-- ---------------------------------------------------------------------------

/**
 * The three staff reads, bound to `app.uid()`.
 *
 * The functions above take the actor as an argument because the gateway resolves it once and passes it
 * down — the right shape for an edge function, the wrong one for a Server Component that already has a
 * session. These wrappers are `security definer` and take **no** actor: the only identity they can use
 * is the one on the request's JWT, so a browser cannot ask about somebody else's patch by editing a
 * parameter. This is the same shape as `public.app_consume_rate_limit()` from 00005.
 */
create or replace function public.staff_scan(p_token text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.get_trip_for_staff(app.uid(), p_token, null);
$$;

create or replace function public.staff_summary()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.staff_scope_summary(app.uid());
$$;

create or replace function public.staff_manifest(p_trip_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.get_trip_manifest(app.uid(), p_trip_id, null, null);
$$;

-- ---------------------------------------------------------------------------
-- 6. Access
-- ---------------------------------------------------------------------------

alter table public.trip_scan_log enable row level security;

-- The scan log is staff reading; there is no client write path and no need for one.
drop policy if exists trip_scan_log_read_staff on public.trip_scan_log;
create policy trip_scan_log_read_staff on public.trip_scan_log
  for select to authenticated
  using (app.is_platform_staff(app.uid()) and (actor_id = app.uid() or app.is_platform_staff(app.uid())));

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.cmd_bulk_verify_trips(uuid, uuid[], public.verification_outcome, text, text, inet)',
    'public.cmd_rotate_trip_qr(uuid, uuid, text, inet)',
    'public.get_trip_for_staff(uuid, text, inet)',
    'public.get_trip_manifest(uuid, uuid, text, inet)',
    'public.staff_scope_summary(uuid)',
    'app.ensure_trip_qr_token(uuid)',
    'app.staff_in_trip_scope(uuid, uuid)',
    'app.is_ops_staff(uuid)',
    'app.staff_scope_governorates(uuid)',
    'app.trip_qr_token_trigger()'
  ]
  loop
    continue when to_regprocedure(v_signature) is null;
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

-- A policy evaluates its predicate as the caller, so the helpers it calls have to be
-- executable by them (00024 learnt this the loud way).
grant execute on function app.is_platform_staff(uuid) to authenticated;
grant execute on function app.is_ops_staff(uuid) to authenticated;
grant execute on function app.staff_scope_governorates(uuid) to authenticated;

grant execute on function public.staff_scan(text) to authenticated, service_role;
grant execute on function public.staff_summary() to authenticated, service_role;
grant execute on function public.staff_manifest(uuid) to authenticated, service_role;
revoke all on function public.staff_scan(text) from anon;
revoke all on function public.staff_summary() from anon;
revoke all on function public.staff_manifest(uuid) from anon;

revoke all on table public.trip_scan_log from anon, authenticated;
grant select on table public.trip_scan_log to authenticated;
grant all on table public.trip_scan_log to service_role;

comment on column public.trips.qr_token is
  'The 24-hex code a checkpoint scans. Issued on verification, rotatable by its operator or a supervisor in scope.';
comment on table public.trip_scan_log is
  'Every scan attempt, allowed or not, with the actor. A run of misses is what a guessing attempt looks like from here.';
comment on function app.staff_in_trip_scope(uuid, uuid) is
  'Platform staff with no geo assignment are global; with one, the trip must touch their patch by origin or destination.';
