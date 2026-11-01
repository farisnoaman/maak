-- Phase 12 — the platform's own health, said out loud.
--
-- Phase 11 gave every *person* a channel. This migration gives the *platform* one: a nightly sweep that looks at
-- the six things the launch plan says somebody must be told about — stale live trips, failed notifications,
-- unbalanced journals, a verification backlog, a payment waiting too long for a decision, and a burst of denied
-- or failed commands — and enqueues one alert per condition through the same `app.enqueue_notification` the user
-- notifications use.
--
-- Why a sweep and not an alerting service: every condition here is a SQL predicate over tables this database
-- already owns. A dashboard nobody watches is a dashboard; a row in `notification_deliveries` with a dedupe key
-- is an alert that pages a phone, keeps a receipt, and can be explained in a support case a month later.
--
-- Dedupe is per check per day (`ops-alert:<check>:<YYYY-MM-DD>`). A trip stuck in `in_progress` for three days
-- produces three alerts, not three hundred, and the count inside each one is what changes.

begin;

alter type public.notification_kind add value if not exists 'ops_alert';

-- A new enum value cannot be used as a literal in the transaction that adds it.
commit;

begin;

-- The six checks, named once so the SQL, the API and the runbook cannot drift.
create or replace function app.ops_checks()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'stale_trips',
    'dead_deliveries',
    'unbalanced_journals',
    'verification_backlog',
    'payment_sla',
    'error_rate'
  ]::text[];
$$;

comment on function app.ops_checks() is
  'The launch runbook''s alert list, in one place: the sweep, the API and docs/runbook.md read the same names.';

insert into public.notification_events (kind, title_key, priority, default_channels) values
  ('ops_alert', 'notifications.opsStaleTrips', 'critical', '{in_app, push, email}')
on conflict (kind) do nothing;

/**
 * The sweep.
 *
 * One pass, six predicates, one notification per *failing* check per recipient per day. Returning the counts
 * even when nothing failed is deliberate: the scheduler logs the result, and "ran and found nothing" is a very
 * different line in a log from "did not run".
 *
 * `p_now` exists so a test can pin the clock instead of waiting for 02:00, the same trick the quiet-hours
 * functions use — but the dedupe key is derived from `p_now` too, so two runs inside one simulated day agree.
 */
