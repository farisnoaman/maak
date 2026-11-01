-- 00031 — Phase 10: one financial truth, and a monetisation engine that is data, not code
--
-- Two halves, deliberately in one migration because they share one question: *what does this owner owe,
-- and what may they do?*
--
--   1. A double-entry ledger. Every money event that Phase 9 recorded in `payment_outbox` becomes a journal
--      here, exactly once. Journals are immutable: a correction is a reversing entry with a reason, never an
--      UPDATE. Posting is idempotent by `(source_kind, source_id)`, which is what makes the outbox replayable.
--
--   2. Subscriptions, invoices and commissions. Plans and their limits already existed as data (00013);
--      what did not exist is a *billing* story: a trial that ends, an invoice that is paid or is not, a
--      period that rolls over, and an expiry that drops the owner back to Basic **without deleting
--      anything they built**.
--
-- The invariant that everything else leans on: **the ledger is the only place money is counted.** A
-- dashboard, a statement and a payout cap are three readings of the same rows, so they cannot disagree.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

-- Debit/credit normal side is implied by kind: assets and expenses are debit-normal, liabilities, revenue
-- and equity are credit-normal. Kept as a column so a report can sort without a hard-coded list.
create type public.ledger_account_kind as enum ('asset', 'liability', 'revenue', 'expense', 'equity');

-- What produced a journal. `expense` and `adjustment` are the manual doors; the rest are events.
create type public.journal_source_kind as enum (
  'payment', 'refund', 'payout', 'invoice', 'commission', 'subscription', 'expense', 'adjustment'
);

create type public.invoice_kind as enum ('booking', 'subscription');
create type public.invoice_status as enum ('draft', 'issued', 'paid', 'void', 'overdue');

create type public.subscription_status as enum (
  'trialing',   -- inside the free window, full plan powers
  'active',     -- paid for the current period
  'past_due',   -- the period ended and the invoice is unpaid: still full powers, but time is short
  'grace',      -- past the grace deadline: still full powers, one step from losing them
  'cancelled',  -- ends at period end, or ended immediately
  'expired'     -- powers gone: back to Basic, nothing deleted
);

create type public.subscription_event_kind as enum (
  'started', 'trial_ended', 'renewed', 'plan_changed', 'cancelled', 'expired', 'payment_failed'
);

create type public.reconciliation_status as enum ('pending', 'matched', 'exception', 'ignored');

alter type public.notification_kind add value if not exists 'invoice_issued';
alter type public.notification_kind add value if not exists 'subscription_activated';
alter type public.notification_kind add value if not exists 'subscription_past_due';
alter type public.notification_kind add value if not exists 'subscription_expired';
-- The integrity job's alarm. Its own kind, because "the ledger does not balance" is not a payment notice and
-- must be routable separately in Phase 11's preferences.
alter type public.notification_kind add value if not exists 'finance_alert';

-- ---------------------------------------------------------------------------
-- 2. The chart of accounts
-- ---------------------------------------------------------------------------
--
-- Only the *platform's* accounts are seeded. An owner's payable, receivable and revenue are not separate
-- rows: every journal carries the owner scope, so an owner's balance is `sum` over their journals. Materialising
-- a per-owner chart would be a second copy of the same facts, and the copy is what goes stale.

create table public.ledger_accounts (
  code        text primary key check (code ~ '^[a-z][a-z0-9_]{2,40}$'),
  kind        public.ledger_account_kind not null,
  name_ar     text not null,
  name_en     text not null,
  -- A system account cannot be renamed away or deleted: reports and posting functions name it literally.
  is_system   boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into public.ledger_accounts (code, kind, name_ar, name_en) values
  ('platform_cash',        'asset',     'نقد المنصة',            'Platform cash'),
  ('platform_bank',        'asset',     'بنك المنصة',            'Platform bank'),
  ('agent_receivable',     'asset',     'مستحق من الوكلاء',      'Receivable from agents'),
  ('operator_receivable',  'asset',     'مستحق على المشغّلين',   'Receivable from operators'),
  ('operator_payable',     'liability', 'مستحق للمشغّلين',       'Payable to operators'),
  ('commission_revenue',   'revenue',   'إيراد العمولة',         'Commission revenue'),
  ('subscription_revenue', 'revenue',   'إيراد الاشتراكات',      'Subscription revenue'),
  ('refund_expense',       'expense',   'مصروف الاستردادات',     'Refund expense'),
  ('payout_clearing',      'asset',     'تسوية التحويلات',       'Payout clearing'),
  ('suspense',             'asset',     'حساب معلّق',            'Suspense')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Journals and their lines
-- ---------------------------------------------------------------------------

create table public.journal_entries (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  posting_date  date not null,
  description   text not null check (length(btrim(description)) between 3 and 300),
  source_kind   public.journal_source_kind not null,
  -- The id of the thing that caused this entry: a payment intent, a refund, a payout, an invoice, a
  -- subscription. Free text, because the sources live in different tables.
  source_table  text not null,
  source_id     uuid not null,
  currency      text not null default 'YER' check (currency = 'YER'),
  -- The owner this journal is *about*. Null for pure platform events (a subscription invoice belongs to an
  -- owner too, so nullable is only for adjustments that concern nobody).
  owner_user_id uuid references public.profiles (id) on delete restrict,
  owner_org_id  uuid references public.organizations (id) on delete restrict,
  -- A correction names the journal it reverses. The original is never touched.
  reverses_id   uuid references public.journal_entries (id) on delete restrict,
  reason        text,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint journal_owner_shape check (owner_user_id is null or owner_org_id is null),
  -- A reversal must say why. An unexplained correction is indistinguishable from a mistake.
  constraint journal_reversal_reason
    check (reverses_id is null or (reason is not null and length(btrim(reason)) >= 5))
);

-- The idempotency key of the whole phase: an outbox row can be replayed any number of times and the second
-- run posts nothing.
create unique index journal_source_uq on public.journal_entries (source_kind, source_table, source_id);
create index journal_posting_date_idx on public.journal_entries (posting_date desc);
create index journal_owner_idx on public.journal_entries (owner_org_id, owner_user_id, posting_date desc);

create table public.ledger_entries (
  id           uuid primary key default gen_random_uuid(),
  journal_id   uuid not null references public.journal_entries (id) on delete restrict,
  seq          smallint not null check (seq > 0),
  account_code text not null references public.ledger_accounts (code) on delete restrict,
  -- Debit and credit are one column, positive always: a negative "debit" is how double-entry quietly stops
  -- balancing.
  direction    text not null check (direction in ('debit', 'credit')),
  amount_yer   integer not null check (amount_yer > 0),
  unique (journal_id, seq)
);

create index ledger_journal_idx on public.ledger_entries (journal_id);
create index ledger_account_idx on public.ledger_entries (account_code);

/**
 * Immutability, enforced where it cannot be forgotten.
 *
 * RLS cannot express "nobody may update", because a service-role writer bypasses RLS entirely. A trigger
 * fires for every role, including the one the edge functions use. Corrections are new journals
 * (`reverses_id`), which is also why a deletion can never leave a hole in a month's totals.
 */
create or replace function app.reject_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'IMMUTABLE: the ledger cannot be % — post a reversing journal instead', tg_op
    using errcode = '23514';
end;
$$;

create trigger journal_entries_immutable
  before update or delete on public.journal_entries
  for each row execute function app.reject_ledger_mutation();

create trigger ledger_entries_immutable
  before update or delete on public.ledger_entries
  for each row execute function app.reject_ledger_mutation();

/**
 * A journal must balance, and a balance cannot be judged until its last line exists.
 *
 * Hence a **constraint trigger, deferred to commit**: `post_journal` writes the header and then the lines,
 * and at no point during that sequence is the journal balanced. Checking at commit is the only check that
 * is both true and useful — an immediate trigger would reject every correctly-built journal.
 */
create or replace function app.assert_balanced_journal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lines integer;
  v_debit integer;
  v_credit integer;
begin
  select count(*), coalesce(sum(case when direction = 'debit' then amount_yer else 0 end), 0),
         coalesce(sum(case when direction = 'credit' then amount_yer else 0 end), 0)
    into v_lines, v_debit, v_credit
    from public.ledger_entries
   where journal_id = new.id;

  if v_lines < 2 then
    raise exception 'UNBALANCED_JOURNAL: % has % line(s); a journal needs at least two', new.code, v_lines
      using errcode = '23514';
  end if;
  if v_debit <> v_credit then
    raise exception 'UNBALANCED_JOURNAL: % debits % but credits %', new.code, v_debit, v_credit
      using errcode = '23514';
  end if;
  if v_debit = 0 then
    raise exception 'UNBALANCED_JOURNAL: % is empty', new.code using errcode = '23514';
  end if;
  return new;
end;
$$;

create constraint trigger journal_entries_balanced
  after insert on public.journal_entries
  deferrable initially deferred
  for each row execute function app.assert_balanced_journal();

create or replace function app.new_finance_code(p_prefix text)
returns text
language sql
volatile
as $$
  select p_prefix || '-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
$$;

-- ---------------------------------------------------------------------------
-- 4. The only writer: app.post_journal
-- ---------------------------------------------------------------------------

/**
 * Posts one balanced journal, or returns the one that already exists.
 *
 * This is the whole write API of the ledger. Every money event in the system — a confirmed payment, a paid
 * refund, a payout, an invoice, a subscription charge, a manual correction — comes through here, which is
 * what makes "no event posts twice" a property of the function rather than a promise of eleven callers.
 *
 * `p_lines` is `[{"account":"platform_cash","direction":"debit","amount":10000}, …]`. The shape is validated
 * here, not by the caller: an unknown account, a non-positive amount or a direction typo raises before
 * anything is inserted.
 *
 * Returns the journal id. The second call for the same `(source_kind, source_table, source_id)` returns the
 * first journal's id and writes nothing.
 */
create or replace function app.post_journal(
  p_source_kind public.journal_source_kind,
  p_source_table text,
  p_source_id uuid,
  p_posting_date date,
  p_description text,
  p_lines jsonb,
  p_actor uuid default null,
  p_owner_user uuid default null,
  p_owner_org uuid default null,
  p_reverses uuid default null,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_journal uuid;
  v_line jsonb;
  v_seq smallint := 0;
  v_account text;
  v_direction text;
  v_amount integer;
  v_debit bigint := 0;
  v_credit bigint := 0;
begin
  -- Replay: the outbox is allowed to be read twice, and this is where that is made free.
  select id into v_existing
    from public.journal_entries
   where source_kind = p_source_kind and source_table = p_source_table and source_id = p_source_id;
  if found then
    return v_existing;
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'VALIDATION_FAILED: a journal needs at least two lines' using errcode = '22023';
  end if;

  insert into public.journal_entries (
    code, posting_date, description, source_kind, source_table, source_id,
    owner_user_id, owner_org_id, reverses_id, reason, created_by
  )
  values (
    app.new_finance_code('JE'), coalesce(p_posting_date, (now() at time zone 'Asia/Aden')::date),
    btrim(p_description), p_source_kind, p_source_table, p_source_id,
    p_owner_user, p_owner_org, p_reverses, nullif(btrim(coalesce(p_reason, '')), ''), p_actor
  )
  returning id into v_journal;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_seq := v_seq + 1;
    v_account := v_line ->> 'account';
    v_direction := v_line ->> 'direction';
    v_amount := (v_line ->> 'amount')::integer;

    if v_amount is null or v_amount <= 0 then
      raise exception 'VALIDATION_FAILED: ledger amounts must be positive integers (got %)', v_amount
        using errcode = '22023';
    end if;
    if v_direction not in ('debit', 'credit') then
      raise exception 'VALIDATION_FAILED: direction must be debit or credit (got %)', v_direction
        using errcode = '22023';
    end if;

    -- The FK would catch an unknown account too, but with a message about a constraint rather than about the
    -- line somebody typed.
    if not exists (select 1 from public.ledger_accounts a where a.code = v_account) then
      raise exception 'VALIDATION_FAILED: unknown ledger account %', v_account using errcode = '22023';
    end if;

    insert into public.ledger_entries (journal_id, seq, account_code, direction, amount_yer)
    values (v_journal, v_seq, v_account, v_direction, v_amount);

    if v_direction = 'debit' then
      v_debit := v_debit + v_amount;
    else
      v_credit := v_credit + v_amount;
    end if;
  end loop;

  -- Refused here *and* by the deferred constraint trigger. The immediate answer is the useful one; the
  -- deferred trigger is the one that cannot be bypassed.
  if v_debit <> v_credit then
    raise exception 'UNBALANCED_JOURNAL: debits % but credits %', v_debit, v_credit
      using errcode = '23514';
  end if;

  return v_journal;
end;
$$;

comment on function app.post_journal(
  public.journal_source_kind, text, uuid, date, text, jsonb, uuid, uuid, uuid, uuid, text
) is 'The single writer of the ledger. Idempotent on (source_kind, source_table, source_id).';

-- ---------------------------------------------------------------------------
-- 5. Commission rules — data, effective-dated, owner-specific wins over global
-- ---------------------------------------------------------------------------

create table public.commission_rules (
  id             uuid primary key default gen_random_uuid(),
  -- Null owner = the platform default. A non-null owner is a negotiated rate; it still cannot escape the
  -- plan discount, which is applied on top.
  owner_user_id  uuid references public.profiles (id) on delete cascade,
  owner_org_id   uuid references public.organizations (id) on delete cascade,
  basis_points   integer not null check (basis_points between 0 and 3_000),
  -- Floors and caps in rials: a 5 % commission on a 200 rial seat is 10 rials, which costs more to collect
  -- than it earns. The cap exists for the opposite reason.
  min_yer        integer check (min_yer is null or min_yer >= 0),
  max_yer        integer check (max_yer is null or max_yer >= 0),
  effective_from date not null default ((now() at time zone 'Asia/Aden')::date),
  effective_to   date,
  note           text check (note is null or length(note) <= 300),
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint commission_owner_shape check (owner_user_id is null or owner_org_id is null),
  constraint commission_window check (effective_to is null or effective_to >= effective_from),
  constraint commission_cap check (min_yer is null or max_yer is null or max_yer >= min_yer)
);

create index commission_lookup_idx
  on public.commission_rules (owner_org_id, owner_user_id, effective_from desc);

-- 5 % is the documented platform default (specs §6.13) and the number the acceptance criteria use.
insert into public.commission_rules (basis_points, effective_from, note)
values (500, date '2026-01-01', 'النسبة الافتراضية للمنصة')
on conflict do nothing;

/**
 * The rate that applies to one owner on one date.
 *
 * Resolution order: the owner's own effective rule, then the global default. The plan discount is applied
 * last and matches `applyPlanCommissionDiscount()` in @maak/core (Pro −1 pp, Business −2 pp) — the two
 * implementations are pinned to each other by a Vitest case and a pgTAP assertion.
 */
create or replace function app.commission_basis_points(
  p_owner_user uuid,
  p_owner_org uuid,
  p_as_of date default null
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  with rule as (
    select r.basis_points
    from public.commission_rules r
    where (case
             when p_owner_org is not null then r.owner_org_id = p_owner_org
             when p_owner_user is not null then r.owner_user_id = p_owner_user
             else false
           end)
      and r.effective_from <= coalesce(p_as_of, (now() at time zone 'Asia/Aden')::date)
      and (r.effective_to is null or r.effective_to >= coalesce(p_as_of, (now() at time zone 'Asia/Aden')::date))
    order by r.effective_from desc, r.created_at desc
    limit 1
  ),
  global_rule as (
    select r.basis_points
    from public.commission_rules r
    where r.owner_user_id is null and r.owner_org_id is null
      and r.effective_from <= coalesce(p_as_of, (now() at time zone 'Asia/Aden')::date)
      and (r.effective_to is null or r.effective_to >= coalesce(p_as_of, (now() at time zone 'Asia/Aden')::date))
    order by r.effective_from desc, r.created_at desc
    limit 1
  ),
  base as (
    select coalesce((select basis_points from rule), (select basis_points from global_rule), 0) as bp
  )
  select greatest(
    0,
    bp - case app.owner_plan(p_owner_user, p_owner_org)
            when 'pro' then 100
            when 'business' then 200
            else 0
          end
  )
  from base;
$$;

/** Commission in rials for a gross amount, honouring the floor and the cap of the winning rule. */
create or replace function app.commission_yer(
  p_owner_user uuid,
  p_owner_org uuid,
  p_gross integer,
  p_as_of date default null
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_bp integer;
  v_min integer;
  v_max integer;
  v_amount integer;
begin
  if p_gross is null or p_gross <= 0 then
    return 0;
  end if;

  v_bp := app.commission_basis_points(p_owner_user, p_owner_org, p_as_of);

  select r.min_yer, r.max_yer into v_min, v_max
    from public.commission_rules r
   where ((case when p_owner_org is not null then r.owner_org_id = p_owner_org
                when p_owner_user is not null then r.owner_user_id = p_owner_user
                else false end)
          or (r.owner_user_id is null and r.owner_org_id is null))
     and r.effective_from <= coalesce(p_as_of, (now() at time zone 'Asia/Aden')::date)
     and (r.effective_to is null or r.effective_to >= coalesce(p_as_of, (now() at time zone 'Asia/Aden')::date))
   order by (r.owner_user_id is not null or r.owner_org_id is not null) desc,
            r.effective_from desc, r.created_at desc
   limit 1;

  v_amount := (p_gross::bigint * v_bp / 10_000)::integer;
  if v_amount = 0 and v_bp > 0 then
    v_amount := 1;  -- a non-zero rate on a non-zero fare is never zero: rounding must not delete a fee
  end if;
  if v_min is not null then v_amount := greatest(v_amount, v_min); end if;
  if v_max is not null then v_amount := least(v_amount, v_max); end if;

  return least(greatest(v_amount, 0), p_gross);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Invoices
-- ---------------------------------------------------------------------------

create table public.invoices (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  kind            public.invoice_kind not null,
  status          public.invoice_status not null default 'issued',

  booking_id      uuid references public.bookings (id) on delete restrict,
  -- One invoice per *payment*, not per booking: a deposit and its balance are two documents, because they are
  -- two transfers on the passenger's statement.
  intent_id       uuid references public.payment_intents (id) on delete restrict,
  subscription_id uuid,  -- FK added after `subscriptions` exists (it is declared below)
  journal_id      uuid references public.journal_entries (id) on delete restrict,

  owner_user_id   uuid references public.profiles (id) on delete restrict,
  owner_org_id    uuid references public.organizations (id) on delete restrict,

  currency        text not null default 'YER' check (currency = 'YER'),
  subtotal_yer    integer not null check (subtotal_yer >= 0),
  commission_yer  integer not null default 0 check (commission_yer >= 0),
  total_yer       integer not null check (total_yer >= 0),

  /**
   * What the invoice said at the moment it was issued: names, route, seat count, the fare and the commission
   * rate applied. Frozen on purpose — an invoice that changes when a trip is edited is not evidence of
   * anything, and the passenger's copy must still match what they were charged a year later.
   */
  snapshot        jsonb not null default '{}'::jsonb,

  issued_at       timestamptz not null default now(),
  due_on          date,
  paid_at         timestamptz,
  voided_at       timestamptz,
  voided_by       uuid references public.profiles (id) on delete set null,
  void_reason     text,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),

  constraint invoice_shape check (
    (kind = 'booking' and booking_id is not null and intent_id is not null and subscription_id is null)
    or (kind = 'subscription' and subscription_id is not null and booking_id is null and intent_id is null)
  ),
  /**
   * What the document asks for, and what it is made of. The passenger's total is the fare; the commission is
   * the operator's deduction from it, shown on *their* statement, not added to the passenger's bill. So
   * `total = subtotal` and the commission sits inside it.
   */
  constraint invoice_total check (total_yer = subtotal_yer),
  constraint invoice_commission_within check (commission_yer <= subtotal_yer),
  constraint invoice_void_reason
    check (status <> 'void' or (void_reason is not null and length(btrim(void_reason)) >= 5))
);

-- One live invoice per payment: replaying the outbox must not mint a second bill, and a deposit plus its
-- balance are legitimately two.
create unique index invoice_intent_live_uq
  on public.invoices (intent_id)
  where kind = 'booking' and status <> 'void';

create index invoice_owner_idx on public.invoices (owner_org_id, owner_user_id, issued_at desc);
create index invoice_status_idx on public.invoices (status, due_on);

-- ---------------------------------------------------------------------------
-- 7. Quotas: overrides, violation log, period counters
-- ---------------------------------------------------------------------------

/**
 * A negotiated limit, for one owner and one metric, with an expiry.
 *
 * The expiry is the point. A support override granted "until the migration finishes" must not silently become
 * a permanent unlimited plan, so `expires_at` is required unless an admin explicitly grants a permanent one —
 * and the row says who did that.
 */
create table public.quota_overrides (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid references public.profiles (id) on delete cascade,
  owner_org_id  uuid references public.organizations (id) on delete cascade,
  metric        text not null check (
                  metric in ('vehicles', 'trips', 'staff', 'drivers', 'active_trips',
                             'featured_listings', 'fleet_reports', 'finance_exports')
                ),
  -- NULL = unlimited, the same convention as `plan_limits`.
  limit_value   integer check (limit_value is null or limit_value >= 0),
  expires_at    timestamptz,
  granted_by    uuid references public.profiles (id) on delete set null,
  reason        text not null check (length(btrim(reason)) >= 5),
  revoked_at    timestamptz,
  revoked_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint override_owner_shape check ((owner_user_id is null) <> (owner_org_id is null))
);

create index quota_override_lookup_idx
  on public.quota_overrides (owner_org_id, owner_user_id, metric)
  where revoked_at is null;

/**
 * A refused attempt, logged so support can see who is hitting a ceiling before the customer writes in.
 *
 * Written by the **gateway**, not by `app.assert_quota`: the command raises, and the raise rolls the whole
 * transaction back — including the log row that was meant to explain it. A row written after the rollback,
 * by the layer that saw the error, is the only version that survives. `_shared/quota-log.ts` and the dev
 * gateway do exactly that.
 */
create table public.quota_violations (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid references public.profiles (id) on delete set null,
  owner_org_id  uuid references public.organizations (id) on delete set null,
  actor_id      uuid references public.profiles (id) on delete set null,
  metric        text not null,
  plan_code     public.plan_code,
  limit_value   integer,
  used          integer,
  action        text,
  created_at    timestamptz not null default now()
);

create index quota_violations_recent_idx on public.quota_violations (created_at desc);

/**
 * A monthly snapshot of usage, for reporting and for "you used 42 of 50 trips" on the billing page.
 *
 * Deliberately **not** the enforcement source: `app.quota_usage` counts live rows, because a counter is a
 * second source of truth that drifts the first time something is deleted outside a command. The counter is
 * written by the rollover job and is allowed to be stale by one day.
 */
create table public.usage_counters (
  owner_user_id  uuid references public.profiles (id) on delete cascade,
  owner_org_id   uuid references public.organizations (id) on delete cascade,
  metric         text not null,
  period_start   date not null,
  used           integer not null default 0 check (used >= 0),
  updated_at     timestamptz not null default now(),
  constraint usage_owner_shape check ((owner_user_id is null) <> (owner_org_id is null)),
  unique (owner_user_id, owner_org_id, metric, period_start)
);

-- ---------------------------------------------------------------------------
-- 8. Subscriptions
-- ---------------------------------------------------------------------------

create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  owner_user_id          uuid references public.profiles (id) on delete restrict,
  owner_org_id           uuid references public.organizations (id) on delete restrict,
  plan_code              public.plan_code not null,
  -- A downgrade is scheduled, not applied: `pending_plan_code` is what the next period starts on.
  pending_plan_code      public.plan_code,
  status                 public.subscription_status not null default 'trialing',
  price_yer              integer not null check (price_yer >= 0),
  trial_ends_at          timestamptz,
  current_period_start   timestamptz not null default now(),
  current_period_end     timestamptz not null,
  grace_ends_at          timestamptz,
  cancel_at_period_end   boolean not null default false,
  cancelled_at           timestamptz,
  cancel_reason          text,
  ended_at               timestamptz,
  created_by             uuid references public.profiles (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint subscription_owner_shape check ((owner_user_id is null) <> (owner_org_id is null)),
  constraint subscription_period check (current_period_end > current_period_start)
);

-- One live subscription per owner. An upgrade does not create a second row; it changes this one.
create unique index subscription_live_uq
  on public.subscriptions (coalesce(owner_user_id, owner_org_id))
  where status in ('trialing', 'active', 'past_due', 'grace');

create index subscription_billing_idx on public.subscriptions (status, current_period_end)
  where status in ('trialing', 'active', 'past_due', 'grace');

alter table public.invoices
  add constraint invoices_subscription_fk
  foreign key (subscription_id) references public.subscriptions (id) on delete restrict;

-- One live invoice per subscription *period*: the renewal job may run twice a day and must bill once.
-- Proration invoices are excluded, because a mid-period upgrade legitimately shares its due date with the
-- period invoice that opened that period — a unique key over both would make an upgrade impossible.
create unique index invoice_subscription_period_uq
  on public.invoices (subscription_id, due_on)
  where kind = 'subscription'
    and status <> 'void'
    and coalesce(snapshot ->> 'proration', 'false') = 'false';

create table public.subscription_events (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions (id) on delete restrict,
  kind            public.subscription_event_kind not null,
  from_plan       public.plan_code,
  to_plan         public.plan_code,
  amount_yer      integer not null default 0,
  invoice_id      uuid references public.invoices (id) on delete set null,
  journal_id      uuid references public.journal_entries (id) on delete set null,
  note            text,
  actor_id        uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index subscription_events_timeline_idx on public.subscription_events (subscription_id, created_at desc);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 9. Plans: the extra metric, and the real effective-plan resolution
-- ---------------------------------------------------------------------------

alter table public.plan_limits drop constraint if exists plan_limits_metric_check;
alter table public.plan_limits add constraint plan_limits_metric_check check (
  metric in ('vehicles', 'trips', 'staff', 'drivers', 'active_trips', 'featured_listings',
             'fleet_reports', 'finance_exports')
);

insert into public.plan_limits (plan_code, metric, limit_value) values
  ('basic', 'finance_exports', 1),
  ('pro', 'finance_exports', 10),
  ('business', 'finance_exports', null)
on conflict (plan_code, metric) do nothing;

/**
 * The plan that actually governs an owner, replacing the Phase 1 stub.
 *
 * Resolution, in order:
 *   · a live subscription (`trialing` / `active` / `past_due` / `grace`) → its plan, because "past due" is a
 *     dunning state, not a downgrade: cutting a paying operator off the day an invoice is late is how a
 *     billing bug becomes a churn event;
 *   · otherwise Basic.
 *
 * `grace` is included on purpose: the whole point of a grace window is that the powers survive it. Expiry is
 * what removes them, and expiry sets `status = 'expired'` — after that this function returns Basic.
 */
create or replace function app.owner_effective_plan(p_uid uuid default app.uid())
returns public.plan_code
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.plan_code
       from public.subscriptions s
      where s.owner_user_id = p_uid
        and s.status in ('trialing', 'active', 'past_due', 'grace')
      order by s.created_at desc
      limit 1),
    'basic'::public.plan_code
  );
$$;

/**
 * An organization's plan: the subscription when there is one, else the stored column.
 *
 * The stored column is how a plan was expressed before billing existed (seeds, and the admin console), and
 * keeping it as the fallback means an organization that never subscribes behaves exactly as it did in Phase 3.
 * Expiry writes 'basic' into it, so "expired → Basic" is true for both routes.
 */
create or replace function app.org_effective_plan(p_org uuid)
returns public.plan_code
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.plan_code
       from public.subscriptions s
      where s.owner_org_id = p_org
        and s.status in ('trialing', 'active', 'past_due', 'grace')
      order by s.created_at desc
      limit 1),
    (select o.plan from public.organizations o where o.id = p_org),
    'basic'::public.plan_code
  );
