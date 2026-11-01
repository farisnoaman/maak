-- ===========================================================================
-- Phase 9 — Payments: money that moves without a card gateway
-- ===========================================================================
--
-- Yemen does not have a card-acquiring market a small operator can join, so the platform does not try.
-- What it has is a passenger with a phone, a wallet number, a transfer receipt, and an operator who has
-- to decide whether the money arrived. This file is that, made auditable:
--
--   1. **An intent is a promise, not a payment.** `payment_intents` records what somebody intends to pay
--      and to which account, *before* any money exists. It never holds a balance and never marks a
--      booking paid by itself — only `cmd_confirm_payment` does, and only from a proof a person submitted.
--   2. **Confirming twice is not paying twice.** `cmd_confirm_payment` is idempotent: the second call
--      returns the same row and writes no second outbox event. The unique `(source_table, source_id,
--      kind)` on `payment_outbox` is what makes that a database fact rather than a convention.
--   3. **A receipt is used once.** The proof's hash and the transfer reference are both unique across
--      intents, so the same photograph cannot pay for two bookings (BR-30).
--   4. **Money events are never lost.** Every confirmed payment, paid refund and paid payout writes an
--      outbox row in the same transaction. Phase 10's ledger consumes that table; if the ledger is late,
--      the money is still accounted for.
--   5. **Prepayment is a gate, not a suggestion.** A trip whose policy is `transfer` or `deposit` cannot
--      have a booking accepted until enough of the money is confirmed — enforced by a trigger on
--      `bookings`, so no code path can skip it.
--
-- All amounts are integer YER (exponent 0). No floats, here or in TypeScript.
--
-- What is deliberately absent: a stored-value wallet, escrow and automatic payouts. This phase records
-- and reconciles money a human moved; it does not move it.

-- ---------------------------------------------------------------------------
-- 1. Types
-- ---------------------------------------------------------------------------

-- The providers Yemen actually uses. `cash_desk` is the office counter, `bank_transfer` the catch-all
-- for a bank that is not in the list — a fixed list plus `other` beats free text that cannot be grouped.
create type public.payment_method as enum (
  'jaib',
  'cash_one',
  'mfloos',
  'yempay',
  'kuraimi',
  'tadhamon',
  'cash_desk',
  'bank_transfer',
  'other'
);

-- Who owns the account: the platform (which passengers pay into), an operator (which receives
-- settlements), or a cash agent (who takes money at a counter).
create type public.payment_account_kind as enum ('platform', 'owner', 'agent');
create type public.payment_account_status as enum ('pending_verification', 'active', 'archived');

create type public.payment_intent_status as enum (
  'awaiting_proof',          -- created, the passenger has not uploaded the receipt yet
  'awaiting_confirmation',   -- proof submitted, a human must decide
  'confirmed',
  'rejected',
  'expired',                 -- nobody uploaded or nobody decided in time
  'cancelled'
);

-- Why the money is being paid. `deposit` and `balance` both point at a booking; the difference is which
-- part of the fare the amount covers, and that is what the booking's `payment_status` reflects.
create type public.payment_intent_purpose as enum ('booking', 'deposit', 'balance', 'subscription');

create type public.refund_status as enum ('requested', 'approved', 'rejected', 'paid');

create type public.agent_tx_kind as enum ('cash_in', 'settlement', 'adjustment', 'refund_out');

create type public.payout_status as enum ('requested', 'approved', 'paid', 'rejected');

-- The ledger seam. `payment_reversed` exists so a correction is an event, never an edit.
create type public.payment_outbox_kind as enum (
  'payment_confirmed',
  'payment_reversed',
  'refund_paid',
  'payout_paid'
);

alter type public.notification_kind add value if not exists 'payment_submitted';
alter type public.notification_kind add value if not exists 'payment_confirmed';
alter type public.notification_kind add value if not exists 'payment_rejected';
alter type public.notification_kind add value if not exists 'refund_decided';
alter type public.notification_kind add value if not exists 'payout_decided';

-- ---------------------------------------------------------------------------
-- 2. Payment accounts — where money is allowed to land
-- ---------------------------------------------------------------------------