create or replace function public.cmd_run_ops_alerts(
  p_actor uuid default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
  -- `coalesce`, not the parameter default: the API sends `p_now: null` from the job runner, and an explicit null
  -- overrides a default. Without this every comparison below would be NULL, every count would be zero, and the
  -- sweep would report a healthy platform for ever — the most dangerous possible bug in an alerting job.
  v_now timestamptz := coalesce(p_now, now());
  v_day text := to_char(coalesce(p_now, now()) at time zone app.notification_timezone(), 'YYYY-MM-DD');
  v_counts jsonb := '{}'::jsonb;
  v_failed text[] := array[]::text[];
  v_count integer;
  v_recipient uuid;
  v_sent integer := 0;
  v_check text;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not (app.has_role('platform_staff', v_uid)
          or app.has_role('platform_admin', v_uid)
          or app.has_role('finance_officer', v_uid)) then
    raise exception 'FORBIDDEN: platform alerts are a staff view' using errcode = '42501';
  end if;

  -- 1. A trip that went `in_progress` and never came back. Eighteen hours is longer than any domestic leg on
  --    the network, so this is a forgotten button or a driver whose phone died — both worth a call.
  select count(*)::int into v_count
    from public.trips t
   where t.status = 'in_progress'
     and coalesce(t.started_at, t.departure_at) < v_now - interval '18 hours';
  v_counts := v_counts || jsonb_build_object('stale_trips', v_count);
  if v_count > 0 then v_failed := v_failed || 'stale_trips'::text; end if;

  -- 2. Deliveries that exhausted five attempts. One is noise; a run of them is a provider problem, and the
  --    health screen is where support looks.
  select count(*)::int into v_count
    from public.notification_deliveries d
   where d.status = 'dead'
     and d.created_at > v_now - interval '7 days';
  v_counts := v_counts || jsonb_build_object('dead_deliveries', v_count);
  if v_count > 0 then v_failed := v_failed || 'dead_deliveries'::text; end if;

  -- 3. The ledger, checked without running the whole Phase 10 integrity job: this is the one check that must
  --    never be true, and if it ever is, finance hears about it before the month closes.
  select count(*)::int into v_count
    from (
      select l.journal_id
        from public.ledger_entries l
       group by l.journal_id
      having sum(case when l.direction = 'debit' then l.amount_yer else -l.amount_yer end) <> 0
    ) x;
  v_counts := v_counts || jsonb_build_object('unbalanced_journals', v_count);
  if v_count > 0 then v_failed := v_failed || 'unbalanced_journals'::text; end if;

  -- 4. The verification queue: pending requests older than the 48-hour SLA. The per-request nag is Phase 11's
  --    `verification-sla` job; this is the count that tells a manager the queue is not moving.
  select count(*)::int into v_count
    from public.verification_requests r
   where r.status = 'pending'
     and r.created_at < v_now - interval '48 hours';
  v_counts := v_counts || jsonb_build_object('verification_backlog', v_count);
  if v_count > 0 then v_failed := v_failed || 'verification_backlog'::text; end if;

  -- 5. A receipt a passenger uploaded and nobody has decided on for six hours. Phase 9 promised a human
  --    decision; this is the promise being kept loudly.
  select count(*)::int into v_count
    from public.payment_intents i
   where i.status = 'awaiting_confirmation'
     and i.proof_uploaded_at < v_now - interval '6 hours';
  v_counts := v_counts || jsonb_build_object('payment_sla', v_count);
  if v_count > 0 then v_failed := v_failed || 'payment_sla'::text; end if;

  -- 6. Commit refusals in the last hour. `audit.log` writes a row for every denied or failed command, so a
  --    spike is the closest thing this system has to an error rate — and twenty in an hour is not a typo.
  select count(*)::int into v_count
    from audit.log a
   where a.outcome in ('denied', 'failed')
     and a.created_at > v_now - interval '1 hour';
  v_counts := v_counts || jsonb_build_object('error_rate', v_count);
  if v_count > 0 and v_count >= 20 then v_failed := v_failed || 'error_rate'::text; end if;

  for v_check in select unnest(v_failed) loop
    for v_recipient in
      select distinct ur.user_id
        from public.user_roles ur
       where ur.revoked_at is null
         and (
           (v_check in ('unbalanced_journals', 'payment_sla')
             and ur.role in ('finance_officer', 'platform_admin'))
           or (v_check not in ('unbalanced_journals', 'payment_sla')
             and ur.role in ('platform_staff', 'platform_admin'))
         )
    loop
      if (app.enqueue_notification(
        v_recipient,
        'ops_alert',
        case v_check
          when 'stale_trips' then 'notifications.opsStaleTrips'
          when 'dead_deliveries' then 'notifications.opsDeadDeliveries'
          when 'unbalanced_journals' then 'notifications.opsUnbalancedJournals'
          when 'verification_backlog' then 'notifications.opsVerificationBacklog'
          when 'payment_sla' then 'notifications.opsPaymentSla'
          else 'notifications.opsErrorRate'
        end,
        jsonb_build_object('count', v_counts ->> v_check, 'check', v_check),
        -- Straight to the screen that answers the question, not to the inbox.
        case v_check
          when 'unbalanced_journals' then '/finance/dashboard'
          when 'payment_sla' then '/finance/payments'
          when 'verification_backlog' then '/staff/verifications'
          when 'stale_trips' then '/staff/trips'
          else '/staff/dashboard'
        end,
        'ops-alert:' || v_check || ':' || v_day
      ) ->> 'created')::boolean then
        v_sent := v_sent + 1;
      end if;
    end loop;
  end loop;

  perform app.write_audit(
    v_uid, 'ops.alert_sweep', 'platform', 'ops',
    null, jsonb_build_object('counts', v_counts, 'failed', v_failed, 'sent', v_sent),
    null, null, null
  );

  return jsonb_build_object(
    'at', v_now,
    'counts', v_counts,
    'alerts', to_jsonb(v_failed),
    'sent', v_sent
  );
end;
$$;

comment on function public.cmd_run_ops_alerts(uuid, timestamptz) is
  'Job: the six launch alerts (stale trips, dead deliveries, unbalanced journals, verification backlog, payment SLA, error rate), once per check per day per recipient.';

revoke all on function public.cmd_run_ops_alerts(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.cmd_run_ops_alerts(uuid, timestamptz) to service_role;

revoke all on function app.ops_checks() from public, anon, authenticated;

commit;
