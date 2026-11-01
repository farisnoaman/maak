-- 00037_finance_alert.sql — the integrity check was ringing a bell nobody is pushed.
--
-- `cmd_run_integrity_check` (Phase 10) reported a broken ledger by writing straight into `public.notifications`:
--
--     insert into public.notifications (user_id, kind, title_key, params, link) select …
--
-- That row is a dead end. It never reaches `notification_deliveries`, so the worker never claims it: no push,
-- no email, no retry, and no dedupe — a ledger that stays broken produced one more in-app row per scheduled
-- run, for ever, in a bell an operator has to remember to open. The one alert that says "the books do not
-- balance" was the one alert the delivery pipeline never saw.
--
-- `00032` already provides the right door, and the event catalogue already knows this kind:
-- `finance_alert` is critical with `{in_app, push, email}`. This migration restates the function with the
-- same checks and the same audit row, and replaces the insert with `app.enqueue_notification` — which applies
-- the catalogue, the recipient's per-channel preferences and quiet hours (critical overrides them), and takes a
-- dedupe key.
--
-- Dedupe is `finance-integrity:<YYYY-MM-DD>` per recipient, in `app.notification_timezone()`: the count in the
-- message is what changes between runs, not the number of messages.
--
-- Nothing else in the function changes. 0015 asserts the delivery rows now exist, that a second run the same
-- day creates none, and that no `finance_alert` notification can exist without an `in_app` delivery behind it.

begin;