$$;

-- ---------------------------------------------------------------------------
-- 10. Exports and reconciliation
-- ---------------------------------------------------------------------------

create table public.finance_exports (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid references public.profiles (id) on delete restrict,
  owner_org_id  uuid references public.organizations (id) on delete restrict,
  kind          text not null check (kind in ('statement', 'revenue', 'payouts', 'invoices')),
  period_from   date not null,
  period_to     date not null,
  row_count     integer not null default 0,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  -- No `export_owner_shape` check: both columns are null for a platform-wide export by finance, and a check
  -- cannot name a role. `cmd_export_finance` refuses "both owners" instead, which is the case that matters.
  constraint export_period check (period_to >= period_from)
);

create index finance_exports_owner_idx on public.finance_exports (owner_org_id, owner_user_id, created_at desc);

/**
 * A bank or wallet statement, imported so somebody can prove the ledger against the money.
 *
 * Two tables, because an import is one act and its lines are many. The import keeps the totals it was given
 * by the file; the lines carry the match. An unmatched line is the exception queue, and it is a *row*, not a
 * report: a queue that has to be recomputed is a queue nobody works.
 */
create table public.reconciliation_imports (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid references public.profiles (id) on delete restrict,
  owner_org_id   uuid references public.organizations (id) on delete restrict,
  source         text not null check (source in ('jaib', 'kuraimi', 'tadhamon', 'cash_desk', 'bank_transfer', 'other')),
  period_from    date not null,
  period_to      date not null,
  imported_by    uuid references public.profiles (id) on delete set null,
  lines_total    integer not null default 0,
  lines_matched  integer not null default 0,
  created_at     timestamptz not null default now(),
  constraint import_period check (period_to >= period_from)
);

create table public.reconciliation_lines (
  id            uuid primary key default gen_random_uuid(),
  import_id     uuid not null references public.reconciliation_imports (id) on delete cascade,
  external_ref  text,
  amount_yer    integer not null check (amount_yer > 0),
  occurred_on   date not null,
  status        public.reconciliation_status not null default 'pending',
  -- At most one target: a line is money that arrived for a payment, or money that left for a payout.
  intent_id     uuid references public.payment_intents (id) on delete restrict,
  payout_id     uuid references public.payouts (id) on delete restrict,
  note          text,
  resolved_by   uuid references public.profiles (id) on delete set null,
  resolved_at   timestamptz,
  constraint line_one_target check (intent_id is null or payout_id is null)
);

create index reconciliation_lines_import_idx on public.reconciliation_lines (import_id, status);
create index reconciliation_lines_open_idx on public.reconciliation_lines (status)
  where status in ('pending', 'exception');

-- ---------------------------------------------------------------------------
-- 11. Quota resolution with overrides (replaces the Phase 3/4 versions)
-- ---------------------------------------------------------------------------

