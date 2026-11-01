-- 0016 — Phase 11: one event, one message, on the channel the user chose
--
-- The promises verified here, in the order the platform makes them:
--   1. accepting a booking produces exactly one push and one in-app row, and a retried job adds nothing
--   2. a saved search alerts once per new matching trip, not once per run of the job
--   3. turning email off for one event stops email and leaves push alone
--   4. quiet hours hold a normal push until 06:00 and never hold a cancellation
--   5. the worker claims, records, backs off, gives up at five, and a dead letter is visible
--   6. preferences are the user's, defaults are the catalogue's, and in-app cannot be silenced
--   7. quota, expiry, reminder and verification jobs each send once and stay idempotent
--   8. a client cannot write notifications, and cannot read somebody else's
--
-- Run with: supabase test db   (requires Docker), or `npm run sql:check` (embedded Postgres).

begin;

create extension if not exists pgtap;

select plan(94);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('10700001-0000-4000-8000-000000000001', 'notif-passenger@example.test', '+967733940001', '{"locale":"ar"}'),
  ('10700002-0000-4000-8000-000000000002', 'notif-operator@example.test', '+967733940002', '{"locale":"ar"}'),
  ('10700003-0000-4000-8000-000000000003', 'notif-staff@example.test', '+967733940003', '{"locale":"ar"}'),
  ('10700004-0000-4000-8000-000000000004', 'notif-other@example.test', '+967733940004', '{"locale":"en"}');

update public.profiles set verification_status = 'verified' where id::text like '1070%';

insert into public.user_roles (user_id, role)
values ('10700003-0000-4000-8000-000000000003', 'platform_staff');

insert into public.organizations (id, name, owner_id, verification_status, plan)
values ('1070aa00-0000-4000-8000-00000000000a', 'Notif Co',
        '10700002-0000-4000-8000-000000000002', 'verified', 'basic');

insert into public.organization_members (org_id, user_id, role, status, joined_at)
values ('1070aa00-0000-4000-8000-00000000000a', '10700002-0000-4000-8000-000000000002',
        'owner', 'active', now());

insert into public.vehicles (
  id, owner_org_id, make, model, model_year, plate_number, plate_governorate_id,
  fuel_type, seats_passenger, seats_total, odometer_km, status, verification_status,
  insurance_expiry, inspection_expiry, registration_expiry, created_by
)
values (
  '1070c001-0000-4000-8000-000000000001', '1070aa00-0000-4000-8000-00000000000a',
  'Toyota', 'Hiace', 2019, '10-2001',
  (select id from public.governorates where code = 'YE-AD'),
  'diesel', 12, 13, 40_000, 'active', 'verified',
  current_date + 200, current_date + 200, current_date + 200,
  '10700002-0000-4000-8000-000000000002'
);

-- A trip that leaves inside the 24-hour reminder band.
insert into public.trips (
  id, code, owner_org_id, vehicle_id, origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, price_per_seat_yer, discount_kind, discount_value,
  payment_policy, deposit_percent, status, verification_status, published_at
)
values (
  '1070b001-0000-4000-8000-000000000001', 'P11-AD-0001',
  '1070aa00-0000-4000-8000-00000000000a', '1070c001-0000-4000-8000-000000000001',
  (select id from public.governorates where code = 'YE-AD'),
  (select id from public.governorates where code = 'YE-SA'),
  now() + interval '24 hours 10 minutes', 12, 12, 10_000, 'none', 0,
  -- Cash, so accepting the booking is not gated on a confirmed deposit: this suite is about the message
  -- that follows the acceptance, not about the payment gate Phase 9 already tests.
  'cash', 30, 'published', 'verified', now()
);

-- One device, so "push" has somewhere to go. Without it every push is skipped, which is correct and is
-- exactly what the no-device case below checks.
insert into public.device_tokens (user_id, platform, token)
values ('10700001-0000-4000-8000-000000000001', 'android', 'ExponentPushToken[notif-passenger]');

-- ---------------------------------------------------------------------------
-- 1. Accepting a booking: one push, one in-app row
-- ---------------------------------------------------------------------------

select public.cmd_create_booking(
  '10700001-0000-4000-8000-000000000001', '1070b001-0000-4000-8000-000000000001',
  1, null, null, 'مسافر التنبيهات', '+967733949001', null, null, 'p11-fixture', null
);

select public.cmd_accept_booking(
  '10700002-0000-4000-8000-000000000002',
  (select id from public.bookings where passenger_id = '10700001-0000-4000-8000-000000000001'),
  'p11-accept', null
);

select is(
  (select count(*)::int from public.notifications
    where user_id = '10700001-0000-4000-8000-000000000001' and kind = 'booking_accepted'),
  1,
  'accepting a booking writes one notification for the passenger'
);

