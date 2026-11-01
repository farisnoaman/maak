-- Phase 11 — notifications: one event, one row, one decision per channel.
--
-- Phase 1 shipped `notifications` as an in-app list and `app.notify()` as the only writer. Every phase since
-- has called it — 51 call sites — so by now the platform knows *what* it wants to tell people and has no idea
-- *how* to reach them: there is no preference, no channel, no retry, no quiet hour, and no answer to "the
-- passenger says they never got it".
--
-- This migration keeps the shape that already works (a row per user per event, holding an i18n key and its
-- values, never rendered text) and adds the three things it was missing:
--
--   1. **A decision per channel.** `notification_deliveries` says, for each event × channel, whether it is
--      pending, sent, skipped (the user turned it off), failed (with a backoff) or dead (five attempts).
--      The decision is data, so "why did this not arrive" is a query rather than an investigation.
--   2. **A policy the user owns.** Preferences per event × channel, quiet hours in Asia/Aden with a critical
--      override. A disabled channel is recorded as skipped, not silently dropped — silence is the thing
--      support cannot debug.
--   3. **A worker seam.** `cmd_claim_notifications` hands out what is due and marks it `sending`;
--      `cmd_record_notification_delivery` records the outcome. The transport (Expo, Resend, a `wa.me` link)
--      lives in the edge function because that is where `fetch` lives, and the *decision* lives here because
--      that is what tests can pin.
--
-- Text stays in the dictionaries. A template row holds keys and a list of required parameters, never a
-- translated string: one row has to render in Arabic and English, and a table of copy is a table that drifts
-- from `dictionaries.ts` and breaks the AR/EN parity gate.

begin;

-- ---------------------------------------------------------------------------
-- 1. Enums, including the five events this phase introduces
-- ---------------------------------------------------------------------------

create type public.notification_channel as enum ('in_app', 'push', 'email', 'whatsapp');

-- `critical` bypasses quiet hours. It is a property of the *event*, not of the channel: a cancellation at
-- 23:40 is happening now and a push about it at 06:00 is worthless, while a maintenance reminder is not.
create type public.notification_priority as enum ('critical', 'normal', 'low');

create type public.notification_delivery_status as enum (
  'pending',  -- due, waiting for the worker
  'sending',  -- claimed by a worker; a stuck row is rescued by the retry job
  'sent',
  'skipped',  -- the user turned this channel off: kept as a row so the answer exists
  'failed',   -- retryable, with a backoff
  'dead'      -- attempts exhausted; the dead-letter state, queryable by support
);

-- New events. `saved_search_match`, `trip_reminder`, `quota_threshold` and `subscription_expiring` are the
-- jobs this phase adds; `verification_sla` is the staff nag for an ageing queue.
alter type public.notification_kind add value if not exists 'saved_search_match';
alter type public.notification_kind add value if not exists 'trip_reminder';
alter type public.notification_kind add value if not exists 'quota_threshold';
alter type public.notification_kind add value if not exists 'subscription_expiring';
alter type public.notification_kind add value if not exists 'verification_sla';

-- A new enum value cannot be used as a literal in the transaction that adds it, and the catalogue below
-- seeds rows for the five events above. So the enum step commits on its own and the rest starts fresh.
commit;

begin;

-- ---------------------------------------------------------------------------
-- 2. The event catalogue
-- ---------------------------------------------------------------------------
--
-- One row per kind. It answers three questions the call sites used to answer by accident: which channels this
-- event wants by default, how urgent it is, and which template renders it. Seeded from the same file rather
-- than typed by hand, so adding an event without thinking about its channels is not possible.

create table public.notification_events (
  kind             public.notification_kind primary key,
  -- The canonical template. A call site may pass a different `title_key` for the same kind (a booking
  -- cancellation and a trip cancellation are both `booking_cancelled`), and its own key wins; this is the
  -- default and what the admin preview shows.
  title_key        text not null,
  priority         public.notification_priority not null default 'normal',
  default_channels public.notification_channel[] not null default '{in_app}',
  is_active        boolean not null default true,
  updated_at       timestamptz not null default now(),
  constraint notification_events_title_key check (title_key ~ '^[a-z][A-Za-z0-9]*\.[A-Za-z0-9]+$')
);

comment on column public.notification_events.default_channels is
  'Channels offered before the user has an opinion. `in_app` is always included by app.enqueue_notification.';

insert into public.notification_events (kind, title_key, priority, default_channels) values
  ('verification_submitted', 'notifications.verificationSubmitted', 'low', '{in_app, push, email}'),
  ('verification_approved', 'notifications.verificationApproved', 'normal', '{in_app, push, email}'),
  ('verification_rejected', 'notifications.verificationRejected', 'critical', '{in_app, push, email}'),
  ('verification_invalidated', 'notifications.verificationInvalidated', 'critical', '{in_app, push, email}'),
  ('member_invited', 'notifications.memberInvited', 'normal', '{in_app, push, email}'),
  ('member_joined', 'notifications.memberJoined', 'low', '{in_app}'),
  ('member_removed', 'notifications.memberRemoved', 'normal', '{in_app, email}'),
  ('role_granted', 'notifications.roleGranted', 'normal', '{in_app, email}'),
  ('role_revoked', 'notifications.roleRevoked', 'critical', '{in_app, email}'),
  ('booking_requested', 'notifications.bookingRequested', 'normal', '{in_app, push}'),
  ('booking_accepted', 'notifications.bookingAccepted', 'normal', '{in_app, push, email}'),
  ('booking_rejected', 'notifications.bookingRejected', 'critical', '{in_app, push, email}'),
  ('booking_cancelled', 'notifications.bookingCancelled', 'critical', '{in_app, push, email}'),
  ('vehicle_maintenance_due', 'notifications.vehicleMaintenanceDue', 'low', '{in_app, push}'),
  ('vehicle_maintenance_overdue', 'notifications.vehicleMaintenanceOverdue', 'normal', '{in_app, push}'),
  ('vehicle_fuel_anomaly', 'notifications.vehicleFuelAnomaly', 'normal', '{in_app, push}'),
  ('payment_submitted', 'notifications.paymentSubmitted', 'normal', '{in_app, push}'),
  ('payment_confirmed', 'notifications.paymentConfirmed', 'normal', '{in_app, push, email}'),
  ('payment_rejected', 'notifications.paymentRejected', 'critical', '{in_app, push, email}'),
  ('refund_decided', 'notifications.refundApproved', 'critical', '{in_app, push, email}'),
  ('payout_decided', 'notifications.payoutApproved', 'critical', '{in_app, push, email}'),
  ('invoice_issued', 'notifications.invoiceIssued', 'normal', '{in_app, email}'),
  ('subscription_activated', 'notifications.subscriptionActivated', 'normal', '{in_app, email}'),
  ('subscription_past_due', 'notifications.subscriptionPastDue', 'critical', '{in_app, push, email}'),
  ('subscription_expired', 'notifications.subscriptionExpired', 'critical', '{in_app, push, email}'),
  ('finance_alert', 'notifications.integrityAlert', 'critical', '{in_app, push, email}'),
  ('saved_search_match', 'notifications.savedSearchMatch', 'normal', '{in_app, push}'),
  ('trip_reminder', 'notifications.tripReminder', 'normal', '{in_app, push}'),
  ('quota_threshold', 'notifications.quotaWarning', 'normal', '{in_app, email}'),
  ('subscription_expiring', 'notifications.subscriptionExpiring7', 'critical', '{in_app, push, email}'),
  ('verification_sla', 'notifications.verificationSla', 'low', '{in_app, email}')
on conflict (kind) do nothing;

-- ---------------------------------------------------------------------------
-- 3. What the user chose
-- ---------------------------------------------------------------------------

