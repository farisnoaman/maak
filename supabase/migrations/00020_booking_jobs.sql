-- ---------------------------------------------------------------------------
-- 00020 — Phase 5: the scheduled sweeps
--
-- Phase 5's promises are time-shaped: a pending request holds its seats for 30 minutes and then must let
-- go, a trip that has left must stop showing "accepted", and an ID image must not live forever. Each of
-- those is already a command (`cmd_expire_booking_holds`, `cmd_finalize_trip_bookings`,
-- `cmd_purge_id_documents`); the job below is a three-line wrapper, so there is exactly one copy of every
-- rule — the one the pgTAP suite exercises — and the scheduler only decides *when*.
--
-- `pg_cron` is installed on Supabase, and this file schedules the three jobs there. It is *not* in the
-- dev/sql-check cluster (embedded Postgres, no Docker), so the schedule block is guarded twice: the
-- functions exist everywhere, the `cron.schedule` calls only where the extension does. The dev backend
-- runs the same functions from a timer, so a laptop expires a hold without pretending to be a cron.
-- ---------------------------------------------------------------------------

/**
 * Hold sweeper. Two minutes is well inside the 30-minute hold, so a seat never sits locked for long after
 * its request died, and the call is cheap when there is nothing to do (one indexed range scan).
 */
create or replace function app.job_expire_holds(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  return coalesce((public.cmd_expire_booking_holds(p_limit) ->> 'expired')::int, 0);
end;
$$;

/**
 * Closes the bookings of trips that have left.
 *
 * The trip's own status is Phase 6's business; this job only answers "is this passenger still expected",
 * and it re-checks each trip through the command, so a trip cancelled in the meantime is refused rather
 * than completed by mistake.
 */
create or replace function app.job_finalize_trips(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip uuid;
  v_count integer := 0;
begin
  for v_trip in
    select t.id
    from public.trips t
    where t.status <> 'cancelled'
      and t.departure_at < now()
      and exists (
        select 1 from public.bookings b
        where b.trip_id = t.id and b.status = 'accepted'
      )
    order by t.departure_at
    limit greatest(coalesce(p_limit, 200), 1)
  loop
    v_count := v_count + coalesce(
      (public.cmd_finalize_trip_bookings(v_trip, 'cron') ->> 'completed')::int, 0
    );
  end loop;

  return v_count;
end;
$$;

/**
 * Deletes the ID images of bookings that ended long ago.
 *
 * The default (90 days) is a retention floor, not a target: the row and its audit trail stay, only the
 * photo goes. `cmd_purge_id_documents` owns the cutoff and the audit row.
 */
create or replace function app.job_purge_documents(p_older_than_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  return coalesce((public.cmd_purge_id_documents(p_older_than_days) ->> 'deleted')::int, 0);
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'app.job_expire_holds(integer)',
    'app.job_finalize_trips(integer)',
    'app.job_purge_documents(integer)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The schedule, where a scheduler exists
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available here; the job functions are still callable by name';
    return;
  end if;

  begin
    execute 'create extension if not exists pg_cron';
  exception
    when others then
      raise notice 'pg_cron could not be created (%); leaving the schedule to the platform', sqlerrm;
      return;
  end;

  -- `cron.schedule(name, …)` upserts by name, so re-running the migration never stacks duplicates.
  execute $q$select cron.schedule('maak_expire_booking_holds', '*/2 * * * *',
                                   'select app.job_expire_holds(500)')$q$;
  execute $q$select cron.schedule('maak_finalize_trip_bookings', '*/10 * * * *',
                                   'select app.job_finalize_trips(200)')$q$;
  execute $q$select cron.schedule('maak_purge_id_documents', '30 3 * * *',
                                   'select app.job_purge_documents(90)')$q$;
end;
$$;
