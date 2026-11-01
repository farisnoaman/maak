-- 0018 — Phase 12: the account deletion that finally has an executor
--
-- The promises verified here:
--   1. only a platform_admin can run it, never on their own account, never without a reason
--   2. it refuses while the answer would be a lie: live bookings, live trips, vehicles, money owed
--   3. the person is erased — name, phone, email, national id, licence, bank details, ID photographs,
--      push tokens, notification bodies, saved searches and roles
--   4. the books are not — the profile row survives, its bookings keep their money, and the audit row
--      records the deletion without recording what was deleted
--   5. a second run is idempotent rather than destructive
--
-- Run with: supabase test db   (or `npm run sql:check`, which needs no Docker)

begin;

create extension if not exists pgtap;

select plan(30);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('55550001-1111-4111-8111-555555555555', 'del-admin@example.test', '+967733600001', '{"locale":"en"}'),
  ('55550002-2222-4222-8222-555555555555', 'del-staff@example.test', '+967733600002', '{"locale":"en"}'),
  ('55550003-3333-4333-8333-555555555555', 'del-operator@example.test', '+967733600003', '{"locale":"ar"}'),
  ('55550004-4444-4444-8444-555555555555', 'del-passenger@example.test', '+967733600004', '{"locale":"ar"}'),
  ('55550005-5555-4555-8555-555555555555', 'del-live@example.test', '+967733600005', '{"locale":"ar"}');

insert into public.user_roles (user_id, role)
values
  ('55550001-1111-4111-8111-555555555555', 'platform_admin'),
  ('55550002-2222-4222-8222-555555555555', 'platform_staff'),
  ('55550004-4444-4444-8444-555555555555', 'geo_supervisor');

update public.profiles
set full_name = case id
      when '55550001-1111-4111-8111-555555555555' then 'مدير المنصة'
      when '55550002-2222-4222-8222-555555555555' then 'موظف الدعم'
      when '55550003-3333-4333-8333-555555555555' then 'مشغل النقل'
      when '55550004-4444-4444-8444-555555555555' then 'سالم المسافر'
      else 'راكب حي'
    end,
    national_id_number = case
      when id = '55550004-4444-4444-8444-555555555555' then '01010101'
      else null
    end,
    birth_place = case when id = '55550004-4444-4444-8444-555555555555' then 'عدن' else null end,
    avatar_path = case
      when id = '55550004-4444-4444-8444-555555555555' then '55550004/avatar.jpg'
      else null
    end,
    verification_status = case
      when id in ('55550003-3333-4333-8333-555555555555', '55550004-4444-4444-8444-555555555555')
        then 'verified'::public.verification_status
      else 'unverified'::public.verification_status
    end,
    deletion_requested_at = case
      when id = '55550004-4444-4444-8444-555555555555' then now() - interval '2 days'
      else null
    end
where id::text like '5555%';

insert into public.vehicles (
  id, owner_user_id, make, model, model_year, plate_number,
  seats_passenger, seats_total, status, verification_status, is_active,
  insurance_expiry, inspection_expiry, registration_expiry
)
values (
  '555500a1-0000-4000-8000-555555555555', '55550003-3333-4333-8333-555555555555',
  'Toyota', 'Hiace', 2019, 'DEL-1001', 12, 13, 'active', 'verified', true,
  current_date + 120, current_date + 120, current_date + 300
);

-- One published trip (which is why the operator cannot be deleted) and one completed one, so the passenger
-- has a *past* booking on the books and no live one.
insert into public.trips (
  id, code, owner_user_id, vehicle_id,
  origin_governorate_id, destination_governorate_id,
  departure_at, seats_total, seats_available, price_per_seat_yer,
  discount_kind, discount_value, status, verification_status, published_at
)
values
  ('555500b1-0000-4000-8000-555555555555', 'DEL-AA-0001', '55550003-3333-4333-8333-555555555555',
   '555500a1-0000-4000-8000-555555555555',
   (select id from public.governorates where code = 'YE-SA'),
   (select id from public.governorates where code = 'YE-AD'),
   now() + interval '3 days', 12, 10, 10000, 'none', 0, 'published', 'verified', now()),
  ('555500b2-0000-4000-8000-555555555555', 'DEL-AA-0002', '55550003-3333-4333-8333-555555555555',
   '555500a1-0000-4000-8000-555555555555',
   (select id from public.governorates where code = 'YE-SA'),
   (select id from public.governorates where code = 'YE-AD'),
   now() - interval '2 days', 12, 10, 10000, 'none', 0, 'published', 'verified', now() - interval '3 days');

