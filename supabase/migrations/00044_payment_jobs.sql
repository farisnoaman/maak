-- 00044 — the payment jobs a cron was supposed to run
--
-- The Phase 9 task list named three jobs and shipped one: `cmd_expire_stale_payment_intents` existed from
-- `00030` and nothing scheduled it. The other two were never written at all:
--
--   · **unmatched-deposit reminders** — a passenger uploaded a receipt and is waiting; nobody is reminded that
--     the receipt is still undecided. (`payment_sla`, the ops alert, is a *staff* signal about the same rows; a
--     passenger who sees "pending" for two days and hears nothing files a dispute, not a ticket.)
--   · **agent settlement reminders** — an agent holding float above their credit limit, or holding cash they
--     collected days ago, is money the platform cannot reconcile. The operators who settle were never told.
--
-- Two decisions worth recording:
--
--   1. **Three jobs, not one.** Expiry, passenger reminders and agent settlements fail differently and should be
--      switchable independently — an expiry bug must not stop reminders. They are registered in
--      `NOTIFICATION_JOB_FN`, so the worker's own type system refuses to schedule a job the API does not know.
--   2. **Dedupe keys carry the period.** A reminder that fires every scheduler tick is a different notification
--      than a reminder that fires once a day, and the difference is one string. `payment:<intent>:<day>` and
--      `settlement:<agent>:<day>`.
--
-- Neither reminder is `critical`: a pending deposit does not wake anybody at 03:00, and quiet hours are allowed
-- to hold it until morning. `expire_stale_payment_intents` sends nothing at all — it closes intents nobody
-- finished, which is housekeeping.

-- ---------------------------------------------------------------------------
-- 1. What the catalogue says about the two kinds 00043 added
-- ---------------------------------------------------------------------------


insert into public.notification_events (kind, title_key, priority, default_channels) values
  ('payment_reminder', 'notifications.paymentReminder', 'normal', '{in_app, push}'),
  ('agent_settlement_due', 'notifications.agentSettlementDue', 'normal', '{in_app, push, email}')
on conflict (kind) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Housekeeping: intents nobody finished
-- ---------------------------------------------------------------------------

-- Unchanged from 00030; re-stated here only because the job that calls it is registered in this migration and a
-- reader should not have to know that. No `create or replace` would be honest if it had drifted, so the body is
-- not repeated — the comment is.

comment on function public.cmd_expire_stale_payment_intents(integer) is
  'Closes intents whose expires_at has passed. Idempotent; safe to run every hour (job: payments-expiry).';

-- ---------------------------------------------------------------------------
-- 3. Passenger and operator reminders about a deposit nobody matched
-- ---------------------------------------------------------------------------

/**
 * Remind the payer about an intent that is still waiting.
 *
 * Two bands, both keyed per intent per day:
 *
 *   · **awaiting_confirmation** — a receipt is uploaded and undecided. After `p_staff_hours` (default 24) the
 *     payer gets "still being checked", which is the sentence that stops a second payment.
 *   · **awaiting_proof** — an intent created and never paid, expiring within `p_expiry_hours` (default 12). This
 *     one is the difference between an expiring intent and a passenger who thinks it is still reserved.
 *
 * Returns counts, not ids: the worker logs the numbers and the rows are in `notifications`.
 */
