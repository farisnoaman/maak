-- Phase 12 — the partition that had no row-level security.
--
-- `public.trip_location_pings` is partitioned by month; the parent has RLS and one policy (the trip's driver
-- or a manager), and Phase 7 granted `select` on the *parent*. The partitions were created with
-- `create table … partition of`, which copies neither the policies nor the grants — so every child table was a
-- table with RLS switched off. Nothing leaked, because a child also inherits no `authenticated` grant and the
-- ACL refuses first; but "the second line of defence happens to hold" is not a security posture, and the new
-- `▶ security posture` section of `npm run sql:check` fails on it.
--
-- Two fixes, because there are two ways a partition appears:
--   1. this migration repairs the ones that exist;
--   2. `app.ensure_trip_ping_partition()` — which creates next month's table on first ping — now applies the
--      same three statements itself, so the hole cannot reopen quietly.

begin;

do $$
declare
  v_child text;
begin
  for v_child in
    select c.relname
      from pg_class c
      join pg_inherits i on i.inhrelid = c.oid
      join pg_class p on p.oid = i.inhparent
      join pg_namespace n on n.oid = p.relnamespace
     where n.nspname = 'public'
       and p.relname = 'trip_location_pings'
  loop
    execute format('alter table public.%I enable row level security', v_child);
    execute format('alter table public.%I force row level security', v_child);
    execute format('drop policy if exists trip_pings_read_own on public.%I', v_child);
    execute format(
      'create policy trip_pings_read_own on public.%I for select to authenticated '
      'using (app.is_trip_driver(app.uid(), trip_id) or app.actor_can_manage_trip(app.uid(), trip_id))',
      v_child
    );
    -- The parent's grant is the only one a client should hold; a direct grant on a child would be a second
    -- door to the same rows.
    execute format('revoke all on table public.%I from anon, authenticated', v_child);
  end loop;
end;
$$;

/**
 * Creating a partition now means making it look like its parent.
 *
 * `security definer`, because a ping arrives from a driver whose role cannot create tables — and `search_path`
 * is pinned, because a definer function that trusts its path is how a schema gets hijacked.
 */
create or replace function app.ensure_trip_ping_partition(p_at timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := date_trunc('month', p_at at time zone 'utc') at time zone 'utc';
  v_to   timestamptz := (date_trunc('month', p_at at time zone 'utc') + interval '1 month') at time zone 'utc';
  v_name text := 'trip_location_pings_' || to_char(p_at at time zone 'utc', 'YYYYMM');
begin
  if to_regclass('public.' || v_name) is null then
    execute format(
      'create table if not exists public.%I partition of public.trip_location_pings for values from (%L) to (%L)',
      v_name, v_from, v_to
    );
  end if;

  -- Idempotent, and applied on every call: a partition created by an older version of this function, or by a
  -- `create table … partition of` typed by hand at 2am, gets the same treatment the next time a ping lands.
  execute format('alter table public.%I enable row level security', v_name);
  execute format('alter table public.%I force row level security', v_name);
  execute format('drop policy if exists trip_pings_read_own on public.%I', v_name);
  execute format(
    'create policy trip_pings_read_own on public.%I for select to authenticated '
    'using (app.is_trip_driver(app.uid(), trip_id) or app.actor_can_manage_trip(app.uid(), trip_id))',
    v_name
  );
  execute format('revoke all on table public.%I from anon, authenticated', v_name);

  return v_name;
end;
$$;

comment on function app.ensure_trip_ping_partition(timestamptz) is
  'Creates the month''s ping partition and gives it the parent''s RLS, policy and grants — a partition is a table too.';

revoke all on function app.ensure_trip_ping_partition(timestamptz) from public, anon, authenticated;
grant execute on function app.ensure_trip_ping_partition(timestamptz) to service_role;

commit;
