/**
 * A subscription invoice is identified by the period it bills, not by the day it falls due.
 *
 * `invoice_subscription_period_uq` was a unique index on `(subscription_id, due_on)` — and `due_on` is not the
 * period. It is a date derived from `current_period_start + billing_due_days`, so two *different* periods produce
 * the same key whenever a subscription is renewed on the day it started:
 *
 *  - created and corrected (or renewed) on the same day: the new period falls due on the same date;
 *  - the pgTAP suite creates a subscription and renews it seconds later, which is why
 *    `0015_finance.test.sql` assertion 68 ("with the next period billed in advance") failed in runs that began just
 *    after midnight in Asia/Aden and passed in runs that began later — the two invoices landed on the same calendar
 *    day or on different ones.
 *
 * The failure was not benign. `app.issue_subscription_invoice` deduplicated on the same date, so it returned the
 * invoice for the *previous, already-paid* period and billed nothing: a live subscription with no charge for the new
 * month, and no error anywhere.
 *
 * The fix is to say what the index always meant. `period_start` becomes a real column (backfilled from the snapshot
 * every period invoice already carries), the unique index moves onto it, and the dedupe in
 * `app.issue_subscription_invoice` reads the same column. Proration invoices remain outside the index — a mid-period
 * upgrade legitimately shares a period with the invoice that opened it.
 */

alter table public.invoices add column if not exists period_start timestamptz;

-- Every period invoice written since 00031 carries its period in the snapshot; the column is that value, extracted.
update public.invoices
   set period_start = (snapshot ->> 'periodStart')::timestamptz
 where period_start is null
   and kind = 'subscription'
   and snapshot ->> 'periodStart' is not null;

drop index if exists public.invoice_subscription_period_uq;

create unique index invoice_subscription_period_uq
  on public.invoices (subscription_id, period_start)
  where kind = 'subscription'
    and status <> 'void'
    and period_start is not null
    and coalesce(snapshot ->> 'proration', 'false') = 'false';

comment on column public.invoices.period_start is
  'The subscription period this invoice bills. The identity of a renewal invoice; due_on only says when it is due.';

create or replace function app.issue_subscription_invoice(
  p_subscription_id uuid,
  p_due_on date,
  p_actor uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.subscriptions;
  v_existing uuid;
  v_invoice public.invoices;
  v_plan public.plans;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id;
  if not found then
    raise exception 'NOT_FOUND: subscription' using errcode = 'P0002';
  end if;

  select id into v_existing
    from public.invoices
   where subscription_id = p_subscription_id and kind = 'subscription'
     and status <> 'void'
     -- The period this invoice is for, which is what makes it the same invoice. `due_on` only says when it is due.
     and (snapshot ->> 'periodStart')::timestamptz = v_sub.current_period_start
     -- A proration invoice is not a period invoice: it must not be mistaken for the period already billed.
     and coalesce(snapshot ->> 'proration', 'false') = 'false';
  if found then
    return v_existing;
  end if;

  select * into v_plan from public.plans where code = v_sub.plan_code;

  insert into public.invoices (
    code, kind, status, subscription_id, owner_user_id, owner_org_id,
    subtotal_yer, commission_yer, total_yer, snapshot, issued_at, due_on, period_start, created_by
  )
  values (
    app.new_finance_code('SUB'), 'subscription', 'issued', p_subscription_id,
    v_sub.owner_user_id, v_sub.owner_org_id,
    v_sub.price_yer, 0, v_sub.price_yer,
    jsonb_build_object(
      'plan', v_sub.plan_code,
      'planNameAr', v_plan.name_ar,
      'planNameEn', v_plan.name_en,
      'periodStart', v_sub.current_period_start,
      'periodEnd', v_sub.current_period_end,
      'currency', 'YER'
    ),
    now(), p_due_on, v_sub.current_period_start, p_actor
  )
  returning * into v_invoice;

  perform app.notify(
    v_sub.owner_user_id, 'invoice_issued', 'notifications.invoiceIssued',
    jsonb_build_object('code', v_invoice.code, 'amount', v_invoice.total_yer),
    '/operator/billing'
  );

  return v_invoice.id;
end;
$$;