create or replace function app.quota_usage(p_owner_user uuid, p_owner_org uuid, p_metric text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case p_metric
    when 'vehicles' then (
      select count(*)::int from public.vehicles v
      where v.is_active
        and (case when p_owner_org is not null then v.owner_org_id = p_owner_org
                  else v.owner_user_id = p_owner_user end)
    )
    when 'drivers' then (
      select count(*)::int from public.driver_profiles d
      where d.is_active and d.status <> 'revoked'
        and (case when p_owner_org is not null then d.org_id = p_owner_org
                  else d.invited_by = p_owner_user end)
    )
    when 'staff' then (
      select count(*)::int from public.organization_members m
      where m.status = 'active'
        and (p_owner_org is not null and m.org_id = p_owner_org
             or p_owner_org is null and m.user_id = p_owner_user)
    )
    -- Per calendar month, in Yemeni time: the limit is "5 trips a month", not "5 trips, ever".
    when 'trips' then (
      select count(*)::int from public.trips t
      where date_trunc('month', t.created_at at time zone 'Asia/Aden')
          = date_trunc('month', now() at time zone 'Asia/Aden')
        and (case when p_owner_org is not null then t.owner_org_id = p_owner_org
                  else t.owner_user_id = p_owner_user end)
    )
    when 'active_trips' then (
      select count(*)::int from public.trips t
      where t.status = 'published' and t.departure_at > now()
        and (case when p_owner_org is not null then t.owner_org_id = p_owner_org
                  else t.owner_user_id = p_owner_user end)
    )
    when 'featured_listings' then (
      select count(*)::int from public.trips t
      where t.featured_until is not null and t.featured_until > now()
        and (case when p_owner_org is not null then t.owner_org_id = p_owner_org
                  else t.owner_user_id = p_owner_user end)
    )
    -- Phase 10: exports are the one metric that is not a resource — it is a rate. Counted from the export
    -- log rather than a counter, for the same reason as every other metric.
    when 'finance_exports' then (
      select count(*)::int from public.finance_exports f
      where date_trunc('month', f.created_at at time zone 'Asia/Aden')
          = date_trunc('month', now() at time zone 'Asia/Aden')
        and (case when p_owner_org is not null then f.owner_org_id = p_owner_org
                  else f.owner_user_id = p_owner_user end)
    )
    -- `fleet_reports` is a capability, not a resource: it is answered by `app.plan_allows`, never by a
    -- count, so a "used" number here would be a lie with a plausible shape.
    else 0
  end;
$$;

/**
 * The quota state without the exception — used to warn before blocking, and to show a plan page its numbers.
 *
 * An active override wins over the plan's limit, and `source` says which one applied so the UI can explain
 * why an operator on Basic has five vehicles. An expired override is not "still applied until someone
 * cleans it up": the `expires_at` test is here, in the read.
 */
create or replace function app.quota_state(
  p_owner_user uuid,
  p_owner_org uuid,
  p_metric text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan public.plan_code;
  v_limit integer;
  v_soft boolean;
  v_override integer;
  v_has_override boolean := false;
  v_used integer;
begin
  v_plan := app.owner_plan(p_owner_user, p_owner_org);

  select l.limit_value, coalesce(p.soft_limit, false)
  into v_limit, v_soft
  from public.plan_limits l
  join public.plans p on p.code = l.plan_code
  where l.plan_code = v_plan and l.metric = p_metric;

  if not found then
    raise exception 'VALIDATION_FAILED: unknown quota metric %', p_metric using errcode = '22023';
  end if;

  select o.limit_value into v_override
    from public.quota_overrides o
   where o.metric = p_metric
     and o.revoked_at is null
     and (o.expires_at is null or o.expires_at > now())
     and (case when p_owner_org is not null then o.owner_org_id = p_owner_org
               else o.owner_user_id = p_owner_user end)
   -- The most generous live override wins: two support grants should not fight, and the later one is the one
   -- somebody meant.
   order by o.limit_value desc nulls first, o.created_at desc
   limit 1;
  v_has_override := found;

  v_used := app.quota_usage(p_owner_user, p_owner_org, p_metric);

  return jsonb_build_object(
    'metric', p_metric,
    'plan', v_plan,
    'limit', case when v_has_override then v_override else v_limit end,
    'plan_limit', v_limit,
    'override', v_has_override,
    'used', v_used,
    'soft', v_soft,
    -- Only a soft plan warns, and only when it is close: a warning shown from day one is noise.
    'warning', (
      case when v_has_override then v_override else v_limit end is not null
      and v_soft
      and (case when v_has_override then v_override else v_limit end) > 0
      and (v_used + 1) * 5 >= (case when v_has_override then v_override else v_limit end) * 4
    )
  );
end;
$$;

-- `app.assert_quota` is unchanged in shape (it already reads `quota_state`), but it is re-created here so the
-- override semantics are the ones it enforces and so this migration is the single place to read them.
create or replace function app.assert_quota(
  p_owner_user uuid,
  p_owner_org uuid,
  p_metric text,
  p_delta integer default 1
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state jsonb;
  v_limit integer;
  v_used integer;
begin
  v_state := app.quota_state(p_owner_user, p_owner_org, p_metric);
  v_limit := (v_state ->> 'limit')::integer;
  v_used := (v_state ->> 'used')::integer;

  -- NULL means unlimited; 0 is a real limit and must still block.
  if v_limit is null then
    return;
  end if;

  if v_used + p_delta > v_limit then
    raise exception 'QUOTA_EXCEEDED: metric=% limit=% used=%', p_metric, v_limit, v_used
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function app.assert_quota(uuid, uuid, text, integer) is
  'Plan limit gate. Blocks at 100% for every plan; app.quota_state() carries the 80% soft warning and the override.';

-- ---------------------------------------------------------------------------
-- 12. Posting: one function per money event, all of them through app.post_journal
-- ---------------------------------------------------------------------------

/**
 * The invoice for one confirmed payment.
 *
 * `snapshot` is the document: route, seats, passenger, method, fare and the commission rate that applied.
 * Everything in it is copied, not referenced, because an invoice is a statement about a moment — a later edit
 * to the trip must not rewrite what the passenger was charged.
 */
create or replace function app.issue_booking_invoice(
  p_intent_id uuid,
  p_journal uuid default null,
  p_actor uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.payment_intents;
  v_booking public.bookings;
  v_trip public.trips;
  v_existing uuid;
  v_commission integer;
  v_invoice public.invoices;
  v_bp integer;
begin
  select * into v_intent from public.payment_intents where id = p_intent_id;
  if not found then
    raise exception 'NOT_FOUND: payment intent' using errcode = 'P0002';
  end if;

  select id into v_existing
    from public.invoices
   where intent_id = p_intent_id and kind = 'booking' and status <> 'void';
  if found then
    return v_existing;
  end if;

  select * into v_booking from public.bookings where id = v_intent.booking_id;
  select * into v_trip from public.trips where id = v_booking.trip_id;

  v_commission := app.commission_yer(
    v_trip.owner_user_id, v_trip.owner_org_id, v_intent.amount_yer,
    (v_intent.confirmed_at at time zone 'Asia/Aden')::date
  );
  v_bp := app.commission_basis_points(
    v_trip.owner_user_id, v_trip.owner_org_id,
    (v_intent.confirmed_at at time zone 'Asia/Aden')::date
  );

  insert into public.invoices (
    code, kind, status, booking_id, intent_id, subscription_id, journal_id,
    owner_user_id, owner_org_id, subtotal_yer, commission_yer, total_yer,
    snapshot, issued_at, paid_at, created_by
  )
  values (
    app.new_finance_code('INV'), 'booking', 'paid', v_booking.id, v_intent.id, null, p_journal,
    v_trip.owner_user_id, v_trip.owner_org_id,
    v_intent.amount_yer, v_commission, v_intent.amount_yer,
    jsonb_build_object(
      'bookingCode', v_booking.code,
      'tripCode', v_trip.code,
      'passenger', v_booking.contact_name,
      'seats', v_booking.seats,
      'method', v_intent.method,
      'purpose', v_intent.purpose,
      'paymentCode', v_intent.code,
      'commissionBasisPoints', v_bp,
      'currency', 'YER'
    ),
    coalesce(v_intent.confirmed_at, now()), coalesce(v_intent.confirmed_at, now()), p_actor
  )
  returning * into v_invoice;

  return v_invoice.id;
end;
$$;

/**
 * Reads Phase 9's outbox and posts everything unposted. The seam between the two phases.
 *
 * Idempotent at three levels: the outbox row is marked consumed, `app.post_journal` refuses a second journal
 * for the same source, and the invoice has a unique live row per payment. Any one of those alone would be
 * enough; three means a retry after a crash mid-loop is safe, which is the case that actually happens.
 *
 * Returns `{posted, skipped, invoices, journals}` so a cron log can say what it did.
 */
create or replace function app.consume_payment_outbox(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.payment_outbox;
  v_lines jsonb;
  v_journal uuid;
  v_invoice uuid;
  v_posting_date date;
  v_gross integer;
  v_commission integer;
  v_payable integer;
  v_posted integer := 0;
  v_invoices integer := 0;
  v_skipped integer := 0;
begin
  for v_row in
    select * from public.payment_outbox
     where consumed_at is null
     order by created_at
     limit greatest(p_limit, 1)
     for update skip locked
  loop
    v_posting_date := (v_row.created_at at time zone 'Asia/Aden')::date;
    v_gross := v_row.amount_yer;

    if v_row.kind = 'payment_confirmed' then
      v_commission := app.commission_yer(
        v_row.owner_user_id, v_row.owner_org_id, v_gross, v_posting_date
      );
      v_payable := v_gross - v_commission;
      v_lines := jsonb_build_array(
        jsonb_build_object('account', 'platform_cash', 'direction', 'debit', 'amount', v_gross)
      );
      if v_payable > 0 then
        v_lines := v_lines || jsonb_build_array(
          jsonb_build_object('account', 'operator_payable', 'direction', 'credit', 'amount', v_payable)
        );
      end if;
      if v_commission > 0 then
        v_lines := v_lines || jsonb_build_array(
          jsonb_build_object('account', 'commission_revenue', 'direction', 'credit', 'amount', v_commission)
        );
      end if;
      -- A zero-commission, zero-payable payment cannot balance; that only happens for a zero amount, which
      -- the payment schema forbids, so falling through to the journal's own refusal is the honest outcome.

      v_journal := app.post_journal(
        'payment', 'payment_intents', v_row.source_id, v_posting_date,
        'تحصيل دفعة / payment received', v_lines,
        v_row.actor_id, v_row.owner_user_id, v_row.owner_org_id
      );

      v_invoice := app.issue_booking_invoice(v_row.source_id, v_journal, v_row.actor_id);
      v_invoices := v_invoices + 1;

    elsif v_row.kind = 'refund_paid' then
      -- Money leaves the platform and reduces what the operator is owed. The commission reversal is a
      -- separate adjustment on purpose: whether the platform refunds its fee is a policy decision, and mixing
      -- it in here would make every refund silently cheaper.
      v_lines := jsonb_build_array(
        jsonb_build_object('account', 'operator_payable', 'direction', 'debit', 'amount', v_gross),
        jsonb_build_object('account', 'platform_cash', 'direction', 'credit', 'amount', v_gross)
      );
      v_journal := app.post_journal(
        'refund', 'refunds', v_row.source_id, v_posting_date,
        'استرداد إلى مسافر / refund issued', v_lines,
        v_row.actor_id, v_row.owner_user_id, v_row.owner_org_id
      );

    elsif v_row.kind = 'payout_paid' then
      v_lines := jsonb_build_array(
        jsonb_build_object('account', 'operator_payable', 'direction', 'debit', 'amount', v_gross),
        jsonb_build_object('account', 'platform_bank', 'direction', 'credit', 'amount', v_gross)
      );
      v_journal := app.post_journal(
        'payout', 'payouts', v_row.source_id, v_posting_date,
        'تحويل مستحقات مشغّل / payout to operator', v_lines,
        v_row.actor_id, v_row.owner_user_id, v_row.owner_org_id
      );

    else
      -- `payment_reversed` is written by the reversal command, not by consumption: skipping it here keeps one
      -- owner for that decision.
      v_skipped := v_skipped + 1;
      update public.payment_outbox set consumed_at = now() where id = v_row.id;
      continue;
    end if;

    update public.payment_outbox set consumed_at = now() where id = v_row.id;
    v_posted := v_posted + 1;
  end loop;

  return jsonb_build_object(
    'posted', v_posted, 'invoices', v_invoices, 'skipped', v_skipped
  );
end;
$$;

/**
 * The owner's balance, from the ledger only.
 *
 * This is what a payout is capped by in Phase 10, and it is deliberately computed from posted journals rather
 * than from payment rows: if the two disagree, the integrity job says so, and reconciling them is a decision
 * somebody makes — not something a report averages away.
 */
create or replace function app.owner_ledger_balance_yer(p_owner_user uuid, p_owner_org uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(
    case
      -- `operator_payable` is a liability: credits increase what the platform owes the operator.
      when e.account_code = 'operator_payable' and e.direction = 'credit' then e.amount_yer
      when e.account_code = 'operator_payable' and e.direction = 'debit' then -e.amount_yer
      else 0
    end
  ), 0)::integer
  from public.ledger_entries e
  join public.journal_entries j on j.id = e.journal_id
  where (case when p_owner_org is not null then j.owner_org_id = p_owner_org
              else j.owner_user_id = p_owner_user end);
$$;

/**
 * What the operator may withdraw, right now — the Phase 9 definition, corrected.
 *
 * Phase 9 summed confirmed payments, refunds and payouts, which promised money the platform had already kept
 * as commission: a 10,000 fare at 5 % left 9,500 owed, but 10,000 withdrawable. It also ignored expenses the
 * operator had chosen to settle out of their balance.
 *
 * The honest formula is the ledger, plus a bridge for whatever the outbox has not posted yet: a payment that
 * has a journal is counted at the amount the journal says (so a later commission change or a reversed
 * posting cannot rewrite history), and one that has not been posted yet is counted net of the commission
 * that will be taken from it. Without that bridge, the number would drop to zero whenever the cron was
 * fifteen minutes late — and an operator's money must not be held hostage by a job.
 */
create or replace function app.owner_available_yer(p_owner_user uuid, p_owner_org uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    app.owner_ledger_balance_yer(p_owner_user, p_owner_org)

    -- Confirmed payments the ledger has not seen yet, net of the commission that will be taken.
    + coalesce((
      select sum(i.amount_yer - app.commission_yer(
        t.owner_user_id, t.owner_org_id, i.amount_yer,
        (i.confirmed_at at time zone 'Asia/Aden')::date
      ))
      from public.payment_intents i
      join public.bookings b on b.id = i.booking_id
      join public.trips t on t.id = b.trip_id
      where i.status = 'confirmed'
        and ((p_owner_org is not null and t.owner_org_id = p_owner_org)
          or (p_owner_org is null and t.owner_user_id = p_owner_user))
        and not exists (
          select 1 from public.journal_entries j
           where j.source_kind = 'payment' and j.source_table = 'payment_intents'
             and j.source_id = i.id
        )
    ), 0)

    -- Refunds already paid out whose posting is still queued.
    - coalesce((
      select sum(r.amount_yer)
      from public.refunds r
      join public.bookings b on b.id = r.booking_id
      join public.trips t on t.id = b.trip_id
      where r.status = 'paid'
        and ((p_owner_org is not null and t.owner_org_id = p_owner_org)
          or (p_owner_org is null and t.owner_user_id = p_owner_user))
        and not exists (
          select 1 from public.journal_entries j
           where j.source_kind = 'refund' and j.source_table = 'refunds' and j.source_id = r.id
        )
    ), 0)

    -- Payouts asked for but not yet paid: money promised out of the balance, so it must not be promised twice.
    - coalesce((
      select sum(p.amount_yer)
      from public.payouts p
      where p.status in ('requested', 'approved')
        and ((p_owner_org is not null and p.owner_org_id = p_owner_org)
          or (p_owner_org is null and p.owner_user_id = p_owner_user))
    ), 0)

    -- Payouts already paid whose posting is still queued.
    - coalesce((
      select sum(p.amount_yer)
      from public.payouts p
      where p.status = 'paid'
        and ((p_owner_org is not null and p.owner_org_id = p_owner_org)
          or (p_owner_org is null and p.owner_user_id = p_owner_user))
        and not exists (
          select 1 from public.journal_entries j
           where j.source_kind = 'payout' and j.source_table = 'payouts' and j.source_id = p.id
        )
    ), 0),
    0
  )::integer;
$$;

comment on function app.owner_available_yer(uuid, uuid) is
  'Withdrawable now: confirmed payments net of commission, less paid refunds and every payout not rejected.';

-- ---------------------------------------------------------------------------
-- 13. Subscription billing internals
-- ---------------------------------------------------------------------------

/** The period length. Monthly, fixed, documented: a 30-day month is what the price list means. */
create or replace function app.billing_period_interval()
returns interval
language sql
immutable
as $$
  select interval '30 days';
$$;

/**
 * Issues the invoice for one subscription period, once.
 *
 * `due_on` is the idempotency key together with the subscription: the renewal job may run hourly and every
 * run after the first must find the invoice rather than mint another. That is also why the unique index lives
 * on the table rather than in this function's `if`.
 */
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
     and status <> 'void' and due_on = p_due_on
     -- A proration invoice is not a period invoice: it must not be mistaken for the period already billed.
     and coalesce(snapshot ->> 'proration', 'false') = 'false';
  if found then
    return v_existing;
  end if;

  select * into v_plan from public.plans where code = v_sub.plan_code;

  insert into public.invoices (
    code, kind, status, subscription_id, owner_user_id, owner_org_id,
    subtotal_yer, commission_yer, total_yer, snapshot, issued_at, due_on, created_by
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
    now(), p_due_on, p_actor
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

-- ---------------------------------------------------------------------------
-- 14. Commands — plans, commissions, overrides
-- ---------------------------------------------------------------------------

/**
 * The plans editor. An admin changes a number here and enforcement follows on the next call, because
 * `app.quota_state` reads `plan_limits` at request time and nothing caches it.
 */
create or replace function public.cmd_update_plan(
  p_actor uuid,
  p_plan jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code public.plan_code := (p_plan ->> 'code')::public.plan_code;
  v_before jsonb;
  v_after jsonb;
  v_limit jsonb;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_admin(p_actor) then
    raise exception 'FORBIDDEN: only a platform admin may edit plans' using errcode = '42501';
  end if;

  select to_jsonb(p) into v_before from public.plans p where p.code = v_code;
  if not found then
    raise exception 'NOT_FOUND: plan %', v_code using errcode = 'P0002';
  end if;

  update public.plans
     set price_yer = coalesce((p_plan ->> 'priceYer')::integer, price_yer),
         trial_days = coalesce((p_plan ->> 'trialDays')::integer, trial_days),
         soft_limit = coalesce((p_plan ->> 'softLimit')::boolean, soft_limit),
         name_ar = coalesce(nullif(btrim(coalesce(p_plan ->> 'nameAr', '')), ''), name_ar),
         name_en = coalesce(nullif(btrim(coalesce(p_plan ->> 'nameEn', '')), ''), name_en),
         features = coalesce(p_plan -> 'features', features)
   where code = v_code;

  -- Limits are one object per plan: `{"vehicles": 5, "trips": 50, "staff": null}`. A key that is absent is
  -- left alone; an explicit null means unlimited, which is the one value JSON can express and SQL cannot
  -- otherwise distinguish from "not sent".
  if p_plan ? 'limits' and jsonb_typeof(p_plan -> 'limits') = 'object' then
    for v_limit in select * from jsonb_array_elements(
      (select jsonb_agg(jsonb_build_object('key', key, 'value', value))
         from jsonb_each(p_plan -> 'limits'))
    ) loop
      insert into public.plan_limits (plan_code, metric, limit_value)
      values (v_code, v_limit ->> 'key',
              case when jsonb_typeof(v_limit -> 'value') = 'null' then null
                   else (v_limit ->> 'value')::integer end)
      on conflict (plan_code, metric) do update
        set limit_value = excluded.limit_value;
    end loop;
  end if;

  select to_jsonb(p) into v_after from public.plans p where p.code = v_code;

  perform app.write_audit(
    p_actor, 'plan.update', 'plan', v_code::text, v_before, v_after, null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'plan', v_after,
    'limits', (select jsonb_object_agg(metric, limit_value) from public.plan_limits where plan_code = v_code)
  );
end;
$$;

/** A negotiated commission rate, effective from a date, optionally capped. Finance and admins only. */
create or replace function public.cmd_upsert_commission_rule(
  p_actor uuid,
  p_rule jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.safe_uuid(p_rule ->> 'orgId');
  v_user uuid := app.safe_uuid(p_rule ->> 'ownerUserId');
  v_bp integer := (p_rule ->> 'basisPoints')::integer;
  v_rule public.commission_rules;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: only finance may set a commission rate' using errcode = '42501';
  end if;
  if v_bp is null or v_bp < 0 or v_bp > 3_000 then
    raise exception 'VALIDATION_FAILED: basisPoints must be between 0 and 3000' using errcode = '22023';
  end if;
  if v_org is not null and v_user is not null then
    raise exception 'VALIDATION_FAILED: a rule targets an organization or a user, not both'
      using errcode = '22023';
  end if;

  insert into public.commission_rules (
    owner_user_id, owner_org_id, basis_points, min_yer, max_yer, effective_from, effective_to, note, created_by
  )
  values (
    v_user, v_org, v_bp,
    (p_rule ->> 'minYer')::integer, (p_rule ->> 'maxYer')::integer,
    coalesce((p_rule ->> 'effectiveFrom')::date, (now() at time zone 'Asia/Aden')::date),
    (p_rule ->> 'effectiveTo')::date,
    nullif(btrim(coalesce(p_rule ->> 'note', '')), ''), p_actor
  )
  returning * into v_rule;

  perform app.write_audit(
    p_actor, 'commission.rule', 'commission_rule', v_rule.id::text, null, to_jsonb(v_rule),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('rule', to_jsonb(v_rule));
end;
$$;

/**
 * A support override: one owner, one metric, one ceiling, and — unless an admin says otherwise — an expiry.
 *
 * Deliberately not part of the plan: an override is an exception with a name on it, and it must be visible in
 * the audit trail as an exception.
 */
create or replace function public.cmd_grant_quota_override(
  p_actor uuid,
  p_override jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.safe_uuid(p_override ->> 'orgId');
  v_user uuid := app.safe_uuid(p_override ->> 'ownerUserId');
  v_reason text := btrim(coalesce(p_override ->> 'reason', ''));
  v_row public.quota_overrides;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_admin(p_actor) then
    raise exception 'FORBIDDEN: only a platform admin may grant a quota override' using errcode = '42501';
  end if;
  if (v_org is null) = (v_user is null) then
    raise exception 'VALIDATION_FAILED: an override targets exactly one owner' using errcode = '22023';
  end if;
  if length(v_reason) < 5 then
    raise exception 'VALIDATION_FAILED: say why this owner gets an exception' using errcode = '22023';
  end if;

  insert into public.quota_overrides (
    owner_user_id, owner_org_id, metric, limit_value, expires_at, granted_by, reason
  )
  values (
    v_user, v_org, p_override ->> 'metric',
    case when p_override ? 'limitValue' and jsonb_typeof(p_override -> 'limitValue') <> 'null'
         then (p_override ->> 'limitValue')::integer end,
    (p_override ->> 'expiresAt')::timestamptz, p_actor, v_reason
  )
  returning * into v_row;

  perform app.write_audit(
    p_actor, 'quota.override', 'quota_override', v_row.id::text, null, to_jsonb(v_row),
    v_reason, p_request_id, p_ip
  );

  return jsonb_build_object('override', to_jsonb(v_row));
end;
$$;

create or replace function public.cmd_revoke_quota_override(
  p_actor uuid,
  p_override_id uuid,
  p_reason text,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.quota_overrides;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_platform_admin(p_actor) then
    raise exception 'FORBIDDEN: only a platform admin may revoke an override' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'VALIDATION_FAILED: say why the override is being withdrawn' using errcode = '22023';
  end if;

  update public.quota_overrides
     set revoked_at = now(), revoked_by = p_actor
   where id = p_override_id and revoked_at is null
   returning * into v_row;
  if not found then
    raise exception 'NOT_FOUND: an active override with that id' using errcode = 'P0002';
  end if;

  perform app.write_audit(
    p_actor, 'quota.override.revoke', 'quota_override', p_override_id::text, to_jsonb(v_row), null,
    btrim(p_reason), p_request_id, p_ip
  );

  return jsonb_build_object('override', to_jsonb(v_row));
end;
$$;

-- ---------------------------------------------------------------------------
-- 15. Subscription lifecycle
-- ---------------------------------------------------------------------------
-- The ladder, in one place so it can be read without following calls:
--
--   trialing ──(trial ends)──▶ active ──(period ends, invoice unpaid)──▶ past_due
--      ▲                        ▲                                          │ (7 days)
--      │                        └────────(invoice paid)────────────────────┤
--      │                                                                   ▼
--      └────────────(plan changed)───────────────────────  grace ──(7 days)──▶ expired
--
-- `grace` is the final notice: still entitled, visibly late, service ends in a week. `expired` is the end of
-- the ladder: the subscription stops being live, `app.owner_effective_plan` falls back to Basic, and nothing
-- the operator created is touched.
--
-- Billing is in advance: an invoice is issued the day a period starts, due seven days later. Nobody is
-- suspended for a service they have paid for, and nobody is billed twice for one day.

create or replace function app.billing_due_days()
returns integer
language sql
immutable
as $$
  select 7;
$$;

create or replace function app.billing_dunning_days()
returns integer
language sql
immutable
as $$
  select 7;
$$;

/** Who may speak for this owner about money: the person themselves, an org owner/manager/accountant, finance. */
create or replace function app.can_manage_billing(
  p_owner_user uuid,
  p_owner_org uuid,
  p_actor uuid default app.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    app.is_finance(p_actor)
    or (p_owner_org is not null and app.org_role(p_owner_org, p_actor) in ('owner', 'manager', 'accountant'))
    or (p_owner_org is null and p_owner_user is not null and p_owner_user = p_actor);
$$;

create or replace function app.subscription_event(
  p_subscription_id uuid,
  p_kind public.subscription_event_kind,
  p_from_plan public.plan_code default null,
  p_to_plan public.plan_code default null,
  p_amount integer default 0,
  p_invoice uuid default null,
  p_journal uuid default null,
  p_note text default null,
  p_actor uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.subscription_events (
    subscription_id, kind, from_plan, to_plan, amount_yer, invoice_id, journal_id, note, actor_id
  )
  values (
    p_subscription_id, p_kind, p_from_plan, p_to_plan, coalesce(p_amount, 0),
    p_invoice, p_journal, p_note, p_actor
  );
end;
$$;

/**
 * Starts a subscription. One live subscription per owner, enforced by an index rather than a check here.
 *
 * The price is copied onto the row at start, because a later change to the plan's price must not silently
 * re-price a running subscription: the operator agreed to a number.
 */
create or replace function public.cmd_start_subscription(
  p_actor uuid,
  p_subscription jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.safe_uuid(p_subscription ->> 'orgId');
  v_user uuid := app.safe_uuid(p_subscription ->> 'ownerUserId');
  v_plan_code public.plan_code := (p_subscription ->> 'planCode')::public.plan_code;
  v_plan public.plans;
  v_wants_trial boolean := coalesce((p_subscription ->> 'trial')::boolean, true);
  v_trial_used boolean;
  v_now timestamptz := now();
  v_sub public.subscriptions;
  v_existing public.subscriptions;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if v_org is null then
    v_user := coalesce(v_user, p_actor);
  end if;
  if (v_org is null) = (v_user is null) then
    raise exception 'VALIDATION_FAILED: a subscription belongs to one owner' using errcode = '22023';
  end if;
  if not app.can_manage_billing(v_user, v_org, p_actor) then
    raise exception 'FORBIDDEN: only the owner or an org manager may start a subscription'
      using errcode = '42501';
  end if;

  select * into v_plan from public.plans where code = v_plan_code;
  if not found then
    raise exception 'NOT_FOUND: plan %', p_plan_code using errcode = 'P0002';
  end if;
  -- Basic is the floor, not a purchase: paying for it would be paying for what everyone already has.
  if v_plan.price_yer = 0 then
    raise exception 'VALIDATION_FAILED: the Basic plan is not sold' using errcode = '22023';
  end if;

  select * into v_existing
    from public.subscriptions
   where (case when v_org is not null then owner_org_id = v_org else owner_user_id = v_user end)
     and status in ('trialing', 'active', 'past_due', 'grace')
   limit 1;
  if found then
    raise exception 'CONFLICT: this owner already has a live subscription' using errcode = '23505';
  end if;

  -- A trial is once per owner, and "once" means ever: re-subscribing after a cancellation does not restart it.
  select exists (
    select 1 from public.subscriptions s
     where (case when v_org is not null then s.owner_org_id = v_org else s.owner_user_id = v_user end)
       and s.trial_ends_at is not null
  ) into v_trial_used;

  insert into public.subscriptions (
    owner_user_id, owner_org_id, plan_code, status, price_yer, trial_ends_at,
    current_period_start, current_period_end, created_by
  )
  values (
    v_user, v_org, v_plan_code,
    (case when v_wants_trial and not v_trial_used and v_plan.trial_days > 0
          then 'trialing' else 'active' end)::public.subscription_status,
    v_plan.price_yer,
    case when v_wants_trial and not v_trial_used and v_plan.trial_days > 0
         then v_now + make_interval(days => v_plan.trial_days) end,
    v_now,
    case when v_wants_trial and not v_trial_used and v_plan.trial_days > 0
         then v_now + make_interval(days => v_plan.trial_days)
         else v_now + app.billing_period_interval() end,
    p_actor
  )
  returning * into v_sub;

  perform app.subscription_event(v_sub.id, 'started', null, v_plan_code, v_plan.price_yer, null, null,
                                 case when v_sub.status = 'trialing' then 'trial' else 'paid' end, p_actor);

  perform app.notify(
    v_sub.owner_user_id, 'subscription_activated', 'notifications.subscriptionActivated',
    jsonb_build_object('plan', v_plan_code, 'status', v_sub.status), '/operator/billing'
  );

  -- A subscription that starts straight into `active` (no trial) is billed now; a trial is billed when it ends.
  if v_sub.status = 'active' then
    perform app.issue_subscription_invoice(
      v_sub.id,
      ((v_now + make_interval(days => app.billing_due_days())) at time zone 'Asia/Aden')::date,
      p_actor
    );
  end if;

  perform app.write_audit(
    p_actor, 'subscription.start', 'subscription', v_sub.id::text, null, to_jsonb(v_sub),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('subscription', to_jsonb(v_sub));
end;
$$;

/**
 * Upgrades now, downgrades at the end of the paid period.
 *
 * The asymmetry is the policy, not an omission: an upgrade is billed immediately and prorated for the days
 * left, while a downgrade cannot claw back money already spent on a period the operator has been using. The
 * planned plan is stored in `pending_plan_code` and applied by the renewal job, so the UI can say "Basic from
 * 12 March" instead of pretending it already happened.
 */
create or replace function public.cmd_change_plan(
  p_actor uuid,
  p_subscription_id uuid,
  p_plan_code public.plan_code,
  p_when text default 'period_end',
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.subscriptions;
  v_new public.plans;
  v_old_rank integer;
  v_new_rank integer;
  v_now timestamptz := now();
  v_days_left integer;
  v_days_total integer;
  v_proration integer;
  v_invoice uuid;
  v_from_plan public.plan_code;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    raise exception 'NOT_FOUND: subscription' using errcode = 'P0002';
  end if;
  if not app.can_manage_billing(v_sub.owner_user_id, v_sub.owner_org_id, p_actor) then
    raise exception 'FORBIDDEN: not your subscription' using errcode = '42501';
  end if;
  if v_sub.status not in ('trialing', 'active', 'past_due', 'grace') then
    raise exception 'CONFLICT: this subscription is %', v_sub.status using errcode = '23505';
  end if;

  select * into v_new from public.plans where code = p_plan_code;
  if not found then
    raise exception 'NOT_FOUND: plan %', p_plan_code using errcode = 'P0002';
  end if;
  if p_plan_code = v_sub.plan_code then
    raise exception 'CONFLICT: already on %', p_plan_code using errcode = '23505';
  end if;

  -- The order of the ladder, in one place. Prices are the product's, but the ordering is the workflow's.
  v_old_rank := case v_sub.plan_code when 'basic' then 0 when 'pro' then 1 else 2 end;
  v_new_rank := case p_plan_code when 'basic' then 0 when 'pro' then 1 else 2 end;

  if p_when = 'now' and v_new_rank < v_old_rank then
    raise exception 'VALIDATION_FAILED: a downgrade takes effect at the end of the paid period'
      using errcode = '22023';
  end if;

  if p_when = 'period_end' then
    update public.subscriptions set pending_plan_code = p_plan_code where id = p_subscription_id
    returning * into v_sub;

    perform app.subscription_event(v_sub.id, 'plan_changed', v_sub.plan_code, p_plan_code, 0, null, null,
                                   'scheduled', p_actor);

    perform app.write_audit(
      p_actor, 'subscription.plan_change', 'subscription', v_sub.id::text,
      jsonb_build_object('plan', v_sub.plan_code), jsonb_build_object('pending', p_plan_code),
      'scheduled', p_request_id, p_ip
    );

    return jsonb_build_object('subscription', to_jsonb(v_sub), 'immediate', false, 'invoiceId', null);
  end if;

  -- Immediate: charge the difference for the days that are left, at the new price.
  v_days_total := greatest(
    1, ceil(extract(epoch from (v_sub.current_period_end - v_sub.current_period_start)) / 86400.0)::integer
  );
  v_days_left := greatest(
    0, ceil(extract(epoch from (v_sub.current_period_end - v_now)) / 86400.0)::integer
  );
  v_proration := ((v_new.price_yer - v_sub.price_yer)::bigint * v_days_left / v_days_total)::integer;
  v_from_plan := v_sub.plan_code;

  update public.subscriptions
     set plan_code = p_plan_code, price_yer = v_new.price_yer, pending_plan_code = null
   where id = p_subscription_id
  returning * into v_sub;

  if v_proration > 0 then
    insert into public.invoices (
      code, kind, status, subscription_id, owner_user_id, owner_org_id,
      subtotal_yer, commission_yer, total_yer, snapshot, issued_at, due_on, created_by
    )
    values (
      app.new_finance_code('SUB'), 'subscription', 'issued', v_sub.id,
      v_sub.owner_user_id, v_sub.owner_org_id,
      v_proration, 0, v_proration,
      jsonb_build_object(
        'plan', p_plan_code,
        'proration', true,
        'daysLeft', v_days_left,
        'daysTotal', v_days_total,
        'fromPlan', v_from_plan,
        'currency', 'YER'
      ),
      v_now, ((v_now + make_interval(days => app.billing_due_days())) at time zone 'Asia/Aden')::date,
      p_actor
    )
    returning id into v_invoice;
  end if;

  perform app.subscription_event(v_sub.id, 'plan_changed', v_from_plan, p_plan_code, v_proration, v_invoice,
                                 null, 'immediate', p_actor);

  perform app.write_audit(
    p_actor, 'subscription.plan_change', 'subscription', v_sub.id::text,
    jsonb_build_object('plan', v_from_plan),
    jsonb_build_object('plan', p_plan_code, 'proration', v_proration),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'subscription', to_jsonb(v_sub), 'immediate', true, 'proration', v_proration, 'invoiceId', v_invoice
  );
end;
$$;

/**
 * Cancels — now, or at the end of the period that has already been paid for.
 *
 * Nothing is deleted and no limit is lowered retroactively: cancellation ends *future* entitlement. What the
 * operator built while subscribed stays, and only the ability to build more comes back to Basic.
 */
create or replace function public.cmd_cancel_subscription(
  p_actor uuid,
  p_subscription_id uuid,
  p_at_period_end boolean default true,
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
  v_sub public.subscriptions;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    raise exception 'NOT_FOUND: subscription' using errcode = 'P0002';
  end if;
  if not app.can_manage_billing(v_sub.owner_user_id, v_sub.owner_org_id, p_actor) then
    raise exception 'FORBIDDEN: not your subscription' using errcode = '42501';
  end if;
  if v_sub.status in ('cancelled', 'expired') then
    return jsonb_build_object('subscription', to_jsonb(v_sub), 'changed', false);
  end if;

  if p_at_period_end then
    update public.subscriptions
       set cancel_at_period_end = true, cancel_reason = v_reason, pending_plan_code = null
     where id = p_subscription_id
    returning * into v_sub;
  else
    update public.subscriptions
       set status = 'cancelled', cancelled_at = now(), ended_at = now(),
           cancel_at_period_end = false, cancel_reason = v_reason, pending_plan_code = null
     where id = p_subscription_id
    returning * into v_sub;

    perform app.subscription_event(v_sub.id, 'cancelled', v_sub.plan_code, null, 0, null, null,
                                   v_reason, p_actor);
  end if;

  perform app.write_audit(
    p_actor, 'subscription.cancel', 'subscription', v_sub.id::text,
    jsonb_build_object('status', v_sub.status),
    jsonb_build_object('atPeriodEnd', p_at_period_end, 'reason', v_reason),
    v_reason, p_request_id, p_ip
  );

  return jsonb_build_object('subscription', to_jsonb(v_sub), 'changed', true);
end;
$$;

/**
 * Pays a subscription invoice. The only place subscription revenue is recognised.
 *
 * Cash basis on purpose: the platform has no receivable from a passenger here, and recognising revenue for
 * money that has not arrived would make the dashboard a wish. A booking invoice is already `paid` when it is
 * minted (the payment cleared first), so this command refuses one rather than unpaying it.
 */
create or replace function public.cmd_pay_invoice(
  p_actor uuid,
  p_invoice_id uuid,
  p_reference text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.invoices;
  v_sub public.subscriptions;
  v_journal uuid;
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_now timestamptz := now();
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: only finance may settle an invoice' using errcode = '42501';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'NOT_FOUND: invoice' using errcode = 'P0002';
  end if;
  if v_invoice.status = 'paid' then
    return jsonb_build_object('invoice', to_jsonb(v_invoice), 'changed', false);
  end if;
  if v_invoice.status = 'void' then
    raise exception 'CONFLICT: this invoice was voided' using errcode = '23505';
  end if;
  if v_invoice.kind <> 'subscription' then
    raise exception 'CONFLICT: a booking invoice is settled by the payment, not by finance'
      using errcode = '23505';
  end if;

  v_journal := app.post_journal(
    'subscription', 'invoices', v_invoice.id,
    (v_now at time zone 'Asia/Aden')::date,
    'اشتراك / subscription payment',
    jsonb_build_array(
      jsonb_build_object('account', 'platform_bank', 'direction', 'debit', 'amount', v_invoice.total_yer),
      jsonb_build_object('account', 'subscription_revenue', 'direction', 'credit',
                         'amount', v_invoice.total_yer)
    ),
    p_actor, v_invoice.owner_user_id, v_invoice.owner_org_id,
    null, v_reference
  );

  update public.invoices
     set status = 'paid', paid_at = v_now, journal_id = v_journal
   where id = p_invoice_id
  returning * into v_invoice;

  select * into v_sub from public.subscriptions where id = v_invoice.subscription_id for update;

  if found and v_sub.status in ('past_due', 'grace') then
    -- A late payment re-anchors the period to the day it was paid: arrears are not compounded, and the
    -- operator does not pay twice for days that have already gone by.
    update public.subscriptions
       set status = 'active',
           current_period_start = v_now,
           current_period_end = v_now + app.billing_period_interval(),
           grace_ends_at = null
     where id = v_sub.id
    returning * into v_sub;

    perform app.issue_subscription_invoice(
      v_sub.id, ((v_now + make_interval(days => app.billing_due_days())) at time zone 'Asia/Aden')::date,
      p_actor
    );
    perform app.subscription_event(v_sub.id, 'renewed', v_sub.plan_code, v_sub.plan_code, v_invoice.total_yer,
                                    v_invoice.id, v_journal, 'paid late', p_actor);
  elsif found then
    perform app.subscription_event(v_sub.id, 'renewed', v_sub.plan_code, v_sub.plan_code, v_invoice.total_yer,
                                    v_invoice.id, v_journal, null, p_actor);
  end if;

  perform app.write_audit(
    p_actor, 'invoice.pay', 'invoice', p_invoice_id::text,
    jsonb_build_object('status', 'issued'), jsonb_build_object('status', 'paid', 'journal', v_journal),
    v_reference, p_request_id, p_ip
  );

  return jsonb_build_object(
    'invoice', to_jsonb(v_invoice),
    'subscription', case when v_sub.id is null then null else to_jsonb(v_sub) end,
    'changed', true
  );
end;
$$;

/**
 * Voids an invoice. Finance only, a reason of substance required, and only while nothing has been posted
 * against it: an invoice that has money behind it is corrected by a reversing journal, not by editing history.
 */
create or replace function public.cmd_void_invoice(
  p_actor uuid,
  p_invoice_id uuid,
  p_reason text,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.invoices;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: only finance may void an invoice' using errcode = '42501';
  end if;
  if length(v_reason) < 5 then
    raise exception 'VALIDATION_FAILED: give a reason for voiding this invoice' using errcode = '22023';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'NOT_FOUND: invoice' using errcode = 'P0002';
  end if;
  if v_invoice.status = 'void' then
    raise exception 'CONFLICT: already void' using errcode = '23505';
  end if;
  -- Paid or posted: history, not a draft. Reverse the journal and issue a credit note instead.
  if v_invoice.status = 'paid' or v_invoice.journal_id is not null then
    raise exception 'CONFLICT: this invoice carries a posted payment; reverse the journal instead'
      using errcode = '23505';
  end if;

  update public.invoices
     set status = 'void', voided_at = now(), voided_by = p_actor, void_reason = v_reason
   where id = p_invoice_id
  returning * into v_invoice;

  perform app.write_audit(
    p_actor, 'invoice.void', 'invoice', p_invoice_id::text,
    jsonb_build_object('status', 'issued'), jsonb_build_object('status', 'void'),
    v_reason, p_request_id, p_ip
  );

  return jsonb_build_object('invoice', to_jsonb(v_invoice));
end;
$$;

/**
 * The renewal job: what has to happen when a period ends.
 *
 * Idempotent by construction — it only acts on rows whose period has already ended, and the invoice it creates
 * is unique per subscription and due date. Running it every hour is the expected use; running it twice in the
 * same hour changes nothing.
 */
create or replace function public.cmd_renew_subscriptions(
  p_actor uuid default null,
  p_limit integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.subscriptions;
  v_plan public.plans;
  v_next_plan public.plan_code;
  v_unpaid integer;
  v_invoice uuid;
  v_now timestamptz := now();
  v_renewed integer := 0;
  v_trials integer := 0;
  v_dunned integer := 0;
  v_cancelled integer := 0;
  v_from public.plan_code;
begin
  for v_sub in
    select * from public.subscriptions
     where status in ('trialing', 'active')
       and current_period_end <= v_now
     order by current_period_end
     limit greatest(p_limit, 1)
     for update skip locked
  loop
    -- A cancellation that was scheduled for the end of the period takes effect before anything is billed.
    if v_sub.cancel_at_period_end then
      update public.subscriptions
         set status = 'cancelled', ended_at = v_now, cancelled_at = coalesce(cancelled_at, v_now)
       where id = v_sub.id;
      perform app.subscription_event(v_sub.id, 'cancelled', v_sub.plan_code, null, 0, null, null,
                                     v_sub.cancel_reason, p_actor);
      v_cancelled := v_cancelled + 1;
      continue;
    end if;

    -- Is the period that just ended paid for? Only a paid period earns another one.
    select count(*) into v_unpaid
      from public.invoices i
     where i.subscription_id = v_sub.id
       and i.kind = 'subscription'
       and i.status in ('issued', 'overdue')
       and i.due_on <= (v_now at time zone 'Asia/Aden')::date;

    if v_unpaid > 0 then
      update public.subscriptions
         set status = 'past_due', grace_ends_at = v_now + make_interval(days => app.billing_dunning_days())
       where id = v_sub.id;
      perform app.subscription_event(v_sub.id, 'payment_failed', v_sub.plan_code, v_sub.plan_code, 0, null, null,
                                     'unpaid period', p_actor);
      perform app.notify(
        v_sub.owner_user_id, 'subscription_past_due', 'notifications.subscriptionPastDue',
        jsonb_build_object('plan', v_sub.plan_code), '/operator/billing'
      );
      v_dunned := v_dunned + 1;
      continue;
    end if;

    v_from := v_sub.plan_code;
    v_next_plan := coalesce(v_sub.pending_plan_code, v_sub.plan_code);
    select * into v_plan from public.plans where code = v_next_plan;

    if v_sub.status = 'trialing' then
      -- The trial ends and the first real period starts now, not at the end of the trial period: that is what
      -- "14 days free, then 7,500 a month" means on the billing page.
      update public.subscriptions
         set status = 'active', plan_code = v_next_plan, price_yer = v_plan.price_yer,
             pending_plan_code = null,
             current_period_start = v_now,
             current_period_end = v_now + app.billing_period_interval()
       where id = v_sub.id
      returning * into v_sub;

      perform app.subscription_event(v_sub.id, 'trial_ended', v_from, v_next_plan, 0, null, null, null, p_actor);
      v_trials := v_trials + 1;
    else
      update public.subscriptions
         set plan_code = v_next_plan, price_yer = v_plan.price_yer, pending_plan_code = null,
             current_period_start = v_sub.current_period_end,
             current_period_end = v_sub.current_period_end + app.billing_period_interval()
       where id = v_sub.id
      returning * into v_sub;
      v_renewed := v_renewed + 1;
    end if;

    v_invoice := app.issue_subscription_invoice(
      v_sub.id,
      ((v_sub.current_period_start + make_interval(days => app.billing_due_days())) at time zone 'Asia/Aden')::date,
      p_actor
    );

    perform app.subscription_event(
      v_sub.id, 'renewed', v_from, v_next_plan, v_plan.price_yer, v_invoice, null,
      case when v_from <> v_next_plan then 'pending plan applied' end, p_actor
    );
  end loop;

  return jsonb_build_object(
    'trialsEnded', v_trials, 'renewed', v_renewed, 'dunned', v_dunned, 'cancelled', v_cancelled
  );
end;
$$;

/**
 * The expiry job, and the reason `grace` exists as a state of its own.
 *
 * `past_due` still has every power; `grace` is the last week and says so in the UI. Only `expired` removes the
 * powers — and it removes them by stopping the subscription from being live, never by deleting the operator's
 * vehicles, trips or staff. `organizations.plan` is set back to Basic so the fallback is visible to anything
 * that reads the column directly.
 */
create or replace function public.cmd_expire_subscriptions(
  p_actor uuid default null,
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.subscriptions;
  v_now timestamptz := now();
  v_grace integer := 0;
  v_expired integer := 0;
  v_overdue integer := 0;
begin
  -- Invoices that are past their due date say so, so a statement does not call them "issued" forever.
  update public.invoices
     set status = 'overdue'
   where kind = 'subscription'
     and status = 'issued'
     and due_on < (v_now at time zone 'Asia/Aden')::date;
  get diagnostics v_overdue = row_count;

  for v_sub in
    select * from public.subscriptions
     where status = 'past_due'
       and grace_ends_at <= v_now
     order by grace_ends_at
     limit greatest(p_limit, 1)
     for update skip locked
  loop
    update public.subscriptions
       set status = 'grace', grace_ends_at = v_now + make_interval(days => app.billing_dunning_days())
     where id = v_sub.id;
    perform app.subscription_event(v_sub.id, 'payment_failed', v_sub.plan_code, v_sub.plan_code, 0, null, null,
                                   'final notice', p_actor);
    perform app.notify(
      v_sub.owner_user_id, 'subscription_past_due', 'notifications.subscriptionFinalNotice',
      jsonb_build_object('plan', v_sub.plan_code), '/operator/billing'
    );
    v_grace := v_grace + 1;
  end loop;

  for v_sub in
    select * from public.subscriptions
     where status = 'grace'
       and grace_ends_at <= v_now
     order by grace_ends_at
     limit greatest(p_limit, 1)
     for update skip locked
  loop
    update public.subscriptions
       set status = 'expired', ended_at = v_now, grace_ends_at = null
     where id = v_sub.id;

    -- The visible downgrade. Nothing else is touched: limits are read at creation time, so existing rows
    -- simply stop being allowed to grow.
    if v_sub.owner_org_id is not null then
      update public.organizations set plan = 'basic' where id = v_sub.owner_org_id;
    end if;

    perform app.subscription_event(v_sub.id, 'expired', v_sub.plan_code, 'basic', 0, null, null, null, p_actor);
    perform app.notify(
      v_sub.owner_user_id, 'subscription_expired', 'notifications.subscriptionExpired',
      jsonb_build_object('plan', v_sub.plan_code), '/operator/billing'
    );
    v_expired := v_expired + 1;
  end loop;

  return jsonb_build_object('invoicesOverdue', v_overdue, 'movedToGrace', v_grace, 'expired', v_expired);
end;
$$;

/**
 * A monthly snapshot of usage per owner, for the billing page.
 *
 * Writes only rows that have something to say. It is allowed to be stale by a day — enforcement never reads
 * it — and that is exactly why it is safe to rebuild it from scratch on every run.
 */
create or replace function public.cmd_snapshot_usage(
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_metric text;
  v_period date := date_trunc('month', now() at time zone 'Asia/Aden')::date;
  v_rows integer := 0;
  v_owner record;
begin
  for v_owner in
    select distinct owner_user_id, owner_org_id
      from (
        select owner_user_id, owner_org_id from public.vehicles
        union all select owner_user_id, owner_org_id from public.trips
        union all select null::uuid, id from public.organizations
      ) o
     where o.owner_user_id is not null or o.owner_org_id is not null
  loop
    foreach v_metric in array array['vehicles', 'trips', 'staff', 'drivers', 'active_trips',
                                    'featured_listings', 'finance_exports']
    loop
      insert into public.usage_counters (owner_user_id, owner_org_id, metric, period_start, used, updated_at)
      values (
        v_owner.owner_user_id, v_owner.owner_org_id, v_metric, v_period,
        app.quota_usage(v_owner.owner_user_id, v_owner.owner_org_id, v_metric), now()
      )
      on conflict (owner_user_id, owner_org_id, metric, period_start)
      do update set used = excluded.used, updated_at = now();
      v_rows := v_rows + 1;
    end loop;
  end loop;

  return jsonb_build_object('period', v_period, 'rows', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- 16. Manual journals, reversals and expenses
-- ---------------------------------------------------------------------------

/**
 * A correction somebody types. Finance only, and never for a money event that has its own posting function:
 * `source_kind` is restricted here so a manual journal cannot masquerade as a payment.
 *
 * `clientReference` is optional and makes the command retry-safe: it becomes the `source_id` (hashed), so a
 * double-click posts one journal.
 */
create or replace function public.cmd_post_manual_journal(
  p_actor uuid,
  p_journal jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind public.journal_source_kind := coalesce(nullif(p_journal ->> 'sourceKind', ''), 'adjustment')::public.journal_source_kind;
  v_org uuid := app.safe_uuid(p_journal ->> 'orgId');
  v_user uuid := app.safe_uuid(p_journal ->> 'ownerUserId');
  v_ref text := nullif(btrim(coalesce(p_journal ->> 'clientReference', '')), '');
  v_source uuid;
  v_reason text := nullif(btrim(coalesce(p_journal ->> 'reason', '')), '');
  v_description text := btrim(coalesce(p_journal ->> 'description', ''));
  v_journal uuid;
  v_row public.journal_entries;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: only finance may post a manual journal' using errcode = '42501';
  end if;
  if v_kind not in ('adjustment', 'expense') then
    raise exception 'VALIDATION_FAILED: a manual journal may only be an adjustment or an expense'
      using errcode = '22023';
  end if;
  if length(v_description) < 3 then
    raise exception 'VALIDATION_FAILED: describe the entry' using errcode = '22023';
  end if;
  if v_org is not null and v_user is not null then
    raise exception 'VALIDATION_FAILED: a journal is about an organization or a user, not both'
      using errcode = '22023';
  end if;

  v_source := coalesce(
    case when v_ref is null then null else md5(v_ref)::uuid end,
    gen_random_uuid()
  );

  v_journal := app.post_journal(
    v_kind, 'manual', v_source,
    coalesce((p_journal ->> 'postingDate')::date, (now() at time zone 'Asia/Aden')::date),
    v_description, p_journal -> 'lines', p_actor, v_user, v_org, null, v_reason
  );

  select * into v_row from public.journal_entries where id = v_journal;

  perform app.write_audit(
    p_actor, 'journal.manual', 'journal', v_journal::text, null, to_jsonb(v_row),
    v_reason, p_request_id, p_ip
  );

  return jsonb_build_object(
    'journal', to_jsonb(v_row),
    'lines', (select jsonb_agg(to_jsonb(l)) from public.ledger_entries l where l.journal_id = v_journal)
  );
end;
$$;

/**
 * The only way to undo a posting: a mirror journal that names it.
 *
 * The original stays exactly as it was, so last month's statement still prints the same numbers, and the
 * month that contains the correction shows both halves. Two reversals of one journal are impossible — the
 * unique source index refuses the second.
 */
create or replace function public.cmd_reverse_journal(
  p_actor uuid,
  p_journal_id uuid,
  p_reason text,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_original public.journal_entries;
  v_lines jsonb;
  v_reversal uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: only finance may reverse a journal' using errcode = '42501';
  end if;
  if length(v_reason) < 5 then
    raise exception 'VALIDATION_FAILED: say why this posting is being reversed' using errcode = '22023';
  end if;

  select * into v_original from public.journal_entries where id = p_journal_id;
  if not found then
    raise exception 'NOT_FOUND: journal' using errcode = 'P0002';
  end if;
  if v_original.reverses_id is not null then
    raise exception 'CONFLICT: this journal is itself a reversal' using errcode = '23505';
  end if;
  if exists (
    select 1 from public.journal_entries j
     where j.reverses_id = p_journal_id
  ) then
    raise exception 'CONFLICT: this journal was already reversed' using errcode = '23505';
  end if;

  select jsonb_agg(jsonb_build_object(
           'account', l.account_code,
           'direction', case when l.direction = 'debit' then 'credit' else 'debit' end,
           'amount', l.amount_yer
         ) order by l.seq)
    into v_lines
    from public.ledger_entries l
   where l.journal_id = p_journal_id;

  v_reversal := app.post_journal(
    'adjustment', 'journal_entries', p_journal_id,
    (now() at time zone 'Asia/Aden')::date,
    'قيد عكسي / reversal of ' || v_original.code,
    v_lines, p_actor, v_original.owner_user_id, v_original.owner_org_id, p_journal_id, v_reason
  );

  perform app.write_audit(
    p_actor, 'journal.reverse', 'journal', p_journal_id::text,
    to_jsonb(v_original),
    jsonb_build_object('reversal', v_reversal), v_reason, p_request_id, p_ip
  );

  return jsonb_build_object(
    'reversalJournalId', v_reversal,
    'journal', (select to_jsonb(j) from public.journal_entries j where j.id = v_reversal)
  );
end;
$$;

/**
 * Records a cost against a vehicle, a trip, or nothing in particular.
 *
 * Two behaviours, because operators genuinely do both:
 *   · paid from their own pocket (default) — a row for the P&L, and **no** journal: the platform never held
 *     the money, so pretending it did would overstate what any account contains;
 *   · paid out of the money the platform is holding for them (`settleFromBalance`) — a settlement journal:
 *     debit `operator_payable`, credit `platform_cash`. Cash left the platform on the operator's behalf, so
 *     what we owe them falls by exactly what left. The operator's own cost stays an `expenses` row, because
 *     their fuel is not the platform's expense — booking it as one would turn a marketplace into a fleet.
 */
create or replace function public.cmd_record_expense(
  p_actor uuid,
  p_expense jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.safe_uuid(p_expense ->> 'orgId');
  v_user uuid := app.safe_uuid(p_expense ->> 'ownerUserId');
  v_amount integer := (p_expense ->> 'amountYer')::integer;
  v_incurred date := coalesce((p_expense ->> 'incurredOn')::date, (now() at time zone 'Asia/Aden')::date);
  v_settle boolean := coalesce((p_expense ->> 'settleFromBalance')::boolean, false);
  v_vehicle uuid := app.safe_uuid(p_expense ->> 'vehicleId');
  v_trip uuid := app.safe_uuid(p_expense ->> 'tripId');
  v_row public.expenses;
  v_journal uuid;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if v_org is null then
    v_user := coalesce(v_user, p_actor);
  end if;
  if (v_org is null) = (v_user is null) then
    raise exception 'VALIDATION_FAILED: an expense belongs to one owner' using errcode = '22023';
  end if;
  if not (app.is_finance(p_actor) or app.can_manage_billing(v_user, v_org, p_actor)) then
    raise exception 'FORBIDDEN: not your expense to record' using errcode = '42501';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'VALIDATION_FAILED: an expense needs a positive amount' using errcode = '22023';
  end if;
  if (p_expense ->> 'category') is null then
    raise exception 'VALIDATION_FAILED: category is required' using errcode = '22023';
  end if;

  insert into public.expenses (
    owner_user_id, owner_org_id, vehicle_id, trip_id, category, amount_yer, incurred_on, description,
    source, source_id, recorded_by
  )
  values (
    v_user, v_org, v_vehicle, v_trip, (p_expense ->> 'category')::public.expense_category,
    v_amount, v_incurred, nullif(btrim(coalesce(p_expense ->> 'description', '')), ''),
    'manual', null, p_actor
  )
  returning * into v_row;

  if v_settle then
    v_journal := app.post_journal(
      'expense', 'expenses', v_row.id, v_incurred,
      'مصروف / ' || v_row.category::text,
      jsonb_build_array(
        jsonb_build_object('account', 'operator_payable', 'direction', 'debit', 'amount', v_amount),
        jsonb_build_object('account', 'platform_cash', 'direction', 'credit', 'amount', v_amount)
      ),
      p_actor, v_user, v_org
    );
  end if;

  perform app.write_audit(
    p_actor, 'expense.record', 'expense', v_row.id::text, null,
    to_jsonb(v_row) || jsonb_build_object('journal', v_journal),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('expense', to_jsonb(v_row), 'journalId', v_journal);
end;
$$;

/**
 * Soft-deletes an expense against the ledger, not against history.
 *
 * The row keeps its marker, and the journal it produced (if any) is reversed rather than edited. Deleting a
 * fuel cost that was never in the ledger is a plain flag.
 */
create or replace function public.cmd_void_expense(
  p_actor uuid,
  p_expense_id uuid,
  p_reason text,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.expenses;
  v_source_journal uuid;
  v_lines jsonb;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_reversal uuid;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if length(v_reason) < 5 then
    raise exception 'VALIDATION_FAILED: say why this expense is being removed' using errcode = '22023';
  end if;

  select * into v_row from public.expenses where id = p_expense_id for update;
  if not found then
    raise exception 'NOT_FOUND: expense' using errcode = 'P0002';
  end if;
  if not (app.is_finance(p_actor)
          or app.can_manage_billing(v_row.owner_user_id, v_row.owner_org_id, p_actor)) then
    raise exception 'FORBIDDEN: not your expense' using errcode = '42501';
  end if;
  if v_row.deleted_at is not null then
    return jsonb_build_object('expense', to_jsonb(v_row), 'changed', false);
  end if;

  select j.id into v_source_journal
    from public.journal_entries j
   where j.source_kind = 'expense' and j.source_table = 'expenses' and j.source_id = p_expense_id;

  if v_source_journal is not null then
    select jsonb_agg(jsonb_build_object(
             'account', l.account_code,
             'direction', case when l.direction = 'debit' then 'credit' else 'debit' end,
             'amount', l.amount_yer
           ) order by l.seq)
      into v_lines
      from public.ledger_entries l where l.journal_id = v_source_journal;

    v_reversal := app.post_journal(
      'adjustment', 'expenses', p_expense_id,
      (now() at time zone 'Asia/Aden')::date,
      'إلغاء مصروف / expense removed', v_lines, p_actor,
      v_row.owner_user_id, v_row.owner_org_id, v_source_journal, v_reason
    );
  end if;

  update public.expenses
     set deleted_at = now(), deleted_by = p_actor, delete_reason = v_reason,
         reversal_entry_id = v_reversal
   where id = p_expense_id
  returning * into v_row;

  perform app.write_audit(
    p_actor, 'expense.void', 'expense', p_expense_id::text, null, to_jsonb(v_row),
    v_reason, p_request_id, p_ip
  );

  return jsonb_build_object('expense', to_jsonb(v_row), 'reversalJournalId', v_reversal, 'changed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 17. Reads: dashboard, statement, export
-- ---------------------------------------------------------------------------

/** Ledger totals per account for one owner and period, as JSON: `{account: {debit, credit, net}}`. */
create or replace function app.ledger_totals(
  p_owner_user uuid,
  p_owner_org uuid,
  p_from date,
  p_to date
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(t.account_code, t.totals), '{}'::jsonb)
  from (
    select l.account_code,
           jsonb_build_object(
             'debit', sum(case when l.direction = 'debit' then l.amount_yer else 0 end),
             'credit', sum(case when l.direction = 'credit' then l.amount_yer else 0 end),
             -- Positive always means "increases what this account is": assets and expenses grow on debit,
             -- liabilities, revenue and equity grow on credit.
             'net', sum(case
                          when a.kind in ('asset', 'expense') and l.direction = 'debit' then l.amount_yer
                          when a.kind in ('asset', 'expense') and l.direction = 'credit' then -l.amount_yer
                          when a.kind in ('liability', 'revenue', 'equity') and l.direction = 'credit' then l.amount_yer
                          else -l.amount_yer
                        end)
           ) as totals
      from public.ledger_entries l
      join public.journal_entries j on j.id = l.journal_id
      join public.ledger_accounts a on a.code = l.account_code
     where j.posting_date between p_from and p_to
       -- With no owner at all the caller is finance asking for the whole ledger, which is a real question
       -- and the one the platform dashboard asks. Answering it with an empty object was a silent zero.
       and (case when p_owner_org is not null then j.owner_org_id = p_owner_org
                 when p_owner_user is not null then j.owner_user_id = p_owner_user
                 else true end)
     group by l.account_code
  ) t;
$$;

/**
 * The operator's month, as the finance dashboard needs it.
 *
 * Everything here is derived, nothing is stored: the complaint about financial dashboards is always the same
 * one — the number on the dashboard and the number on the statement disagree because one of them is a cached
 * copy. Both of these read the ledger and the expense table in the same shape, from the same helpers.
 */
create or replace function public.cmd_get_finance_dashboard(
  p_actor uuid,
  p_scope jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.safe_uuid(p_scope ->> 'orgId');
  v_user uuid := app.safe_uuid(p_scope ->> 'ownerUserId');
  v_month_start date := date_trunc('month', now() at time zone 'Asia/Aden')::date;
  v_today date := (now() at time zone 'Asia/Aden')::date;
  v_platform boolean;
  v_totals jsonb;
  v_gross bigint;
  v_commission bigint;
  v_subs bigint;
  v_refunds bigint;
  v_expenses bigint;
  v_payouts bigint;
  v_payable integer;
  v_available integer;
  v_pending_payout integer;
  v_unpaid_invoices integer;
  v_quota jsonb;
  v_sub jsonb;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  -- No scope means "my own books". A platform-wide dashboard is finance's, and only finance's.
  v_platform := app.is_finance(p_actor) and coalesce((p_scope ->> 'platform')::boolean, v_org is null and v_user is null);
  if not v_platform then
    if v_org is null then
      v_user := coalesce(v_user, p_actor);
    end if;
    if not app.can_manage_billing(v_user, v_org, p_actor) then
      raise exception 'FORBIDDEN: not your books' using errcode = '42501';
    end if;
  end if;

  v_totals := app.ledger_totals(
    case when v_platform then null else v_user end,
    case when v_platform then null else v_org end,
    v_month_start, v_today
  );

  -- Platform-wide, the owner columns are null on subscription journals, so the sum over all journals is the
  -- platform's own revenue; owner-scoped, it is the owner's share.
  if v_platform then
    select
      coalesce(sum(case when l.account_code = 'platform_cash' and l.direction = 'debit' then l.amount_yer
                        when l.account_code = 'platform_cash' and l.direction = 'credit' then -l.amount_yer end), 0),
      coalesce(sum(case when l.account_code = 'commission_revenue' and l.direction = 'credit' then l.amount_yer
                        when l.account_code = 'commission_revenue' and l.direction = 'debit' then -l.amount_yer end), 0),
      coalesce(sum(case when l.account_code = 'subscription_revenue' and l.direction = 'credit' then l.amount_yer
                        when l.account_code = 'subscription_revenue' and l.direction = 'debit' then -l.amount_yer end), 0),
      coalesce(sum(case when l.account_code = 'refund_expense' and l.direction = 'debit' then l.amount_yer
                        when l.account_code = 'refund_expense' and l.direction = 'credit' then -l.amount_yer end), 0)
      into v_gross, v_commission, v_subs, v_refunds
      from public.ledger_entries l
      join public.journal_entries j on j.id = l.journal_id
     where j.posting_date between v_month_start and v_today;

    select coalesce(sum(p.amount_yer), 0) into v_payouts
      from public.payouts p
     where p.status = 'paid' and p.paid_at::date between v_month_start and v_today;
  else
    select
      coalesce(sum(case when l.account_code = 'operator_payable' and l.direction = 'credit' then l.amount_yer
                        when l.account_code = 'operator_payable' and l.direction = 'debit' then -l.amount_yer end), 0),
      coalesce(sum(case when l.account_code = 'commission_revenue' and l.direction = 'credit' then l.amount_yer
                        when l.account_code = 'commission_revenue' and l.direction = 'debit' then -l.amount_yer end), 0),
      0, 0
      into v_gross, v_commission, v_subs, v_refunds
      from public.ledger_entries l
      join public.journal_entries j on j.id = l.journal_id
     where j.posting_date between v_month_start and v_today
       and (case when v_org is not null then j.owner_org_id = v_org else j.owner_user_id = v_user end);

    select coalesce(sum(e.amount_yer), 0) into v_expenses
      from public.expenses e
     where e.deleted_at is null
       and e.incurred_on between v_month_start and v_today
       and (case when v_org is not null then e.owner_org_id = v_org else e.owner_user_id = v_user end);

    v_payable := app.owner_ledger_balance_yer(v_user, v_org);
    v_available := app.owner_available_yer(v_user, v_org);

    select coalesce(sum(p.amount_yer), 0) into v_payouts
      from public.payouts p
     where p.status = 'paid' and p.paid_at::date between v_month_start and v_today
       and (case when v_org is not null then p.owner_org_id = v_org else p.owner_user_id = v_user end);

    select coalesce(sum(p.amount_yer), 0) into v_pending_payout
      from public.payouts p
     where p.status in ('requested', 'approved')
       and (case when v_org is not null then p.owner_org_id = v_org else p.owner_user_id = v_user end);

    select count(*) into v_unpaid_invoices
      from public.invoices i
     where i.kind = 'subscription' and i.status in ('issued', 'overdue')
       and (case when v_org is not null then i.owner_org_id = v_org else i.owner_user_id = v_user end);

    -- The limits, from the same function `app.assert_quota` refuses on, so "1 of 1 vehicles" and the
    -- refusal to add a second one always agree.
    select coalesce(jsonb_agg(jsonb_build_object(
             'metric', m.metric,
             'limit', (app.quota_state(v_user, v_org, m.metric) ->> 'limit')::int,
             'used', (app.quota_state(v_user, v_org, m.metric) ->> 'used')::int)
             order by m.metric), '[]'::jsonb)
      into v_quota
      from (select distinct l.metric from public.plan_limits l) m;

    select to_jsonb(s) into v_sub
      from public.subscriptions s
     where (case when v_org is not null then s.owner_org_id = v_org else s.owner_user_id = v_user end)
       and s.status in ('trialing', 'active', 'past_due', 'grace')
     limit 1;
  end if;

  return jsonb_build_object(
    'platform', v_platform,
    'currency', 'YER',
    'period', jsonb_build_object('from', v_month_start, 'to', v_today),
    'totals', v_totals,
    'summary', jsonb_build_object(
      'grossYer', coalesce(v_gross, 0),
      'commissionYer', coalesce(v_commission, 0),
      'subscriptionYer', coalesce(v_subs, 0),
      'refundsYer', coalesce(v_refunds, 0),
      'expensesYer', coalesce(v_expenses, 0),
      'payoutsYer', coalesce(v_payouts, 0),
      'netYer', case
        when v_platform then coalesce(v_commission, 0) + coalesce(v_subs, 0)
                               - coalesce(v_refunds, 0) - coalesce(v_payouts, 0)
        else coalesce(v_gross, 0) - coalesce(v_commission, 0) - coalesce(v_expenses, 0)
      end,
      -- The number the operator actually cares about, and the one the acceptance criterion names:
      -- revenue − commission − expenses.
      'profitYer', case
        when v_platform then coalesce(v_commission, 0) + coalesce(v_subs, 0) - coalesce(v_refunds, 0)
        else coalesce(v_gross, 0) - coalesce(v_commission, 0) - coalesce(v_expenses, 0)
      end,
      'payableYer', v_payable,
      'availableYer', v_available,
      'pendingPayoutsYer', coalesce(v_pending_payout, 0),
      'unpaidInvoices', coalesce(v_unpaid_invoices, 0)
    ),
    'subscription', v_sub,
    'quota', coalesce(v_quota, '[]'::jsonb),
    'plan', case when v_platform then null
                 else app.owner_plan(v_user, v_org) end
  );
end;
$$;

/**
 * A statement: every journal that touched this owner in a period, plus the totals it adds up to.
 *
 * Deliberately the rows and the arithmetic in one answer, from one query, so the PDF, the CSV and the dashboard
 * cannot disagree: they are three renderings of this function.
 */
create or replace function public.cmd_get_statement(
  p_actor uuid,
  p_scope jsonb,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.safe_uuid(p_scope ->> 'orgId');
  v_user uuid := app.safe_uuid(p_scope ->> 'ownerUserId');
  v_from date := coalesce(p_from, date_trunc('month', now() at time zone 'Asia/Aden')::date);
  v_to date := coalesce(p_to, (now() at time zone 'Asia/Aden')::date);
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if v_org is null then
    v_user := coalesce(v_user, p_actor);
  end if;
  if (v_org is null) = (v_user is null) then
    raise exception 'VALIDATION_FAILED: a statement is for one owner' using errcode = '22023';
  end if;
  if not app.can_manage_billing(v_user, v_org, p_actor) then
    raise exception 'FORBIDDEN: not your statement' using errcode = '42501';
  end if;
  if v_to < v_from then
    raise exception 'VALIDATION_FAILED: the period ends before it starts' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'currency', 'YER',
    'from', v_from,
    'to', v_to,
    'totals', app.ledger_totals(v_user, v_org, v_from, v_to),
    'balance', app.owner_ledger_balance_yer(v_user, v_org),
    'journals', coalesce((
      select jsonb_agg(row order by row ->> 'postingDate' desc, row ->> 'code' desc)
      from (
        select jsonb_build_object(
                 'id', j.id,
                 'code', j.code,
                 'postingDate', j.posting_date,
                 'description', j.description,
                 'sourceKind', j.source_kind,
                 'reversesId', j.reverses_id,
                 'amountYer', (
                   select coalesce(sum(l.amount_yer), 0)
                     from public.ledger_entries l
                    where l.journal_id = j.id
                      and l.account_code in ('operator_payable', 'commission_revenue',
                                             'subscription_revenue', 'refund_expense')
                 ),
                 -- The lines travel with the journal: the ledger screen prints the double entry, and
                 -- asking for it in a second query is how the two answers end up disagreeing.
                 'lines', coalesce((
                   select jsonb_agg(jsonb_build_object(
                            'account', l.account_code,
                            'direction', l.direction,
                            'amountYer', l.amount_yer)
                          order by l.account_code, l.direction)
                     from public.ledger_entries l
                    where l.journal_id = j.id
                 ), '[]'::jsonb)
               ) as row
          from public.journal_entries j
         where j.posting_date between v_from and v_to
           and (case when v_org is not null then j.owner_org_id = v_org else j.owner_user_id = v_user end)
      ) r
    ), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'incurredOn', e.incurred_on, 'category', e.category,
               'amountYer', e.amount_yer, 'description', e.description))
        from public.expenses e
       where e.deleted_at is null
         and e.incurred_on between v_from and v_to
         and (case when v_org is not null then e.owner_org_id = v_org else e.owner_user_id = v_user end)
    ), '[]'::jsonb)
  );
end;
$$;

/**
 * Generates a CSV-shaped export and records that it happened, in the same transaction.
 *
 * The record is the quota: `finance_exports` is counted from the log, so an export that is not logged is an
 * export that does not count, and one that is logged but not produced is a line somebody can be asked about.
 */
create or replace function public.cmd_export_finance(
  p_actor uuid,
  p_export jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.safe_uuid(p_export ->> 'orgId');
  v_user uuid := app.safe_uuid(p_export ->> 'ownerUserId');
  v_kind text := coalesce(nullif(p_export ->> 'kind', ''), 'statement');
  v_from date := coalesce((p_export ->> 'from')::date,
                          date_trunc('month', now() at time zone 'Asia/Aden')::date);
  v_to date := coalesce((p_export ->> 'to')::date, (now() at time zone 'Asia/Aden')::date);
  v_rows jsonb;
  v_log public.finance_exports;
  v_count integer;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if v_kind not in ('statement', 'revenue', 'payouts', 'invoices') then
    raise exception 'VALIDATION_FAILED: unknown export kind %', v_kind using errcode = '22023';
  end if;
  if v_to < v_from then
    raise exception 'VALIDATION_FAILED: the period ends before it starts' using errcode = '22023';
  end if;

  if v_org is not null and v_user is not null then
    raise exception 'VALIDATION_FAILED: an export is for one owner' using errcode = '22023';
  end if;
  if app.is_finance(p_actor) and v_org is null and v_user is null then
    -- A platform-wide export by finance: no owner scope, and no plan quota — the plan limits an operator's
    -- exports, and finance is not on a plan.
    null;
  else
    if v_org is null then
      v_user := coalesce(v_user, p_actor);
    end if;
    if not app.can_manage_billing(v_user, v_org, p_actor) then
      raise exception 'FORBIDDEN: not your data to export' using errcode = '42501';
    end if;
    perform app.assert_quota(v_user, v_org, 'finance_exports', 1);
  end if;

  if v_kind = 'statement' and (v_org is not null or v_user is not null) then
    v_rows := public.cmd_get_statement(p_actor, jsonb_build_object(
                 'orgId', v_org, 'ownerUserId', v_user), v_from, v_to) -> 'journals';
  elsif v_kind = 'statement' then
    -- Finance's platform-wide statement has no single owner to print for, so it exports the period's
    -- account totals instead of a per-owner journal list. Different shape, same query as the dashboard.
    select coalesce(jsonb_agg(jsonb_build_object(
             'account', g.account_code,
             'debit', g.debit, 'credit', g.credit, 'net', g.credit - g.debit)), '[]'::jsonb)
      into v_rows
      from (
        select l.account_code,
               sum(case when l.direction = 'debit' then l.amount_yer else 0 end)::bigint as debit,
               sum(case when l.direction = 'credit' then l.amount_yer else 0 end)::bigint as credit
          from public.ledger_entries l
          join public.journal_entries j on j.id = l.journal_id
         where j.posting_date between v_from and v_to
         group by l.account_code
      ) g;
  elsif v_kind = 'payouts' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'code', p.code, 'status', p.status, 'amountYer', p.amount_yer,
             'requestedAt', p.requested_at, 'paidAt', p.paid_at)), '[]'::jsonb)
      into v_rows
      from public.payouts p
     where p.requested_at::date between v_from and v_to
       and (case when v_org is not null then p.owner_org_id = v_org
                 when v_user is not null then p.owner_user_id = v_user
                 else true end);
  elsif v_kind = 'invoices' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'code', i.code, 'kind', i.kind, 'status', i.status, 'totalYer', i.total_yer,
             'issuedAt', i.issued_at, 'dueOn', i.due_on)), '[]'::jsonb)
      into v_rows
      from public.invoices i
     where i.issued_at::date between v_from and v_to
       and (case when v_org is not null then i.owner_org_id = v_org
                 when v_user is not null then i.owner_user_id = v_user
                 else true end);
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'account', code, 'debit', value ->> 'debit', 'credit', value ->> 'credit', 'net', value ->> 'net')), '[]'::jsonb)
      into v_rows
      from jsonb_each(app.ledger_totals(v_user, v_org, v_from, v_to)) as t(code, value);
  end if;

  v_count := coalesce(jsonb_array_length(v_rows), 0);

  insert into public.finance_exports (
    owner_user_id, owner_org_id, kind, period_from, period_to, row_count, created_by
  )
  values (v_user, v_org, v_kind, v_from, v_to, v_count, p_actor)
  returning * into v_log;

  perform app.write_audit(
    p_actor, 'finance.export', 'finance_export', v_log.id::text, null,
    jsonb_build_object('kind', v_kind, 'rows', v_count, 'from', v_from, 'to', v_to),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('export', to_jsonb(v_log), 'rows', v_rows, 'rowCount', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- 18. Reconciliation
-- ---------------------------------------------------------------------------

/**
 * Imports a statement, and matches what it can without asking anybody.
 *
 * The matcher is deliberately conservative: exact amount, a date within three days, one candidate, no other
 * line already claiming it. Anything else is an exception, because a reconciliation feature that guesses is
 * worse than no reconciliation feature at all — it turns a known gap into an unknown one.
 */
create or replace function public.cmd_import_reconciliation(
  p_actor uuid,
  p_import jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.safe_uuid(p_import ->> 'orgId');
  v_user uuid := app.safe_uuid(p_import ->> 'ownerUserId');
  v_source text := coalesce(nullif(p_import ->> 'source', ''), 'other');
  v_from date := (p_import ->> 'from')::date;
  v_to date := (p_import ->> 'to')::date;
  v_line jsonb;
  v_import_id uuid;
  v_amount integer;
  v_on date;
  v_ref text;
  v_intent uuid;
  v_payout uuid;
  v_matched integer := 0;
  v_exceptions integer := 0;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: only finance may import a statement' using errcode = '42501';
  end if;
  if v_source not in ('jaib', 'kuraimi', 'tadhamon', 'cash_desk', 'bank_transfer', 'other') then
    raise exception 'VALIDATION_FAILED: unknown statement source %', v_source using errcode = '22023';
  end if;
  if v_from is null or v_to is null or v_to < v_from then
    raise exception 'VALIDATION_FAILED: the period is required and must not be inverted' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_import -> 'lines', '[]'::jsonb)) = 0 then
    raise exception 'VALIDATION_FAILED: nothing to import' using errcode = '22023';
  end if;
  if v_org is not null and v_user is not null then
    raise exception 'VALIDATION_FAILED: an import belongs to one owner' using errcode = '22023';
  end if;

  insert into public.reconciliation_imports (
    owner_user_id, owner_org_id, source, period_from, period_to, imported_by
  )
  values (v_user, v_org, v_source, v_from, v_to, p_actor)
  returning id into v_import_id;

  for v_line in select * from jsonb_array_elements(p_import -> 'lines') loop
    v_amount := (v_line ->> 'amountYer')::integer;
    v_on := coalesce((v_line ->> 'occurredOn')::date, v_from);
    v_ref := nullif(btrim(coalesce(v_line ->> 'externalRef', '')), '');
    v_intent := null;
    v_payout := null;

    if v_amount is null or v_amount <= 0 then
      raise exception 'VALIDATION_FAILED: every imported line needs a positive amount'
        using errcode = '22023';
    end if;

    -- Incoming money: one confirmed payment of exactly this amount, within three days, not yet matched.
    select i.id into v_intent
      from public.payment_intents i
     where i.status = 'confirmed'
       and i.amount_yer = v_amount
       and i.confirmed_at::date between v_on - 3 and v_on + 3
       and not exists (
         select 1 from public.reconciliation_lines rl
          where rl.intent_id = i.id
       )
       and (case when v_org is not null
                 then exists (select 1 from public.bookings b join public.trips t on t.id = b.trip_id
                               where b.id = i.booking_id and t.owner_org_id = v_org)
                 when v_user is not null
                 then exists (select 1 from public.bookings b join public.trips t on t.id = b.trip_id
                               where b.id = i.booking_id and t.owner_user_id = v_user)
                 else true end)
     order by abs((i.confirmed_at::date - v_on))
     limit 1;

    if v_intent is null then
      select p.id into v_payout
        from public.payouts p
       where p.status = 'paid'
         and p.amount_yer = v_amount
         and p.paid_at::date between v_on - 3 and v_on + 3
         and not exists (select 1 from public.reconciliation_lines rl where rl.payout_id = p.id)
         and (case when v_org is not null then p.owner_org_id = v_org
                   when v_user is not null then p.owner_user_id = v_user
                   else true end)
       order by abs((p.paid_at::date - v_on))
       limit 1;
    end if;

    insert into public.reconciliation_lines (
      import_id, external_ref, amount_yer, occurred_on, status, intent_id, payout_id, note,
      resolved_by, resolved_at
    )
    values (
      v_import_id, v_ref, v_amount, v_on,
      -- Explicit cast: a CASE yields text, and text does not assign to an enum implicitly. Without this the
      -- whole import failed with a 500 the first time a real statement was pasted in.
      (case when v_intent is not null or v_payout is not null then 'matched' else 'exception' end)
       ::public.reconciliation_status,
      v_intent, v_payout, nullif(btrim(coalesce(v_line ->> 'note', '')), ''),
      case when v_intent is not null or v_payout is not null then p_actor end,
      case when v_intent is not null or v_payout is not null then now() end
    );

    if v_intent is not null or v_payout is not null then
      v_matched := v_matched + 1;
    else
      v_exceptions := v_exceptions + 1;
    end if;
  end loop;

  update public.reconciliation_imports
     set lines_total = v_matched + v_exceptions, lines_matched = v_matched
   where id = v_import_id;

  perform app.write_audit(
    p_actor, 'reconciliation.import', 'reconciliation_import', v_import_id::text, null,
    jsonb_build_object('source', v_source, 'matched', v_matched, 'exceptions', v_exceptions),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'importId', v_import_id,
    'matched', v_matched,
    'exceptions', v_exceptions,
    'lines', (select jsonb_agg(to_jsonb(rl) order by rl.occurred_on)
                from public.reconciliation_lines rl where rl.import_id = v_import_id)
  );
end;
$$;

/**
 * Settles one exception by hand: match it to a payment or a payout, or dismiss it.
 *
 * A manual match is the one place where money is connected after the fact, so it is audited with the reason
 * and it cannot overwrite an existing match — an exception queue where rows can be re-matched is not a queue,
 * it is a suggestion box.
 */
create or replace function public.cmd_resolve_reconciliation_line(
  p_actor uuid,
  p_line_id uuid,
  p_resolution jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line public.reconciliation_lines;
  v_status public.reconciliation_status := coalesce(nullif(p_resolution ->> 'status', ''), 'matched')::public.reconciliation_status;
  v_note text := nullif(btrim(coalesce(p_resolution ->> 'note', '')), '');
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: only finance may settle a reconciliation line' using errcode = '42501';
  end if;
  if v_status not in ('matched', 'exception', 'ignored') then
    raise exception 'VALIDATION_FAILED: resolve as matched, exception or ignored' using errcode = '22023';
  end if;

  select * into v_line from public.reconciliation_lines where id = p_line_id for update;
  if not found then
    raise exception 'NOT_FOUND: reconciliation line' using errcode = 'P0002';
  end if;
  if v_line.status = 'matched' and v_status = 'matched' then
    raise exception 'CONFLICT: this line is already matched' using errcode = '23505';
  end if;
  if v_status = 'matched' then
    if app.safe_uuid(p_resolution ->> 'intentId') is null
       and app.safe_uuid(p_resolution ->> 'payoutId') is null then
      raise exception 'VALIDATION_FAILED: a match needs a payment or a payout' using errcode = '22023';
    end if;
    if app.safe_uuid(p_resolution ->> 'intentId') is not null
       and app.safe_uuid(p_resolution ->> 'payoutId') is not null then
      raise exception 'VALIDATION_FAILED: match to one thing, not two' using errcode = '22023';
    end if;
  end if;

  update public.reconciliation_lines
     set status = v_status,
         intent_id = case when v_status = 'matched' then app.safe_uuid(p_resolution ->> 'intentId') end,
         payout_id = case when v_status = 'matched' then app.safe_uuid(p_resolution ->> 'payoutId') end,
         note = coalesce(v_note, note),
         resolved_by = p_actor,
         resolved_at = now()
   where id = p_line_id
  returning * into v_line;

  perform app.write_audit(
    p_actor, 'reconciliation.resolve', 'reconciliation_line', p_line_id::text,
    jsonb_build_object('status', 'exception'), jsonb_build_object('status', v_status),
    v_note, p_request_id, p_ip
  );

  return jsonb_build_object('line', to_jsonb(v_line));
end;
$$;

-- ---------------------------------------------------------------------------
-- 19. The daily integrity job
-- ---------------------------------------------------------------------------

/**
 * Nine checks, one answer. Each returns a count of things that are wrong, and the job is green only when all of
 * them are zero.
 *
 * This is the test the acceptance criteria describe as "tampering with one amount turns it red": every check is
 * a real query over the real tables, so it cannot pass by being told to. It notifies finance when it goes red,
 * and it writes the result to the audit log so "was it green yesterday?" is answerable.
 */
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
    insert into public.notifications (user_id, kind, title_key, params, link)
    select distinct ur.user_id, 'finance_alert'::public.notification_kind, 'notifications.integrityAlert',
           jsonb_build_object('failed', v_failed), '/finance/dashboard'
      from public.user_roles ur
     where ur.role in ('finance_officer', 'platform_admin')
       and ur.revoked_at is null;
  end if;

  return jsonb_build_object('status', v_name, 'failed', v_failed, 'checks', v_checks, 'checkedAt', now());
end;
$$;

/** Drains the Phase 9 outbox into the ledger. Separate from the read so a cron can log both numbers. */
create or replace function public.cmd_consume_outbox(
  p_actor uuid default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := app.consume_payment_outbox(p_limit);

  perform app.write_audit(
    p_actor, 'finance.outbox_consume', 'payment_outbox', null, null, v_result, null, null, null
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 20. Reads: RLS on the finance graph
-- ---------------------------------------------------------------------------
-- Same shape as every other phase: SELECT is granted and filtered, everything else is already revoked by
-- 00003's default privileges, and the ledger's own triggers make an UPDATE or a DELETE impossible even for the
-- service role.

alter table public.ledger_accounts         enable row level security;
alter table public.journal_entries         enable row level security;
alter table public.ledger_entries          enable row level security;
alter table public.commission_rules        enable row level security;
alter table public.invoices                enable row level security;
alter table public.quota_overrides         enable row level security;
alter table public.quota_violations        enable row level security;
alter table public.usage_counters          enable row level security;
alter table public.subscriptions           enable row level security;
alter table public.subscription_events     enable row level security;
alter table public.finance_exports         enable row level security;
alter table public.reconciliation_imports  enable row level security;
alter table public.reconciliation_lines    enable row level security;

alter table public.ledger_accounts         force row level security;
alter table public.journal_entries         force row level security;
alter table public.ledger_entries          force row level security;
alter table public.commission_rules        force row level security;
alter table public.invoices                force row level security;
alter table public.quota_overrides         force row level security;
alter table public.quota_violations        force row level security;
alter table public.usage_counters          force row level security;
alter table public.subscriptions           force row level security;
alter table public.subscription_events     force row level security;
alter table public.finance_exports         force row level security;
alter table public.reconciliation_imports  force row level security;
alter table public.reconciliation_lines    force row level security;

/** One predicate for "this row is about an owner the caller speaks for". */
create or replace function app.can_read_owner(p_owner_user uuid, p_owner_org uuid, p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    app.is_finance(p_uid)
    or (p_owner_user is not null and p_owner_user = p_uid)
    or (p_owner_org is not null and app.is_org_member(p_owner_org, p_uid))
    -- A journal with no owner is a platform-level posting: none of an operator's business.
    or (p_owner_user is null and p_owner_org is null and app.is_platform_admin(p_uid));
$$;

-- The chart is reference data: names, no numbers. Any signed-in user may read it, because a statement that
-- prints "operator_payable" has to be explainable.
create policy ledger_accounts_read_authenticated on public.ledger_accounts
  for select to authenticated using (true);

create policy journal_entries_read_owner on public.journal_entries
  for select to authenticated
  using (app.can_read_owner(owner_user_id, owner_org_id));

create policy ledger_entries_read_owner on public.ledger_entries
  for select to authenticated
  using (exists (
    select 1 from public.journal_entries j
     where j.id = journal_id and app.can_read_owner(j.owner_user_id, j.owner_org_id)
  ));

-- Commission rates are what finance negotiates: an operator learns their own rate from their statement, not
-- from a table full of other operators' deals.
create policy commission_rules_read_finance on public.commission_rules
  for select to authenticated using (app.is_finance());

create policy invoices_read_owner on public.invoices
  for select to authenticated using (app.can_read_owner(owner_user_id, owner_org_id));

create policy subscriptions_read_owner on public.subscriptions
  for select to authenticated using (app.can_read_owner(owner_user_id, owner_org_id));

create policy subscription_events_read_owner on public.subscription_events
  for select to authenticated
  using (exists (
    select 1 from public.subscriptions s
     where s.id = subscription_id and app.can_read_owner(s.owner_user_id, s.owner_org_id)
  ));

-- An override is shown to the owner it belongs to: "you have 5 vehicles until 1 March because support granted
-- it" is a support answer, and hiding the row makes the invoice look wrong.
create policy quota_overrides_read_owner on public.quota_overrides
  for select to authenticated using (app.can_read_owner(owner_user_id, owner_org_id));

create policy usage_counters_read_owner on public.usage_counters
  for select to authenticated using (app.can_read_owner(owner_user_id, owner_org_id));

create policy quota_violations_read_finance on public.quota_violations
  for select to authenticated using (app.is_finance());

create policy finance_exports_read_owner on public.finance_exports
  for select to authenticated using (app.can_read_owner(owner_user_id, owner_org_id));

create policy reconciliation_imports_read_finance on public.reconciliation_imports
  for select to authenticated using (app.is_finance());

create policy reconciliation_lines_read_finance on public.reconciliation_lines
  for select to authenticated using (app.is_finance());

grant select on public.ledger_accounts        to authenticated;
grant select on public.journal_entries        to authenticated;
grant select on public.ledger_entries         to authenticated;
grant select on public.commission_rules       to authenticated;
grant select on public.invoices               to authenticated;
grant select on public.quota_overrides        to authenticated;
grant select on public.quota_violations       to authenticated;
grant select on public.usage_counters         to authenticated;
grant select on public.subscriptions          to authenticated;
grant select on public.subscription_events    to authenticated;
grant select on public.finance_exports        to authenticated;
grant select on public.reconciliation_imports to authenticated;
grant select on public.reconciliation_lines   to authenticated;

-- A signed-in user may ask about their own quota and nothing else. The wrapper takes no owner argument for
-- the same reason `my_available_payout_yer` takes none.
create or replace function public.my_quota_state(p_metric text, p_org_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.uid();
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing session' using errcode = '28000';
  end if;
  if p_org_id is not null then
    if not app.is_org_member(p_org_id, v_uid) then
      raise exception 'FORBIDDEN: not a member of this organization' using errcode = '42501';
    end if;
    return app.quota_state(null, p_org_id, p_metric);
  end if;
  return app.quota_state(v_uid, null, p_metric);
end;
$$;

revoke all on function public.my_quota_state(text, uuid) from public, anon;
grant execute on function public.my_quota_state(text, uuid) to authenticated, service_role;

-- Policies execute as the querying role, so the predicate itself must be callable by one. It is the only app
-- helper a signed-in user may run, and it answers a boolean about rows they are already being shown.
revoke all on function app.can_read_owner(uuid, uuid, uuid) from public, anon;
grant execute on function app.can_read_owner(uuid, uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 21. Execute grants: writes are service-only
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.cmd_start_subscription(uuid, jsonb, text, inet)',
    'public.cmd_change_plan(uuid, uuid, public.plan_code, text, text, inet)',
    'public.cmd_cancel_subscription(uuid, uuid, boolean, text, text, inet)',
    'public.cmd_pay_invoice(uuid, uuid, text, text, inet)',
    'public.cmd_void_invoice(uuid, uuid, text, text, inet)',
    'public.cmd_renew_subscriptions(uuid, integer)',
    'public.cmd_expire_subscriptions(uuid, integer)',
    'public.cmd_snapshot_usage(uuid)',
    'public.cmd_update_plan(uuid, jsonb, text, inet)',
    'public.cmd_upsert_commission_rule(uuid, jsonb, text, inet)',
    'public.cmd_grant_quota_override(uuid, jsonb, text, inet)',
    'public.cmd_revoke_quota_override(uuid, uuid, text, text, inet)',
    'public.cmd_post_manual_journal(uuid, jsonb, text, inet)',
    'public.cmd_reverse_journal(uuid, uuid, text, text, inet)',
    'public.cmd_record_expense(uuid, jsonb, text, inet)',
    'public.cmd_void_expense(uuid, uuid, text, text, inet)',
    'public.cmd_import_reconciliation(uuid, jsonb, text, inet)',
    'public.cmd_resolve_reconciliation_line(uuid, uuid, jsonb, text, inet)',
    'public.cmd_get_finance_dashboard(uuid, jsonb)',
    'public.cmd_get_statement(uuid, jsonb, date, date)',
    'public.cmd_export_finance(uuid, jsonb, text, inet)',
    'public.cmd_run_integrity_check(uuid, text, inet)',
    'public.cmd_consume_outbox(uuid, integer)',
    'app.post_journal(public.journal_source_kind, text, uuid, date, text, jsonb, uuid, uuid, uuid, uuid, text)',
    'app.consume_payment_outbox(integer)',
    'app.issue_booking_invoice(uuid, uuid, uuid)',
    'app.issue_subscription_invoice(uuid, date, uuid)',
    'app.owner_ledger_balance_yer(uuid, uuid)',
    'app.ledger_totals(uuid, uuid, date, date)',
    'app.commission_yer(uuid, uuid, integer, date)',
    'app.commission_basis_points(uuid, uuid, date)',
    'app.quota_state(uuid, uuid, text)',
    'app.quota_usage(uuid, uuid, text)',
    'app.assert_quota(uuid, uuid, text, integer)',
    'app.subscription_event(uuid, public.subscription_event_kind, public.plan_code, public.plan_code, integer, uuid, uuid, text, uuid)',
    'app.new_finance_code(text)',
    'app.owner_effective_plan(uuid)',
    'app.org_effective_plan(uuid)',
    'app.owner_plan(uuid, uuid)',
    'app.can_manage_billing(uuid, uuid, uuid)',
    'app.billing_period_interval()',
    'app.billing_due_days()',
    'app.billing_dunning_days()'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

comment on table public.journal_entries is
  'The double-entry ledger. Append-only: corrections are reversing journals that name the original.';
comment on table public.invoices is
  'What a passenger (booking) or an operator (subscription) was billed, frozen at issue time.';
comment on table public.subscriptions is
  'One live subscription per owner. Expiry falls back to Basic; nothing the operator built is deleted.';