/** Quiet hours and the locale the worker renders in. One row per user, created on first save. */
create table public.notification_settings (
  user_id            uuid primary key references public.profiles (id) on delete cascade,
  quiet_hours_enabled boolean not null default true,
  quiet_start        time not null default '22:00',
  quiet_end          time not null default '06:00',
  -- The zone quiet hours and the test clocks are expressed in. A column, not a constant, because the
  -- dispatcher must be able to say "not before 06:00 in Aden" without embedding it in three places.
  timezone           text not null default 'Asia/Aden' check (timezone = 'Asia/Aden'),
  updated_at         timestamptz not null default now(),
  constraint notification_settings_quiet_window check (quiet_start <> quiet_end)
);

comment on table public.notification_settings is
  'Absent row = platform defaults. A row exists only once the user saves the screen, so "defaults" is the absence of an opinion rather than a seeded opinion.';

create table public.notification_preferences (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       public.notification_kind not null,
  channel    public.notification_channel not null,
  enabled    boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, channel)
);

comment on table public.notification_preferences is
  'Only deviations are stored: no row means "whatever the event catalogue says". That keeps a rule change to the defaults from being silently overridden by rows nobody remembers writing.';

/** Expo push tokens. A token belongs to one device; registering it again moves it to the newest user. */
create table public.device_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  platform     text not null check (platform in ('ios', 'android', 'web')),
  token        text not null check (length(btrim(token)) between 8 and 400),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  unique (token)
);

create index device_tokens_user_idx on public.device_tokens (user_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- 4. One row per event × channel: the decision, and the attempts behind it
-- ---------------------------------------------------------------------------

create table public.notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  channel         public.notification_channel not null,
  status          public.notification_delivery_status not null default 'pending',
  attempts        integer not null default 0 check (attempts between 0 and 20),
  next_attempt_at timestamptz not null default now(),
  -- When a worker took the row. A claim older than ten minutes is rescued, not trusted.
  claimed_at      timestamptz,
  last_error      text,
  provider_ref    text,
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  unique (notification_id, channel),
  -- `sending` must carry an attempt, otherwise a stuck row cannot be told apart from a fresh one.
  constraint delivery_sending_has_attempt check (status <> 'sending' or attempts > 0)
);

create index notification_deliveries_due_idx
  on public.notification_deliveries (next_attempt_at)
  where status in ('pending', 'failed');

create index notification_deliveries_user_idx
  on public.notification_deliveries (user_id, created_at desc);

-- The dead-letter trail. One row per attempt, so a payload that failed four times can be inspected rather
-- than guessed at, and so the retry schedule is visible after the fact.
create table public.notification_delivery_attempts (
  id          uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.notification_deliveries (id) on delete cascade,
  attempt     integer not null check (attempt > 0),
  outcome     text not null check (outcome in ('sent', 'failed')),
  error       text,
  provider_ref text,
  created_at  timestamptz not null default now(),
  unique (delivery_id, attempt)
);

create index notification_delivery_attempts_delivery_idx
  on public.notification_delivery_attempts (delivery_id);

-- ---------------------------------------------------------------------------
-- 5. `notifications`: what a notification is, not how it travels
-- ---------------------------------------------------------------------------
--
-- A dedupe key is what makes the jobs idempotent: the trip reminder for trip X goes out once, the quota
-- warning for March goes out once, the saved-search alert for trip Y goes out once. The dispatcher may run
-- every five minutes for a month and the passenger still gets one message.

alter table public.notifications
  add column dedupe_key text,
  add column priority public.notification_priority not null default 'normal';

create unique index notifications_dedupe_uq
  on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null;

comment on column public.notifications.dedupe_key is
  'Idempotency for a scheduled event: trip + id + lead time, or quota + owner + metric + period. Nullable, because a one-off event has nothing to dedupe against.';

-- ---------------------------------------------------------------------------
-- 6. Saved searches: "tell me when something matches"
-- ---------------------------------------------------------------------------

create table public.saved_searches (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  label           text check (label is null or length(btrim(label)) between 1 and 80),
  -- Exactly the payload `search_public_trips` takes, so an alert is the same predicate as the screen.
  filters         jsonb not null,
  notify          boolean not null default true,
  -- md5 of the canonical filters: saving the same search twice is one search, not a duplicate that alerts
  -- twice for the same trip.
  fingerprint     text not null,
  last_matched_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, fingerprint),
  constraint saved_searches_filters_object check (jsonb_typeof(filters) = 'object')
);

create index saved_searches_notify_idx on public.saved_searches (user_id) where notify;

create table public.saved_search_matches (
  id              uuid primary key default gen_random_uuid(),
  saved_search_id uuid not null references public.saved_searches (id) on delete cascade,
  trip_id         uuid not null references public.trips (id) on delete cascade,
  notified_at     timestamptz not null default now(),
  unique (saved_search_id, trip_id)
);

comment on table public.saved_search_matches is
  'One row per (search, trip). The unique key is the whole "once per new trip, not per refresh" requirement: the matching job can run every minute and cannot send twice.';

create index saved_search_matches_trip_idx on public.saved_search_matches (trip_id);

commit;

-- ---------------------------------------------------------------------------
-- 7. Quiet hours: a clock, in one place
-- ---------------------------------------------------------------------------
--
-- Every rule below is expressed against `Asia/Aden`, never against the server's zone or the user's phone.
-- A Yemeni operator on a trip through a foreign network still gets silence between 22:00 and 06:00 *of the
-- country the trip is in*, and a test can pin the hour instead of waiting for one.

/** The zone quiet hours are measured in. A constant with a name, so no rule has to restate it. */
create or replace function app.notification_timezone()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'Asia/Aden'::text;
$$;

/** Late enough that `attempts` stops growing. Five attempts spans an hour and a half of backoff. */
create or replace function app.notification_max_attempts()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 5;
$$;

/** 1 min, 5 min, 15 min, then an hour. Jitter is the worker's business; the floor is here. */
create or replace function app.notification_backoff(p_attempts integer)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case
    when p_attempts <= 1 then interval '1 minute'
    when p_attempts = 2 then interval '5 minutes'
    when p_attempts = 3 then interval '15 minutes'
    else interval '60 minutes'
  end;
$$;

/**
 * Is this user inside their quiet window at `p_at`?
 *
 * No settings row means the platform default, which is on: silence is the safer default for a stranger, and
 * a user who wants their phone to buzz at midnight can say so. The window may wrap past midnight, which the
 * two comparisons below handle as two cases rather than one clever expression.
 */
create or replace function app.in_quiet_hours(p_user uuid, p_at timestamptz default now())
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  v_start time;
  v_end time;
  v_local time;
begin
  if p_user is null then
    return false;
  end if;

  select s.quiet_hours_enabled, s.quiet_start, s.quiet_end
    into v_enabled, v_start, v_end
    from public.notification_settings s
   where s.user_id = p_user;

  if not found then
    v_enabled := true;
    v_start := '22:00';
    v_end := '06:00';
  end if;

  if not v_enabled then
    return false;
  end if;

  v_local := (p_at at time zone app.notification_timezone())::time;
  if v_start < v_end then
    return v_local >= v_start and v_local < v_end;
  end if;
  return v_local >= v_start or v_local < v_end;
end;
$$;

/**
 * When quiet hours end, as an instant — the moment a held push becomes deliverable.
 *
 * `datediff` style arithmetic on a local date, then converted back: 23:00 on the 5th resumes at 06:00 on the
 * 6th, and 03:00 on the 6th resumes at 06:00 the same day.
 */
create or replace function app.quiet_resume_at(p_user uuid, p_at timestamptz default now())
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_end time;
  v_local time;
  v_date date;
begin
  select s.quiet_end into v_end
    from public.notification_settings s
   where s.user_id = p_user;

  v_end := coalesce(v_end, '06:00');
  v_local := (p_at at time zone app.notification_timezone())::time;
  v_date := (p_at at time zone app.notification_timezone())::date;

  -- Already past the resume hour today: the window that is open now started yesterday evening.
  if v_local >= v_end then
    v_date := v_date + 1;
  end if;

  return (v_date + v_end) at time zone app.notification_timezone();
end;
$$;