create or replace function public.cmd_notify_payment_reminders(
  p_actor uuid,
  p_staff_hours integer default 24,
  p_expiry_hours integer default 12,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_created boolean;
  v_pending integer := 0;
  v_expiring integer := 0;
  v_day text := to_char(p_at at time zone app.notification_timezone(), 'YYYY-MM-DD');
begin
  for v_row in
    select i.id, i.code, i.payer_id, i.amount_yer, i.proof_uploaded_at, i.booking_id
      from public.payment_intents i
     where i.status = 'awaiting_confirmation'
       and i.proof_uploaded_at is not null
       and i.proof_uploaded_at <= p_at - make_interval(hours => greatest(coalesce(p_staff_hours, 24), 1))
     order by i.proof_uploaded_at
     limit 500
  loop
    v_created := (app.enqueue_notification(
      v_row.payer_id,
      'payment_reminder',
      'notifications.paymentPending',
      jsonb_build_object('code', v_row.code, 'amount', v_row.amount_yer),
      '/account/bookings/' || coalesce(v_row.booking_id::text, ''),
      'payment:' || v_row.id::text || ':' || v_day,
      'normal',
      p_at
    ) ->> 'created')::boolean;
    if v_created then v_pending := v_pending + 1; end if;
  end loop;

  for v_row in
    select i.id, i.code, i.payer_id, i.amount_yer, i.expires_at, i.booking_id
      from public.payment_intents i
     where i.status = 'awaiting_proof'
       and i.expires_at is not null
       and i.expires_at > p_at
       and i.expires_at <= p_at + make_interval(hours => greatest(coalesce(p_expiry_hours, 12), 1))
     order by i.expires_at
     limit 500
  loop
    v_created := (app.enqueue_notification(
      v_row.payer_id,
      'payment_reminder',
      'notifications.paymentExpiring',
      jsonb_build_object('code', v_row.code, 'amount', v_row.amount_yer),
      '/pay/' || v_row.id::text,
      'payment:' || v_row.id::text || ':' || v_day,
      'normal',
      p_at
    ) ->> 'created')::boolean;
    if v_created then v_expiring := v_expiring + 1; end if;
  end loop;

  return jsonb_build_object('day', v_day, 'pending', v_pending, 'expiring', v_expiring);
end;
$$;

comment on function public.cmd_notify_payment_reminders(uuid, integer, integer, timestamptz) is
  'Reminds payers about undecided receipts (default 24 h) and expiring intents (default 12 h). Once per intent '
  'per day. Job: payment-reminders.';

-- ---------------------------------------------------------------------------
-- 4. Agents holding money they should have settled
-- ---------------------------------------------------------------------------

/**
 * Tell an agent — and the finance desk — that a settlement is due.
 *
 * The trigger is exposure, not a timer: an agent whose float has reached their credit limit is holding as much
 * of the platform's money as the platform agreed to risk with them, and the next cash-in has to be a settlement.
 * Agents at or above `p_threshold_pct` (default 90 %) of their limit are reminded before that wall, and an agent
 * whose *newest* transaction is older than `p_stale_days` (default 3) gets the same message even below the
 * limit: money that has not moved in three days is either lost or forgotten.
 *
 * A pending settlement (`agent_cash_in_settled` is the other direction) is not modelled here — that is a
 * `payment_sla` concern for the desk; this job's job is the agent's own balance.
 */
create or replace function public.cmd_notify_agent_settlements(
  p_actor uuid,
  p_threshold_pct integer default 90,
  p_stale_days integer default 3,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent record;
  v_finance uuid[];
  v_recipient uuid;
  v_created boolean;
  v_reminded integer := 0;
  v_finance_sent integer := 0;
  v_day text := to_char(p_at at time zone app.notification_timezone(), 'YYYY-MM-DD');
  v_threshold integer := least(greatest(coalesce(p_threshold_pct, 90), 1), 100);
  v_stale integer := greatest(coalesce(p_stale_days, 3), 1);
begin
  select coalesce(array_agg(distinct u.user_id), array[]::uuid[]) into v_finance
    from public.user_roles u
   where u.role = 'finance_officer' and u.revoked_at is null;

  for v_agent in
    select a.id, a.user_id, a.float_balance_yer, a.credit_limit_yer
      from public.agents a
     where a.status = 'active'
       and a.float_balance_yer > 0
       and (
         (a.credit_limit_yer > 0 and a.float_balance_yer * 100 >= a.credit_limit_yer * v_threshold)
         or not exists (
           select 1 from public.agent_transactions t
            where t.agent_id = a.id and t.created_at > p_at - make_interval(days => v_stale)
         )
       )
     order by a.float_balance_yer desc
  loop
    v_created := (app.enqueue_notification(
      v_agent.user_id,
      'agent_settlement_due',
      'notifications.agentSettlementDue',
      jsonb_build_object(
        'amount', v_agent.float_balance_yer,
        'limit', v_agent.credit_limit_yer,
        'percent', case when v_agent.credit_limit_yer > 0
                        then least((v_agent.float_balance_yer * 100) / v_agent.credit_limit_yer, 100)
                        else null end
      ),
      '/operator/billing',
      'settlement:' || v_agent.id::text || ':' || v_day,
      'normal',
      p_at
    ) ->> 'created')::boolean;
    if v_created then v_reminded := v_reminded + 1; end if;

    -- The desk gets one message per agent per day, not one per finance officer per tick.
    foreach v_recipient in array v_finance loop
      v_created := (app.enqueue_notification(
        v_recipient,
        'agent_settlement_due',
        'notifications.agentSettlementDueDesk',
        jsonb_build_object('agent', v_agent.user_id, 'amount', v_agent.float_balance_yer),
        '/finance/agents',
        'settlement-desk:' || v_agent.id::text || ':' || v_recipient::text || ':' || v_day,
        'normal',
        p_at
      ) ->> 'created')::boolean;
      if v_created then v_finance_sent := v_finance_sent + 1; end if;
    end loop;
  end loop;

  return jsonb_build_object('day', v_day, 'agents', v_reminded, 'finance', v_finance_sent);
end;
$$;

comment on function public.cmd_notify_agent_settlements(uuid, integer, integer, timestamptz) is
  'Reminds agents at >= 90 % of their credit limit (or with no movement for 3 days), and the finance desk. Once '
  'per agent per day. Job: agent-settlements.';

-- ---------------------------------------------------------------------------
-- 5. Grants: the worker, and nobody else
-- ---------------------------------------------------------------------------

revoke all on function public.cmd_notify_payment_reminders(uuid, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.cmd_notify_payment_reminders(uuid, integer, integer, timestamptz)
  to service_role;

revoke all on function public.cmd_notify_agent_settlements(uuid, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.cmd_notify_agent_settlements(uuid, integer, integer, timestamptz)
  to service_role;
