-- ===========================================================================
-- Phase 5 — Bookings, passenger data and requests
-- ===========================================================================
--
-- A booking is a *transaction*, not a row: seats are held the moment a passenger asks, the fare is
-- recomputed from the trip (never trusted from the client), and every state change either releases a
-- seat or keeps it. The four rules this file exists to make true:
--
--   * **Two people, one seat.** A seat is only sold once. `cmd_create_booking` locks the trip row before
--     it counts, so the second of two simultaneous requests for the last seat gets `NO_SEATS_LEFT`
--     rather than a refund conversation.
--   * **Holds expire.** A request nobody answers releases its seats after 30 minutes (BR-10), by cron
--     or lazily on the next booking — both paths call the same function.
--   * **Passenger identity is a document, and documents leak.** The ID photo lives in a private bucket,
--     is readable only by the passenger, the trip's operator and platform staff, every read is logged,
--     and the only URL the app ever mints is a 5-minute signed one.
--   * **A cancellation is arithmetic.** `app.compute_refund()` is the single place a refund amount is
--     decided, mirrored by `computeRefund()` in `@maak/core` and pinned by parity tests in both suites.
--
-- Prices: integer minor units (YER exponent 0). No floats anywhere, here or in TypeScript.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

create type public.booking_status as enum (
  'pending',                 -- a request with a live seat hold, waiting for the operator
  'accepted',
  'rejected',
  'expired',                 -- the hold ran out before the operator answered
  'cancelled_by_passenger',
  'cancelled_by_operator',
  'no_show',
  'completed'
);

create type public.id_document_type as enum ('national_id', 'passport', 'iqama', 'other');

create type public.booking_payment_status as enum ('unpaid', 'deposit_paid', 'paid', 'refunded');

create type public.booking_event_kind as enum (
  'created', 'accepted', 'rejected', 'cancelled', 'expired', 'no_show', 'completed', 'document_shared'
);

create type public.document_access_kind as enum ('owner', 'operator', 'staff', 'share_link');

-- The four booking notifications. `add value` (not a type rewrite) so existing rows keep their meaning.
alter type public.notification_kind add value if not exists 'booking_requested';
alter type public.notification_kind add value if not exists 'booking_accepted';
alter type public.notification_kind add value if not exists 'booking_rejected';
alter type public.notification_kind add value if not exists 'booking_cancelled';

-- ---------------------------------------------------------------------------
-- 2. Bookings
-- ---------------------------------------------------------------------------

create table public.bookings (
  id                      uuid primary key default gen_random_uuid(),
  -- Short human reference for a support conversation: BK-7F3A9C.
  code                    text not null unique,
  trip_id                 uuid not null references public.trips (id) on delete restrict,
  passenger_id            uuid not null references public.profiles (id) on delete restrict,
  -- Who made the booking. The same as the passenger today; Phase 9 adds agents booking for others.
  booked_by               uuid not null references public.profiles (id) on delete restrict,

  status                  public.booking_status not null default 'pending',
  seats                   smallint not null check (seats between 1 and 8),

  origin_stop_id          uuid references public.trip_stops (id) on delete restrict,
  destination_stop_id     uuid references public.trip_stops (id) on delete restrict,
  -- Where the passenger gets on and off, as a destination sequence — the same key `app.trip_total()`
  -- prices by. Copied at booking time so a later stop edit cannot silently re-price a sold seat.
  destination_seq         smallint,

  -- Money, all in the trip's currency (YER, exponent 0). Recomputed by the command; the client's
  -- number is a claim that must match, never an input (ADR-24).
  currency                char(3) not null default 'YER',
  unit_price_yer          integer not null check (unit_price_yer >= 0),
  subtotal_yer            integer not null check (subtotal_yer >= 0),
  discount_yer            integer not null default 0 check (discount_yer >= 0),
  total_yer               integer not null check (total_yer >= 0),
  refund_yer              integer not null default 0 check (refund_yer >= 0),
  payment_status          public.booking_payment_status not null default 'unpaid',

  -- Passenger-supplied identity for this trip. The ID *image* lives in `passenger_documents`.
  contact_name            text not null check (length(btrim(contact_name)) between 2 and 120),
  contact_phone           text not null check (length(btrim(contact_phone)) between 6 and 20),
  passenger_gender        text check (passenger_gender in ('male', 'female')),
  note                    text check (note is null or length(note) <= 500),

  -- BR-10: a request holds its seats for 30 minutes. NULL once the booking is no longer holding.
  hold_expires_at         timestamptz,
  accepted_at             timestamptz,
  decided_by              uuid references public.profiles (id) on delete set null,
  reject_reason           text,
  cancelled_at            timestamptz,
  cancelled_by            uuid references public.profiles (id) on delete set null,
  cancel_reason           text,
  completed_at            timestamptz,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint bookings_code_shape check (code ~ '^BK-[A-Z0-9]{6}$'),
  constraint bookings_total_adds_up check (total_yer = subtotal_yer - discount_yer),
  constraint bookings_stops_differ check (
    origin_stop_id is null or destination_stop_id is null or origin_stop_id <> destination_stop_id
  ),
  constraint bookings_hold_while_pending check (status <> 'pending' or hold_expires_at is not null),
  constraint bookings_reject_reason check (status <> 'rejected' or reject_reason is not null)
);

create index bookings_trip_idx on public.bookings (trip_id, status);
create index bookings_passenger_idx on public.bookings (passenger_id, created_at desc);
create index bookings_hold_idx on public.bookings (hold_expires_at) where status = 'pending';

-- One live booking per passenger per trip. A second request for the same seat is a mistake or an
-- attempt to hold inventory, and either way the answer is no — with a code the UI can explain.
create unique index bookings_one_active_per_trip
  on public.bookings (trip_id, passenger_id)
  where status in ('pending', 'accepted');

create trigger bookings_set_updated_at
  before update on public.bookings
  for each row execute function app.set_updated_at();

comment on column public.bookings.hold_expires_at is
  'BR-10: pending requests hold seats until this timestamp. Expiry is handled by cmd_expire_booking_holds().';
comment on column public.bookings.destination_seq is
  'Copied from trip_stops at booking time; the price was computed against it and must not drift.';

-- ---------------------------------------------------------------------------
-- 3. Passenger documents (the ID image)
-- ---------------------------------------------------------------------------