create or replace function public.cmd_run_integrity_check(
  p_actor uuid default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checks jsonb := '[]'::jsonb;
  v_failed integer := 0;
  v_count integer;
  v_name text;
  v_day text;
  v_recipient uuid;
begin
  -- 1. Every journal balances. The deferred trigger should make this impossible; "should" is why it is checked.
  select count(*) into v_count from (
    select l.journal_id
      from public.ledger_entries l
     group by l.journal_id
    having sum(case when l.direction = 'debit' then l.amount_yer else -l.amount_yer end) <> 0
  ) x;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('name', 'journals_balanced', 'failures', v_count));
  v_failed := v_failed + v_count;

  -- 2. No journal with fewer than two lines.
  select count(*) into v_count from (
    select l.journal_id from public.ledger_entries l group by l.journal_id having count(*) < 2
  ) x;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('name', 'journals_have_two_lines', 'failures', v_count));
  v_failed := v_failed + v_count;

  -- 3. The whole ledger nets to zero: every debit has a credit somewhere, and no entry is orphaned.
  select abs(coalesce(sum(case when l.direction = 'debit' then l.amount_yer else -l.amount_yer end), 0))::integer
    into v_count
    from public.ledger_entries l;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('name', 'trial_balance_zero', 'failures', v_count));
  v_failed := v_failed + v_count;

  -- 4. No confirmed payment is missing its journal.
  select count(*) into v_count
    from public.payment_intents i
   where i.status = 'confirmed'
     and not exists (
       select 1 from public.journal_entries j
        where j.source_kind = 'payment' and j.source_table = 'payment_intents' and j.source_id = i.id
     );
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('name', 'payments_posted', 'failures', v_count));
  v_failed := v_failed + v_count;

  -- 5. No paid payout is missing its journal.
  select count(*) into v_count
    from public.payouts p
   where p.status = 'paid'
     and not exists (
       select 1 from public.journal_entries j
        where j.source_kind = 'payout' and j.source_table = 'payouts' and j.source_id = p.id
     );
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('name', 'payouts_posted', 'failures', v_count));
  v_failed := v_failed + v_count;

  -- 6. No paid refund is missing its journal.
  select count(*) into v_count
    from public.refunds r
   where r.status = 'paid'
     and not exists (
       select 1 from public.journal_entries j
        where j.source_kind = 'refund' and j.source_table = 'refunds' and j.source_id = r.id
     );
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('name', 'refunds_posted', 'failures', v_count));
  v_failed := v_failed + v_count;

  -- 7. The outbox is being drained. A backlog older than an hour means the cron is not running.
  select count(*) into v_count
    from public.payment_outbox o
   where o.consumed_at is null
     and o.created_at < now() - interval '1 hour';
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('name', 'outbox_drained', 'failures', v_count));
  v_failed := v_failed + v_count;

  -- 8. Owner balances: nobody is owed a negative amount. Negative payable means the ledger says the operator
  --    owes the platform, which for a marketplace is either a real receivable or a bug — finance decides, so
  --    it is surfaced rather than silently floored at zero the way the payout cap does.
  select count(*) into v_count from (
    select j.owner_user_id, j.owner_org_id,
           sum(case when l.account_code = 'operator_payable' and l.direction = 'credit' then l.amount_yer
                    when l.account_code = 'operator_payable' and l.direction = 'debit' then -l.amount_yer
                    else 0 end) as balance
      from public.journal_entries j
      join public.ledger_entries l on l.journal_id = j.id
     group by j.owner_user_id, j.owner_org_id
    having sum(case when l.account_code = 'operator_payable' and l.direction = 'credit' then l.amount_yer
                    when l.account_code = 'operator_payable' and l.direction = 'debit' then -l.amount_yer
                    else 0 end) < 0
  ) x;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('name', 'owner_balances_positive', 'failures', v_count));
  v_failed := v_failed + v_count;

  -- 9. Suspense: money parked because nobody knew where it belonged. Zero is the only healthy number.
  -- Counted, not summed: a check's `failures` is a number of rows, and reporting 1 000 "failures" for one
  -- unaudited rial is how an alert gets ignored.
  select count(*) into v_count
    from (
      select 1
        from public.ledger_entries l
       where l.account_code = 'suspense'
       group by l.journal_id
      having sum(case when l.direction = 'debit' then l.amount_yer else -l.amount_yer end) <> 0
    ) s;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('name', 'suspense_empty', 'failures', v_count));
  v_failed := v_failed + v_count;

  -- 10. Every invoice that is `paid` has a payment behind it and totals that add up.
  select count(*) into v_count
    from public.invoices i
   where i.kind = 'booking'
     and i.status = 'paid'
     and (i.intent_id is null or i.total_yer <= 0 or i.commission_yer > i.total_yer);
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('name', 'invoices_consistent', 'failures', v_count));
  v_failed := v_failed + v_count;

  v_name := case when v_failed = 0 then 'ok' else 'alert' end;

  insert into audit.log (actor_id, action, entity_type, entity_id, after, request_id, ip)
  values (p_actor, 'finance.integrity_check', 'ledger', null,
          jsonb_build_object('status', v_name, 'failed', v_failed, 'checks', v_checks),
          p_request_id, p_ip);

  if v_failed > 0 then
    -- Through the pipeline, not around it: `app.enqueue_notification` writes the in-app row *and* the
    -- delivery rows the worker drains, applies the event catalogue (`finance_alert` is critical, so in_app +
    -- push + email and a quiet-hours override), and honours a dedupe key. The version that inserted into
    -- `notifications` directly produced a bell with nothing behind it: no push, no email, and one row per run.
    v_day := to_char(now() at time zone app.notification_timezone(), 'YYYY-MM-DD');

    for v_recipient in
      select distinct ur.user_id
        from public.user_roles ur
       where ur.role in ('finance_officer', 'platform_admin')
         and ur.revoked_at is null
    loop
      perform app.enqueue_notification(
        v_recipient,
        'finance_alert',
        'notifications.integrityAlert',
        jsonb_build_object('failed', v_failed),
        '/finance/dashboard',
        -- Per day and per recipient: a ledger that stays broken cries once a night with the current count,
        -- not once per scheduled run.
        'finance-integrity:' || v_day
      );
    end loop;
  end if;

  return jsonb_build_object('status', v_name, 'failed', v_failed, 'checks', v_checks, 'checkedAt', now());
end;
$$;

commit;