-- A completed trip has to say when it started (00022's check), and completing it is what makes it history
-- rather than a live trip the deletion would have to refuse.
update public.trips
set status = 'completed', started_at = now() - interval '2 days', completed_at = now() - interval '2 days'
where id = '555500b2-0000-4000-8000-555555555555';

insert into public.bookings (
  id, code, trip_id, passenger_id, booked_by, status, seats,
  unit_price_yer, subtotal_yer, discount_yer, total_yer, payment_status,
  contact_name, contact_phone, note, passenger_gender, completed_at, hold_expires_at
)
values
  -- The passenger's history: finished, paid, and it has to still be there afterwards.
  ('555500c1-0000-4000-8000-555555555555', 'BK-DEL001', '555500b2-0000-4000-8000-555555555555',
   '55550004-4444-4444-8444-555555555555', '55550004-4444-4444-8444-555555555555',
   'completed', 1, 10000, 10000, 0, 10000, 'paid', 'سالم المسافر', '+967733600004', 'ملاحظة خاصة',
   'male', now() - interval '2 days', null),
  -- Somebody else's live booking: the rail that stops a deletion from stranding a trip.
  ('555500c2-0000-4000-8000-555555555555', 'BK-DEL002', '555500b1-0000-4000-8000-555555555555',
   '55550005-5555-4555-8555-555555555555', '55550005-5555-4555-8555-555555555555',
   'pending', 1, 10000, 10000, 0, 10000, 'unpaid', 'راكب حي', '+967733600005', null, null, null,
   now() + interval '20 minutes');

-- Everything else a real account accumulates and that must not survive it.
insert into public.notifications (user_id, kind, title_key, params, priority, dedupe_key)
values ('55550004-4444-4444-8444-555555555555', 'booking_accepted', 'notifications.booking_accepted.title',
        '{"code":"BK-DEL001"}'::jsonb, 'normal', 'del-test-1');

insert into public.device_tokens (user_id, platform, token)
values ('55550004-4444-4444-8444-555555555555', 'android', 'ExponentPushToken[del-test]');

insert into public.saved_searches (user_id, label, filters, fingerprint)
values ('55550004-4444-4444-8444-555555555555', 'عدن → صنعاء', '{"origin":[]}'::jsonb, 'del-fingerprint-1');

insert into public.driver_profiles (user_id, invited_phone, full_name, invited_by, licence_no, licence_photo_path)
values ('55550004-4444-4444-8444-555555555555', '+967733600004', 'سالم المسافر',
        '55550003-3333-4333-8333-555555555555', 'DL-000111', '55550004/licence.jpg');

insert into public.payment_accounts (kind, method, owner_user_id, provider_label, account_number, holder_name, status)
values ('agent', 'bank_transfer', '55550004-4444-4444-8444-555555555555', 'بنك عدن',
        '0123456789012', 'سالم المسافر', 'pending_verification');

insert into public.verification_requests (id, subject_type, subject_id, requested_by, status, note)
values ('555500d1-0000-4000-8000-555555555555', 'individual',
        '55550004-4444-4444-8444-555555555555', '55550004-4444-4444-8444-555555555555',
        'pending', 'رقم الهوية 01010101');

insert into public.verification_documents (request_id, kind, storage_path, mime, size_bytes)
values ('555500d1-0000-4000-8000-555555555555', 'national_id_front', '55550004/national-id.jpg', 'image/jpeg', 2048);

insert into public.passenger_documents (booking_id, id_type, id_number, photo_path)
values ('555500c1-0000-4000-8000-555555555555', 'national_id', '01010101', '55550004/passenger-id.jpg');

-- ---------------------------------------------------------------------------
-- 1. Who may run it, and which requests are refused before anything is erased
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_delete_account(
       '55550002-2222-4222-8222-555555555555', '55550004-4444-4444-8444-555555555555', 'طلب المستخدم'
     ) $$,
  '42501',
  null,
  'platform_staff cannot delete an account — this is a platform_admin command'
);