create table public.passenger_documents (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null unique references public.bookings (id) on delete cascade,
  id_type       public.id_document_type not null,
  id_number     text not null check (length(btrim(id_number)) between 4 and 40),
  birth_place   text check (birth_place is null or length(btrim(birth_place)) between 2 and 120),
  birth_date    date check (birth_date is null or birth_date > date '1900-01-01'),
  -- Object path in the private `passenger-ids` bucket, `<booking_id>/<file>`.
  photo_path    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger passenger_documents_set_updated_at
  before update on public.passenger_documents
  for each row execute function app.set_updated_at();

comment on table public.passenger_documents is
  'ID material for one booking. Readable by the passenger, the trip operator and platform staff; every read goes through log_document_access().';

-- Every read of an ID document leaves a row. Written by `log_document_access()` (a read with one
-- side effect) and by `resolve_id_share_token()`; never writable from a client.
create table public.document_access_log (
  id          bigint generated always as identity primary key,
  booking_id  uuid not null references public.bookings (id) on delete cascade,
  actor_id    uuid references public.profiles (id) on delete set null,
  kind        public.document_access_kind not null,
  ip          inet,
  user_agent  text check (user_agent is null or length(user_agent) <= 400),
  created_at  timestamptz not null default now()
);

create index document_access_log_booking_idx on public.document_access_log (booking_id, created_at desc);
create index document_access_log_actor_idx on public.document_access_log (actor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Booking timeline and the WhatsApp share token
-- ---------------------------------------------------------------------------

create table public.booking_events (
  id          bigint generated always as identity primary key,
  booking_id  uuid not null references public.bookings (id) on delete cascade,
  kind        public.booking_event_kind not null,
  actor_id    uuid references public.profiles (id) on delete set null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index booking_events_booking_idx on public.booking_events (booking_id, created_at);

create table public.booking_share_tokens (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null references public.bookings (id) on delete cascade,
  -- 32 hex chars. Guessing one is 2^-128 work, and it expires regardless.
  token           text not null unique check (token ~ '^[0-9a-f]{32}$'),
  created_by      uuid not null references public.profiles (id) on delete cascade,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  view_count      integer not null default 0,
  last_viewed_at  timestamptz,
  created_at      timestamptz not null default now(),

  constraint booking_share_tokens_future check (expires_at > created_at)
);

create index booking_share_tokens_booking_idx on public.booking_share_tokens (booking_id, created_at desc);

comment on table public.booking_share_tokens is
  '72-hour WhatsApp link to a watermarked ID preview. The link is not the document: it resolves to a preview and an audit row.';

-- ---------------------------------------------------------------------------
-- 5. Who may see what, and how many seats are real
-- ---------------------------------------------------------------------------

/**
 * Seats sold = accepted, plus pending requests whose hold has not run out.
 *
 * Replaces the Phase 4 stub that returned `0`. Every caller is unchanged — that was the point of the
 * stub. A hold counts as sold while it lives, which is what makes a 30-minute hold mean anything.
 */
create or replace function app.trip_booked_seats(p_trip_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(b.seats), 0)::int
  from public.bookings b
  where b.trip_id = p_trip_id
    and (
      b.status = 'accepted'
      or (b.status = 'pending' and b.hold_expires_at > now())
    );
$$;

/** True when the caller is the passenger of this booking (or the account that made it). */
create or replace function app.is_booking_passenger(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.bookings b
    where b.id = p_booking_id
      and (b.passenger_id = app.uid() or b.booked_by = app.uid())
  );
$$;

/**
 * One predicate for "may this caller see this booking", used by RLS and by the document reader.
 *
 * The three audiences are the passenger, the operator who owns the trip (individual or organisation),
 * and platform staff. Nobody else — not another operator, not another passenger on the same trip.
 */
create or replace function app.can_read_booking(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.bookings b
    where b.id = p_booking_id
      and (
        b.passenger_id = app.uid()
        or b.booked_by = app.uid()
        or app.actor_can_manage_trip(app.uid(), b.trip_id)
        or app.is_platform_staff()
      )
  );
$$;

/** The operator side of the same question: who may accept, reject or cancel somebody's seat. */
create or replace function app.can_manage_booking(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.bookings b
    where b.id = p_booking_id
      and app.actor_can_manage_trip(app.uid(), b.trip_id)
  );
$$;

/**
 * BR-09 — the refund ladder, in one place.
 *
 * Mirrors `computeRefund()` with the booking policy in `packages/core/src/domain/finance.ts`:
 * ≥ 48 h → 100 %, ≥ 24 h → 75 %, ≥ 2 h → 50 %, < 2 h → nothing. Percentages are basis points, and the
 * amount is never more than what was paid. Operator cancellations do not use this function's ladder —
 * they refund in full, because the passenger did nothing wrong.
 */
create or replace function app.compute_refund(p_paid integer, p_hours_before numeric)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_bps integer := 0;
  v_amount integer;
begin
  if p_paid is null or p_paid < 0 then
    raise exception 'VALIDATION_FAILED: paid amount must be non-negative' using errcode = '22023';
  end if;
  if p_hours_before is null then
    raise exception 'VALIDATION_FAILED: hours before departure is required' using errcode = '22023';
  end if;

  if p_paid = 0 then
    return jsonb_build_object(
      'amountMinor', 0, 'eligible', false, 'appliedBasisPoints', 0, 'reason', 'nothing_paid'
    );
  end if;

  if p_hours_before >= 48 then
    v_bps := 10000;
  elsif p_hours_before >= 24 then
    v_bps := 7500;
  elsif p_hours_before >= 2 then
    v_bps := 5000;
  end if;

  if v_bps = 0 then
    return jsonb_build_object(
      'amountMinor', 0, 'eligible', false, 'appliedBasisPoints', 0, 'reason', 'outside_policy'
    );
  end if;

  v_amount := least(round(p_paid::numeric * v_bps / 10000)::int, p_paid);

  return jsonb_build_object(
    'amountMinor', v_amount,
    'eligible', true,
    'appliedBasisPoints', v_bps,
    'reason', case when v_bps = 10000 then 'full' else 'partial' end
  );
end;
$$;

/** Notifies whoever runs the trip: the individual owner, or the active owners/managers of the org. */
create or replace function app.notify_trip_managers(
  p_trip public.trips,
  p_kind public.notification_kind,
  p_title_key text,
  p_params jsonb default '{}'::jsonb,
  p_link text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_count integer := 0;
begin
  if p_trip.owner_user_id is not null then
    perform app.notify(p_trip.owner_user_id, p_kind, p_title_key, p_params, p_link);
    return 1;
  end if;

  if p_trip.owner_org_id is not null then
    for v_user in
      select m.user_id
      from public.organization_members m
      where m.org_id = p_trip.owner_org_id
        and m.status = 'active'
        and m.user_id is not null
        and m.role in ('owner', 'manager')
    loop
      perform app.notify(v_user, p_kind, p_title_key, p_params, p_link);
      v_count := v_count + 1;
    end loop;
  end if;

  return v_count;
end;
$$;

/** BK-XXXXXX. Derived from time and randomness because pgcrypto is not on the search path here. */
create or replace function app.new_booking_code()
returns text
language sql
volatile
as $$
  select 'BK-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
$$;

-- ---------------------------------------------------------------------------
-- 6. Commands — one transaction each
-- ---------------------------------------------------------------------------

/**
 * A passenger asks for seats.
 *
 * Order matters and is the whole safety story:
 *   1. lock the trip row, so two simultaneous requests are serialised (no double-sold last seat);
 *   2. recompute availability from the bookings table, not from a cached counter;
 *   3. recompute the fare from the trip and the chosen stop, and compare it with what the client showed
 *      — a fare that moved between page load and submit is `PRICE_CHANGED`, not a silent overcharge;
 *   4. insert the hold, then recompute `trips.seats_available` so the marketplace tells the truth.
 */
create or replace function public.cmd_create_booking(
  p_actor uuid,
  p_trip_id uuid,
  p_seats integer,
  p_destination_stop_id uuid,
  p_claimed_total integer,
  p_contact_name text,
  p_contact_phone text,
  p_gender text default null,
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
  v_trip public.trips%rowtype;
  v_seq smallint;
  v_seats integer := coalesce(p_seats, 1);
  v_priced_seats integer;
  v_pricing jsonb;
  v_total integer;
  v_available integer;
  v_code text;
  v_booking public.bookings%rowtype;
  v_existing public.bookings%rowtype;
  v_attempt integer := 0;
  v_constraint text;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  if v_trip.status <> 'published' then
    raise exception 'CONFLICT: this trip is not open for booking' using errcode = '23505';
  end if;

  -- A booking made at the kerb is not a booking: the operator needs time to answer and the passenger
  -- needs time to cancel. Two hours is the same line BR-09 draws for cancellation.
  if v_trip.departure_at <= now() + interval '2 hours' then
    raise exception 'CANCEL_WINDOW_CLOSED: this trip leaves in less than 2 hours' using errcode = '23505';
  end if;

  if p_contact_name is null or length(btrim(p_contact_name)) < 2 then
    raise exception 'VALIDATION_FAILED: passenger name is required' using errcode = '22023';
  end if;
  if p_contact_phone is null or length(btrim(p_contact_phone)) < 6 then
    raise exception 'VALIDATION_FAILED: a contact phone is required' using errcode = '22023';
  end if;

  if v_trip.gender_policy = 'women_only' and coalesce(p_gender, '') <> 'female' then
    raise exception 'VALIDATION_FAILED: this trip is for women only' using errcode = '22023';
  end if;
  if v_trip.gender_policy = 'men_only' and coalesce(p_gender, '') <> 'male' then
    raise exception 'VALIDATION_FAILED: this trip is for men only' using errcode = '22023';
  end if;

  -- Whole-vehicle bookings reserve the vehicle, whatever number of seats was typed.
  if v_trip.booking_mode = 'whole_trip' then
    v_seats := v_trip.seats_total;
  end if;

  if v_seats < 1 or v_seats > 8 or v_seats > v_trip.seats_total then
    raise exception 'VALIDATION_FAILED: seats must be between 1 and 8' using errcode = '22023';
  end if;

  if p_destination_stop_id is not null then
    select s.seq into v_seq
    from public.trip_stops s
    where s.id = p_destination_stop_id and s.trip_id = p_trip_id;
    if v_seq is null then
      raise exception 'VALIDATION_FAILED: that stop is not on this trip' using errcode = '22023';
    end if;
  end if;

  -- One live booking per passenger per trip — the rule `bookings_one_active_per_trip` enforces. Stated
  -- here as a check with a name, because the index alone answers "that entry already exists", which is
  -- true, useless, and arrives five random codes later (see the retry loop below).
  select * into v_existing
  from public.bookings b
  where b.trip_id = p_trip_id
    and b.passenger_id = p_actor
    and b.status in ('pending', 'accepted')
  limit 1;

  if v_existing.id is not null then
    raise exception 'ALREADY_BOOKED: booking % is already % on this trip',
      v_existing.code, v_existing.status
      using errcode = '23505';
  end if;

  v_available := app.recompute_seats_available(p_trip_id);
  if v_available < v_seats then
    raise exception 'NO_SEATS_LEFT: only % seat(s) left', v_available using errcode = '23505';
  end if;

  v_priced_seats := case when v_trip.booking_mode = 'whole_trip' then 1 else v_seats end;
  v_pricing := app.trip_total(v_trip, v_seq, v_priced_seats);
  v_total := (v_pricing ->> 'totalMinor')::int;

  if p_claimed_total is not null and p_claimed_total <> v_total then
    raise exception 'PRICE_CHANGED: the fare is now % (was %)', v_total, p_claimed_total
      using errcode = '22023';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_code := app.new_booking_code();
    begin
      insert into public.bookings (
        code, trip_id, passenger_id, booked_by, seats, origin_stop_id, destination_stop_id,
        destination_seq, unit_price_yer, subtotal_yer, discount_yer, total_yer,
        contact_name, contact_phone, passenger_gender, note, hold_expires_at
      ) values (
        -- Boarding is at the trip's origin; `origin_stop_id` stays null until a phase models mid-route pickup.
        v_code, p_trip_id, p_actor, p_actor, v_seats, null::uuid,
        p_destination_stop_id, v_seq,
        (v_pricing ->> 'unitFareMinor')::int,
        (v_pricing ->> 'subtotalMinor')::int,
        (v_pricing ->> 'discountMinor')::int,
        v_total,
        btrim(p_contact_name), btrim(p_contact_phone), p_gender, nullif(btrim(coalesce(p_note, '')), ''),
        now() + interval '30 minutes'
      )
      returning * into v_booking;
      exit;
    exception when unique_violation then
      -- Only a code collision is worth retrying: `BK-` plus six random characters will eventually
      -- collide. Every other violation here is the one-active-booking index, which the check above
      -- already turned into a sentence — retrying it just burns five codes and hides the reason.
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint <> 'bookings_code_key' or v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  perform app.recompute_seats_available(p_trip_id);

  insert into public.booking_events (booking_id, kind, actor_id, detail)
  values (v_booking.id, 'created', p_actor,
          jsonb_build_object('seats', v_seats, 'total', v_total, 'hold_minutes', 30));

  perform app.notify_trip_managers(
    v_trip, 'booking_requested', 'notifications.bookingRequested',
    jsonb_build_object('code', v_booking.code, 'tripCode', v_trip.code, 'seats', v_seats),
    '/operator/trips/' || p_trip_id::text || '/bookings'
  );

  perform app.write_audit(
    p_actor, 'booking.create', 'booking', v_booking.id::text, null,
    jsonb_build_object('trip_id', p_trip_id, 'seats', v_seats, 'total_yer', v_total),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('booking', to_jsonb(v_booking), 'seatsAvailable', app.recompute_seats_available(p_trip_id));
end;
$$;

/**
 * Records the ID material for a booking.
 *
 * Rejects a `photo_path` outside `<booking_id>/` or one that names no stored object: an approval or an
 * operator review must never point at a file that does not exist. The bucket policy enforces the same
 * folder rule at the storage layer; this check exists because a path is data and data is not trusted.
 */
create or replace function public.cmd_set_passenger_document(
  p_actor uuid,
  p_booking_id uuid,
  p_id_type public.id_document_type,
  p_id_number text,
  p_birth_place text default null,
  p_birth_date date default null,
  p_photo_path text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_document public.passenger_documents%rowtype;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then
    raise exception 'NOT_FOUND: booking' using errcode = 'P0002';
  end if;

  if v_booking.passenger_id <> p_actor then
    raise exception 'FORBIDDEN: not your booking' using errcode = '42501';
  end if;

  if v_booking.status not in ('pending', 'accepted') then
    raise exception 'CONFLICT: this booking is %', v_booking.status using errcode = '23505';
  end if;

  if p_id_number is null or length(btrim(p_id_number)) < 4 then
    raise exception 'VALIDATION_FAILED: an ID number is required' using errcode = '22023';
  end if;

  if p_photo_path is not null then
    if split_part(p_photo_path, '/', 1) <> p_booking_id::text then
      raise exception 'VALIDATION_FAILED: the photo belongs to a different booking' using errcode = '22023';
    end if;
    if not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'passenger-ids' and o.name = p_photo_path
    ) then
      raise exception 'VALIDATION_FAILED: upload the photo before saving it' using errcode = '22023';
    end if;
  end if;

  insert into public.passenger_documents as d (
    booking_id, id_type, id_number, birth_place, birth_date, photo_path
  ) values (
    p_booking_id, p_id_type, btrim(p_id_number), nullif(btrim(coalesce(p_birth_place, '')), ''),
    p_birth_date, p_photo_path
  )
  on conflict (booking_id) do update
    set id_type = excluded.id_type,
        id_number = excluded.id_number,
        birth_place = excluded.birth_place,
        birth_date = excluded.birth_date,
        photo_path = coalesce(excluded.photo_path, d.photo_path),
        updated_at = now()
  returning * into v_document;

  perform app.write_audit(
    p_actor, 'booking.setDocument', 'booking', p_booking_id::text, null,
    jsonb_build_object('id_type', p_id_type, 'has_photo', p_photo_path is not null),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('document', jsonb_build_object(
    'id', v_document.id,
    'bookingId', v_document.booking_id,
    'idType', v_document.id_type,
    'idNumber', v_document.id_number,
    'birthPlace', v_document.birth_place,
    'birthDate', v_document.birth_date,
    'photoPath', v_document.photo_path
  ));
end;
$$;

/** Shared body of accept and bulk-accept. Returns the updated row; raises the case-specific code. */
create or replace function app.accept_booking_internal(p_actor uuid, p_booking_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_trip public.trips%rowtype;
begin
  select * into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then
    raise exception 'NOT_FOUND: booking' using errcode = 'P0002';
  end if;

  select * into v_trip from public.trips t where t.id = v_booking.trip_id;

  if not app.actor_can_manage_trip(p_actor, v_booking.trip_id) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;

  if v_booking.status <> 'pending' then
    raise exception 'CONFLICT: the booking is already %', v_booking.status using errcode = '23505';
  end if;

  -- A hold that expired while the operator was reading the inbox is not a seat any more. Saying so is
  -- kinder than accepting a passenger the vehicle has no room for.
  if v_booking.hold_expires_at is not null and v_booking.hold_expires_at <= now() then
    raise exception 'CONFLICT: the seat hold expired' using errcode = '23505';
  end if;

  update public.bookings
  set status = 'accepted', accepted_at = now(), decided_by = p_actor, hold_expires_at = null
  where id = p_booking_id
  returning * into v_booking;

  perform app.recompute_seats_available(v_booking.trip_id);

  insert into public.booking_events (booking_id, kind, actor_id, detail)
  values (p_booking_id, 'accepted', p_actor, '{}'::jsonb);

  perform app.notify(
    v_booking.passenger_id, 'booking_accepted', 'notifications.bookingAccepted',
    jsonb_build_object('code', v_booking.code, 'tripCode', v_trip.code),
    '/account/bookings/' || v_booking.id::text
  );

  return v_booking;
end;
$$;

create or replace function public.cmd_accept_booking(
  p_actor uuid,
  p_booking_id uuid,
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
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  v_booking := app.accept_booking_internal(p_actor, p_booking_id);

  perform app.write_audit(
    p_actor, 'booking.accept', 'booking', p_booking_id::text,
    jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'accepted'),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('booking', to_jsonb(v_booking));
end;
$$;

create or replace function public.cmd_bulk_accept_bookings(
  p_actor uuid,
  p_booking_ids uuid[],
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_accepted text[] := '{}';
  v_refused text[] := '{}';
  v_booking public.bookings;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_booking_ids is null or cardinality(p_booking_ids) = 0 then
    raise exception 'VALIDATION_FAILED: choose at least one booking' using errcode = '22023';
  end if;
  if cardinality(p_booking_ids) > 50 then
    raise exception 'VALIDATION_FAILED: at most 50 bookings per batch' using errcode = '22023';
  end if;

  foreach v_id in array p_booking_ids
  loop
    begin
      -- A savepoint per booking: one stale hold must not roll back the eleven good decisions.
      begin
        v_booking := app.accept_booking_internal(p_actor, v_id);
        v_accepted := v_accepted || v_booking.code;
      exception when others then
        v_refused := v_refused || v_id::text;
      end;
    end;
  end loop;

  perform app.write_audit(
    p_actor, 'booking.bulkAccept', 'booking', null,
    null, jsonb_build_object('accepted', v_accepted, 'refused', v_refused),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('accepted', to_jsonb(v_accepted), 'refused', to_jsonb(v_refused));
end;
$$;

create or replace function public.cmd_reject_booking(
  p_actor uuid,
  p_booking_id uuid,
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
  v_booking public.bookings%rowtype;
  v_trip public.trips%rowtype;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'VALIDATION_FAILED: a rejection needs a reason' using errcode = '22023';
  end if;

  select * into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then
    raise exception 'NOT_FOUND: booking' using errcode = 'P0002';
  end if;

  if not app.actor_can_manage_trip(p_actor, v_booking.trip_id) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;
  if v_booking.status <> 'pending' then
    raise exception 'CONFLICT: the booking is already %', v_booking.status using errcode = '23505';
  end if;

  select * into v_trip from public.trips t where t.id = v_booking.trip_id;

  update public.bookings
  set status = 'rejected', reject_reason = btrim(p_reason), decided_by = p_actor,
      hold_expires_at = null,
      -- Money that was already taken goes back in full: the passenger did not choose this.
      refund_yer = case when payment_status = 'paid' then total_yer else refund_yer end
  where id = p_booking_id
  returning * into v_booking;

  perform app.recompute_seats_available(v_booking.trip_id);

  insert into public.booking_events (booking_id, kind, actor_id, detail)
  values (p_booking_id, 'rejected', p_actor, jsonb_build_object('reason', btrim(p_reason)));

  perform app.notify(
    v_booking.passenger_id, 'booking_rejected', 'notifications.bookingRejected',
    jsonb_build_object('code', v_booking.code, 'tripCode', v_trip.code, 'reason', btrim(p_reason)),
    '/account/bookings/' || v_booking.id::text
  );

  perform app.write_audit(
    p_actor, 'booking.reject', 'booking', p_booking_id::text,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'rejected', 'refund_yer', v_booking.refund_yer),
    p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('booking', to_jsonb(v_booking));
end;
$$;

/**
 * BR-09 from the passenger's side: cancel at least two hours before departure.
 *
 * Before that line the answer is `CANCEL_WINDOW_CLOSED` — a code the UI can explain — and after it the
 * refund comes from `app.compute_refund()`, stored on the row so Phase 9 has an amount to pay rather
 * than a policy to re-derive at payout time.
 */
create or replace function public.cmd_cancel_booking_by_passenger(
  p_actor uuid,
  p_booking_id uuid,
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
  v_booking public.bookings%rowtype;
  v_trip public.trips%rowtype;
  v_hours numeric;
  v_decision jsonb;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then
    raise exception 'NOT_FOUND: booking' using errcode = 'P0002';
  end if;

  if v_booking.passenger_id <> p_actor then
    raise exception 'FORBIDDEN: not your booking' using errcode = '42501';
  end if;
  if v_booking.status not in ('pending', 'accepted') then
    raise exception 'CONFLICT: the booking is already %', v_booking.status using errcode = '23505';
  end if;

  select * into v_trip from public.trips t where t.id = v_booking.trip_id;

  v_hours := extract(epoch from (v_trip.departure_at - now())) / 3600.0;
  if v_hours < 2 then
    raise exception 'CANCEL_WINDOW_CLOSED: cancellation closes 2 hours before departure'
      using errcode = '23505';
  end if;

  v_decision := app.compute_refund(v_booking.total_yer, v_hours);

  update public.bookings
  set status = 'cancelled_by_passenger', cancelled_at = now(), cancelled_by = p_actor,
      cancel_reason = nullif(btrim(coalesce(p_reason, '')), ''),
      hold_expires_at = null,
      refund_yer = (v_decision ->> 'amountMinor')::int
  where id = p_booking_id
  returning * into v_booking;

  perform app.recompute_seats_available(v_booking.trip_id);

  insert into public.booking_events (booking_id, kind, actor_id, detail)
  values (p_booking_id, 'cancelled', p_actor, jsonb_build_object(
    'by', 'passenger', 'refund_yer', v_booking.refund_yer,
    'basis_points', (v_decision ->> 'appliedBasisPoints')::int
  ));

  perform app.notify_trip_managers(
    v_trip, 'booking_cancelled', 'notifications.bookingCancelled',
    jsonb_build_object('code', v_booking.code, 'tripCode', v_trip.code, 'seats', v_booking.seats, 'by', 'passenger'),
    '/operator/trips/' || v_booking.trip_id::text || '/bookings'
  );

  perform app.write_audit(
    p_actor, 'booking.cancelByPassenger', 'booking', p_booking_id::text,
    jsonb_build_object('status', 'accepted'),
    jsonb_build_object('status', 'cancelled_by_passenger', 'refund_yer', v_booking.refund_yer),
    p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('booking', to_jsonb(v_booking), 'refund', v_decision);
end;
$$;

/** The operator may cancel anything it sold, at any hour, and refunds in full (BR-09, §6.9). */
create or replace function public.cmd_cancel_booking_by_operator(
  p_actor uuid,
  p_booking_id uuid,
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
  v_booking public.bookings%rowtype;
  v_trip public.trips%rowtype;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'VALIDATION_FAILED: a cancellation needs a reason' using errcode = '22023';
  end if;

  select * into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then
    raise exception 'NOT_FOUND: booking' using errcode = 'P0002';
  end if;
  if not app.actor_can_manage_trip(p_actor, v_booking.trip_id) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;
  if v_booking.status not in ('pending', 'accepted') then
    raise exception 'CONFLICT: the booking is already %', v_booking.status using errcode = '23505';
  end if;

  select * into v_trip from public.trips t where t.id = v_booking.trip_id;

  update public.bookings
  set status = 'cancelled_by_operator', cancelled_at = now(), cancelled_by = p_actor,
      cancel_reason = btrim(p_reason), hold_expires_at = null,
      -- Full refund whether or not money was taken yet: the passenger keeps nothing to chase.
      refund_yer = total_yer
  where id = p_booking_id
  returning * into v_booking;

  perform app.recompute_seats_available(v_booking.trip_id);

  insert into public.booking_events (booking_id, kind, actor_id, detail)
  values (p_booking_id, 'cancelled', p_actor,
          jsonb_build_object('by', 'operator', 'reason', btrim(p_reason), 'refund_yer', v_booking.refund_yer));

  perform app.notify(
    v_booking.passenger_id, 'booking_cancelled', 'notifications.bookingCancelled',
    jsonb_build_object('code', v_booking.code, 'tripCode', v_trip.code, 'by', 'operator',
                       'reason', btrim(p_reason)),
    '/account/bookings/' || v_booking.id::text
  );

  perform app.write_audit(
    p_actor, 'booking.cancelByOperator', 'booking', p_booking_id::text,
    jsonb_build_object('status', 'accepted'),
    jsonb_build_object('status', 'cancelled_by_operator', 'refund_yer', v_booking.refund_yer),
    p_reason, p_request_id, p_ip
  );

  return jsonb_build_object('booking', to_jsonb(v_booking));
end;
$$;

/**
 * BR-11 — the sweeper.
 *
 * Idempotent and cheap: one UPDATE ... RETURNING, one recompute per affected trip. Called by cron every
 * minute and, defensively, by `cmd_create_booking`'s availability check (which counts only holds that
 * are still live, so a missed run can never oversell a seat — this function only tidies up the rows).
 */
create or replace function public.cmd_expire_booking_holds(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_count integer := 0;
  v_trip uuid;
  v_touched uuid[] := '{}';
begin
  for v_booking in
    update public.bookings
    set status = 'expired', hold_expires_at = null
    where id in (
      select b.id from public.bookings b
      where b.status = 'pending' and b.hold_expires_at <= now()
      order by b.hold_expires_at
      limit greatest(coalesce(p_limit, 200), 1)
      for update skip locked
    )
    returning *
  loop
    v_count := v_count + 1;
    insert into public.booking_events (booking_id, kind, detail)
    values (v_booking.id, 'expired', jsonb_build_object('hold_expired_at', v_booking.hold_expires_at));
    if not (v_booking.trip_id = any (v_touched)) then
      v_touched := v_touched || v_booking.trip_id;
    end if;
  end loop;

  foreach v_trip in array v_touched
  loop
    perform app.recompute_seats_available(v_trip);
  end loop;

  return jsonb_build_object('expired', v_count, 'trips', cardinality(v_touched));
end;
$$;

/** A passenger who did not board. Recorded, never refunded. */
create or replace function public.cmd_mark_no_show(
  p_actor uuid,
  p_booking_id uuid,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_trip public.trips%rowtype;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then
    raise exception 'NOT_FOUND: booking' using errcode = 'P0002';
  end if;
  if not app.actor_can_manage_trip(p_actor, v_booking.trip_id) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;
  if v_booking.status <> 'accepted' then
    raise exception 'CONFLICT: the booking is already %', v_booking.status using errcode = '23505';
  end if;

  select * into v_trip from public.trips t where t.id = v_booking.trip_id;
  if v_trip.departure_at > now() then
    raise exception 'CONFLICT: the trip has not departed yet' using errcode = '23505';
  end if;

  update public.bookings
  set status = 'no_show', refund_yer = 0, completed_at = now()
  where id = p_booking_id
  returning * into v_booking;

  insert into public.booking_events (booking_id, kind, actor_id)
  values (p_booking_id, 'no_show', p_actor);

  perform app.write_audit(
    p_actor, 'booking.noShow', 'booking', p_booking_id::text,
    jsonb_build_object('status', 'accepted'), jsonb_build_object('status', 'no_show'),
    null, p_request_id, p_ip
  );

  return jsonb_build_object('booking', to_jsonb(v_booking));
end;
$$;

/** End of the trip: every accepted booking on it becomes history. Safe to run twice. */
create or replace function public.cmd_finalize_trip_bookings(
  p_trip_id uuid,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_booking public.bookings%rowtype;
  v_count integer := 0;
begin
  select * into v_trip from public.trips t where t.id = p_trip_id;
  if not found then
    raise exception 'NOT_FOUND: trip' using errcode = 'P0002';
  end if;

  if v_trip.status <> 'completed' and v_trip.departure_at > now() then
    raise exception 'CONFLICT: the trip has not finished yet' using errcode = '23505';
  end if;

  for v_booking in
    update public.bookings
    set status = 'completed', completed_at = now()
    where trip_id = p_trip_id and status = 'accepted'
    returning *
  loop
    v_count := v_count + 1;
    insert into public.booking_events (booking_id, kind, detail)
    values (v_booking.id, 'completed', '{}'::jsonb);
  end loop;

  perform app.recompute_seats_available(p_trip_id);

  perform app.write_audit(
    null, 'booking.finalize', 'trip', p_trip_id::text, null,
    jsonb_build_object('completed', v_count), null, p_request_id, null
  );

  return jsonb_build_object('completed', v_count);
end;
$$;

/** The passenger list the operator needs before the vehicle leaves. Accepted and completed only. */
create or replace function public.get_trip_manifest_data(
  p_actor uuid,
  p_trip_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;
  if not app.actor_can_manage_trip(p_actor, p_trip_id) then
    raise exception 'FORBIDDEN: not your trip' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(item order by item ->> 'passengerName'), '[]'::jsonb) into v_items
  from (
    select jsonb_build_object(
      'bookingId', b.id,
      'code', b.code,
      'status', b.status,
      'seats', b.seats,
      'passengerName', b.contact_name,
      'contactPhone', b.contact_phone,
      'gender', b.passenger_gender,
      'note', b.note,
      'paymentStatus', b.payment_status,
      'totalYer', b.total_yer,
      'refundYer', b.refund_yer,
      'idType', d.id_type,
      'idNumber', d.id_number,
      'birthPlace', d.birth_place,
      'birthDate', d.birth_date,
      'photoPath', d.photo_path
    ) as item
    from public.bookings b
    left join public.passenger_documents d on d.booking_id = b.id
    where b.trip_id = p_trip_id and b.status in ('accepted', 'completed')
  ) rows;

  return jsonb_build_object('tripId', p_trip_id, 'passengers', v_items);
end;
$$;

/**
 * A 72-hour WhatsApp link to a *preview* of the ID, not to the ID.
 *
 * The passenger creates it for a specific operator; the token is single-booking, revocable by asking for
 * a new one, and every view is logged with the viewer's actor id. The app renders the preview with a
 * watermark carrying the booking code and the viewer's name, so a screenshot identifies who took it.
 */
create or replace function public.create_id_share_link(
  p_actor uuid,
  p_booking_id uuid,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_token text;
  v_expires timestamptz;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then
    raise exception 'NOT_FOUND: booking' using errcode = 'P0002';
  end if;
  if v_booking.passenger_id <> p_actor then
    raise exception 'FORBIDDEN: not your booking' using errcode = '42501';
  end if;
  if v_booking.status not in ('pending', 'accepted') then
    raise exception 'CONFLICT: this booking is %', v_booking.status using errcode = '23505';
  end if;

  -- One live link per booking: asking again invalidates the one already sent.
  update public.booking_share_tokens
  set revoked_at = now()
  where booking_id = p_booking_id and revoked_at is null and expires_at > now();

  v_token := md5(random()::text || clock_timestamp()::text || p_booking_id::text);
  v_expires := now() + interval '72 hours';

  insert into public.booking_share_tokens (booking_id, token, created_by, expires_at)
  values (p_booking_id, v_token, p_actor, v_expires);

  insert into public.booking_events (booking_id, kind, actor_id, detail)
  values (p_booking_id, 'document_shared', p_actor, jsonb_build_object('expires_at', v_expires));

  perform app.write_audit(
    p_actor, 'booking.shareDocument', 'booking', p_booking_id::text, null,
    jsonb_build_object('expires_at', v_expires), null, p_request_id, p_ip
  );

  return jsonb_build_object('token', v_token, 'expiresAt', v_expires, 'path', '/s/' || v_token);
end;
$$;

create or replace function public.resolve_id_share_token(
  p_token text,
  p_user_agent text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token public.booking_share_tokens%rowtype;
  v_booking public.bookings%rowtype;
  v_trip public.trips%rowtype;
  v_doc public.passenger_documents%rowtype;
begin
  select * into v_token from public.booking_share_tokens t where t.token = p_token for update;
  if not found then
    raise exception 'NOT_FOUND: link' using errcode = 'P0002';
  end if;
  if v_token.revoked_at is not null or v_token.expires_at <= now() then
    raise exception 'NOT_FOUND: this link has expired' using errcode = 'P0002';
  end if;

  select * into v_booking from public.bookings b where b.id = v_token.booking_id;

  -- A link is about a live booking. Once the seat is gone — cancelled, rejected, expired, or the trip is
  -- over — the ID it points at stops being the operator's business, and the answer is the same one an
  -- expired link gets: the link is gone, and nothing is learned by probing it.
  if v_booking.status not in ('pending', 'accepted') then
    raise exception 'NOT_FOUND: this link has expired' using errcode = 'P0002';
  end if;

  -- The audience is the operator of that trip (or staff reviewing it). A passenger forwarding the link
  -- to a friend does not extend its audience — that is what the audit row says when it happens.
  if not (app.actor_can_manage_trip(app.uid(), v_booking.trip_id) or app.is_platform_staff()) then
    raise exception 'FORBIDDEN: this link is for the trip operator' using errcode = '42501';
  end if;

  select * into v_trip from public.trips t where t.id = v_booking.trip_id;
  select * into v_doc from public.passenger_documents d where d.booking_id = v_booking.id;

  update public.booking_share_tokens
  set view_count = view_count + 1, last_viewed_at = now()
  where id = v_token.id
  returning * into v_token;

  insert into public.document_access_log (booking_id, actor_id, kind, ip, user_agent)
  values (v_booking.id, app.uid(), 'share_link', p_ip, left(p_user_agent, 400));

  return jsonb_build_object(
    'bookingId', v_booking.id,
    'bookingCode', v_booking.code,
    'tripCode', v_trip.code,
    'passengerName', v_booking.contact_name,
    'contactPhone', v_booking.contact_phone,
    'idType', v_doc.id_type,
    'idNumber', v_doc.id_number,
    'birthPlace', v_doc.birth_place,
    'birthDate', v_doc.birth_date,
    'photoPath', v_doc.photo_path,
    'expiresAt', v_token.expires_at,
    'views', v_token.view_count
  );
end;
$$;

/**
 * "I looked at this ID" — a read with one side effect.
 *
 * Reads bypass the gateway, so there is no server action to hang the log on. The app calls this once per
 * rendered document instead; it refuses a caller who could not have read the document anyway, so the log
 * cannot be filled with other people's booking ids.
 */
create or replace function public.log_document_access(
  p_booking_id uuid,
  p_user_agent text default null,
  p_ip inet default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind public.document_access_kind;
begin
  if app.uid() is null then
    raise exception 'UNAUTHENTICATED: sign in first' using errcode = '28000';
  end if;

  if not app.can_read_booking(p_booking_id) then
    raise exception 'FORBIDDEN: not your booking' using errcode = '42501';
  end if;

  if app.is_platform_staff() then
    v_kind := 'staff';
  elsif app.is_booking_passenger(p_booking_id) then
    v_kind := 'owner';
  else
    v_kind := 'operator';
  end if;

  insert into public.document_access_log (booking_id, actor_id, kind, ip, user_agent)
  values (p_booking_id, app.uid(), v_kind, p_ip, left(p_user_agent, 400));

  return true;
end;
$$;

/**
 * Retention. An ID is kept while it can still be needed (a dispute, a manifest, a police check) and no
 * longer; the storage objects are removed by the same cron that calls this, because Postgres cannot
 * delete a file and a database row that says otherwise would be a lie.
 */
create or replace function public.cmd_purge_id_documents(p_older_than_days integer default 90)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days integer := greatest(coalesce(p_older_than_days, 90), 1);
  v_deleted integer;
begin
  with gone as (
    delete from public.passenger_documents d
    using public.bookings b
    where b.id = d.booking_id
      and b.status in ('cancelled_by_passenger', 'cancelled_by_operator', 'rejected', 'expired', 'no_show', 'completed')
      and d.updated_at < now() - make_interval(days => v_days)
    returning d.id
  )
  select count(*)::int into v_deleted from gone;

  perform app.write_audit(
    null, 'booking.purgeDocuments', 'passenger_documents', null, null,
    jsonb_build_object('deleted', v_deleted, 'older_than_days', v_days), null, null, null
  );

  return jsonb_build_object('deleted', v_deleted, 'olderThanDays', v_days);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. A cancelled trip cancels its bookings — by trigger, not by remembering to
-- ---------------------------------------------------------------------------

/**
 * Phase 4 left a comment in `cmd_cancel_trip`: "Phase 5 refunds the passengers inside this command."
 * A trigger is better than a line in one command: a cancel from a staff tool, an admin console, or a
 * future cron reaches the same rule, and a passenger is never left holding a seat on a trip that will
 * not run.
 */
create or replace function app.on_trip_cancelled_bookings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
begin
  for v_booking in
    update public.bookings
    set status = 'cancelled_by_operator',
        cancelled_at = now(),
        cancelled_by = new.cancelled_by,
        cancel_reason = coalesce(new.cancel_reason, 'trip cancelled'),
        hold_expires_at = null,
        refund_yer = total_yer
    where trip_id = new.id and status in ('pending', 'accepted')
    returning *
  loop
    insert into public.booking_events (booking_id, kind, detail)
    values (v_booking.id, 'cancelled',
            jsonb_build_object('by', 'trip_cancelled', 'refund_yer', v_booking.refund_yer));

    perform app.notify(
      v_booking.passenger_id, 'booking_cancelled', 'notifications.tripCancelled',
      jsonb_build_object('code', v_booking.code, 'tripCode', new.code, 'reason', new.cancel_reason),
      '/account/bookings/' || v_booking.id::text
    );
  end loop;

  perform app.recompute_seats_available(new.id);
  return null;
end;
$$;

create trigger trips_cancel_bookings
  after update of status on public.trips
  for each row
  when (new.status = 'cancelled' and old.status <> 'cancelled')
  execute function app.on_trip_cancelled_bookings();

/**
 * Closing a booking revokes the ID links made for it.
 *
 * Belt and braces with the status check inside `resolve_id_share_token`: the check makes an old link
 * useless, this makes it *not exist*, so a later query cannot even count how many links once pointed at a
 * cancelled passenger.
 */
create or replace function app.on_booking_closed_revoke_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status not in ('pending', 'accepted')
     and (old.status in ('pending', 'accepted') or old.status is distinct from new.status) then
    update public.booking_share_tokens
    set revoked_at = now()
    where booking_id = new.id and revoked_at is null;
  end if;
  return new;
end;
$$;

create trigger bookings_revoke_links_on_close
  after update of status on public.bookings
  for each row execute function app.on_booking_closed_revoke_links();

-- ---------------------------------------------------------------------------
-- 8. Reads: RLS on the booking graph
-- ---------------------------------------------------------------------------

alter table public.bookings              enable row level security;
alter table public.passenger_documents   enable row level security;
alter table public.document_access_log   enable row level security;
alter table public.booking_events        enable row level security;
alter table public.booking_share_tokens  enable row level security;

alter table public.bookings              force row level security;
alter table public.passenger_documents   force row level security;
alter table public.document_access_log   force row level security;
alter table public.booking_events        force row level security;
alter table public.booking_share_tokens  force row level security;

-- Written against the row's own columns, not through app.can_read_booking(), because that function
-- reads `bookings` and a policy that runs it on `bookings` is a recursive plan waiting to happen.
create policy bookings_read_own_or_operator on public.bookings
  for select to authenticated
  using (
    passenger_id = app.uid()
    or booked_by = app.uid()
    or app.actor_can_manage_trip(app.uid(), trip_id)
    or app.is_platform_staff()
  );

create policy passenger_documents_read_authorised on public.passenger_documents
  for select to authenticated
  using (app.can_read_booking(booking_id));

create policy booking_events_read_authorised on public.booking_events
  for select to authenticated
  using (app.can_read_booking(booking_id));

create policy booking_share_tokens_read_self on public.booking_share_tokens
  for select to authenticated
  using (app.can_read_booking(booking_id));

-- The log is for staff and auditors. A passenger seeing "who looked at my ID" would be a nice feature
-- and a worse privacy leak: it tells an operator's competitor when a document was opened.
create policy document_access_log_read_staff on public.document_access_log
  for select to authenticated
  using (app.is_platform_staff());

grant select on public.bookings             to authenticated;
grant select on public.passenger_documents  to authenticated;
grant select on public.booking_events       to authenticated;
grant select on public.booking_share_tokens to authenticated;
grant select on public.document_access_log  to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Storage: private passenger IDs, one folder per booking
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'passenger-ids', 'passenger-ids', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

/**
 * Read access is exactly "may you see this booking" — the same predicate as the document row and the
 * booking itself, so there is no fourth answer to learn.
 */
create policy passenger_ids_read_authorised on storage.objects
  for select to authenticated
  using (
    bucket_id = 'passenger-ids'
    and app.can_read_booking(app.safe_uuid((storage.foldername(name))[1]))
  );

-- Only the passenger uploads their own ID, into `<booking-id>/…`. Not the operator: an operator who
-- photographs a passenger's card does it on the passenger's device, or types the number.
create policy passenger_ids_write_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'passenger-ids'
    and app.is_booking_passenger(app.safe_uuid((storage.foldername(name))[1]))
  );

-- ---------------------------------------------------------------------------
-- 10. Execute grants: writes are service-only, the read helpers are signed-in only
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.cmd_create_booking(uuid, uuid, integer, uuid, integer, text, text, text, text, text, inet)',
    'public.cmd_set_passenger_document(uuid, uuid, public.id_document_type, text, text, date, text, text, inet)',
    'public.cmd_accept_booking(uuid, uuid, text, inet)',
    'public.cmd_reject_booking(uuid, uuid, text, text, inet)',
    'public.cmd_bulk_accept_bookings(uuid, uuid[], text, inet)',
    'public.cmd_cancel_booking_by_passenger(uuid, uuid, text, text, inet)',
    'public.cmd_cancel_booking_by_operator(uuid, uuid, text, text, inet)',
    'public.cmd_expire_booking_holds(integer)',
    'public.cmd_mark_no_show(uuid, uuid, text, inet)',
    'public.cmd_finalize_trip_bookings(uuid, text)',
    'public.cmd_purge_id_documents(integer)',
    'public.get_trip_manifest_data(uuid, uuid)',
    'public.create_id_share_link(uuid, uuid, text, inet)',
    'app.accept_booking_internal(uuid, uuid)',
    'app.trip_booked_seats(uuid)',
    'app.compute_refund(integer, numeric)',
    'app.new_booking_code()',
    'app.notify_trip_managers(public.trips, public.notification_kind, text, jsonb, text)',
    'app.on_trip_cancelled_bookings()',
    'app.on_booking_closed_revoke_links()'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;

  -- Predicates the policies execute as the querying role, plus the two reads that write an audit row.
  -- `resolve_id_share_token` is authenticated-only: the audience is the operator, never a visitor.
  foreach v_signature in array array[
    'app.can_read_booking(uuid)',
    'app.is_booking_passenger(uuid)',
    'app.can_manage_booking(uuid)',
    'public.log_document_access(uuid, text, inet)',
    'public.resolve_id_share_token(text, text, inet)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', v_signature);
    execute format('grant execute on function %s to authenticated, service_role', v_signature);
  end loop;
end;
$$;