/** Explicit choice, else the event's default, else in-app only. */
create or replace function app.channel_enabled(
  p_user uuid,
  p_kind public.notification_kind,
  p_channel public.notification_channel
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.enabled
       from public.notification_preferences p
      where p.user_id = p_user and p.kind = p_kind and p.channel = p_channel),
    (select p_channel = any (e.default_channels)
       from public.notification_events e
      where e.kind = p_kind),
    p_channel = 'in_app'
  );
$$;

-- ---------------------------------------------------------------------------
-- 8. The outbox: enqueue once, decide per channel
-- ---------------------------------------------------------------------------

/**
 * Write one notification and the delivery decisions that follow from it.
 *
 * This replaces the direct INSERT `app.notify()` used to do. The signature carries the two things a job
 * needs and a call site usually does not: a dedupe key (so a retried job sends once) and a priority (so a
 * cancellation at 23:40 is not held until morning).
 *
 * The in-app row is written unconditionally and marked sent: the row *is* the in-app delivery. Every other
 * channel gets a decision, and a decision to skip is recorded, because "why did I not get an email" is a
 * support question that deserves an answer better than a shrug.
 */
create or replace function app.enqueue_notification(
  p_user uuid,
  p_kind public.notification_kind,
  p_title_key text default null,
  p_params jsonb default '{}'::jsonb,
  p_link text default null,
  p_dedupe_key text default null,
  p_priority public.notification_priority default null,
  -- The clock. Real callers never pass it; a test stands at 23:00 without waiting until 23:00.
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.notification_events;
  v_id uuid;
  v_existing uuid;
  v_priority public.notification_priority;
  v_channel public.notification_channel;
  v_channels public.notification_channel[];
  v_offered public.notification_channel[];
  v_status public.notification_delivery_status;
  v_next timestamptz;
  v_reason text;
begin
  if p_user is null then
    return jsonb_build_object('id', null, 'created', false);
  end if;

  select * into v_event from public.notification_events e where e.kind = p_kind;
  v_priority := coalesce(p_priority, v_event.priority, 'normal');

  if p_dedupe_key is not null then
    select id into v_existing
      from public.notifications n
     where n.user_id = p_user and n.dedupe_key = p_dedupe_key;
    if found then
      return jsonb_build_object('id', v_existing, 'created', false);
    end if;
  end if;

  insert into public.notifications (user_id, kind, title_key, params, link, priority, dedupe_key)
  values (
    p_user, p_kind,
    coalesce(p_title_key, v_event.title_key, 'notifications.generic'),
    coalesce(p_params, '{}'::jsonb), p_link, v_priority, p_dedupe_key
  )
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;

  if v_id is null then
    -- A concurrent worker inserted the same key first. It owns the deliveries; hand back its row.
    select id into v_id
      from public.notifications n
     where n.user_id = p_user and n.dedupe_key = p_dedupe_key;
    return jsonb_build_object('id', v_id, 'created', false);
  end if;

  insert into public.notification_deliveries (notification_id, user_id, channel, status, sent_at, attempts)
  values (v_id, p_user, 'in_app', 'sent', p_at, 0);

  -- Which channels get a decision row: the event's own list, plus anything the user has explicitly turned
  -- *on* for this kind. A channel the user turned off is included when the event would otherwise have used
  -- it, so the skip is on the record; a channel the event never offers gets no row at all.
  select e.default_channels into v_offered
    from public.notification_events e
   where e.kind = p_kind;

  select coalesce(array_agg(c order by c), '{}'::public.notification_channel[])
    into v_channels
    from unnest(enum_range(null::public.notification_channel)) c
   where c <> 'in_app'
     and (c = any (coalesce(v_offered, '{}')) or app.channel_enabled(p_user, p_kind, c));

  foreach v_channel in array v_channels loop
    v_status := 'pending';
    v_next := p_at;
    v_reason := null;

    if not app.channel_enabled(p_user, p_kind, v_channel) then
      v_status := 'skipped';
      v_reason := 'preference';
    elsif v_channel = 'push'
       and not exists (
         select 1 from public.device_tokens dt
          where dt.user_id = p_user and dt.revoked_at is null
       ) then
      v_status := 'skipped';
      v_reason := 'no_device';
    elsif v_channel = 'whatsapp'
       and not exists (
         select 1 from public.profiles p
          where p.id = p_user and p.phone is not null and length(btrim(p.phone)) >= 6
       ) then
      v_status := 'skipped';
      v_reason := 'no_phone';
    elsif v_channel = 'push'
       and v_priority <> 'critical'
       and app.in_quiet_hours(p_user, p_at) then
      -- Held, not dropped: it becomes deliverable the moment the window closes.
      v_next := app.quiet_resume_at(p_user, p_at);
    end if;

    insert into public.notification_deliveries (
      notification_id, user_id, channel, status, next_attempt_at, last_error
    )
    values (v_id, p_user, v_channel, v_status, v_next, v_reason)
    on conflict (notification_id, channel) do nothing;
  end loop;

  return jsonb_build_object('id', v_id, 'created', true);
end;
$$;

/**
 * The Phase 1 surface, kept alive on purpose.
 *
 * Fifty-one call sites in migrations 00006–00031 call this, and every one of them wanted exactly this
 * behaviour. Rewriting them would add 51 chances to get a parameter wrong and buy nothing, so the wrapper
 * stays and the work happens in `app.enqueue_notification`.
 */
create or replace function app.notify(
  p_user uuid,
  p_kind public.notification_kind,
  p_title_key text,
  p_params jsonb default '{}'::jsonb,
  p_link text default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select (app.enqueue_notification(
    p_user, p_kind, p_title_key, p_params, p_link, null, null, now()
  ) ->> 'id')::uuid;
$$;

-- ---------------------------------------------------------------------------
-- 9. The worker seam
-- ---------------------------------------------------------------------------

/**
 * A claim that never came back is not a delivery.
 *
 * The worker can be killed between claiming and recording (a deploy, an OOM, a 10-second timeout against a
 * provider that then succeeded anyway). Rather than guess, a claim older than ten minutes is returned to the
 * queue — at-least-once delivery with a provider-side idempotency key is the honest contract, and the
 * `dedupe_key` above is what keeps "at least once" from becoming "twice".
 */
create or replace function app.rescue_stuck_deliveries(p_stale interval default '10 minutes')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.notification_deliveries d
     set status = case
           when d.attempts >= app.notification_max_attempts()
             then 'dead'::public.notification_delivery_status
           else 'failed'::public.notification_delivery_status
         end,
         last_error = coalesce(d.last_error, 'stuck'),
         next_attempt_at = now() + app.notification_backoff(d.attempts)
   where d.status = 'sending'
     and d.claimed_at < now() - p_stale;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

/** A push nobody can receive is not a failure — it is a decision, made early and recorded. */
create or replace function app.skip_undeliverable(p_channel public.notification_channel default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.notification_deliveries d
     set status = 'skipped', last_error = 'no_device', next_attempt_at = now()
   where d.status in ('pending', 'failed')
     and d.channel = 'push'
     and (p_channel is null or d.channel = p_channel)
     and not exists (
       select 1 from public.device_tokens dt
        where dt.user_id = d.user_id and dt.revoked_at is null
     );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

/**
 * Hand the worker what is due, and nothing else.
 *
 * `for update skip locked` is what makes two workers (a cron and a manual retry) safe: neither waits for the
 * other, and no delivery is claimed twice. The row moves to `sending` before it is returned, so a crash
 * mid-send leaves evidence rather than silence.
 */
create or replace function public.cmd_claim_notifications(
  p_actor uuid,
  p_limit integer default 20,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 200);
  v_ids uuid[];
  v_items jsonb;
begin
  perform app.rescue_stuck_deliveries();
  perform app.skip_undeliverable();

  with due as (
    select d.id
      from public.notification_deliveries d
     where d.status in ('pending', 'failed')
       and d.next_attempt_at <= now()
       and d.attempts < app.notification_max_attempts()
     order by d.next_attempt_at, d.created_at
     limit v_limit
     for update skip locked
  ), claimed as (
    update public.notification_deliveries d
       set status = 'sending',
           attempts = d.attempts + 1,
           claimed_at = now(),
           last_error = null
      from due
     where d.id = due.id
    returning d.id
  )
  select array_agg(id) into v_ids from claimed;

  if v_ids is null then
    return jsonb_build_object('claimed', 0, 'items', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'deliveryId', d.id,
           'notificationId', n.id,
           'userId', d.user_id,
           'channel', d.channel,
           'attempts', d.attempts,
           'maxAttempts', app.notification_max_attempts(),
           'kind', n.kind,
           'priority', n.priority,
           'titleKey', n.title_key,
           'params', n.params,
           'link', n.link,
           'locale', coalesce(p.preferred_language, 'ar'),
           'tokens', case when d.channel = 'push' then (
             select coalesce(jsonb_agg(dt.token order by dt.last_seen_at desc), '[]'::jsonb)
               from public.device_tokens dt
              where dt.user_id = d.user_id and dt.revoked_at is null
           ) else '[]'::jsonb end,
           'phone', case when d.channel = 'whatsapp' then p.phone else null end,
           'createdAt', n.created_at
         ) order by d.created_at), '[]'::jsonb)
    into v_items
    from public.notification_deliveries d
    join public.notifications n on n.id = d.notification_id
    join public.profiles p on p.id = d.user_id
   where d.id = any(v_ids);

  return jsonb_build_object('claimed', array_length(v_ids, 1), 'items', v_items);
end;
$$;

/**
 * Record what happened, and decide what happens next.
 *
 * `sent` is final. `failed` schedules a backoff until the fifth attempt, then the row is `dead` — visible,
 * counted and inspectable, which is the difference between a dead letter and a lost message. Replaying a
 * record call cannot corrupt the state: anything not in `sending` is refused as a conflict rather than
 * silently overwritten.
 */
create or replace function public.cmd_record_notification_delivery(
  p_actor uuid,
  p_delivery_id uuid,
  p_outcome text,
  p_error text default null,
  p_provider_ref text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery public.notification_deliveries;
  v_status public.notification_delivery_status;
  v_next timestamptz;
begin
  if p_outcome not in ('sent', 'failed', 'skipped') then
    raise exception 'VALIDATION_FAILED: outcome must be sent, failed or skipped (got %)', p_outcome
      using errcode = '22023';
  end if;

  select * into v_delivery
    from public.notification_deliveries d
   where d.id = p_delivery_id
   for update;

  if not found then
    raise exception 'NOT_FOUND: delivery % does not exist', p_delivery_id using errcode = 'P0002';
  end if;

  if v_delivery.status <> 'sending' then
    raise exception 'CONFLICT: delivery % is %, not sending', p_delivery_id, v_delivery.status
      using errcode = '40001';
  end if;

  if p_outcome = 'sent' then
    v_status := 'sent';
    v_next := v_delivery.next_attempt_at;
    update public.notification_deliveries d
       set status = 'sent', sent_at = now(), provider_ref = p_provider_ref, last_error = null
     where d.id = p_delivery_id;
  elsif p_outcome = 'skipped' then
    -- Not a failed attempt: the address was missing, so the attempt counter gives the number back.
    v_status := 'skipped';
    v_next := now();
    update public.notification_deliveries d
       set status = 'skipped',
           attempts = greatest(d.attempts - 1, 0),
           last_error = coalesce(nullif(btrim(coalesce(p_error, '')), ''), 'no_destination'),
           next_attempt_at = now()
     where d.id = p_delivery_id;
  elsif v_delivery.attempts >= app.notification_max_attempts() then
    v_status := 'dead';
    v_next := v_delivery.next_attempt_at;
    update public.notification_deliveries d
       set status = 'dead', last_error = coalesce(p_error, 'unknown'), next_attempt_at = now()
     where d.id = p_delivery_id;
  else
    v_status := 'failed';
    v_next := now() + app.notification_backoff(v_delivery.attempts);
    update public.notification_deliveries d
       set status = 'failed', last_error = coalesce(p_error, 'unknown'), next_attempt_at = v_next
     where d.id = p_delivery_id;
  end if;

  if p_outcome <> 'skipped' then
    insert into public.notification_delivery_attempts (delivery_id, attempt, outcome, error, provider_ref)
    values (p_delivery_id, v_delivery.attempts, p_outcome, p_error, p_provider_ref)
    on conflict (delivery_id, attempt) do nothing;
  end if;

  return jsonb_build_object(
    'deliveryId', p_delivery_id,
    'status', v_status,
    'attempts', case when p_outcome = 'skipped' then greatest(v_delivery.attempts - 1, 0) else v_delivery.attempts end,
    'nextAttemptAt', v_next
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Preferences, devices and the inbox
-- ---------------------------------------------------------------------------

/** Everything the preferences screen needs, in one round trip: the catalogue, the user's deviations, devices. */
create or replace function public.cmd_get_notification_settings(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
  v_settings public.notification_settings;
  v_locale text;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_settings from public.notification_settings s where s.user_id = v_uid;
  select coalesce(p.preferred_language, 'ar') into v_locale from public.profiles p where p.id = v_uid;

  return jsonb_build_object(
    'settings', jsonb_build_object(
      'quietHoursEnabled', coalesce(v_settings.quiet_hours_enabled, true),
      'quietStart', to_char(coalesce(v_settings.quiet_start, '22:00'::time), 'HH24:MI'),
      'quietEnd', to_char(coalesce(v_settings.quiet_end, '06:00'::time), 'HH24:MI'),
      'timezone', app.notification_timezone(),
      'saved', v_settings.user_id is not null
    ),
    'locale', v_locale,
    'events', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'kind', e.kind,
               'titleKey', e.title_key,
                   'priority', e.priority,
               'channels', jsonb_build_object(
                 'in_app', true,
                 'push', app.channel_enabled(v_uid, e.kind, 'push'),
                 'email', app.channel_enabled(v_uid, e.kind, 'email'),
                 'whatsapp', app.channel_enabled(v_uid, e.kind, 'whatsapp')
               ),
               'customised', exists (
                 select 1 from public.notification_preferences p
                  where p.user_id = v_uid and p.kind = e.kind
               )
             ) order by e.priority desc, e.kind), '[]'::jsonb)
        from public.notification_events e
       where e.is_active
    ),
    'devices', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', dt.id,
               'platform', dt.platform,
               'lastSeenAt', dt.last_seen_at
             ) order by dt.last_seen_at desc), '[]'::jsonb)
        from public.device_tokens dt
       where dt.user_id = v_uid and dt.revoked_at is null
    )
  );