select throws_ok(
  $$ select public.cmd_delete_account(
       '55550001-1111-4111-8111-555555555555', '55550001-1111-4111-8111-555555555555', 'أريد حذف حسابي'
     ) $$,
  '42501',
  null,
  'and nobody can run it on their own account, not even the admin'
);

select throws_ok(
  $$ select public.cmd_delete_account(
       '55550001-1111-4111-8111-555555555555', '55550004-4444-4444-8444-555555555555', '   '
     ) $$,
  '22023',
  null,
  'a deletion without a reason is refused — the record has to say why'
);

select throws_ok(
  $$ select public.cmd_delete_account(
       '55550001-1111-4111-8111-555555555555', '55550009-9999-4999-8999-555555555555', 'طلب المستخدم'
     ) $$,
  '22023',
  null,
  'an account that does not exist is a validation error, not a silent success'
);

select throws_ok(
  $$ select public.cmd_delete_account(
       '55550001-1111-4111-8111-555555555555', '55550005-5555-4555-8555-555555555555', 'طلب المستخدم'
     ) $$,
  '23505',
  null,
  'a passenger with a live booking cannot be deleted — somebody is still holding a seat'
);

select throws_ok(
  $$ select public.cmd_delete_account(
       '55550001-1111-4111-8111-555555555555', '55550003-3333-4333-8333-555555555555', 'طلب المستخدم'
     ) $$,
  '23505',
  null,
  'an operator with a published trip cannot be deleted — the trip would have no owner'
);

select is(
  (select count(*)::int from public.profiles where id = '55550004-4444-4444-8444-555555555555'
     and deleted_at is null),
  1,
  'every refusal above left the account exactly as it was'
);

-- ---------------------------------------------------------------------------
-- 2. The deletion
-- ---------------------------------------------------------------------------

create temporary table t_deleted on commit drop as
select public.cmd_delete_account(
  '55550001-1111-4111-8111-555555555555',
  '55550004-4444-4444-8444-555555555555',
  'طلب المستخدم عبر الدعم',
  'del-request-1',
  null
) as payload;

select is(
  (select payload ->> 'deleted' from t_deleted)::boolean,
  true,
  'a passenger with only past bookings is deleted'
);

select is(
  (select count(*)::int from public.profiles where id = '55550004-4444-4444-8444-555555555555'),
  1,
  'the profile row survives — bookings, trips and invoices reference it with ON DELETE RESTRICT'
);

select is(
  (
    select count(*)::int from public.profiles
    where id = '55550004-4444-4444-8444-555555555555'
      and deleted_at is not null
      and deleted_by = '55550001-1111-4111-8111-555555555555'
      and full_name is null
      and phone is null
      and email is null
      and national_id_number is null
      and birth_place is null
      and avatar_path is null
      and deletion_requested_at is null
      and verification_status = 'unverified'
  ),
  1,
  'and every identifying column on it is erased, with the admin and the moment recorded'
);

select is(
  (select count(*)::int from public.user_roles
   where user_id = '55550004-4444-4444-8444-555555555555' and revoked_at is null),
  0,
  'the roles are revoked, so a deleted account holds no authority'
);

select is(
  (select count(*)::int from public.device_tokens where user_id = '55550004-4444-4444-8444-555555555555'),
  0,
  'the push tokens are gone — nothing can be delivered to that phone'
);

select is(
  (select count(*)::int from public.notifications where user_id = '55550004-4444-4444-8444-555555555555'),
  0,
  'and the notification bodies with them'
);

select is(
  (select count(*)::int from public.saved_searches where user_id = '55550004-4444-4444-8444-555555555555'),
  0,
  'a saved search is personal data too'
);

select is(
  (
    select count(*)::int from public.driver_profiles
    where user_id = '55550004-4444-4444-8444-555555555555'
      and full_name = 'محذوف'
      and invited_phone = '000000'
      and licence_no is null
      and licence_photo_path is null
      and is_active = false
  ),
  1,
  'the driver profile is scrubbed and deactivated rather than deleted, because trip history points at it'
);