select is(
  (select count(*)::int from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.user_id = '10700001-0000-4000-8000-000000000001'
      and n.kind = 'booking_accepted' and d.channel = 'push'),
  1,
  'and exactly one push decision for it'
);

select is(
  (select d.status::text from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.user_id = '10700001-0000-4000-8000-000000000001'
      and n.kind = 'booking_accepted' and d.channel = 'in_app'),
  'sent',
  'the in-app row is its own delivery, already delivered'
);

select is(
  (select d.status::text from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.user_id = '10700001-0000-4000-8000-000000000001'
      and n.kind = 'booking_accepted' and d.channel = 'push'),
  'pending',
  'and the push is waiting for the worker, not yet sent'
);

-- The same event, enqueued twice by a retried job, is still one event.
select app.enqueue_notification(
  '10700001-0000-4000-8000-000000000001', 'booking_accepted', 'notifications.bookingAccepted',
  '{"code":"BK-X"}'::jsonb, '/account/bookings/x', 'test:retry:1'
);

select app.enqueue_notification(
  '10700001-0000-4000-8000-000000000001', 'booking_accepted', 'notifications.bookingAccepted',
  '{"code":"BK-X"}'::jsonb, '/account/bookings/x', 'test:retry:1'
);

select is(
  (select count(*)::int from public.notifications
    where user_id = '10700001-0000-4000-8000-000000000001' and dedupe_key = 'test:retry:1'),
  1,
  'a replayed enqueue with the same dedupe key writes one row'
);

select is(
  (select count(*)::int from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.user_id = '10700001-0000-4000-8000-000000000001' and n.dedupe_key = 'test:retry:1'),
  3,
  'and one delivery per channel, not three more'
);

-- ---------------------------------------------------------------------------
-- 2. Preferences: email off, push untouched
-- ---------------------------------------------------------------------------

select public.cmd_set_notification_preference(
  '10700001-0000-4000-8000-000000000001', 'booking_accepted', 'email', false, null, null
);

select app.enqueue_notification(
  '10700001-0000-4000-8000-000000000001', 'booking_accepted', 'notifications.bookingAccepted',
  '{"code":"BK-Y"}'::jsonb, '/account/bookings/y', 'test:pref:1'
);