end;
$$;

/**
 * One switch, one row.
 *
 * `in_app` is refused: it is the record of the event, and turning it off would mean an event the user cannot
 * find afterwards. Deleting the preference (by setting it back to the default) is `cmd_reset_notification_preference`.
 */
create or replace function public.cmd_set_notification_preference(
  p_actor uuid,
  p_kind public.notification_kind,
  p_channel public.notification_channel,
  p_enabled boolean,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
  v_before jsonb;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_channel = 'in_app' then
    raise exception 'VALIDATION_FAILED: in-app notifications cannot be switched off'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.notification_events e where e.kind = p_kind) then
    raise exception 'NOT_FOUND: unknown notification kind %', p_kind using errcode = 'P0002';
  end if;

  select jsonb_build_object('enabled', p.enabled) into v_before
    from public.notification_preferences p
   where p.user_id = v_uid and p.kind = p_kind and p.channel = p_channel;

  insert into public.notification_preferences (user_id, kind, channel, enabled)
  values (v_uid, p_kind, p_channel, p_enabled)
  on conflict (user_id, kind, channel) do update
    set enabled = excluded.enabled, updated_at = now();

  perform app.write_audit(
    v_uid, 'notification.preference', 'notification_preference',
    v_uid::text || ':' || p_kind::text || ':' || p_channel::text,
    v_before, jsonb_build_object('enabled', p_enabled), null, p_request_id, p_ip
  );

  return jsonb_build_object('kind', p_kind, 'channel', p_channel, 'enabled', p_enabled);
end;
$$;

