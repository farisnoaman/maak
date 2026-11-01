-- Phase 11, the job that was written and never scheduled: maintenance reminders.
--
-- `app.job_maintenance_scan()` has existed since Phase 8 and is a careful piece of work — it notifies on the
-- *transition* into due/overdue, so a van that has been overdue for three weeks produces one notification
-- rather than twenty-one. Nothing called it. No command, no API action, no worker job: the fleet screens could
-- show a red badge and the owner was never told the belt was due, which is exactly the deliverable Phase 11's
-- plan line "Reminder jobs: … maintenance …" asks for.
--
-- So this migration is deliberately thin: it wraps the existing sweep in the same `cmd_*` shape every other
-- job uses (explicit actor, audit row, `service_role`-only), and leaves the dedupe rule where it belongs — in
-- the function that already implements it.

begin;

create or replace function public.cmd_run_maintenance_scan(
  p_actor uuid,
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_sent integer;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  -- Staff or the scheduler only. An owner running this for themselves would be harmless (the sweep is scoped to
  -- vehicles it reads anyway) but the shape matters: a job is a platform action, and the audit row should say
  -- so. The worker holds a staff token for exactly this reason.
  if not (app.has_role('platform_staff', v_uid)
          or app.has_role('platform_admin', v_uid)
          or app.has_role('finance_officer', v_uid)) then
    raise exception 'FORBIDDEN: the maintenance sweep is a platform job' using errcode = '42501';
  end if;

  v_sent := app.job_maintenance_scan(v_limit);

  perform app.write_audit(
    v_uid, 'notification.job', 'maintenance_scan', 'maintenance',
    null, jsonb_build_object('sent', v_sent, 'limit', v_limit), null, null, null
  );

  return jsonb_build_object('sent', v_sent);
end;
$$;

comment on function public.cmd_run_maintenance_scan(uuid, integer) is
  'Job: the daily maintenance sweep Phase 8 wrote and nothing scheduled — one notification per vehicle per transition into due/overdue.';

-- Same access shape as every other job in 00032: no client grant, the gateway resolves the actor and calls it
-- with the service role.
revoke all on function public.cmd_run_maintenance_scan(uuid, integer) from public, anon, authenticated;
grant execute on function public.cmd_run_maintenance_scan(uuid, integer) to service_role;

commit;