select is(
  (
    select count(*)::int from public.payment_accounts
    where owner_user_id = '55550004-4444-4444-8444-555555555555'
      and status = 'archived'
      and archived_at is not null
      and holder_name = 'محذوف'
      and account_number like 'redacted-%'
  ),
  1,
  'bank details are redacted and the account archived — payouts still point at the row'
);

select is(
  (select count(*)::int from public.verification_documents
   where request_id = '555500d1-0000-4000-8000-555555555555'),
  0,
  'the national id photograph is deleted'
);

select is(
  (select count(*)::int from public.passenger_documents
   where booking_id = '555500c1-0000-4000-8000-555555555555'),
  0,
  'and so is the passenger document attached to the booking'
);

select is(
  (select note from public.verification_requests where id = '555500d1-0000-4000-8000-555555555555'),
  null::text,
  'the verification request stays as history, with its free text emptied'
);

select is(
  (select to_jsonb((select payload -> 'documentsToErase' from t_deleted)))::text,
  '["55550004/national-id.jpg", "55550004/passenger-id.jpg"]',
  'the Storage paths are handed back, because the rows are ours and the files are not'
);

-- ---------------------------------------------------------------------------
-- 3. The books survive, and the audit row says so without saying who
-- ---------------------------------------------------------------------------

select is(
  (
    select (total_yer, payment_status::text, status::text)
    from public.bookings where id = '555500c1-0000-4000-8000-555555555555'
  ),
  (10000, 'paid'::text, 'completed'::text),
  'the completed booking keeps its money, its payment status and its status'
);

select is(
  (
    select (contact_name, contact_phone, passenger_gender)
    from public.bookings where id = '555500c1-0000-4000-8000-555555555555'
  ),
  ('محذوف'::text, '+967000000000'::text, null::text),
  'and loses the name and phone of the person it was for'
);

select is(
  (
    select count(*)::int from public.bookings
    where passenger_id = '55550004-4444-4444-8444-555555555555'
  ),
  1,
  'the booking row is still attributable to the account id — the books keep adding up'
);

select is(
  (
    select count(*)::int from audit.log
    where action = 'account.deleted' and actor_id = '55550001-1111-4111-8111-555555555555'
      and entity_id = '55550004-4444-4444-8444-555555555555'
  ),
  1,
  'the deletion is audited with the admin who ran it'
);

select is(
  (
    select after ->> 'authScrubbed' from audit.log
    where action = 'account.deleted' and entity_id = '55550004-4444-4444-8444-555555555555'
  ),
  'true',
  'and the audit says whether the login itself was scrubbed, rather than assuming it'
);

select is(
  (
    select (before ? 'full_name') or (before ? 'email') or (before ? 'phone')
        or (before ? 'national_id_number')
    from audit.log
    where action = 'account.deleted' and entity_id = '55550004-4444-4444-8444-555555555555'
  ),
  false,
  'the immutable audit row carries flags, not the personal data that was just erased'
);

select is(
  (select before ->> 'hadEmail' from audit.log
   where action = 'account.deleted' and entity_id = '55550004-4444-4444-8444-555555555555'),
  'true',
  'it still records the shape of what was there — that there *was* an email'
);

select is(
  (select email from auth.users where id = '55550004-4444-4444-8444-555555555555'),
  null::text,
  'the login identity in auth.users is erased as well as the profile'
);

-- ---------------------------------------------------------------------------
-- 4. Idempotency, and the write lockdown
-- ---------------------------------------------------------------------------

select is(
  (public.cmd_delete_account(
    '55550001-1111-4111-8111-555555555555', '55550004-4444-4444-8444-555555555555', 'إعادة المحاولة'
  ) ->> 'alreadyDeleted')::boolean,
  true,
  'a retried deletion is idempotent — it reports the first one and erases nothing twice'
);

select is(
  has_function_privilege('anon', 'public.cmd_delete_account(uuid, uuid, text, text, inet)', 'execute'),
  false,
  'no client role can execute the deletion command'
);

select * from finish();
rollback;