/** Back to the catalogue default: deleting the deviation is the only way to follow future changes. */
create or replace function public.cmd_reset_notification_preference(
  p_actor uuid,
  p_kind public.notification_kind,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
  v_count integer;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  delete from public.notification_preferences p
   where p.user_id = v_uid and p.kind = p_kind;

  get diagnostics v_count = row_count;

  perform app.write_audit(
    v_uid, 'notification.preference.reset', 'notification_preference', v_uid::text || ':' || p_kind::text,
    null, jsonb_build_object('removed', v_count), null, p_request_id, p_ip
  );

  return jsonb_build_object('kind', p_kind, 'reset', v_count);
end;
$$;

/**
 * Quiet hours, saved.
 *
 * `HH:MM` in, `time` stored, and an explicit refusal of a window whose ends are equal — a zero-length window
 * is almost always a typo where the user meant "off", and there is a switch for that.
 */
create or replace function public.cmd_update_notification_settings(
  p_actor uuid,
  p_quiet_hours_enabled boolean,
  p_quiet_start text default '22:00',
  p_quiet_end text default '06:00',
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
  v_start time;
  v_end time;
  v_before jsonb;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  if coalesce(p_quiet_start, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or coalesce(p_quiet_end, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'VALIDATION_FAILED: quiet hours must be HH:MM (got % and %)', p_quiet_start, p_quiet_end
      using errcode = '22023';
  end if;

  v_start := p_quiet_start::time;
  v_end := p_quiet_end::time;
  if v_start = v_end then
    raise exception 'VALIDATION_FAILED: quiet hours cannot start and end at the same time'
      using errcode = '22023';
  end if;

  select jsonb_build_object(
           'quietHoursEnabled', s.quiet_hours_enabled,
           'quietStart', to_char(s.quiet_start, 'HH24:MI'),
           'quietEnd', to_char(s.quiet_end, 'HH24:MI')
         )
    into v_before
    from public.notification_settings s
   where s.user_id = v_uid;

  insert into public.notification_settings (user_id, quiet_hours_enabled, quiet_start, quiet_end)
  values (v_uid, coalesce(p_quiet_hours_enabled, true), v_start, v_end)
  on conflict (user_id) do update
    set quiet_hours_enabled = excluded.quiet_hours_enabled,
        quiet_start = excluded.quiet_start,
        quiet_end = excluded.quiet_end,
        updated_at = now();

  perform app.write_audit(
    v_uid, 'notification.settings', 'notification_settings', v_uid::text, v_before,
    jsonb_build_object(
      'quietHoursEnabled', coalesce(p_quiet_hours_enabled, true),
      'quietStart', to_char(v_start, 'HH24:MI'),
      'quietEnd', to_char(v_end, 'HH24:MI')
    ),
    null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'quietHoursEnabled', coalesce(p_quiet_hours_enabled, true),
    'quietStart', to_char(v_start, 'HH24:MI'),
    'quietEnd', to_char(v_end, 'HH24:MI'),
    'timezone', app.notification_timezone()
  );
end;
$$;

/**
 * Register this device.
 *
 * The token is unique, not (user, token): a shared phone that changes hands must receive the *new* user's
 * push and not the previous one's, so re-registering moves the row rather than duplicating it.
 */
create or replace function public.cmd_register_device_token(
  p_actor uuid,
  p_platform text,
  p_token text,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if coalesce(p_platform, '') not in ('ios', 'android', 'web') then
    raise exception 'VALIDATION_FAILED: platform must be ios, android or web (got %)', p_platform
      using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_token, ''))) < 8 then
    raise exception 'VALIDATION_FAILED: a device token is at least 8 characters' using errcode = '22023';
  end if;

  insert into public.device_tokens (user_id, platform, token)
  values (v_uid, p_platform, btrim(p_token))
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        last_seen_at = now(),
        revoked_at = null
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'platform', p_platform);
end;
$$;

create or replace function public.cmd_revoke_device_token(
  p_actor uuid,
  p_id uuid,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  update public.device_tokens dt
     set revoked_at = now()
   where dt.id = p_id and dt.user_id = v_uid and dt.revoked_at is null;

  if not found then
    raise exception 'NOT_FOUND: no live device % for this account', p_id using errcode = 'P0002';
  end if;

  return jsonb_build_object('id', p_id, 'revoked', true);
end;
$$;

/**
 * The inbox, with the delivery trail attached.
 *
 * Cursor-paged by `created_at` rather than offset: a notification arriving between two page loads must not
 * push an item from page 1 to page 2 unseen. `unread` counts the whole inbox, not the page.
 */
create or replace function public.cmd_list_notifications(
  p_actor uuid,
  p_limit integer default 30,
  p_before timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_items jsonb;
  v_next timestamptz;
  v_unread integer;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id,
           'kind', x.kind,
           'titleKey', x.title_key,
           'params', x.params,
           'link', x.link,
           'priority', x.priority,
           'readAt', x.read_at,
           'createdAt', x.created_at,
           'channels', x.channels
         ) order by x.created_at desc), '[]'::jsonb),
         min(x.created_at)
    into v_items, v_next
    from (
      select n.id, n.kind, n.title_key, n.params, n.link, n.priority, n.read_at, n.created_at,
             (select jsonb_object_agg(d.channel, d.status)
                from public.notification_deliveries d
               where d.notification_id = n.id) as channels
        from public.notifications n
       where n.user_id = v_uid
         and (p_before is null or n.created_at < p_before)
       order by n.created_at desc
       limit v_limit
    ) x;

  select count(*)::int into v_unread
    from public.notifications n
   where n.user_id = v_uid and n.read_at is null;

  return jsonb_build_object(
    'items', v_items,
    'unread', v_unread,
    'nextCursor', case when jsonb_array_length(v_items) = v_limit then v_next else null end
  );
end;
$$;

