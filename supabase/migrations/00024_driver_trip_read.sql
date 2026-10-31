-- ---------------------------------------------------------------------------
-- 00024 — the driver can read the trip they are driving (Phase 6.2 defect)
--
-- 00014's read policies answer one question — "may this user *see* this trip?" — and for a driver the
-- only clause that matched was `status = 'published'`. That is enough while they are loading the
-- vehicle and stops being enough the moment `cmd_start_trip` moves it to `in_progress`: the driver's
-- own console then renders "this trip is not assigned to you", because the row it needs is invisible.
--
-- The commands were never the problem (they are `security definer` and re-derive the driver from
-- `driver_profiles`); the *read* was. This migration closes the gap in the two places the driver's
-- console reads: the trip, its stops, and the passenger count it shows.
-- ---------------------------------------------------------------------------

create or replace function app.can_read_trip(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id
      and (
        (t.status = 'published' and t.verification_status <> 'rejected' and t.cancelled_at is null)
        or (t.owner_user_id is not null and t.owner_user_id = app.uid())
        or (t.owner_org_id is not null and app.is_org_member(t.owner_org_id))
        -- The assigned driver, in every status: an `in_progress` trip is precisely the one they must
        -- be able to read, and a `completed` one stays in their history.
        or app.is_trip_driver(app.uid(), t.id)
        or app.is_platform_staff()
      )
  );
$$;

alter table public.trips enable row level security;

drop policy if exists trips_read_visible on public.trips;
create policy trips_read_visible on public.trips
  for select to authenticated
  using (
    (status = 'published' and verification_status <> 'rejected' and cancelled_at is null)
    or (owner_user_id is not null and owner_user_id = app.uid())
    or (owner_org_id is not null and app.is_org_member(owner_org_id))
    or app.is_trip_driver(app.uid(), id)
    or app.is_platform_staff()
  );

-- The console shows how many seats are taken; that number lives in `bookings`, which the driver could
-- not read either. A driver sees the bookings on their own trip and nothing else — no documents, no
-- payment, no contact details beyond what the manifest needs later (Phase 7).
drop policy if exists bookings_read_driver on public.bookings;
create policy bookings_read_driver on public.bookings
  for select to authenticated
  using (app.is_trip_driver(app.uid(), trip_id));

-- A policy runs with the caller's rights, so a predicate used *inside* one must be executable by them.
-- `app.is_trip_driver` was granted to `service_role` only (00022), which made every new policy that
-- mentions it answer `permission denied for function is_trip_driver` — a 500 from PostgREST, not an
-- empty result, which is how a "driver sees their trip" fix can look like a database outage.
grant execute on function app.is_trip_driver(uuid, uuid) to authenticated;

comment on function app.can_read_trip(uuid) is
  'May the caller read this trip? Public when published, plus its owner, its organisation, its assigned driver and platform staff.';