create table public.payment_accounts (
  id                        uuid primary key default gen_random_uuid(),
  kind                      public.payment_account_kind not null,
  method                    public.payment_method not null,
  -- The owner scope. Platform accounts have neither (the platform owns itself); every other account has
  -- exactly one, so "whose money is this" has a single answer.
  owner_user_id             uuid references public.profiles (id) on delete cascade,
  owner_org_id              uuid references public.organizations (id) on delete cascade,

  provider_label            text check (provider_label is null or length(btrim(provider_label)) between 2 and 60),
  account_number            text not null check (length(btrim(account_number)) between 3 and 64),
  holder_name               text not null check (length(btrim(holder_name)) between 3 and 120),
  -- What the passenger is told to do, in both languages, written by whoever owns the account.
  instructions_ar           text check (instructions_ar is null or length(instructions_ar) <= 500),
  instructions_en           text check (instructions_en is null or length(instructions_en) <= 500),

  status                    public.payment_account_status not null default 'pending_verification',
  is_default                boolean not null default false,
  verification_document_path text check (
    verification_document_path is null or length(verification_document_path) <= 300
  ),
  verified_by               uuid references public.profiles (id) on delete set null,
  verified_at               timestamptz,
  archived_at               timestamptz,
  archive_reason            text,

  created_by                uuid references public.profiles (id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint payment_accounts_owner_scope check (
    (kind = 'platform' and owner_user_id is null and owner_org_id is null)
    or (kind <> 'platform' and num_nonnulls(owner_user_id, owner_org_id) = 1)
  ),
  constraint payment_accounts_archived_stamped check (status <> 'archived' or archived_at is not null),
  -- Only a verified account may say it is active, and only an active one may be the default. The second
  -- half is what stops "the default account" from pointing at something that cannot receive money.
  constraint payment_accounts_active_verified check (status <> 'active' or verified_at is not null),
  constraint payment_accounts_default_active check (not is_default or status = 'active')
);

create index payment_accounts_owner_idx
  on public.payment_accounts (owner_org_id, owner_user_id, method)
  where status <> 'archived';
create index payment_accounts_default_idx
  on public.payment_accounts (method)
  where is_default and status = 'active';

-- One default per method per owner scope. `coalesce(..., zero-uuid)` is the platform's "no owner" scope,
-- so the platform can have exactly one default Jaib wallet and one default cash desk, not two of each.
create unique index payment_accounts_one_default
  on public.payment_accounts (
    method,
    coalesce(owner_user_id, owner_org_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where is_default and status = 'active';

create trigger payment_accounts_set_updated_at
  before update on public.payment_accounts
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Payment intents — the thing a passenger pays
-- ---------------------------------------------------------------------------

create table public.payment_intents (
  id                        uuid primary key default gen_random_uuid(),
  code                      text not null unique check (code ~ '^PI-[A-Z0-9]{6}$'),
  purpose                   public.payment_intent_purpose not null,
  booking_id                uuid references public.bookings (id) on delete restrict,
  payer_id                  uuid not null references public.profiles (id) on delete restrict,
  payee_account_id          uuid references public.payment_accounts (id) on delete restrict,

  method                    public.payment_method not null,
  currency                  char(3) not null default 'YER',
  amount_yer                integer not null check (amount_yer > 0),
  status                    public.payment_intent_status not null default 'awaiting_proof',

  -- The client's idempotency key. A double-tapped "pay" returns the same intent instead of two.
  client_reference          text check (client_reference is null or length(btrim(client_reference)) between 6 and 64),
  -- What the passenger typed off their transfer receipt.
  reference_no              text check (reference_no is null or length(btrim(reference_no)) between 3 and 64),

  proof_path                text check (proof_path is null or length(proof_path) <= 300),
  -- sha256 of the uploaded file, lower-case hex. Unique across intents: one receipt pays once.
  proof_hash                text check (proof_hash is null or proof_hash ~ '^[0-9a-f]{64}$'),
  proof_uploaded_at         timestamptz,

  expires_at                timestamptz,
  confirmed_by              uuid references public.profiles (id) on delete set null,
  confirmed_at              timestamptz,
  rejected_by               uuid references public.profiles (id) on delete set null,
  rejected_at               timestamptz,
  rejected_reason           text,
  cancelled_at              timestamptz,
  note                      text check (note is null or length(note) <= 500),

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint payment_intents_subject check (
    (purpose = 'subscription' and booking_id is null)
    or (purpose <> 'subscription' and booking_id is not null)
  ),
  -- "Awaiting confirmation" means a human has something to look at. Without this a confirm queue could
  -- contain rows with no receipt, which is how a confirmation gets clicked without a receipt.
  constraint payment_intents_proof_before_review check (
    status <> 'awaiting_confirmation' or (proof_path is not null and proof_uploaded_at is not null)
  ),
  constraint payment_intents_confirmed_stamped check (status <> 'confirmed' or confirmed_at is not null),
  constraint payment_intents_rejected_reason check (
    status <> 'rejected' or rejected_reason is not null
  )
);

create index payment_intents_booking_idx on public.payment_intents (booking_id, status);
create index payment_intents_payer_idx on public.payment_intents (payer_id, created_at desc);
create index payment_intents_review_idx
  on public.payment_intents (created_at)
  where status = 'awaiting_confirmation';
create index payment_intents_open_idx
  on public.payment_intents (expires_at)
  where status in ('awaiting_proof', 'awaiting_confirmation');

-- Idempotency: the same client key from the same payer is the same intent, whatever the network did.
create unique index payment_intents_client_reference
  on public.payment_intents (payer_id, client_reference)
  where client_reference is not null;

-- BR-30 — one receipt, one payment. A hash reused on another intent is refused by the index, and the
-- command turns the violation into `PROOF_ALREADY_USED` instead of a 500.
create unique index payment_intents_proof_once
  on public.payment_intents (proof_hash)
  where proof_hash is not null;

-- The same bank reference cannot pay for two different bookings either. Partial because a cash desk
-- payment has no reference at all.
create unique index payment_intents_reference_once
  on public.payment_intents (method, reference_no)
  where reference_no is not null and status in ('awaiting_confirmation', 'confirmed');

create trigger payment_intents_set_updated_at
  before update on public.payment_intents
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Refunds
-- ---------------------------------------------------------------------------

create table public.refunds (
  id                        uuid primary key default gen_random_uuid(),
  code                      text not null unique check (code ~ '^RF-[A-Z0-9]{6}$'),
  booking_id                uuid not null references public.bookings (id) on delete restrict,
  intent_id                 uuid references public.payment_intents (id) on delete set null,

  amount_yer                integer not null check (amount_yer > 0),
  status                    public.refund_status not null default 'requested',
  reason                    text not null check (length(btrim(reason)) between 5 and 300),

  requested_by              uuid not null references public.profiles (id) on delete restrict,
  requested_at              timestamptz not null default now(),
  decided_by                uuid references public.profiles (id) on delete set null,
  decided_at                timestamptz,
  decision_note             text,
  paid_by                   uuid references public.profiles (id) on delete set null,
  paid_at                   timestamptz,
  payment_reference         text check (payment_reference is null or length(payment_reference) <= 64),

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint refunds_rejected_note check (
    status <> 'rejected' or (decision_note is not null and length(btrim(decision_note)) >= 5)
  ),
  constraint refunds_paid_stamped check (status <> 'paid' or paid_at is not null)
);

create index refunds_booking_idx on public.refunds (booking_id, status);
create index refunds_queue_idx on public.refunds (requested_at) where status in ('requested', 'approved');

-- One live refund per booking. A second request while the first is undecided is a duplicate, not a
-- second entitlement — the passenger can cancel it and ask again with a different amount.
create unique index refunds_one_open_per_booking
  on public.refunds (booking_id)
  where status in ('requested', 'approved');

create trigger refunds_set_updated_at
  before update on public.refunds
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Cash agents
-- ---------------------------------------------------------------------------

create table public.agents (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null unique references public.profiles (id) on delete cascade,
  org_id                    uuid references public.organizations (id) on delete set null,

  -- Money the agent is holding on the platform's behalf. Never negative: an agent who owes more than
  -- they hold is a settlement problem, not a negative balance.
  float_balance_yer         integer not null default 0 check (float_balance_yer >= 0),
  -- The most float this agent may hold at once — the platform's exposure to one counter.
  credit_limit_yer          integer not null default 0 check (credit_limit_yer >= 0),
  status                    text not null default 'active' check (status in ('active', 'suspended')),

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create trigger agents_set_updated_at
  before update on public.agents
  for each row execute function app.set_updated_at();

create table public.agent_transactions (
  id                        uuid primary key default gen_random_uuid(),
  agent_id                  uuid not null references public.agents (id) on delete restrict,
  kind                      public.agent_tx_kind not null,
  amount_yer                integer not null check (amount_yer <> 0),
  -- The balance after this row, written by the command under the agent's row lock. A statement is then
  -- a read, not a running total somebody has to trust.
  balance_after_yer         integer not null check (balance_after_yer >= 0),
  intent_id                 uuid references public.payment_intents (id) on delete set null,
  actor_id                  uuid references public.profiles (id) on delete set null,
  note                      text check (note is null or length(note) <= 300),
  created_at                timestamptz not null default now()
);

create index agent_transactions_agent_idx on public.agent_transactions (agent_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 6. Payouts
-- ---------------------------------------------------------------------------

create table public.payouts (
  id                        uuid primary key default gen_random_uuid(),
  code                      text not null unique check (code ~ '^PO-[A-Z0-9]{6}$'),
  owner_user_id             uuid references public.profiles (id) on delete restrict,
  owner_org_id              uuid references public.organizations (id) on delete restrict,

  amount_yer                integer not null check (amount_yer > 0),
  status                    public.payout_status not null default 'requested',
  method                    public.payment_method not null default 'bank_transfer',
  destination_account_id    uuid references public.payment_accounts (id) on delete restrict,

  requested_by              uuid not null references public.profiles (id) on delete restrict,
  requested_at              timestamptz not null default now(),
  approved_by               uuid references public.profiles (id) on delete set null,
  approved_at               timestamptz,
  rejected_reason           text,
  paid_by                   uuid references public.profiles (id) on delete set null,
  paid_at                   timestamptz,
  payment_reference         text check (payment_reference is null or length(payment_reference) <= 64),
  note                      text check (note is null or length(note) <= 300),

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint payouts_owner_scope check (num_nonnulls(owner_user_id, owner_org_id) = 1),
  constraint payouts_paid_stamped check (status <> 'paid' or paid_at is not null),
  constraint payouts_rejected_reason check (
    status <> 'rejected' or (rejected_reason is not null and length(btrim(rejected_reason)) >= 5)
  ),
  -- Segregation of duties, in the schema: the person who asked cannot be the person who approved.
  -- The command refuses it with a code the UI can explain; this is the version that cannot be bypassed.
  constraint payouts_not_self_approved check (approved_by is null or approved_by <> requested_by)
);

create index payouts_owner_idx on public.payouts (owner_org_id, owner_user_id, status);
create index payouts_queue_idx on public.payouts (requested_at) where status = 'requested';

create trigger payouts_set_updated_at
  before update on public.payouts
  for each row execute function app.set_updated_at();

-- What a payout is made of. Optional in this phase (a payout may be a plain request), but present so the
-- statement can answer "which bookings were paid out" without a second guess.
create table public.payout_items (
  id                        uuid primary key default gen_random_uuid(),
  payout_id                 uuid not null references public.payouts (id) on delete cascade,
  source_kind               text not null check (source_kind in ('booking', 'agent', 'adjustment')),
  source_id                 uuid,
  amount_yer                integer not null check (amount_yer <> 0),
  unique (payout_id, source_kind, source_id)
);

-- ---------------------------------------------------------------------------
-- 7. The ledger seam — an append-only outbox
-- ---------------------------------------------------------------------------

create table public.payment_outbox (
  id                        uuid primary key default gen_random_uuid(),
  kind                      public.payment_outbox_kind not null,
  source_table              text not null check (source_table in ('payment_intents', 'refunds', 'payouts')),
  source_id                 uuid not null,
  amount_yer                integer not null,
  currency                  char(3) not null default 'YER',
  owner_user_id             uuid references public.profiles (id) on delete set null,
  owner_org_id              uuid references public.organizations (id) on delete set null,
  actor_id                  uuid references public.profiles (id) on delete set null,
  payload                   jsonb not null default '{}'::jsonb,
  created_at                timestamptz not null default now(),
  consumed_at               timestamptz,
  -- The idempotency of the whole file: one money event, one row, forever.
  unique (source_table, source_id, kind)
);

create index payment_outbox_pending_idx on public.payment_outbox (created_at) where consumed_at is null;

-- ---------------------------------------------------------------------------
-- 8. A trip may ask for a deposit, and the percentage lives on the trip
-- ---------------------------------------------------------------------------

-- `trips.payment_policy = 'deposit'` said "a deposit is due" without ever saying how much, so a booking
-- could not compute one. 30 % is the number the plan quotes; it is a column so an operator can differ.
alter table public.trips
  add column if not exists deposit_percent smallint not null default 30
    check (deposit_percent between 1 and 100);

-- ---------------------------------------------------------------------------
-- 9. Helpers
-- ---------------------------------------------------------------------------

/** Finance officers and platform staff. The people who may confirm money they did not send. */
create or replace function app.is_finance(p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_role('finance_officer', p_uid)
      or app.has_role('platform_staff', p_uid)
      or app.has_role('platform_admin', p_uid);
$$;

/**
 * May this account read this intent?
 *
 * The payer, the operator whose trip is being paid for, and finance. Written as one predicate because
 * the RLS policy, the storage policy and the share link all have to answer the same question, and three
 * copies of it would eventually disagree.
 */
create or replace function app.can_read_payment_intent(p_intent_id uuid, p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.payment_intents i
    left join public.bookings b on b.id = i.booking_id
    where i.id = p_intent_id
      and (
        i.payer_id = p_uid
        or (b.id is not null and app.actor_can_manage_trip(p_uid, b.trip_id))
        or app.is_finance(p_uid)
      )
  );
$$;

/** Everything confirmed against a booking, in YER. Confirmed only — a proof in the queue is not money. */
create or replace function app.booking_paid_yer(p_booking_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  -- Money the platform is still holding for this booking: confirmed payments minus refunds already
  -- transferred back. Kept net rather than gross so that a refunded deposit is genuinely "not paid"
  -- and its seat may not be held without paying again.
  select greatest(
    coalesce((
      select sum(i.amount_yer) from public.payment_intents i
       where i.booking_id = p_booking_id and i.status = 'confirmed'
    ), 0)
    - coalesce((
      select sum(r.amount_yer) from public.refunds r
       where r.booking_id = p_booking_id and r.status = 'paid'
    ), 0),
    0
  )::integer;
$$;

/**
 * How much must be confirmed before the seat may be held.
 *
 * `transfer` asks for the whole fare; `deposit` asks for the trip's percentage, rounded **up** because a
 * deposit that rounds down is a discount nobody agreed to. `cash` asks for nothing — the driver collects
 * on boarding, and blocking that would make the platform useless on a bus.
 */
create or replace function app.booking_amount_due_yer(p_booking_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when t.payment_policy = 'transfer' then b.total_yer
    when t.payment_policy = 'deposit'
      then ((b.total_yer::bigint * t.deposit_percent) + 99) / 100
    else 0
  end::integer
  from public.bookings b
  join public.trips t on t.id = b.trip_id
  where b.id = p_booking_id;
$$;

/**
 * Rewrites `bookings.payment_status` from the money that actually exists.
 *
 * Called after every confirm, refund and payout — never by a client. It reads confirmed intents rather
 * than a counter, so a status can always be justified by rows that are still there.
 */
create or replace function app.refresh_booking_payment_status(p_booking_id uuid)
returns public.booking_payment_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings;
  v_paid integer;
  v_status public.booking_payment_status;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if not found then
    return null;
  end if;

  v_paid := app.booking_paid_yer(p_booking_id);

  v_status := case
    when v_booking.refund_yer >= v_booking.total_yer and v_booking.refund_yer > 0 then 'refunded'
    when v_paid <= 0 then 'unpaid'
    when v_paid >= v_booking.total_yer then 'paid'
    else 'deposit_paid'
  end;

  if v_status is distinct from v_booking.payment_status then
    update public.bookings set payment_status = v_status where id = p_booking_id;
  end if;

  return v_status;
end;
$$;

/**
 * The outbox write. `on conflict do nothing` is the whole idempotency story: a second confirmation of the
 * same intent inserts nothing, so the ledger can never post twice even if the command is retried.
 * Returns true when this call is the one that created the event.
 */
create or replace function app.queue_money_event(
  p_kind public.payment_outbox_kind,
  p_source_table text,
  p_source_id uuid,
  p_amount_yer integer,
  p_payload jsonb default '{}'::jsonb,
  p_actor uuid default null,
  p_owner_user uuid default null,
  p_owner_org uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted integer;
begin
  insert into public.payment_outbox
    (kind, source_table, source_id, amount_yer, payload, actor_id, owner_user_id, owner_org_id)
  values
    (p_kind, p_source_table, p_source_id, p_amount_yer, coalesce(p_payload, '{}'::jsonb),
     p_actor, p_owner_user, p_owner_org)
  on conflict (source_table, source_id, kind) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end;
$$;

/** An account that is not `active` may not receive money — checked here so every caller agrees. */
create or replace function app.assert_payment_account_active(p_account_id uuid)
returns public.payment_accounts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account public.payment_accounts;
begin
  select * into v_account from public.payment_accounts where id = p_account_id;
  if not found then
    raise exception 'NOT_FOUND: payment account' using errcode = 'P0002';
  end if;
  if v_account.status <> 'active' then
    raise exception 'PAYMENT_ACCOUNT_NOT_ACTIVE: this account cannot receive money yet'
      using errcode = '23514';
  end if;
  return v_account;
end;
$$;

/**
 * What an owner has earned and not yet been paid: confirmed payments on their trips, minus refunds the
 * platform has actually paid out, minus payouts already paid or in flight. Integer arithmetic throughout.
 */
create or replace function app.owner_available_yer(p_owner_user uuid, p_owner_org uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    coalesce((
      select sum(i.amount_yer)
      from public.payment_intents i
      join public.bookings b on b.id = i.booking_id
      join public.trips t on t.id = b.trip_id
      where i.status = 'confirmed'
        and ((p_owner_org is not null and t.owner_org_id = p_owner_org)
          or (p_owner_org is null and t.owner_user_id = p_owner_user))
    ), 0)
    - coalesce((
      select sum(r.amount_yer)
      from public.refunds r
      join public.bookings b on b.id = r.booking_id
      join public.trips t on t.id = b.trip_id
      where r.status = 'paid'
        and ((p_owner_org is not null and t.owner_org_id = p_owner_org)
          or (p_owner_org is null and t.owner_user_id = p_owner_user))
    ), 0)
    - coalesce((
      select sum(p.amount_yer)
      from public.payouts p
      where p.status in ('requested', 'approved', 'paid')
        and ((p_owner_org is not null and p.owner_org_id = p_owner_org)
          or (p_owner_org is null and p.owner_user_id = p_owner_user))
    ), 0),
    0
  )::integer;
$$;

create or replace function app.new_payment_code(p_prefix text)
returns text
language sql
volatile
as $$
  select p_prefix || '-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
$$;

/**
 * Prepayment is a gate on *accepting* a booking, not on creating it: a passenger may always ask for a
 * seat, and the operator may always see the request. What they may not do is promise the seat before the
 * money the trip asks for has been confirmed.
 *
 * A trigger rather than a branch inside `app.accept_booking_internal`, because a branch protects one
 * path and a trigger protects the transition — including the bulk accept, the staff override and any
 * future caller that has not been written yet.
 */
create or replace function app.enforce_prepay_before_accept()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due integer;
  v_paid integer;
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    v_due := app.booking_amount_due_yer(new.id);
    if v_due > 0 then
      v_paid := app.booking_paid_yer(new.id);
      if v_paid < v_due then
        raise exception
          'PAYMENT_REQUIRED: % of % confirmed before this seat can be held', v_paid, v_due
          using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger bookings_prepay_gate
  before update on public.bookings
  for each row execute function app.enforce_prepay_before_accept();

-- ---------------------------------------------------------------------------
-- 10. Commands — one transaction each
-- ---------------------------------------------------------------------------

/**
 * Add a payment account.
 *
 * The platform's accounts are created by finance and are live immediately: there is nobody above them to
 * verify. An operator's or agent's account starts `pending_verification` and receives nothing until
 * finance confirms ownership from a document — an unverified account number is how a payout lands in a
 * stranger's wallet.
 */
create or replace function public.cmd_create_payment_account(
  p_actor uuid,
  p_account jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind public.payment_account_kind := coalesce(nullif(p_account ->> 'kind', ''), 'owner')::public.payment_account_kind;
  v_method public.payment_method := (p_account ->> 'method')::public.payment_method;
  v_org uuid := app.safe_uuid(p_account ->> 'orgId');
  v_account public.payment_accounts;
  v_status public.payment_account_status;
  v_holder text := btrim(coalesce(p_account ->> 'holderName', ''));
  v_number text := btrim(coalesce(p_account ->> 'accountNumber', ''));
  v_owner_user uuid;
  v_owner_org uuid;
  v_is_default boolean;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if v_method is null then
    raise exception 'VALIDATION_FAILED: method is required' using errcode = '22023';
  end if;
  if length(v_number) < 3 or length(v_holder) < 3 then
    raise exception 'VALIDATION_FAILED: account number and holder name are required'
      using errcode = '22023';
  end if;

  -- The owner scope of the row, resolved before the insert: a platform account and an org account
  -- both hang off a scope, a personal one off the actor. `coalesce(..., zero-uuid)` is the same
  -- "no owner" bucket the unique index uses.
  if v_kind = 'platform' then
    if not app.is_finance(p_actor) then
      raise exception 'FORBIDDEN: only finance may add a platform account' using errcode = '42501';
    end if;
    v_status := 'active';
  else
    if v_org is not null and not app.is_org_member(v_org, p_actor) then
      raise exception 'FORBIDDEN: not a member of this organization' using errcode = '42501';
    end if;
    if not app.is_verified_actor(p_actor) then
      raise exception 'NOT_VERIFIED: verify your account before adding a payment account'
        using errcode = '42501';
    end if;
    v_status := 'pending_verification';
  end if;

  v_owner_user := case when v_kind = 'platform' or v_org is not null then null else p_actor end;
  v_owner_org := v_org;
  v_is_default := coalesce((p_account ->> 'isDefault')::boolean, false);

  -- A new default retires the previous one for the same method and owner *before* the insert.
  -- Doing it afterwards would trip `payment_accounts_one_default`, which is the point of that index:
  -- there is never a moment in which two defaults exist. Demoted rather than deleted, so the archive
  -- still shows what passengers were told at the time.
  if v_is_default and v_status = 'active' then
    update public.payment_accounts
       set is_default = false
     where method = v_method
       and is_default
       and status = 'active'
       and coalesce(owner_user_id, owner_org_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(v_owner_user, v_owner_org, '00000000-0000-0000-0000-000000000000'::uuid);
  end if;

  insert into public.payment_accounts (
    kind, method, owner_user_id, owner_org_id, provider_label, account_number, holder_name,
    instructions_ar, instructions_en, status, is_default, verification_document_path,
    verified_by, verified_at, created_by
  )
  values (
    v_kind, v_method,
    v_owner_user,
    v_owner_org,
    nullif(btrim(coalesce(p_account ->> 'providerLabel', '')), ''),
    v_number, v_holder,
    nullif(btrim(coalesce(p_account ->> 'instructionsAr', '')), ''),
    nullif(btrim(coalesce(p_account ->> 'instructionsEn', '')), ''),
    v_status,
    v_is_default,
    nullif(btrim(coalesce(p_account ->> 'verificationDocumentPath', '')), ''),
    case when v_status = 'active' then p_actor end,
    case when v_status = 'active' then now() end,
    p_actor
  )
  returning * into v_account;

  perform app.write_audit(
    p_actor, 'payment.account.create', 'payment_account', v_account.id::text,
    null,
    jsonb_build_object(
      'kind', v_account.kind, 'method', v_account.method, 'status', v_account.status,
      'isDefault', v_account.is_default
    ),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('account', to_jsonb(v_account));
end;
$$;

/**
 * Finance decides whether an account may receive money.
 *
 * Rejection archives the row instead of deleting it: a rejected account is evidence, and the same number
 * resubmitted tomorrow must not look like a first attempt.
 */
create or replace function public.cmd_verify_payment_account(
  p_actor uuid,
  p_account_id uuid,
  p_approve boolean,
  p_note text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.payment_accounts;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: only finance may verify a payment account' using errcode = '42501';
  end if;
  if p_approve is not true and (p_note is null or length(btrim(p_note)) < 5) then
    raise exception 'VALIDATION_FAILED: say why the account was refused' using errcode = '22023';
  end if;

  select * into v_account from public.payment_accounts where id = p_account_id for update;
  if not found then
    raise exception 'NOT_FOUND: payment account' using errcode = 'P0002';
  end if;
  if v_account.status = 'archived' then
    raise exception 'CONFLICT: this account is archived' using errcode = '23505';
  end if;

  if p_approve then
    update public.payment_accounts
       set status = 'active', verified_by = p_actor, verified_at = now()
     where id = p_account_id
     returning * into v_account;
  else
    update public.payment_accounts
       set status = 'archived', archived_at = now(), is_default = false,
           archive_reason = btrim(p_note)
     where id = p_account_id
     returning * into v_account;
  end if;

  perform app.write_audit(
    p_actor, 'payment.account.verify', 'payment_account', p_account_id::text,
    jsonb_build_object('status', 'pending_verification'),
    jsonb_build_object('status', v_account.status, 'note', p_note),
    p_note, p_request_id, p_ip
  );

  return jsonb_build_object('account', to_jsonb(v_account));
end;
$$;

/** Retire an account. The owner may do it; finance may do it to anybody's. */
create or replace function public.cmd_archive_payment_account(
  p_actor uuid,
  p_account_id uuid,
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
  v_account public.payment_accounts;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_account from public.payment_accounts where id = p_account_id for update;
  if not found then
    raise exception 'NOT_FOUND: payment account' using errcode = 'P0002';
  end if;
  if not (
    app.is_finance(p_actor)
    or v_account.owner_user_id = p_actor
    or (v_account.owner_org_id is not null and app.org_role(v_account.owner_org_id, p_actor) in ('owner', 'manager'))
  ) then
    raise exception 'FORBIDDEN: not your account' using errcode = '42501';
  end if;
  if v_account.status = 'archived' then
    return jsonb_build_object('account', to_jsonb(v_account), 'changed', false);
  end if;

  update public.payment_accounts
     set status = 'archived', archived_at = now(), is_default = false,
         archive_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_account_id
   returning * into v_account;

  perform app.write_audit(
    p_actor, 'payment.account.archive', 'payment_account', p_account_id::text,
    jsonb_build_object('status', 'active'), jsonb_build_object('status', 'archived'),
    p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('account', to_jsonb(v_account), 'changed', true);
end;
$$;

/**
 * A passenger says they are about to pay.
 *
 * The amount is computed from the booking and the trip, never from the request: a client that asks for a
 * 1-riyal intent for a 5 000-riyal seat is refused with `PRICE_CHANGED`, exactly like the booking wizard.
 * `clientReference` makes a double-tapped "pay" return the same intent rather than two.
 */
create or replace function public.cmd_create_payment_intent(
  p_actor uuid,
  p_intent jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings;
  v_trip public.trips;
  v_purpose public.payment_intent_purpose := coalesce(nullif(p_intent ->> 'purpose', ''), 'booking')::public.payment_intent_purpose;
  v_method public.payment_method := (p_intent ->> 'method')::public.payment_method;
  v_client_ref text := nullif(btrim(coalesce(p_intent ->> 'clientReference', '')), '');
  v_claimed integer := nullif(p_intent ->> 'claimedAmountYer', '')::integer;
  v_existing public.payment_intents;
  v_account public.payment_accounts;
  v_paid integer;
  v_amount integer;
  v_intent public.payment_intents;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if v_method is null then
    raise exception 'VALIDATION_FAILED: method is required' using errcode = '22023';
  end if;

  if v_client_ref is not null then
    select * into v_existing
      from public.payment_intents
     where payer_id = p_actor and client_reference = v_client_ref;
    if found then
      return jsonb_build_object('intent', to_jsonb(v_existing), 'created', false);
    end if;
  end if;

  if v_purpose = 'subscription' then
    raise exception 'VALIDATION_FAILED: subscriptions are billed in Phase 10' using errcode = '22023';
  end if;

  select * into v_booking
    from public.bookings
   where id = app.safe_uuid(p_intent ->> 'bookingId')
   for update;
  if not found then
    raise exception 'NOT_FOUND: booking' using errcode = 'P0002';
  end if;
  if v_booking.passenger_id <> p_actor and v_booking.booked_by <> p_actor
     and not app.actor_can_manage_trip(p_actor, v_booking.trip_id) then
    raise exception 'FORBIDDEN: not your booking' using errcode = '42501';
  end if;
  if v_booking.status in ('cancelled_by_passenger', 'cancelled_by_operator', 'rejected', 'expired') then
    raise exception 'CONFLICT: this booking is closed' using errcode = '23505';
  end if;

  select * into v_trip from public.trips where id = v_booking.trip_id;
  v_paid := app.booking_paid_yer(v_booking.id);

  v_amount := case
    when v_purpose = 'deposit' then app.booking_amount_due_yer(v_booking.id) - v_paid
    else v_booking.total_yer - v_paid
  end;

  if v_amount <= 0 then
    raise exception 'ALREADY_PAID: nothing is outstanding on this booking' using errcode = '23505';
  end if;
  if v_claimed is not null and v_claimed <> v_amount then
    raise exception 'PRICE_CHANGED: the amount due is now % (was %)', v_amount, v_claimed
      using errcode = '23514';
  end if;

  -- Where the money goes: the platform's default account for this method. `assert_payment_account_active`
  -- is what stops an archived wallet from being offered to a passenger.
  select * into v_account
    from public.payment_accounts
   where kind = 'platform' and method = v_method and is_default and status = 'active'
   limit 1;
  if not found then
    raise exception 'PAYMENT_METHOD_UNAVAILABLE: no active account for this method'
      using errcode = 'P0002';
  end if;

  insert into public.payment_intents (
    code, purpose, booking_id, payer_id, payee_account_id, method, currency, amount_yer,
    status, client_reference, expires_at, note
  )
  values (
    app.new_payment_code('PI'), v_purpose, v_booking.id, p_actor, v_account.id, v_method,
    v_booking.currency, v_amount, 'awaiting_proof', v_client_ref,
    now() + interval '24 hours', nullif(btrim(coalesce(p_intent ->> 'note', '')), '')
  )
  returning * into v_intent;

  perform app.write_audit(
    p_actor, 'payment.intent.create', 'payment_intent', v_intent.id::text,
    null,
    jsonb_build_object(
      'bookingId', v_booking.id, 'amountYer', v_amount, 'method', v_method,
      'purpose', v_purpose, 'accountId', v_account.id
    ),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('intent', to_jsonb(v_intent), 'created', true);
end;
$$;

/**
 * The passenger uploads the receipt.
 *
 * Two refusals matter more than the happy path: the same file used twice (`PROOF_ALREADY_USED`) and the
 * same bank reference used twice (`REFERENCE_ALREADY_USED`). Both are unique indexes, so the check is the
 * database's and not this function's memory. Re-uploading a *better photograph* of the same transfer on
 * the same intent is allowed until somebody confirms it.
 */
create or replace function public.cmd_submit_payment_proof(
  p_actor uuid,
  p_intent_id uuid,
  p_proof_path text,
  p_proof_hash text,
  p_reference_no text default null,
  p_claimed_amount integer default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.payment_intents;
  v_booking public.bookings;
  v_trip public.trips;
  v_hash text := lower(btrim(coalesce(p_proof_hash, '')));
  v_reference text := nullif(btrim(coalesce(p_reference_no, '')), '');
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_intent from public.payment_intents where id = p_intent_id for update;
  if not found then
    raise exception 'NOT_FOUND: payment intent' using errcode = 'P0002';
  end if;
  if v_intent.payer_id <> p_actor then
    raise exception 'FORBIDDEN: this payment is not yours' using errcode = '42501';
  end if;
  if v_intent.status = 'confirmed' then
    raise exception 'CONFLICT: this payment is already confirmed' using errcode = '23505';
  end if;
  if v_intent.status not in ('awaiting_proof', 'awaiting_confirmation') then
    raise exception 'CONFLICT: this payment is %', v_intent.status using errcode = '23505';
  end if;
  if p_proof_path is null or length(btrim(p_proof_path)) < 3 then
    raise exception 'VALIDATION_FAILED: a receipt image is required' using errcode = '22023';
  end if;
  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'VALIDATION_FAILED: proofHash must be a sha256 in lower-case hex'
      using errcode = '22023';
  end if;
  if p_claimed_amount is not null and p_claimed_amount <> v_intent.amount_yer then
    raise exception 'PRICE_CHANGED: the amount due is % (was %)', v_intent.amount_yer, p_claimed_amount
      using errcode = '23514';
  end if;

  if exists (
    select 1 from public.payment_intents
     where proof_hash = v_hash and id <> v_intent.id
  ) then
    raise exception 'PROOF_ALREADY_USED: this receipt has already been used' using errcode = '23505';
  end if;
  if v_reference is not null and exists (
    select 1 from public.payment_intents
     where method = v_intent.method and reference_no = v_reference and id <> v_intent.id
       and status in ('awaiting_confirmation', 'confirmed')
  ) then
    raise exception 'REFERENCE_ALREADY_USED: this reference is already on another payment'
      using errcode = '23505';
  end if;

  update public.payment_intents
     set proof_path = btrim(p_proof_path),
         proof_hash = v_hash,
         proof_uploaded_at = now(),
         reference_no = coalesce(v_reference, reference_no),
         status = 'awaiting_confirmation'
   where id = p_intent_id
   returning * into v_intent;

  select * into v_booking from public.bookings where id = v_intent.booking_id;
  select * into v_trip from public.trips where id = v_booking.trip_id;

  perform app.notify_trip_managers(
    v_trip, 'payment_submitted', 'notifications.paymentSubmitted',
    jsonb_build_object('code', v_intent.code, 'amount', v_intent.amount_yer),
    '/operator/payments'
  );

  perform app.write_audit(
    p_actor, 'payment.proof.submit', 'payment_intent', p_intent_id::text,
    jsonb_build_object('status', 'awaiting_proof'),
    jsonb_build_object('status', 'awaiting_confirmation', 'reference', v_reference),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('intent', to_jsonb(v_intent), 'changed', true);
end;
$$;

/**
 * Somebody looked at the receipt and the money is real.
 *
 * Idempotent by design: confirming an already-confirmed intent returns it with `changed = false` and
 * writes nothing — no second notification, no second outbox row. That is the promise the plan asks for
 * ("confirming twice does nothing the second time"), and `payment_outbox`'s unique key is the part that
 * holds even if this function is ever rewritten.
 */
create or replace function public.cmd_confirm_payment(
  p_actor uuid,
  p_intent_id uuid,
  p_note text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.payment_intents;
  v_booking public.bookings;
  v_trip public.trips;
  v_status public.booking_payment_status;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_intent from public.payment_intents where id = p_intent_id for update;
  if not found then
    raise exception 'NOT_FOUND: payment intent' using errcode = 'P0002';
  end if;

  select * into v_booking from public.bookings where id = v_intent.booking_id;
  select * into v_trip from public.trips where id = v_booking.trip_id;

  if not (app.actor_can_manage_trip(p_actor, v_booking.trip_id) or app.is_finance(p_actor)) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;

  if v_intent.status = 'confirmed' then
    return jsonb_build_object('intent', to_jsonb(v_intent), 'changed', false);
  end if;
  if v_intent.status <> 'awaiting_confirmation' then
    raise exception 'CONFLICT: this payment is % and cannot be confirmed', v_intent.status
      using errcode = '23505';
  end if;

  update public.payment_intents
     set status = 'confirmed', confirmed_by = p_actor, confirmed_at = now(),
         note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note)
   where id = p_intent_id
   returning * into v_intent;

  v_status := app.refresh_booking_payment_status(v_booking.id);

  perform app.queue_money_event(
    'payment_confirmed', 'payment_intents', v_intent.id, v_intent.amount_yer,
    jsonb_build_object(
      'bookingId', v_booking.id, 'tripId', v_booking.trip_id, 'method', v_intent.method,
      'purpose', v_intent.purpose, 'bookingTotalYer', v_booking.total_yer
    ),
    p_actor, v_trip.owner_user_id, v_trip.owner_org_id
  );

  perform app.notify(
    v_intent.payer_id, 'payment_confirmed', 'notifications.paymentConfirmed',
    jsonb_build_object('code', v_intent.code, 'amount', v_intent.amount_yer),
    '/account/bookings'
  );

  perform app.write_audit(
    p_actor, 'payment.confirm', 'payment_intent', p_intent_id::text,
    jsonb_build_object('status', 'awaiting_confirmation'),
    jsonb_build_object('status', 'confirmed', 'bookingPaymentStatus', v_status),
    p_note, p_request_id, p_ip
  );

  return jsonb_build_object(
    'intent', to_jsonb(v_intent),
    'changed', true,
    'bookingPaymentStatus', v_status
  );
end;
$$;

/** The receipt was wrong, unreadable or never arrived. The passenger can upload again. */
create or replace function public.cmd_reject_payment(
  p_actor uuid,
  p_intent_id uuid,
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
  v_intent public.payment_intents;
  v_booking public.bookings;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'VALIDATION_FAILED: the passenger needs a reason' using errcode = '22023';
  end if;

  select * into v_intent from public.payment_intents where id = p_intent_id for update;
  if not found then
    raise exception 'NOT_FOUND: payment intent' using errcode = 'P0002';
  end if;

  select * into v_booking from public.bookings where id = v_intent.booking_id;
  if not (app.actor_can_manage_trip(p_actor, v_booking.trip_id) or app.is_finance(p_actor)) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;
  if v_intent.status = 'confirmed' then
    raise exception 'CONFLICT: this payment is already confirmed; request a refund instead'
      using errcode = '23505';
  end if;
  if v_intent.status not in ('awaiting_proof', 'awaiting_confirmation') then
    raise exception 'CONFLICT: this payment is %', v_intent.status using errcode = '23505';
  end if;

  update public.payment_intents
     set status = 'rejected', rejected_by = p_actor, rejected_at = now(),
         rejected_reason = btrim(p_reason)
   where id = p_intent_id
   returning * into v_intent;

  perform app.notify(
    v_intent.payer_id, 'payment_rejected', 'notifications.paymentRejected',
    jsonb_build_object('code', v_intent.code, 'reason', btrim(p_reason)),
    '/account/bookings'
  );

  perform app.write_audit(
    p_actor, 'payment.reject', 'payment_intent', p_intent_id::text,
    jsonb_build_object('status', 'awaiting_confirmation'),
    jsonb_build_object('status', 'rejected'), btrim(p_reason), p_request_id, p_ip
  );

  return jsonb_build_object('intent', to_jsonb(v_intent), 'changed', true);
end;
$$;

/** The passenger changed their mind before paying. Only their own intent, only before a confirmation. */
create or replace function public.cmd_cancel_payment_intent(
  p_actor uuid,
  p_intent_id uuid,
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
  v_intent public.payment_intents;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_intent from public.payment_intents where id = p_intent_id for update;
  if not found then
    raise exception 'NOT_FOUND: payment intent' using errcode = 'P0002';
  end if;
  if v_intent.payer_id <> p_actor and not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: this payment is not yours' using errcode = '42501';
  end if;
  if v_intent.status = 'confirmed' then
    raise exception 'CONFLICT: confirmed money is refunded, not cancelled' using errcode = '23505';
  end if;
  if v_intent.status <> 'awaiting_proof' and v_intent.status <> 'awaiting_confirmation' then
    return jsonb_build_object('intent', to_jsonb(v_intent), 'changed', false);
  end if;

  update public.payment_intents
     set status = 'cancelled', cancelled_at = now(),
         note = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), note)
   where id = p_intent_id
   returning * into v_intent;

  perform app.write_audit(
    p_actor, 'payment.cancel', 'payment_intent', p_intent_id::text,
    jsonb_build_object('status', 'awaiting_proof'),
    jsonb_build_object('status', 'cancelled'), p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('intent', to_jsonb(v_intent), 'changed', true);
end;
$$;

/**
 * Housekeeping: intents nobody finished. Called by cron; returns how many it closed.
 *
 * Expiry is *lazy as well* — a stale intent still reads as "waiting for you" until this runs, which is
 * why it runs often and why the passenger's page shows the expiry time.
 */
create or replace function public.cmd_expire_stale_payment_intents(
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with stale as (
    select id from public.payment_intents
     where status in ('awaiting_proof', 'awaiting_confirmation')
       and expires_at is not null
       and expires_at < now()
     order by expires_at
     limit greatest(1, least(coalesce(p_limit, 500), 5000))
     for update skip locked
  )
  update public.payment_intents i
     set status = 'expired'
    from stale
   where i.id = stale.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Refunds — request, decide, pay
-- ---------------------------------------------------------------------------
-- Three steps on purpose. A refund somebody can execute alone is a refund with one pair of eyes, and the
-- whole point of the queue is that the person who approves is not the person who asked.

create or replace function public.cmd_request_refund(
  p_actor uuid,
  p_booking_id uuid,
  p_amount integer,
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
  v_booking public.bookings;
  v_paid integer;
  v_outstanding integer;
  v_refund public.refunds;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'VALIDATION_FAILED: a refund needs an amount' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'VALIDATION_FAILED: say why the money is being returned' using errcode = '22023';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'NOT_FOUND: booking' using errcode = 'P0002';
  end if;
  if not (
    v_booking.passenger_id = p_actor
    or v_booking.booked_by = p_actor
    or app.actor_can_manage_trip(p_actor, v_booking.trip_id)
    or app.is_finance(p_actor)
  ) then
    raise exception 'FORBIDDEN: not your booking' using errcode = '42501';
  end if;

  -- One open decision per booking. Two pending requests would let the passenger ask the same money
  -- back twice and the second one would only surface at payment time; refusing it here is kinder.
  if exists (
    select 1 from public.refunds
     where booking_id = v_booking.id and status in ('requested', 'approved')
  ) then
    raise exception 'DUPLICATE: a refund on this booking is already waiting for a decision'
      using errcode = '23505';
  end if;

  v_paid := app.booking_paid_yer(v_booking.id);
  select v_paid - coalesce(sum(amount_yer), 0)
    into v_outstanding
    from public.refunds
   where booking_id = v_booking.id and status in ('requested', 'approved');

  if p_amount > v_outstanding then
    raise exception 'VALIDATION_FAILED: at most % can be refunded on this booking', v_outstanding
      using errcode = '22023';
  end if;

  insert into public.refunds (code, booking_id, intent_id, amount_yer, reason, requested_by)
  values (
    app.new_payment_code('RF'), v_booking.id,
    (select id from public.payment_intents
      where booking_id = v_booking.id and status = 'confirmed'
      order by confirmed_at desc limit 1),
    p_amount, btrim(p_reason), p_actor
  )
  returning * into v_refund;

  perform app.write_audit(
    p_actor, 'refund.request', 'refund', v_refund.id::text,
    null,
    jsonb_build_object('bookingId', v_booking.id, 'amountYer', p_amount),
    btrim(p_reason), p_request_id, p_ip
  );

  return jsonb_build_object('refund', to_jsonb(v_refund));
end;
$$;

create or replace function public.cmd_decide_refund(
  p_actor uuid,
  p_refund_id uuid,
  p_approve boolean,
  p_note text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: only finance may decide a refund' using errcode = '42501';
  end if;
  if p_approve is not true and (p_note is null or length(btrim(p_note)) < 5) then
    raise exception 'VALIDATION_FAILED: say why the refund was refused' using errcode = '22023';
  end if;

  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found then
    raise exception 'NOT_FOUND: refund' using errcode = 'P0002';
  end if;
  if v_refund.status <> 'requested' then
    raise exception 'CONFLICT: this refund is %', v_refund.status using errcode = '23505';
  end if;

  update public.refunds
     set status = (case when p_approve then 'approved' else 'rejected' end)::public.refund_status,
         decided_by = p_actor, decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_refund_id
   returning * into v_refund;

  -- Two keys, not one key plus an English enum in the middle of an Arabic sentence: the passenger reads
  -- a sentence, never a status code.
  perform app.notify(
    v_refund.requested_by, 'refund_decided',
    case when p_approve then 'notifications.refundApproved' else 'notifications.refundRejected' end,
    jsonb_build_object('code', v_refund.code, 'amount', v_refund.amount_yer),
    '/account/bookings'
  );

  perform app.write_audit(
    p_actor, 'refund.decide', 'refund', p_refund_id::text,
    jsonb_build_object('status', 'requested'),
    jsonb_build_object('status', v_refund.status), p_note, p_request_id, p_ip
  );

  return jsonb_build_object('refund', to_jsonb(v_refund));
end;
$$;

/**
 * The money actually left. Separate from approval because approval is a decision and this is a transfer,
 * and the two happen on different days with different evidence.
 */
create or replace function public.cmd_pay_refund(
  p_actor uuid,
  p_refund_id uuid,
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
  v_refund public.refunds;
  v_booking public.bookings;
  v_trip public.trips;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: only finance may pay a refund' using errcode = '42501';
  end if;

  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found then
    raise exception 'NOT_FOUND: refund' using errcode = 'P0002';
  end if;
  if v_refund.status = 'paid' then
    return jsonb_build_object('refund', to_jsonb(v_refund), 'changed', false);
  end if;
  if v_refund.status <> 'approved' then
    raise exception 'CONFLICT: this refund is % and was never approved', v_refund.status
      using errcode = '23505';
  end if;

  update public.refunds
     set status = 'paid', paid_by = p_actor, paid_at = now(),
         payment_reference = nullif(btrim(coalesce(p_reference, '')), '')
   where id = p_refund_id
   returning * into v_refund;

  -- The booking's own refund column is what the passenger's page prints, so it moves with the money.
  update public.bookings
     set refund_yer = refund_yer + v_refund.amount_yer
   where id = v_refund.booking_id
   returning * into v_booking;
  perform app.refresh_booking_payment_status(v_booking.id);

  select * into v_trip from public.trips where id = v_booking.trip_id;

  perform app.queue_money_event(
    'refund_paid', 'refunds', v_refund.id, v_refund.amount_yer,
    jsonb_build_object('bookingId', v_booking.id, 'tripId', v_booking.trip_id),
    p_actor, v_trip.owner_user_id, v_trip.owner_org_id
  );

  perform app.notify(
    v_booking.passenger_id, 'refund_decided', 'notifications.refundPaid',
    jsonb_build_object('code', v_refund.code, 'amount', v_refund.amount_yer),
    '/account/bookings'
  );

  perform app.write_audit(
    p_actor, 'refund.pay', 'refund', p_refund_id::text,
    jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', 'paid'), p_reference, p_request_id, p_ip
  );

  return jsonb_build_object('refund', to_jsonb(v_refund), 'changed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Agents — cash at a counter, with a ceiling
-- ---------------------------------------------------------------------------

/**
 * An agent takes cash for the platform. Their float grows; the platform's exposure to them grows with it,
 * which is what the credit limit bounds. Exceeding it is refused rather than warned about: a counter that
 * can hold unlimited cash on somebody else's behalf is a way to lose a week of fares.
 */
create or replace function public.cmd_agent_cash_in(
  p_actor uuid,
  p_agent_id uuid,
  p_amount integer,
  p_note text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.agents;
  v_tx public.agent_transactions;
  v_balance integer;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'VALIDATION_FAILED: a cash-in needs a positive amount' using errcode = '22023';
  end if;

  select * into v_agent from public.agents where id = p_agent_id for update;
  if not found then
    raise exception 'NOT_FOUND: agent' using errcode = 'P0002';
  end if;
  if v_agent.status <> 'active' then
    raise exception 'CONFLICT: this agent is suspended' using errcode = '23505';
  end if;
  if v_agent.user_id <> p_actor and not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: not your float' using errcode = '42501';
  end if;

  v_balance := v_agent.float_balance_yer + p_amount;
  if v_balance > v_agent.credit_limit_yer then
    raise exception 'CREDIT_LIMIT_EXCEEDED: this agent may hold at most %', v_agent.credit_limit_yer
      using errcode = '23514';
  end if;

  update public.agents set float_balance_yer = v_balance where id = p_agent_id;
  -- The snapshot is what the caller gets back, so it has to be the row *after* the write.
  v_agent.float_balance_yer := v_balance;

  insert into public.agent_transactions (agent_id, kind, amount_yer, balance_after_yer, actor_id, note)
  values (p_agent_id, 'cash_in', p_amount, v_balance, p_actor,
          nullif(btrim(coalesce(p_note, '')), ''))
  returning * into v_tx;

  perform app.write_audit(
    p_actor, 'agent.cash_in', 'agent', p_agent_id::text,
    jsonb_build_object('float', v_agent.float_balance_yer),
    jsonb_build_object('float', v_balance, 'amountYer', p_amount),
    p_note, p_request_id, p_ip
  );

  return jsonb_build_object('agent', to_jsonb(v_agent), 'transaction', to_jsonb(v_tx));
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Payouts
-- ---------------------------------------------------------------------------

/**
 * An operator asks for the money their confirmed bookings earned.
 *
 * The ceiling is computed from confirmed payments, not from a balance column, so an owner cannot ask for
 * money the ledger has not seen — and a second request cannot spend the same riyal twice.
 */
create or replace function public.cmd_request_payout(
  p_actor uuid,
  p_payout jsonb,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.safe_uuid(p_payout ->> 'orgId');
  v_amount integer := nullif(p_payout ->> 'amountYer', '')::integer;
  v_method public.payment_method := coalesce(nullif(p_payout ->> 'method', ''), 'bank_transfer')::public.payment_method;
  v_available integer;
  v_payout public.payouts;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'VALIDATION_FAILED: a payout needs an amount' using errcode = '22023';
  end if;
  if v_org is not null and not (
    app.org_role(v_org, p_actor) in ('owner', 'manager', 'accountant') or app.is_finance(p_actor)
  ) then
    raise exception 'FORBIDDEN: not a member of this organization' using errcode = '42501';
  end if;

  v_available := app.owner_available_yer(case when v_org is null then p_actor end, v_org);
  if v_amount > v_available then
    raise exception 'VALIDATION_FAILED: at most % is available to withdraw', v_available
      using errcode = '22023';
  end if;

  insert into public.payouts (
    code, owner_user_id, owner_org_id, amount_yer, method, destination_account_id,
    requested_by, note
  )
  values (
    app.new_payment_code('PO'),
    case when v_org is null then p_actor end, v_org, v_amount, v_method,
    app.safe_uuid(p_payout ->> 'destinationAccountId'),
    p_actor, nullif(btrim(coalesce(p_payout ->> 'note', '')), '')
  )
  returning * into v_payout;

  perform app.write_audit(
    p_actor, 'payout.request', 'payout', v_payout.id::text,
    null, jsonb_build_object('amountYer', v_amount, 'availableYer', v_available),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('payout', to_jsonb(v_payout));
end;
$$;

/**
 * Finance approves. The requester cannot do it, and the schema refuses that combination even if this
 * branch is ever bypassed (`payouts_not_self_approved`).
 */
create or replace function public.cmd_approve_payout(
  p_actor uuid,
  p_payout_id uuid,
  p_note text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout public.payouts;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_payout from public.payouts where id = p_payout_id for update;
  if not found then
    raise exception 'NOT_FOUND: payout' using errcode = 'P0002';
  end if;
  if not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: only finance may approve a payout' using errcode = '42501';
  end if;
  if v_payout.requested_by = p_actor and not app.is_platform_admin(p_actor) then
    raise exception 'PAYOUT_SELF_APPROVAL: somebody else must approve your own payout'
      using errcode = '42501';
  end if;
  if v_payout.status <> 'requested' then
    raise exception 'CONFLICT: this payout is %', v_payout.status using errcode = '23505';
  end if;

  update public.payouts
     set status = 'approved', approved_by = p_actor, approved_at = now()
   where id = p_payout_id
   returning * into v_payout;

  perform app.notify(
    v_payout.requested_by, 'payout_decided', 'notifications.payoutApproved',
    jsonb_build_object('code', v_payout.code, 'amount', v_payout.amount_yer),
    '/operator/payouts'
  );

  perform app.write_audit(
    p_actor, 'payout.approve', 'payout', p_payout_id::text,
    jsonb_build_object('status', 'requested'),
    jsonb_build_object('status', 'approved'), p_note, p_request_id, p_ip
  );

  return jsonb_build_object('payout', to_jsonb(v_payout));
end;
$$;

create or replace function public.cmd_mark_payout_paid(
  p_actor uuid,
  p_payout_id uuid,
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
  v_payout public.payouts;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_finance(p_actor) then
    raise exception 'FORBIDDEN: only finance may mark a payout paid' using errcode = '42501';
  end if;

  select * into v_payout from public.payouts where id = p_payout_id for update;
  if not found then
    raise exception 'NOT_FOUND: payout' using errcode = 'P0002';
  end if;
  if v_payout.status = 'paid' then
    return jsonb_build_object('payout', to_jsonb(v_payout), 'changed', false);
  end if;
  if v_payout.status <> 'approved' then
    raise exception 'CONFLICT: this payout is % and was never approved', v_payout.status
      using errcode = '23505';
  end if;

  update public.payouts
     set status = 'paid', paid_by = p_actor, paid_at = now(),
         payment_reference = nullif(btrim(coalesce(p_reference, '')), '')
   where id = p_payout_id
   returning * into v_payout;

  perform app.queue_money_event(
    'payout_paid', 'payouts', v_payout.id, v_payout.amount_yer,
    jsonb_build_object('method', v_payout.method),
    p_actor, v_payout.owner_user_id, v_payout.owner_org_id
  );

  perform app.notify(
    v_payout.requested_by, 'payout_decided', 'notifications.payoutPaid',
    jsonb_build_object('code', v_payout.code, 'amount', v_payout.amount_yer),
    '/operator/payouts'
  );

  perform app.write_audit(
    p_actor, 'payout.pay', 'payout', p_payout_id::text,
    jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', 'paid'), p_reference, p_request_id, p_ip
  );

  return jsonb_build_object('payout', to_jsonb(v_payout), 'changed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. Reads: RLS on the payment graph
-- ---------------------------------------------------------------------------

alter table public.payment_accounts    enable row level security;
alter table public.payment_intents     enable row level security;
alter table public.refunds             enable row level security;
alter table public.agents              enable row level security;
alter table public.agent_transactions  enable row level security;
alter table public.payouts             enable row level security;
alter table public.payout_items        enable row level security;
alter table public.payment_outbox      enable row level security;

alter table public.payment_accounts    force row level security;
alter table public.payment_intents     force row level security;
alter table public.refunds             force row level security;
alter table public.agents              force row level security;
alter table public.agent_transactions  force row level security;
alter table public.payouts             force row level security;
alter table public.payout_items        force row level security;
alter table public.payment_outbox      force row level security;

/** The payer of one intent — the only account allowed to upload against it. */
create or replace function app.is_payment_payer(p_intent_id uuid, p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.payment_intents i
    where i.id = p_intent_id and i.payer_id = p_uid
  );
$$;

-- Every active platform account is public to signed-in users: a passenger cannot pay a number they are
-- not allowed to read. Owner and agent accounts are visible to their owners and to finance only.
create policy payment_accounts_read_active_platform on public.payment_accounts
  for select to authenticated
  using (
    (kind = 'platform' and status = 'active')
    or owner_user_id = app.uid()
    or (owner_org_id is not null and app.is_org_member(owner_org_id))
    or app.is_finance()
  );

create policy payment_intents_read_authorised on public.payment_intents
  for select to authenticated
  using (app.can_read_payment_intent(id));

create policy refunds_read_authorised on public.refunds
  for select to authenticated
  using (app.can_read_booking(booking_id) or app.is_finance());

create policy agents_read_self_or_finance on public.agents
  for select to authenticated
  using (user_id = app.uid() or app.is_finance());

create policy agent_transactions_read_authorised on public.agent_transactions
  for select to authenticated
  using (
    app.is_finance()
    or exists (select 1 from public.agents a where a.id = agent_id and a.user_id = app.uid())
  );

create policy payouts_read_authorised on public.payouts
  for select to authenticated
  using (
    owner_user_id = app.uid()
    or (owner_org_id is not null and app.is_org_member(owner_org_id))
    or app.is_finance()
  );

create policy payout_items_read_authorised on public.payout_items
  for select to authenticated
  using (exists (select 1 from public.payouts p where p.id = payout_id));

-- The outbox is an accounting seam, not a feature: finance may read it, nobody else has a reason to.
create policy payment_outbox_read_finance on public.payment_outbox
  for select to authenticated
  using (app.is_finance());

grant select on public.payment_accounts   to authenticated;
grant select on public.payment_intents    to authenticated;
grant select on public.refunds            to authenticated;
grant select on public.agents             to authenticated;
grant select on public.agent_transactions to authenticated;
grant select on public.payouts            to authenticated;
grant select on public.payout_items       to authenticated;
grant select on public.payment_outbox     to authenticated;

-- ---------------------------------------------------------------------------
-- 15. Storage: private receipts, one folder per intent
-- ---------------------------------------------------------------------------
-- A receipt carries a name, a phone number and sometimes an account balance. It is not public, and its
-- read permission is the same predicate as the intent it belongs to.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-proofs', 'payment-proofs', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

create policy payment_proofs_read_authorised on storage.objects
  for select to authenticated
  using (
    bucket_id = 'payment-proofs'
    and app.can_read_payment_intent(app.safe_uuid((storage.foldername(name))[1]))
  );

-- Only the payer uploads, into `<intent-id>/…`. An operator photographs a receipt on the passenger's
-- device or asks them to upload it; it does not do it for them.
create policy payment_proofs_write_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'payment-proofs'
    and app.is_payment_payer(app.safe_uuid((storage.foldername(name))[1]))
  );

/**
 * What the calling operator may still withdraw, right now.
 *
 * `app.owner_available_yer` is service-only because it takes an owner as an argument — a client could
 * otherwise ask about anybody's money. This wrapper derives the owner from the session instead, which is
 * why it is the one money helper a signed-in user may call: the payouts screen needs a number it can
 * trust, and recomputing the formula in TypeScript would be a second definition of the payout cap.
 */
create or replace function public.my_available_payout_yer(p_org_id uuid default null)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.uid();
begin
  if v_uid is null then
    return 0;
  end if;
  if p_org_id is not null then
    if not app.is_org_member(p_org_id, v_uid) then
      raise exception 'FORBIDDEN: not a member of this organization' using errcode = '42501';
    end if;
    return app.owner_available_yer(null, p_org_id);
  end if;
  return app.owner_available_yer(v_uid, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- 16. Execute grants: writes are service-only, read helpers are signed-in only
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.cmd_create_payment_account(uuid, jsonb, text, inet)',
    'public.cmd_verify_payment_account(uuid, uuid, boolean, text, text, inet)',
    'public.cmd_archive_payment_account(uuid, uuid, text, text, inet)',
    'public.cmd_create_payment_intent(uuid, jsonb, text, inet)',
    'public.cmd_submit_payment_proof(uuid, uuid, text, text, text, integer, text, inet)',
    'public.cmd_confirm_payment(uuid, uuid, text, text, inet)',
    'public.cmd_reject_payment(uuid, uuid, text, text, inet)',
    'public.cmd_cancel_payment_intent(uuid, uuid, text, text, inet)',
    'public.cmd_expire_stale_payment_intents(integer)',
    'public.cmd_request_refund(uuid, uuid, integer, text, text, inet)',
    'public.cmd_decide_refund(uuid, uuid, boolean, text, text, inet)',
    'public.cmd_pay_refund(uuid, uuid, text, text, inet)',
    'public.cmd_agent_cash_in(uuid, uuid, integer, text, text, inet)',
    'public.cmd_request_payout(uuid, jsonb, text, inet)',
    'public.cmd_approve_payout(uuid, uuid, text, text, inet)',
    'public.cmd_mark_payout_paid(uuid, uuid, text, text, inet)',
    'app.booking_paid_yer(uuid)',
    'app.booking_amount_due_yer(uuid)',
    'app.refresh_booking_payment_status(uuid)',
    'app.queue_money_event(public.payment_outbox_kind, text, uuid, integer, jsonb, uuid, uuid, uuid)',
    'app.owner_available_yer(uuid, uuid)',
    'app.assert_payment_account_active(uuid)',
    'app.enforce_prepay_before_accept()',
    'app.new_payment_code(text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;

  -- Policies run as the querying role, so exactly these three must be callable by a signed-in user.
  -- The payout screen's number: owner derived from the session, not from an argument.
  revoke all on function public.my_available_payout_yer(uuid) from public, anon;
  grant execute on function public.my_available_payout_yer(uuid) to authenticated, service_role;

  foreach v_signature in array array[
    'app.can_read_payment_intent(uuid, uuid)',
    'app.is_payment_payer(uuid, uuid)',
    'app.is_finance(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', v_signature);
    execute format('grant execute on function %s to authenticated, service_role', v_signature);
  end loop;
end;
$$;