/** Support's view: is the pipeline healthy, and what is stuck. Platform staff and finance only. */
create or replace function public.cmd_get_notification_health(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.is_finance(v_uid) then
    raise exception 'FORBIDDEN: notification health is a staff view' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'since', now() - interval '7 days',
    'byChannel', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'channel', c.channel, 'status', c.status, 'count', c.n
             ) order by c.channel, c.status), '[]'::jsonb)
        from (
          select d.channel, d.status, count(*)::int as n
            from public.notification_deliveries d
           where d.created_at >= now() - interval '7 days'
           group by d.channel, d.status
        ) c
    ),
    'dead', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'deliveryId', d.id, 'notificationId', d.notification_id, 'channel', d.channel,
               'attempts', d.attempts, 'lastError', d.last_error, 'createdAt', d.created_at
             ) order by d.created_at desc), '[]'::jsonb)
        from (
          select * from public.notification_deliveries
           where status = 'dead'
           order by created_at desc
           limit 20
        ) d
    ),
    'pending', (
      select count(*)::int from public.notification_deliveries where status in ('pending', 'sending')
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Saved searches
-- ---------------------------------------------------------------------------

/**
 * The filters a saved search may hold — the same vocabulary the marketplace accepts.
 *
 * Rejected rather than ignored: a typo'd key (`price_max`) that is silently dropped turns into an alert that
 * fires for every trip in the country, which teaches the user to switch alerts off.
 */
create or replace function app.saved_search_filters_valid(p_filters jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_filters is not null
     and jsonb_typeof(p_filters) = 'object'
     and not exists (
       select 1 from jsonb_object_keys(p_filters) k
        where k not in ('q', 'origin', 'destination', 'gender', 'booking',
                        'direct', 'priceMax', 'dateFrom', 'dateTo')
     )
     and (not (p_filters ? 'q') or jsonb_typeof(p_filters -> 'q') = 'string')
     and (not (p_filters ? 'priceMax') or jsonb_typeof(p_filters -> 'priceMax') = 'number')
     and (not (p_filters ? 'direct') or jsonb_typeof(p_filters -> 'direct') = 'boolean')
     and (not (p_filters ? 'origin') or jsonb_typeof(p_filters -> 'origin') = 'array')
     and (not (p_filters ? 'destination') or jsonb_typeof(p_filters -> 'destination') = 'array');
$$;

/**
 * Save this search — once.
 *
 * The fingerprint is the canonical jsonb text, so the same predicate saved twice updates the existing row
 * instead of creating a second subscription that alerts separately for every match.
 */
create or replace function public.cmd_save_search(
  p_actor uuid,
  p_filters jsonb,
  p_label text default null,
  p_notify boolean default true,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
  v_fingerprint text;
  v_id uuid;
  v_created boolean := false;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.saved_search_filters_valid(p_filters) then
    raise exception 'VALIDATION_FAILED: unsupported search filters' using errcode = '22023';
  end if;

  v_fingerprint := md5(p_filters::text);

  insert into public.saved_searches (user_id, label, filters, notify, fingerprint)
  values (v_uid, nullif(btrim(coalesce(p_label, '')), ''), p_filters, coalesce(p_notify, true), v_fingerprint)
  on conflict (user_id, fingerprint) do nothing
  returning id into v_id;

  if v_id is null then
    select s.id into v_id
      from public.saved_searches s
     where s.user_id = v_uid and s.fingerprint = v_fingerprint;
    update public.saved_searches s
       set notify = coalesce(p_notify, s.notify),
           label = coalesce(nullif(btrim(coalesce(p_label, '')), ''), s.label),
           updated_at = now()
     where s.id = v_id;
  else
    v_created := true;
  end if;

  perform app.write_audit(
    v_uid, 'search.saved', 'saved_search', v_id::text, null,
    jsonb_build_object('filters', p_filters, 'notify', coalesce(p_notify, true), 'created', v_created),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('id', v_id, 'created', v_created);
end;
$$;

create or replace function public.cmd_list_saved_searches(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  return jsonb_build_object('items', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', s.id,
             'label', s.label,
             'filters', s.filters,
             'notify', s.notify,
             'matches', (select count(*)::int from public.saved_search_matches m where m.saved_search_id = s.id),
             'lastMatchedAt', s.last_matched_at,
             'createdAt', s.created_at
           ) order by s.created_at desc), '[]'::jsonb)
      from public.saved_searches s
     where s.user_id = v_uid
  ));
end;
$$;

create or replace function public.cmd_update_saved_search(
  p_actor uuid,
  p_id uuid,
  p_notify boolean default null,
  p_label text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  update public.saved_searches s
     set notify = coalesce(p_notify, s.notify),
         label = coalesce(nullif(btrim(coalesce(p_label, '')), ''), s.label),
         updated_at = now()
   where s.id = p_id and s.user_id = v_uid;

  if not found then
    raise exception 'NOT_FOUND: no saved search % for this account', p_id using errcode = 'P0002';
  end if;

  return jsonb_build_object('id', p_id, 'updated', true);
end;
$$;

create or replace function public.cmd_delete_saved_search(
  p_actor uuid,
  p_id uuid,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := coalesce(p_actor, app.uid());
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  delete from public.saved_searches s where s.id = p_id and s.user_id = v_uid;

  if not found then
    raise exception 'NOT_FOUND: no saved search % for this account', p_id using errcode = 'P0002';
  end if;

  perform app.write_audit(
    v_uid, 'search.deleted', 'saved_search', p_id::text, null, null, null, p_request_id, p_ip
  );

  return jsonb_build_object('id', p_id, 'deleted', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. The jobs
-- ---------------------------------------------------------------------------
--
-- All five are ordinary functions granted to `service_role` only, called by the `dispatch` edge action. There
-- is no scheduler in this repo yet (Phase 12 debt, shared with the finance jobs): the caller decides when,
-- and every job is idempotent because each notification carries a dedupe key.

/**
 * The saved-search alert: one message per new matching trip, never per refresh.
 *
 * "New" means published after the search was saved (or after the last alert), which is why the join goes to
 * `trips.published_at` and not to the projection's `updated_at` — a seat sale must not resurrect a trip the
 * user has already been told about. The match table is the second guard, and the only one that has to be
 * correct: it makes the job safe to run every minute.
 */
create or replace function public.cmd_match_saved_searches(
  p_actor uuid,
  p_limit integer default 200,
  p_per_search integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_per_search integer := least(greatest(coalesce(p_per_search, 3), 1), 10);
  v_search record;
  v_trip record;
  v_matches integer := 0;
  v_new integer;
  v_searches integer := 0;
  v_locale text;
begin
  for v_search in
    select s.id, s.user_id, s.filters, s.created_at,
           coalesce(s.last_matched_at, s.created_at) as since
      from public.saved_searches s
     where s.notify
     order by coalesce(s.last_matched_at, s.created_at)
     limit v_limit
  loop
    v_new := 0;
    select coalesce(p.preferred_language, 'ar') into v_locale
      from public.profiles p where p.id = v_search.user_id;

    for v_trip in
      select t.trip_id, tr.code, t.departure_at, t.price_from_yer, t.seats_available,
             og.name_ar as origin_ar, coalesce(og.name_en, og.name_ar) as origin_en,
             dg.name_ar as destination_ar, coalesce(dg.name_en, dg.name_ar) as destination_en
        from public.trips_search t
        join public.trips tr on tr.id = t.trip_id
        join public.governorates og on og.id = t.origin_governorate_id
        join public.governorates dg on dg.id = t.destination_governorate_id
       where t.is_public
         and t.status = 'published'
         and t.departure_at > now()
         and tr.published_at >= v_search.since
         and app.trip_matches(t, v_search.filters, null)
         and not exists (
           select 1 from public.saved_search_matches m
            where m.saved_search_id = v_search.id and m.trip_id = t.trip_id
         )
       order by t.departure_at
       limit v_per_search
    loop
      insert into public.saved_search_matches (saved_search_id, trip_id)
      values (v_search.id, v_trip.trip_id)
      on conflict (saved_search_id, trip_id) do nothing;

      if found then
        v_new := v_new + 1;
        if (app.enqueue_notification(
          v_search.user_id,
          'saved_search_match',
          'notifications.savedSearchMatch',
          jsonb_build_object(
            'tripCode', v_trip.code,
            'origin', case when v_locale = 'ar' then v_trip.origin_ar else v_trip.origin_en end,
            'destination', case when v_locale = 'ar' then v_trip.destination_ar else v_trip.destination_en end,
            'departureAt', to_char(v_trip.departure_at at time zone app.notification_timezone(), 'YYYY-MM-DD"T"HH24:MI'),
            'price', v_trip.price_from_yer,
            'seats', v_trip.seats_available
          ),
          '/trips/' || v_trip.code,
          'search:' || v_search.id::text || ':' || v_trip.trip_id::text
        ) ->> 'created')::boolean then
          v_matches := v_matches + 1;
        end if;
      end if;
    end loop;

    -- The window moves only when something was actually sent. A search that matched nothing today must still
    -- catch a trip published ten minutes ago, which a blanket `last_matched_at = now()` would skip.
    if v_new > 0 then
      update public.saved_searches s set last_matched_at = now() where s.id = v_search.id;
    end if;
    v_searches := v_searches + 1;
  end loop;

  return jsonb_build_object('searches', v_searches, 'matches', v_matches);
end;
$$;

/**
 * "Your trip leaves in about a day."
 *
 * Bookings whose trip departs inside a one-hour band around the lead time, accepted and not cancelled. The
 * band (rather than `= now() + 24h`) is what makes the job runnable every five minutes without gaps or
 * double sends: the dedupe key covers the overlap, and the band covers a slow scheduler.
 */
create or replace function public.cmd_send_trip_reminders(
  p_actor uuid,
  p_hours integer default 24,
  p_band interval default '1 hour'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hours integer := least(greatest(coalesce(p_hours, 24), 1), 72);
  v_center timestamptz := now() + make_interval(hours => v_hours);
  v_sent integer := 0;
  v_row record;
  v_locale text;
begin
  for v_row in
    select b.id as booking_id, b.code as booking_code, b.passenger_id,
           t.code as trip_code, t.departure_at, t.origin_governorate_id, t.destination_governorate_id
      from public.bookings b
      join public.trips t on t.id = b.trip_id
     where b.status = 'accepted'
       and t.status in ('published', 'in_progress')
       and t.departure_at between v_center - (p_band / 2) and v_center + (p_band / 2)
       and not exists (
         select 1 from public.notifications n
          where n.user_id = b.passenger_id
            and n.dedupe_key = 'trip:' || b.id::text || ':' || v_hours::text || 'h'
       )
  loop
    select coalesce(p.preferred_language, 'ar') into v_locale
      from public.profiles p where p.id = v_row.passenger_id;

    if (app.enqueue_notification(
      v_row.passenger_id,
      'trip_reminder',
      'notifications.tripReminder',
      jsonb_build_object(
        'tripCode', v_row.trip_code,
        'bookingCode', v_row.booking_code,
        'hours', v_hours,
        'origin', (select case when v_locale = 'ar' then g.name_ar else coalesce(g.name_en, g.name_ar) end
                     from public.governorates g where g.id = v_row.origin_governorate_id),
        'destination', (select case when v_locale = 'ar' then g.name_ar else coalesce(g.name_en, g.name_ar) end
                          from public.governorates g where g.id = v_row.destination_governorate_id),
        'departureAt', to_char(v_row.departure_at at time zone app.notification_timezone(), 'YYYY-MM-DD"T"HH24:MI')
      ),
      '/bookings/' || v_row.booking_code,
      'trip:' || v_row.booking_id::text || ':' || v_hours::text || 'h'
    ) ->> 'created')::boolean then
      v_sent := v_sent + 1;
    end if;
  end loop;

  return jsonb_build_object('sent', v_sent);
end;
$$;

/**
 * Quota warnings at 80% and 100%, once per metric per period.
 *
 * The period is the month in Aden time, which is what "this month's exports" means to an operator. Both
 * thresholds carry their own dedupe key, so a metric that crosses 80 % stays warned while it climbs, and
 * then gets exactly one more message when it runs out.
 */
create or replace function public.cmd_notify_quota_thresholds(
  p_actor uuid,
  p_period text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period text := coalesce(
    p_period, to_char(now() at time zone app.notification_timezone(), 'YYYY-MM')
  );
  v_owner record;
  v_metric text;
  v_state jsonb;
  v_limit integer;
  v_used integer;
  v_pct integer;
  v_threshold integer;
  v_sent integer := 0;
  v_recipients uuid[];
  v_recipient uuid;
  v_metrics text[];
begin
  select array_agg(distinct l.metric order by l.metric) into v_metrics from public.plan_limits l;

  for v_owner in
    select s.owner_user_id as user_id, s.owner_org_id as org_id
      from public.subscriptions s
     where s.status in ('trialing', 'active', 'past_due', 'grace')
     order by s.created_at
  loop
    v_recipients := array[]::uuid[];
    if v_owner.org_id is not null then
      select coalesce(array_agg(m.user_id), array[]::uuid[]) into v_recipients
        from public.organization_members m
       where m.org_id = v_owner.org_id and m.role in ('owner', 'manager') and m.status = 'active';
    end if;
    if v_owner.user_id is not null then
      v_recipients := v_recipients || v_owner.user_id;
    end if;

    foreach v_metric in array v_metrics loop
      v_state := app.quota_state(v_owner.user_id, v_owner.org_id, v_metric);
      v_limit := (v_state ->> 'limit')::integer;
      v_used := (v_state ->> 'used')::integer;

      continue when v_limit is null or v_limit = 0;

      v_pct := (v_used * 100) / v_limit;
      v_threshold := case when v_pct >= 100 then 100 when v_pct >= 80 then 80 else null end;
      continue when v_threshold is null;

      foreach v_recipient in array v_recipients loop
        if (app.enqueue_notification(
          v_recipient,
          'quota_threshold',
          case when v_threshold >= 100
            then 'notifications.quotaReached'
            else 'notifications.quotaWarning'
          end,
          jsonb_build_object(
            'metric', v_metric,
            'used', v_used,
            'limit', v_limit,
            'percent', least(v_pct, 100),
            'threshold', v_threshold,
            'period', v_period
          ),
          '/operator/billing',
          'quota:' || coalesce(v_owner.org_id, v_owner.user_id)::text || ':'
            || v_metric || ':' || v_threshold::text || ':' || v_period
        ) ->> 'created')::boolean then
          v_sent := v_sent + 1;
        end if;
      end loop;
    end loop;
  end loop;

  return jsonb_build_object('period', v_period, 'sent', v_sent);
end;
$$;

/**
 * Seven, three and one day before a period (or a trial) ends.
 *
 * Keyed by subscription and *period end*, so a renewal that extends the period makes the next reminders a new
 * set rather than a suppressed repeat.
 */
create or replace function public.cmd_notify_subscription_expiring(p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub record;
  v_ends timestamptz;
  v_days integer;
  v_sent integer := 0;
  v_recipients uuid[];
  v_recipient uuid;
begin
  for v_sub in
    select s.id, s.owner_user_id, s.owner_org_id, s.status,
           coalesce(s.trial_ends_at, s.current_period_end) as ends_on
      from public.subscriptions s
     where s.status in ('trialing', 'active', 'past_due', 'grace')
       and s.cancel_at_period_end = false
  loop
    v_ends := v_sub.ends_on;
    v_days := (v_ends at time zone app.notification_timezone())::date
              - (now() at time zone app.notification_timezone())::date;

    continue when v_days not in (7, 3, 1);

    v_recipients := array[]::uuid[];
    if v_sub.owner_org_id is not null then
      select coalesce(array_agg(m.user_id), array[]::uuid[]) into v_recipients
        from public.organization_members m
       where m.org_id = v_sub.owner_org_id and m.role in ('owner', 'manager') and m.status = 'active';
    end if;
    if v_sub.owner_user_id is not null then
      v_recipients := v_recipients || v_sub.owner_user_id;
    end if;

    foreach v_recipient in array v_recipients loop
      if (app.enqueue_notification(
        v_recipient,
        'subscription_expiring',
        case v_days
          when 7 then 'notifications.subscriptionExpiring7'
          when 3 then 'notifications.subscriptionExpiring3'
          else 'notifications.subscriptionExpiring1'
        end,
        jsonb_build_object(
          'days', v_days,
          'status', v_sub.status,
          'endsAt', to_char(v_ends at time zone app.notification_timezone(), 'YYYY-MM-DD')
        ),
        '/operator/billing',
        'subscription:' || v_sub.id::text || ':' || to_char(v_ends, 'YYYYMMDD') || ':' || v_days::text
      ) ->> 'created')::boolean then
        v_sent := v_sent + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('sent', v_sent);
end;
$$;

/**
 * The queue nobody is looking at.
 *
 * Verification requests older than the SLA, one message per request per day to the platform staff on duty.
 * The daily dedupe is deliberate: an ageing request is a nag, not an alarm, and a nag that arrives hourly is
 * a nag people filter out.
 */
create or replace function public.cmd_notify_pending_verifications(
  p_actor uuid,
  p_sla interval default '48 hours'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request record;
  v_staff uuid;
  v_sent integer := 0;
  v_day text := to_char(now() at time zone app.notification_timezone(), 'YYYYMMDD');
begin
  for v_request in
    select r.id, r.subject_type, r.subject_id, r.created_at
      from public.verification_requests r
     where r.status = 'pending'
       and r.created_at < now() - p_sla
  loop
    for v_staff in
      select distinct ur.user_id
        from public.user_roles ur
       where ur.role in ('platform_staff', 'platform_admin') and ur.revoked_at is null
    loop
      if (app.enqueue_notification(
        v_staff,
        'verification_sla',
        'notifications.verificationSla',
        jsonb_build_object(
          'subjectType', v_request.subject_type,
          'ageHours', floor(extract(epoch from (now() - v_request.created_at)) / 3600)::int
        ),
        '/staff/verification',
        'verification-sla:' || v_request.id::text || ':' || v_day
      ) ->> 'created')::boolean then
        v_sent := v_sent + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('sent', v_sent);
end;
$$;

/**
 * Rescue, then re-arm what died.
 *
 * Two different problems, one job: a claim that never returned (rescue) and a delivery that exhausted its
 * attempts but may still be worth one more try a day later — a provider outage is not a permanent failure.
 * Reviving resets `attempts`, so the retry schedule starts over rather than immediately dying again.
 */
create or replace function public.cmd_retry_notifications(
  p_actor uuid,
  p_max_age interval default '7 days'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rescued integer;
  v_skipped integer;
  v_revived integer;
begin
  v_rescued := app.rescue_stuck_deliveries();
  v_skipped := app.skip_undeliverable();

  update public.notification_deliveries d
     set status = 'failed', attempts = 0, next_attempt_at = now(), last_error = 'revived'
   where d.status = 'dead'
     and d.created_at > now() - p_max_age
     and d.created_at < now() - interval '1 day';

  get diagnostics v_revived = row_count;

  return jsonb_build_object('rescued', v_rescued, 'skipped', v_skipped, 'revived', v_revived);
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Access
-- ---------------------------------------------------------------------------
--
-- Reads go through the commands above, which take an explicit actor and answer for that actor only. That is
-- stricter than the row-level policies the tables would otherwise need, and it keeps the delivery trail
-- (provider errors, tokens) out of a client's reach entirely. RLS is still switched on so a future grant
-- cannot turn into an accidental exposure.

alter table public.notification_settings enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.device_tokens enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.notification_delivery_attempts enable row level security;
alter table public.saved_searches enable row level security;
alter table public.saved_search_matches enable row level security;
alter table public.notification_events enable row level security;

alter table public.notification_settings force row level security;
alter table public.notification_preferences force row level security;
alter table public.device_tokens force row level security;
alter table public.notification_deliveries force row level security;
alter table public.notification_delivery_attempts force row level security;
alter table public.saved_searches force row level security;
alter table public.saved_search_matches force row level security;
alter table public.notification_events force row level security;

-- The catalogue is reference data, not personal: a signed-in client may read it so the preferences screen can
-- label an event before the command answers.
create policy notification_events_read_authenticated on public.notification_events
  for select to authenticated using (true);

-- Own rows, for the tables where a direct read is genuinely the caller's own data and nothing else.
create policy notification_settings_read_own on public.notification_settings
  for select to authenticated using (user_id = app.uid());

create policy notification_preferences_read_own on public.notification_preferences
  for select to authenticated using (user_id = app.uid());

create policy device_tokens_read_own on public.device_tokens
  for select to authenticated using (user_id = app.uid());

create policy saved_searches_read_own on public.saved_searches
  for select to authenticated using (user_id = app.uid());

create policy notification_deliveries_read_own on public.notification_deliveries
  for select to authenticated using (user_id = app.uid());

-- No INSERT/UPDATE/DELETE policies anywhere: writes are the commands' job, and `force row level security`
-- means even the table owner is subject to that. The edge function goes through `service_role`.

grant select on public.notification_events to authenticated;
grant select on public.notification_settings to authenticated;
grant select on public.notification_preferences to authenticated;
grant select on public.device_tokens to authenticated;
grant select on public.saved_searches to authenticated;
grant select on public.notification_deliveries to authenticated;

revoke all on function app.enqueue_notification(
  uuid, public.notification_kind, text, jsonb, text, text, public.notification_priority, timestamptz
) from public, anon, authenticated;
revoke all on function app.notify(uuid, public.notification_kind, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function app.in_quiet_hours(uuid, timestamptz) from public, anon, authenticated;
revoke all on function app.quiet_resume_at(uuid, timestamptz) from public, anon, authenticated;
revoke all on function app.channel_enabled(uuid, public.notification_kind, public.notification_channel)
  from public, anon, authenticated;
revoke all on function app.rescue_stuck_deliveries(interval) from public, anon, authenticated;
revoke all on function app.skip_undeliverable(public.notification_channel) from public, anon, authenticated;
revoke all on function app.notification_backoff(integer) from public, anon, authenticated;
revoke all on function app.notification_max_attempts() from public, anon, authenticated;
revoke all on function app.notification_timezone() from public, anon, authenticated;
revoke all on function app.saved_search_filters_valid(jsonb) from public, anon, authenticated;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.cmd_claim_notifications(uuid, integer, text, inet)',
    'public.cmd_record_notification_delivery(uuid, uuid, text, text, text, text, inet)',
    'public.cmd_get_notification_settings(uuid)',
    'public.cmd_set_notification_preference(uuid, public.notification_kind, public.notification_channel, boolean, text, inet)',
    'public.cmd_reset_notification_preference(uuid, public.notification_kind, text, inet)',
    'public.cmd_update_notification_settings(uuid, boolean, text, text, text, inet)',
    'public.cmd_register_device_token(uuid, text, text, text, inet)',
    'public.cmd_revoke_device_token(uuid, uuid, text, inet)',
    'public.cmd_list_notifications(uuid, integer, timestamptz)',
    'public.cmd_get_notification_health(uuid)',
    'public.cmd_save_search(uuid, jsonb, text, boolean, text, inet)',
    'public.cmd_list_saved_searches(uuid)',
    'public.cmd_update_saved_search(uuid, uuid, boolean, text, text, inet)',
    'public.cmd_delete_saved_search(uuid, uuid, text, inet)',
    'public.cmd_match_saved_searches(uuid, integer, integer)',
    'public.cmd_send_trip_reminders(uuid, integer, interval)',
    'public.cmd_notify_quota_thresholds(uuid, text)',
    'public.cmd_notify_subscription_expiring(uuid)',
    'public.cmd_notify_pending_verifications(uuid, interval)',
    'public.cmd_retry_notifications(uuid, interval)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

-- No `authenticated` grant on any command in this phase: the gateway resolves the caller from the JWT and
-- passes it as the actor, so a client cannot name somebody else. The policies above remain as a second line,
-- and as the answer to "what happens if somebody grants SELECT here later".

-- ---------------------------------------------------------------------------
-- 14. Comments for the next reader
-- ---------------------------------------------------------------------------

comment on table public.notifications is
  'One row per (user, event): the title key and its values, never rendered text. Phase 11 adds priority and a dedupe key.';
comment on table public.notification_deliveries is
  'The decision for every event x channel, plus the attempt counter. A skipped row is a decision, not a failure.';
comment on table public.notification_delivery_attempts is
  'One row per transport attempt, including the failures. The dead-letter trail support reads.';
comment on table public.device_tokens is
  'Expo push tokens. Unique per token: re-registering moves a device to the newest user.';
comment on table public.notification_events is
  'The event catalogue: default channels, priority and the canonical template keys.';
comment on table public.saved_searches is
  'A marketplace predicate the user wants to be told about. Fingerprinted so the same search cannot be saved twice.';

comment on function public.cmd_claim_notifications(uuid, integer, text, inet) is
  'Worker: hands out due deliveries, marks them sending, and never hands the same row to two workers.';
comment on function public.cmd_record_notification_delivery(uuid, uuid, text, text, text, text, inet) is
  'Worker: records the outcome and schedules the backoff. Five failures is dead, and dead is visible.';
comment on function public.cmd_match_saved_searches(uuid, integer, integer) is
  'Job: alerts once per (search, trip). Safe to run every minute.';
comment on function public.cmd_send_trip_reminders(uuid, integer, interval) is
  'Job: the day-before reminder, in a band around the lead time so a slow scheduler leaves no gap.';
comment on function public.cmd_notify_quota_thresholds(uuid, text) is
  'Job: 80% and 100% usage warnings, once per metric per threshold per month.';
comment on function public.cmd_notify_subscription_expiring(uuid) is
  'Job: 7, 3 and 1 day warnings, keyed by the period end so a renewal re-arms them.';
comment on function public.cmd_notify_pending_verifications(uuid, interval) is
  'Job: ages the verification queue out loud, once a day per request.';
comment on function public.cmd_retry_notifications(uuid, interval) is
  'Job: rescues abandoned claims, skips undeliverable pushes, re-arms day-old dead letters.';