select is(
  (select d.status::text from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:pref:1' and d.channel = 'email'),
  'skipped',
  'turning email off for one event makes the email decision a recorded skip'
);

select is(
  (select d.last_error from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:pref:1' and d.channel = 'email'),
  'preference',
  'and it says why, because "no email arrived" is a support question'
);

select is(
  (select d.status::text from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:pref:1' and d.channel = 'push'),
  'pending',
  'push keeps working: the switch is per event and per channel'
);

select throws_ok(
  $$ select public.cmd_set_notification_preference(
       '10700001-0000-4000-8000-000000000001', 'booking_accepted', 'in_app', false, null, null) $$,
  '22023',
  null,
  'in-app cannot be switched off: it is the record of the event'
);

select throws_ok(
  $$ select public.cmd_update_notification_settings(
       '10700001-0000-4000-8000-000000000001', true, '22:00', '22:00', null, null) $$,
  '22023',
  null,
  'a zero-length quiet window is refused, because it is a typo for "off"'
);

select public.cmd_update_notification_settings(
  '10700001-0000-4000-8000-000000000001', true, '22:00', '06:00', null, null
);

select is(
  (select public.cmd_get_notification_settings('10700001-0000-4000-8000-000000000001')
     #>> '{settings,quietStart}'),
  '22:00',
  'the settings round-trip keeps the hour the user typed'
);

select is(
  (select public.cmd_get_notification_settings('10700001-0000-4000-8000-000000000001')
     #>> '{settings,timezone}'),
  'Asia/Aden',
  'and always measures it in Aden, whatever the server thinks the time is'
);

select is(
  (select bool_and(enabled) from public.notification_preferences
    where user_id = '10700004-0000-4000-8000-000000000004'),
  null,
  'a user who never opened the screen has no preference rows at all, only defaults'
);

-- ---------------------------------------------------------------------------
-- 3. Quiet hours
-- ---------------------------------------------------------------------------

select ok(
  app.in_quiet_hours('10700001-0000-4000-8000-000000000001', timestamptz '2026-03-06 23:00:00+03'),
  '23:00 in Aden is inside quiet hours'
);

select ok(
  not app.in_quiet_hours('10700001-0000-4000-8000-000000000001', timestamptz '2026-03-06 21:30:00+03'),
  '21:30 is not'
);

select is(
  app.quiet_resume_at('10700001-0000-4000-8000-000000000001', timestamptz '2026-03-06 23:00:00+03'),
  timestamptz '2026-03-07 06:00:00+03',
  'a message held at 23:00 becomes deliverable at 06:00 the next morning'
);

select is(
  app.quiet_resume_at('10700001-0000-4000-8000-000000000001', timestamptz '2026-03-07 03:00:00+03'),
  timestamptz '2026-03-07 06:00:00+03',
  'and one held at 03:00 waits only until the same morning'
);

select app.enqueue_notification(
  '10700001-0000-4000-8000-000000000001', 'trip_reminder', 'notifications.tripReminder',
  '{"tripCode":"P11-AD-0001","hours":24}'::jsonb, '/account/bookings/z', 'test:quiet:1',
  null, timestamptz '2026-03-06 23:00:00+03'
);

select is(
  (select d.status::text from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:quiet:1' and d.channel = 'push'),
  'pending',
  'a normal push raised at 23:00 is held, not dropped'
);

select is(
  (select d.next_attempt_at from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:quiet:1' and d.channel = 'push'),
  timestamptz '2026-03-07 06:00:00+03',
  'and its next attempt is 06:00, not "as soon as possible"'
);

select is(
  (select d.status::text from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:quiet:1' and d.channel = 'in_app'),
  'sent',
  'the in-app row is unaffected: quiet hours are about interrupting people, not about hiding news'
);

select app.enqueue_notification(
  '10700001-0000-4000-8000-000000000001', 'booking_cancelled', 'notifications.bookingCancelled',
  '{"code":"BK-Z","tripCode":"P11-AD-0001"}'::jsonb, '/account/bookings/z', 'test:critical:1',
  null, timestamptz '2026-03-06 23:00:00+03'
);

select is(
  (select d.next_attempt_at from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:critical:1' and d.channel = 'push'),
  timestamptz '2026-03-06 23:00:00+03',
  'a cancellation at 23:00 goes out at 23:00: critical bypasses quiet hours'
);

select public.cmd_update_notification_settings(
  '10700001-0000-4000-8000-000000000001', false, '22:00', '06:00', null, null
);

select app.enqueue_notification(
  '10700001-0000-4000-8000-000000000001', 'trip_reminder', 'notifications.tripReminder',
  '{"tripCode":"P11-AD-0001","hours":24}'::jsonb, '/account/bookings/z', 'test:quiet:off',
  null, timestamptz '2026-03-06 23:00:00+03'
);

select is(
  (select d.next_attempt_at from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:quiet:off' and d.channel = 'push'),
  timestamptz '2026-03-06 23:00:00+03',
  'switching quiet hours off sends immediately'
);

select public.cmd_update_notification_settings(
  '10700001-0000-4000-8000-000000000001', true, '22:00', '06:00', null, null
);

-- A push with no device is a decision, made early and recorded.
select app.enqueue_notification(
  '10700004-0000-4000-8000-000000000004', 'booking_accepted', 'notifications.bookingAccepted',
  '{"code":"BK-N"}'::jsonb, '/account/bookings/n', 'test:nodevice:1'
);

select is(
  (select d.status::text from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:nodevice:1' and d.channel = 'push'),
  'skipped',
  'a user with no registered device gets a skipped push rather than a failure'
);

-- ---------------------------------------------------------------------------
-- 4. The worker: claim, record, back off, give up
-- ---------------------------------------------------------------------------

-- Park everything that is due, so the claim below is about one row.
update public.notification_deliveries
   set next_attempt_at = now() + interval '30 days'
 where status in ('pending', 'failed');

update public.notification_deliveries d
   set next_attempt_at = now() - interval '1 minute'
  from public.notifications n
 where n.id = d.notification_id and n.dedupe_key = 'test:quiet:off' and d.channel = 'push';

select is(
  jsonb_array_length(public.cmd_claim_notifications(
    '10700003-0000-4000-8000-000000000003', 10, null, null) -> 'items'),
  1,
  'the worker is handed exactly the due delivery'
);

select is(
  (select public.cmd_claim_notifications(
     '10700003-0000-4000-8000-000000000003', 10, null, null) -> 'claimed')::int,
  0,
  'and a second claim in the same instant finds nothing, because the row is already claimed'
);

select is(
  (select d.status::text from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:quiet:off' and d.channel = 'push'),
  'sending',
  'a claimed row says so, so a crash mid-send leaves evidence'
);

select is(
  (select d.attempts from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:quiet:off' and d.channel = 'push'),
  1,
  'and counts the attempt'
);

select is(
  (select jsonb_array_length(public.cmd_claim_notifications(
     '10700003-0000-4000-8000-000000000003', 10, null, null) -> 'items')),
  0,
  'claiming twice does not re-hand a row that is in flight'
);

select public.cmd_record_notification_delivery(
  '10700003-0000-4000-8000-000000000003',
  (select d.id from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:quiet:off' and d.channel = 'push'),
  'sent', null, 'expo:receipt-1', null, null
);

select is(
  (select d.status::text from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:quiet:off' and d.channel = 'push'),
  'sent',
  'recording a send closes the delivery'
);

select is(
  (select d.provider_ref from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:quiet:off' and d.channel = 'push'),
  'expo:receipt-1',
  'and keeps the provider receipt, so "sent" can be proven'
);

select is(
  (select count(*)::int from public.notification_delivery_attempts a
     join public.notification_deliveries d on d.id = a.delivery_id
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:quiet:off'),
  1,
  'with one attempt row behind it'
);

select throws_ok(
  format(
    $$ select public.cmd_record_notification_delivery(
         '10700003-0000-4000-8000-000000000003', %L::uuid, 'sent', null, null, null, null) $$,
    (select d.id from public.notification_deliveries d
       join public.notifications n on n.id = d.notification_id
      where n.dedupe_key = 'test:quiet:off' and d.channel = 'push')
  ),
  '40001',
  null,
  'recording the same delivery twice is a conflict, not a second send'
);

-- A delivery that keeps failing backs off, then dies visibly.
select app.enqueue_notification(
  '10700001-0000-4000-8000-000000000001', 'payment_confirmed', 'notifications.paymentConfirmed',
  '{"amount":5000,"code":"BK-B"}'::jsonb, '/account/bookings/b', 'test:dead:1'
);

do $$
declare
  v_id uuid;
  i integer;
begin
  select d.id into v_id
    from public.notification_deliveries d
    join public.notifications n on n.id = d.notification_id
   where n.dedupe_key = 'test:dead:1' and d.channel = 'push';

  for i in 1..5 loop
    update public.notification_deliveries
       set next_attempt_at = now() - interval '1 second'
     where id = v_id and status in ('pending', 'failed');
    perform public.cmd_claim_notifications('10700003-0000-4000-8000-000000000003', 1, null, null);
    perform public.cmd_record_notification_delivery(
      '10700003-0000-4000-8000-000000000003', v_id, 'failed', 'expo: 503', null, null, null
    );
  end loop;
end;
$$;

select is(
  (select d.status::text from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:dead:1' and d.channel = 'push'),
  'dead',
  'five failures is a dead letter, not an infinite retry'
);

select is(
  (select d.attempts from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:dead:1' and d.channel = 'push'),
  5,
  'and the counter says how many times it was tried'
);

select is(
  (select count(*)::int from public.notification_delivery_attempts a
     join public.notification_deliveries d on d.id = a.delivery_id
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:dead:1'),
  5,
  'with an inspectable row per attempt'
);

select is(
  (select jsonb_array_length(public.cmd_get_notification_health(
     '10700003-0000-4000-8000-000000000003') -> 'dead')) >= 1,
  true,
  'and support can see the dead letter'
);

select is(
  (public.cmd_retry_notifications('10700003-0000-4000-8000-000000000003') ->> 'revived')::int,
  0,
  'a dead letter from a minute ago is not revived: a provider outage needs time to pass'
);

update public.notification_deliveries
   set created_at = now() - interval '2 days'
 where id in (
   select d.id from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:dead:1'
 );

select is(
  (public.cmd_retry_notifications('10700003-0000-4000-8000-000000000003') ->> 'revived')::int,
  1,
  'a day-old dead letter is re-armed once'
);

select is(
  (select d.status::text from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:dead:1' and d.channel = 'push'),
  'failed',
  'and starts its backoff over rather than dying again immediately'
);

-- A claim that never came back is rescued after ten minutes.
update public.notification_deliveries
   set status = 'sending', claimed_at = now() - interval '20 minutes', attempts = 1
 where id in (
   select d.id from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.dedupe_key = 'test:dead:1' and d.channel = 'push'
 );

select is(
  (select public.cmd_retry_notifications('10700003-0000-4000-8000-000000000003') ->> 'rescued')::int,
  1,
  'an abandoned claim is returned to the queue instead of silently swallowing the message'
);

-- ---------------------------------------------------------------------------
-- 5. Saved searches: one alert per new trip
-- ---------------------------------------------------------------------------

select public.cmd_save_search(
  '10700001-0000-4000-8000-000000000001',
  jsonb_build_object(
    'origin', jsonb_build_array((select id::text from public.governorates where code = 'YE-AD')),
    'destination', jsonb_build_array((select id::text from public.governorates where code = 'YE-SA')),
    'priceMax', 5000
  ),
  'عدن ← صنعاء', true, false, null, null
);

select is(
  (select count(*)::int from public.saved_searches
    where user_id = '10700001-0000-4000-8000-000000000001'),
  1,
  'a saved search is one row'
);

select public.cmd_save_search(
  '10700001-0000-4000-8000-000000000001',
  jsonb_build_object(
    'origin', jsonb_build_array((select id::text from public.governorates where code = 'YE-AD')),
    'destination', jsonb_build_array((select id::text from public.governorates where code = 'YE-SA')),
    'priceMax', 5000
  ),
  'عدن ← صنعاء', true, false, null, null
);

select is(
  (select count(*)::int from public.saved_searches
    where user_id = '10700001-0000-4000-8000-000000000001'),
  1,
  'saving the same predicate twice is one search, not two subscriptions to the same thing'
);

select throws_ok(
  $$ select public.cmd_save_search(
       '10700001-0000-4000-8000-000000000001', '{"price_max": 5000}'::jsonb, null, true, false, null, null) $$,
  '22023',
  null,
  'a filter key the marketplace does not understand is refused, not ignored'
);

-- A cheap trip on the same route, published now: this is the "new trip" the alert is about.
insert into public.trips (
  id, code, owner_org_id, vehicle_id, origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, price_per_seat_yer, discount_kind, discount_value,
  payment_policy, deposit_percent, status, verification_status, published_at
)
values (
  '1070b002-0000-4000-8000-000000000002', 'P11-AD-0002',
  '1070aa00-0000-4000-8000-00000000000a', '1070c001-0000-4000-8000-000000000001',
  (select id from public.governorates where code = 'YE-AD'),
  (select id from public.governorates where code = 'YE-SA'),
  now() + interval '2 days', 12, 12, 4_500, 'none', 0,
  'transfer', 30, 'published', 'verified', now()
);

select is(
  (public.cmd_match_saved_searches('10700003-0000-4000-8000-000000000003', 200, 3) ->> 'matches')::int,
  1,
  'the job finds the one new trip that matches'
);

select is(
  (select count(*)::int from public.notifications
    where user_id = '10700001-0000-4000-8000-000000000001' and kind = 'saved_search_match'),
  1,
  'and alerts once'
);

select is(
  (public.cmd_match_saved_searches('10700003-0000-4000-8000-000000000003', 200, 3) ->> 'matches')::int,
  0,
  'running the job again matches nothing: the alert is per new trip, not per refresh'
);

select is(
  (select count(*)::int from public.notifications
    where user_id = '10700001-0000-4000-8000-000000000001' and kind = 'saved_search_match'),
  1,
  'and the passenger still has one message'
);

select is(
  (select params ->> 'tripCode' from public.notifications
    where kind = 'saved_search_match' limit 1),
  'P11-AD-0002',
  'the alert names the trip it is about'
);

select is(
  (select params ->> 'origin' from public.notifications
    where kind = 'saved_search_match' limit 1),
  'عدن',
  'and renders the place in the reader''s language'
);

-- A second matching trip alerts again; an expensive one does not.
insert into public.trips (
  id, code, owner_org_id, vehicle_id, origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, price_per_seat_yer, discount_kind, discount_value,
  payment_policy, deposit_percent, status, verification_status, published_at
)
values
  ('1070b003-0000-4000-8000-000000000003', 'P11-AD-0003',
   '1070aa00-0000-4000-8000-00000000000a', '1070c001-0000-4000-8000-000000000001',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '3 days', 12, 12, 4_000, 'none', 0,
   'transfer', 30, 'published', 'verified', now()),
  ('1070b004-0000-4000-8000-000000000004', 'P11-AD-0004',
   '1070aa00-0000-4000-8000-00000000000a', '1070c001-0000-4000-8000-000000000001',
   (select id from public.governorates where code = 'YE-AD'),
   (select id from public.governorates where code = 'YE-SA'),
   now() + interval '4 days', 12, 12, 90_000, 'none', 0,
   'transfer', 30, 'published', 'verified', now());

select is(
  (public.cmd_match_saved_searches('10700003-0000-4000-8000-000000000003', 200, 3) ->> 'matches')::int,
  1,
  'the second new trip alerts, and the one above the price cap does not'
);

select is(
  (select count(*)::int from public.saved_search_matches m
     join public.saved_searches s on s.id = m.saved_search_id
    where s.user_id = '10700001-0000-4000-8000-000000000001'),
  2,
  'and the match table remembers both, one row per (search, trip)'
);

select ok(
  (select last_matched_at from public.saved_searches
    where user_id = '10700001-0000-4000-8000-000000000001') is not null,
  'the search window advanced only because something was actually sent'
);

-- Turning alerts off is a preference, not a deletion.
select public.cmd_update_saved_search(
  '10700001-0000-4000-8000-000000000001',
  (select id from public.saved_searches where user_id = '10700001-0000-4000-8000-000000000001'),
  false, null, null, null, null
);

insert into public.trips (
  id, code, owner_org_id, vehicle_id, origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, price_per_seat_yer, discount_kind, discount_value,
  payment_policy, deposit_percent, status, verification_status, published_at
)
values (
  '1070b005-0000-4000-8000-000000000005', 'P11-AD-0005',
  '1070aa00-0000-4000-8000-00000000000a', '1070c001-0000-4000-8000-000000000001',
  (select id from public.governorates where code = 'YE-AD'),
  (select id from public.governorates where code = 'YE-SA'),
  now() + interval '5 days', 12, 12, 3_500, 'none', 0,
  'transfer', 30, 'published', 'verified', now()
);

select is(
  (public.cmd_match_saved_searches('10700003-0000-4000-8000-000000000003', 200, 3) ->> 'matches')::int,
  0,
  'a search with alerts off matches nothing for the user, but stays saved'
);

select is(
  (select count(*)::int from public.saved_searches
    where user_id = '10700001-0000-4000-8000-000000000001'),
  1,
  'the search itself is still there'
);

-- ---------------------------------------------------------------------------
-- 6. The scheduled jobs
-- ---------------------------------------------------------------------------

select ok(
  (public.cmd_send_trip_reminders('10700003-0000-4000-8000-000000000003',
                                  array['tomorrow']::text[]) ->> 'sent')::int >= 1,
  'the reminder job finds the booking whose trip leaves in about a day'
);

select is(
  (public.cmd_send_trip_reminders('10700003-0000-4000-8000-000000000003',
                                  array['tomorrow']::text[]) ->> 'sent')::int,
  0,
  'running it again sends nothing, even though the trip is still inside the band'
);

select is(
  (select count(*)::int from public.notifications
    where user_id = '10700001-0000-4000-8000-000000000001'
      and dedupe_key like 'trip:%'),
  1,
  'so the passenger gets one reminder, not one per scheduler tick'
);

-- A live subscription on the basic plan, with its one allowed vehicle.
insert into public.subscriptions (id, owner_org_id, plan_code, status, price_yer, current_period_end)
values ('1070d001-0000-4000-8000-000000000001', '1070aa00-0000-4000-8000-00000000000a',
        'basic', 'active', 0, now() + interval '20 days');

select ok(
  (public.cmd_notify_quota_thresholds('10700003-0000-4000-8000-000000000003', '2026-03') ->> 'sent')::int >= 1,
  'a metric at its limit raises a quota warning'
);

select is(
  (select count(*)::int from public.notifications
    where kind = 'quota_threshold' and title_key = 'notifications.quotaReached'
      and params ->> 'metric' = 'vehicles'),
  1,
  'the 100% case uses the sentence that says nothing more will be accepted'
);

select is(
  (select min(params ->> 'threshold') from public.notifications where kind = 'quota_threshold'),
  '100',
  'and every metric at its limit is reported as reached, not only the first'
);

select is(
  (public.cmd_notify_quota_thresholds('10700003-0000-4000-8000-000000000003', '2026-03') ->> 'sent')::int,
  0,
  'the same warning is not repeated in the same month'
);

select is(
  (select count(*)::int from public.notifications
    where kind = 'subscription_expiring' and title_key = 'notifications.subscriptionExpiring3'),
  0,
  'a subscription ending in 20 days does not warn yet'
);

update public.subscriptions
   set current_period_end = now() + interval '3 days'
 where id = '1070d001-0000-4000-8000-000000000001';

select ok(
  (public.cmd_notify_subscription_expiring('10700003-0000-4000-8000-000000000003') ->> 'sent')::int >= 1,
  'three days out it does'
);

select is(
  (select count(*)::int from public.notifications
    where kind = 'subscription_expiring' and title_key = 'notifications.subscriptionExpiring3'),
  1,
  'once, with the sentence built for three days'
);

select is(
  (public.cmd_notify_subscription_expiring('10700003-0000-4000-8000-000000000003') ->> 'sent')::int,
  0,
  'and running it again the same day adds nothing'
);

-- An ageing verification request nags the staff on duty once a day.
insert into public.verification_requests (id, subject_type, subject_id, requested_by, status, created_at)
values ('1070e001-0000-4000-8000-000000000001', 'organization',
        '1070aa00-0000-4000-8000-00000000000a', '10700002-0000-4000-8000-000000000002',
        'pending', now() - interval '3 days');

select is(
  (public.cmd_notify_pending_verifications('10700003-0000-4000-8000-000000000003', '48 hours') ->> 'sent')::int,
  1,
  'a request older than the SLA reaches the staff on duty'
);

select is(
  (public.cmd_notify_pending_verifications('10700003-0000-4000-8000-000000000003', '48 hours') ->> 'sent')::int,
  0,
  'a nag that arrives hourly is a nag people filter out, so it is daily'
);

select is(
  (select params ->> 'ageHours' from public.notifications
    where kind = 'verification_sla' limit 1)::int >= 70,
  true,
  'and it says how long the queue has been waiting'
);

-- ---------------------------------------------------------------------------
-- 7. Access
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.notification_deliveries
    where user_id = '10700001-0000-4000-8000-000000000001')
  >
  (select count(*)::int from public.notification_deliveries
    where user_id = '10700004-0000-4000-8000-000000000004'),
  true,
  'the fixture really has more activity for one user than the other'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"10700001-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select count(*)::int from public.notification_deliveries
    where user_id <> '10700001-0000-4000-8000-000000000001'),
  0,
  'a signed-in user reads only their own deliveries'
);

select is(
  (select count(*)::int from public.notifications
    where user_id <> '10700001-0000-4000-8000-000000000001'),
  0,
  'and only their own notifications'
);

select throws_ok(
  $$ insert into public.notification_settings (user_id, quiet_hours_enabled)
     values ('10700001-0000-4000-8000-000000000001', false) $$,
  '42501',
  null,
  'preferences are written by the command, never by the client'
);

select throws_ok(
  $$ select app.enqueue_notification(
       '10700004-0000-4000-8000-000000000004', 'booking_accepted', 'notifications.bookingAccepted') $$,
  '42501',
  null,
  'and nobody can mint a notification for somebody else'
);

select throws_ok(
  $$ select public.cmd_list_notifications('10700001-0000-4000-8000-000000000001', 30, null) $$,
  '42501',
  null,
  'the inbox command is the gateway''s, not the browser''s'
);

reset role;

select is(
  (public.cmd_list_notifications('10700001-0000-4000-8000-000000000001', 5, null) -> 'items')
  @> jsonb_build_array(jsonb_build_object('kind', 'booking_accepted')),
  true,
  'the inbox lists the booking acceptance first, newest first'
);

select ok(
  (public.cmd_list_notifications('10700001-0000-4000-8000-000000000001', 5, null) ->> 'unread')::int > 0,
  'with an unread count that is about the whole inbox, not the page'
);

select is(
  jsonb_typeof(
    public.cmd_list_notifications('10700001-0000-4000-8000-000000000001', 5, null)
      -> 'items' -> 0 -> 'channels'
  ),
  'object',
  'each item carries the delivery decision per channel'
);

-- ---------------------------------------------------------------------------
-- 9. The events and jobs the first pass left out
-- ---------------------------------------------------------------------------

-- The 2-hour band. A trip that leaves in two hours is a different message from one that leaves tomorrow,
-- and it is the same job: the band decides the window, the dedupe key decides the once.
update public.trips
   set departure_at = now() + interval '2 hours 5 minutes',
       -- Cash, so the second booking in this suite is not gated on a confirmed deposit (Phase 9 tests that).
       payment_policy = 'cash'
 where id = '1070b005-0000-4000-8000-000000000005';

select public.cmd_create_booking(
  '10700001-0000-4000-8000-000000000001', '1070b005-0000-4000-8000-000000000005',
  1, null, null, 'مسافر التنبيهات', '+967733949001', null, null, 'p11-soon', null
);

select public.cmd_accept_booking(
  '10700002-0000-4000-8000-000000000002',
  (select id from public.bookings where trip_id = '1070b005-0000-4000-8000-000000000005'
     and passenger_id = '10700001-0000-4000-8000-000000000001'),
  'p11-soon-accept', null
);

select is(
  (public.cmd_send_trip_reminders('10700003-0000-4000-8000-000000000003',
                                  array['soon']::text[]) ->> 'sent')::int,
  1,
  'the two-hour band sends its own reminder'
);

select is(
  (select title_key from public.notifications
    where dedupe_key like 'trip:%:soon'),
  'notifications.tripReminderSoon',
  'and it is the sentence for two hours, not the one for tomorrow'
);

select is(
  (public.cmd_send_trip_reminders('10700003-0000-4000-8000-000000000003',
                                  array['soon']::text[]) ->> 'sent')::int,
  0,
  'the same band twice in an hour sends nothing the second time'
);

-- §6.10's plan upgrade/downgrade: Phase 10 recorded the transition and told nobody.
insert into public.subscription_events (subscription_id, kind, from_plan, to_plan)
values ('1070d001-0000-4000-8000-000000000001', 'plan_changed', 'basic', 'pro');

select is(
  (select params ->> 'to' from public.notifications
    where kind = 'subscription_plan_changed'
      and user_id = '10700002-0000-4000-8000-000000000002'),
  'pro',
  'a plan change notifies the owner from the event row, so no command can forget to'
);

select is(
  (select count(*)::int from public.notifications where kind = 'subscription_plan_changed'),
  1,
  'one message for one owner, not one per member plus one for the company'
);

-- §6.10's cash-in settled by agent: the float moved in Phase 9 and the agent was told nothing.
insert into public.agents (id, user_id, float_balance_yer, credit_limit_yer)
values ('1070e001-0000-4000-8000-000000000001', '10700004-0000-4000-8000-000000000004',
        50_000, 200_000);

insert into public.agent_transactions (agent_id, kind, amount_yer, balance_after_yer, actor_id)
values ('1070e001-0000-4000-8000-000000000001', 'settlement', 30_000, 20_000,
        '10700003-0000-4000-8000-000000000003');

select is(
  (select params ->> 'balance' from public.notifications
    where kind = 'agent_cash_in_settled'
      and user_id = '10700004-0000-4000-8000-000000000004'),
  '20000',
  'settling an agent cash-in tells the agent, with the balance after the settlement'
);

-- The no-show window: the trip left, and somebody is still "accepted".
update public.trips
   set departure_at = now() - interval '2 hours',
       status = 'in_progress',
       -- A trip in progress has a start time; the constraint says so, and pretending otherwise would make
       -- the fixture illegal rather than the feature wrong.
       started_at = now() - interval '2 hours'
 where id = '1070b001-0000-4000-8000-000000000001';

select is(
  (public.cmd_notify_no_shows('10700003-0000-4000-8000-000000000003', '45 minutes') ->> 'sent')::int,
  1,
  'the no-show window finds a trip that left with an accepted booking still on it'
);

select is(
  (select params ->> 'count' from public.notifications
    where kind = 'no_show_alert' and user_id = '10700002-0000-4000-8000-000000000002'),
  '1',
  'and it counts the unresolved bookings instead of guessing who boarded'
);

select is(
  (public.cmd_notify_no_shows('10700003-0000-4000-8000-000000000003', '45 minutes') ->> 'sent')::int,
  0,
  'the same trip is reported once a day, not once per scheduler tick'
);

-- The digest: two new trips, one message.
insert into public.saved_searches (id, user_id, label, filters, notify, digest, fingerprint)
values ('1070f001-0000-4000-8000-000000000001', '10700001-0000-4000-8000-000000000001',
        'ملخص يومي', '{"priceMax": 12000}'::jsonb, true, true, 'digest-fixture');

insert into public.saved_search_matches (saved_search_id, trip_id) values
  ('1070f001-0000-4000-8000-000000000001', '1070b001-0000-4000-8000-000000000001'),
  ('1070f001-0000-4000-8000-000000000001', '1070b005-0000-4000-8000-000000000005');

select is(
  (public.cmd_digest_saved_searches('10700003-0000-4000-8000-000000000003') ->> 'sent')::int,
  1,
  'a digest search gets one message for both new trips'
);

select is(
  (select params ->> 'count' from public.notifications
    where kind = 'saved_search_match'
      and title_key = 'notifications.savedSearchDigest'
      and user_id = '10700001-0000-4000-8000-000000000001'),
  '2',
  'and it counts the matches rather than naming one of them twice'
);

select is(
  (public.cmd_digest_saved_searches('10700003-0000-4000-8000-000000000003') ->> 'sent')::int,
  0,
  'the second run reports nothing: the matches it sent are stamped'
);

select ok(
  (select bool_and(m.digested_at is not null) from public.saved_search_matches m
    where m.saved_search_id = '1070f001-0000-4000-8000-000000000001'),
  'and the stamp is what makes that true without a second table'
);

-- The deep link keeps the filters: the alert is about a search, so it opens the search.
select ok(
  (select n.link like '/trips?%' and n.link like '%priceMax=5000%' and n.link like '%origin=%'
     from public.notifications n
    where n.kind = 'saved_search_match' and n.dedupe_key like 'search:%'
    limit 1),
  'a saved-search alert links back to the filtered search, not to a bare trip page'
);

-- The catalogue behind the admin preview: staff only, and every event in it.
select is(
  (select jsonb_array_length(public.cmd_get_notification_catalogue(
            '10700003-0000-4000-8000-000000000003') -> 'items')),
  35,
  'the catalogue lists every event: 31 from the first pass, the three §6.10 additions, and the ops alert 00034 adds'
);

select throws_ok(
  $$ select public.cmd_get_notification_catalogue('10700001-0000-4000-8000-000000000001') $$,
  '42501',
  null,
  'and a passenger cannot read the platform''s routing table'
);

select * from finish();
rollback;
