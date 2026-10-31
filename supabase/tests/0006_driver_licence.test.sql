-- 0006 — Phase 3.1: the driver's licence, photographed
--
-- The promises verified here:
--   1. the licence image lives in a private bucket, one folder per driver account
--   2. the only writer is `cmd_set_driver_licence` — not executable by a client
--   3. a driver may photograph their own licence; a stranger may not touch it, at the command *or* at
--      storage
--   4. the path is checked, not trusted: another driver's folder, `..`, or a file that was never
--      uploaded are all refused
--   5. an expired licence cannot be uploaded as evidence of a valid one
--   6. changing the licence re-opens verification, clears the approver, and notifies staff; saving the
--      same values twice is not an event
--   7. the operator who invited the driver and platform staff can read the folder; nobody else can
--
-- Run with: supabase test db   (requires Docker)

begin;

create extension if not exists pgtap;

select plan(31);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('dddd0001-1111-4111-8111-dddddddddddd', 'licence-driver@example.test', '+967733300001', '{"locale":"ar"}'),
  ('dddd0002-2222-4222-8222-dddddddddddd', 'licence-other-driver@example.test', '+967733300002', '{"locale":"ar"}'),
  ('dddd0003-3333-4333-8333-dddddddddddd', 'licence-owner@example.test', '+967733300003', '{"locale":"ar"}'),
  ('dddd0004-4444-4444-8444-dddddddddddd', 'licence-staff@example.test', '+967733300004', '{"locale":"ar"}'),
  ('dddd0005-5555-4555-8555-dddddddddddd', 'licence-stranger@example.test', '+967733300005', '{"locale":"ar"}'),
  ('dddd0006-6666-4666-8666-dddddddddddd', 'licence-invited@example.test', '+967733300006', '{"locale":"ar"}');

insert into public.user_roles (user_id, role)
values ('dddd0004-4444-4444-8444-dddddddddddd', 'platform_staff');

update public.profiles
set verification_status = 'verified'
where id in (
  'dddd0001-1111-4111-8111-dddddddddddd',
  'dddd0002-2222-4222-8222-dddddddddddd',
  'dddd0003-3333-4333-8333-dddddddddddd',
  'dddd0006-6666-4666-8666-dddddddddddd'
);

insert into public.organizations (id, name, owner_id, verification_status, plan)
values ('dddd00a0-0000-4000-8000-dddddddddddd', 'Licence Co', 'dddd0003-3333-4333-8333-dddddddddddd', 'verified', 'basic');

insert into public.organization_members (org_id, user_id, role, status, joined_at)
values ('dddd00a0-0000-4000-8000-dddddddddddd', 'dddd0003-3333-4333-8333-dddddddddddd', 'owner', 'active', now());

-- The driver who will upload their licence: accepted, and already approved once.
insert into public.driver_profiles (
  id, user_id, invited_phone, full_name, org_id, invited_by, licence_no, licence_expiry,
  status, verification_status, verified_by, verified_at
)
values (
  'dddd00b0-0000-4000-8000-dddddddddddd',
  'dddd0001-1111-4111-8111-dddddddddddd',
  '+967733300001', 'سائق الرخصة', 'dddd00a0-0000-4000-8000-dddddddddddd',
  'dddd0003-3333-4333-8333-dddddddddddd', 'OLD-0001', current_date + 200,
  'active', 'verified', 'dddd0004-4444-4444-8444-dddddddddddd', now() - interval '2 days'
);

-- A second accepted driver, so "somebody else's folder" is a real folder.
insert into public.driver_profiles (
  id, user_id, invited_phone, full_name, org_id, invited_by, licence_no, licence_expiry,
  status, verification_status
)
values (
  'dddd00b1-0000-4000-8000-dddddddddddd',
  'dddd0002-2222-4222-8222-dddddddddddd',
  '+967733300002', 'سائق آخر', 'dddd00a0-0000-4000-8000-dddddddddddd',
  'dddd0003-3333-4333-8333-dddddddddddd', 'OTH-0002', current_date + 200,
  'active', 'unverified'
);

-- Invited but never accepted: no account behind the row, so no licence to attach.
insert into public.driver_profiles (
  id, invited_phone, full_name, org_id, invited_by, status, verification_status
)
values (
  'dddd00b2-0000-4000-8000-dddddddddddd',
  '+967733300006', 'سائق مدعو', 'dddd00a0-0000-4000-8000-dddddddddddd',
  'dddd0003-3333-4333-8333-dddddddddddd', 'invited', 'unverified'
);

-- An uploaded object, standing in for what the phone pushed to storage before calling the command.
insert into storage.objects (bucket_id, name, owner)
values ('driver-documents', 'dddd0001-1111-4111-8111-dddddddddddd/licence-1.jpg',
        'dddd0001-1111-4111-8111-dddddddddddd');

-- ---------------------------------------------------------------------------
-- 1. The bucket and the single write path
-- ---------------------------------------------------------------------------

select ok(
  exists (select 1 from storage.buckets where id = 'driver-documents' and not public),
  'licence images live in a private bucket'
);

select is(
  (select count(*)::int from storage.buckets where id = 'driver-documents' and public),
  0,
  'and there is no public door to it'
);

select is(
  has_function_privilege('authenticated', 'public.cmd_set_driver_licence(uuid, uuid, text, date, text, text, text, inet)', 'execute'),
  false,
  'a client cannot call the licence command directly'
);

select is(
  has_function_privilege('service_role', 'public.cmd_set_driver_licence(uuid, uuid, text, date, text, text, text, inet)', 'execute'),
  true,
  'the edge function can'
);

select is(
  has_function_privilege('authenticated', 'app.can_read_driver_documents(uuid)', 'execute'),
  true,
  'the storage predicate is executable by the caller the policy runs as'
);

-- ---------------------------------------------------------------------------
-- 2. The driver photographs their own licence
-- ---------------------------------------------------------------------------

create temp table uploaded as
select public.cmd_set_driver_licence(
  'dddd0001-1111-4111-8111-dddddddddddd',
  'dddd00b0-0000-4000-8000-dddddddddddd',
  'YE-DL-993311',
  current_date + 400,
  'C',
  'dddd0001-1111-4111-8111-dddddddddddd/licence-1.jpg',
  'test-request-licence',
  null
) as result;

select is(
  ((select result from uploaded) ->> 'verificationStatus'),
  'pending',
  'uploading the licence puts the driver back in the review queue'
);

select is(
  ((select result from uploaded) ->> 'reverificationRequired')::boolean,
  true,
  'and says so — the approval was about a document that has now been replaced'
);

select is(
  (select licence_photo_path from public.driver_profiles where id = 'dddd00b0-0000-4000-8000-dddddddddddd'),
  'dddd0001-1111-4111-8111-dddddddddddd/licence-1.jpg',
  'the path is stored'
);

select is(
  (select licence_no from public.driver_profiles where id = 'dddd00b0-0000-4000-8000-dddddddddddd'),
  'YE-DL-993311',
  'the number is stored'
);

select is(
  (select verified_by from public.driver_profiles where id = 'dddd00b0-0000-4000-8000-dddddddddddd'),
  null::uuid,
  'and the previous approver is cleared, because they approved something else'
);

select ok(
  exists (
    select 1 from public.notifications
    where user_id = 'dddd0004-4444-4444-8444-dddddddddddd'
      and title_key = 'notifications.driverPending'
  ),
  'staff are told there is a licence to look at'
);

select ok(
  exists (
    select 1 from audit.log
    where action = 'driver.setLicence'
      and entity_id = 'dddd00b0-0000-4000-8000-dddddddddddd'
      and before ? 'licencePhotoPath'
      and after ->> 'licencePhotoPath' = 'dddd0001-1111-4111-8111-dddddddddddd/licence-1.jpg'
  ),
  'the change is audited with before and after'
);

-- ---------------------------------------------------------------------------
-- 3. What the command refuses
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.cmd_set_driver_licence(
       'dddd0001-1111-4111-8111-dddddddddddd', 'dddd00b0-0000-4000-8000-dddddddddddd',
       'YE-DL-993312', current_date + 400, 'C',
       'dddd0002-2222-4222-8222-dddddddddddd/licence-1.jpg'
     ) $$,
  '22023',
  null,
  'a path inside another driver''s folder is refused'
);

select throws_ok(
  $$ select public.cmd_set_driver_licence(
       'dddd0001-1111-4111-8111-dddddddddddd', 'dddd00b0-0000-4000-8000-dddddddddddd',
       'YE-DL-993313', current_date + 400, 'C',
       'dddd0001-1111-4111-8111-dddddddddddd/nothing-here.jpg'
     ) $$,
  '22023',
  null,
  'a path to a file that was never uploaded is refused'
);

select throws_ok(
  $$ select public.cmd_set_driver_licence(
       'dddd0001-1111-4111-8111-dddddddddddd', 'dddd00b0-0000-4000-8000-dddddddddddd',
       'YE-DL-993314', current_date - 1, 'C', null
     ) $$,
  '22023',
  null,
  'an expired licence is refused — it cannot be evidence of a valid one'
);

select throws_ok(
  $$ select public.cmd_set_driver_licence(
       'dddd0005-5555-4555-8555-dddddddddddd', 'dddd00b0-0000-4000-8000-dddddddddddd',
       'YE-DL-993315', current_date + 400, 'C', null
     ) $$,
  '42501',
  null,
  'a stranger cannot rewrite somebody else''s licence'
);

select throws_ok(
  $$ select public.cmd_set_driver_licence(
       'dddd0003-3333-4333-8333-dddddddddddd', 'dddd00b2-0000-4000-8000-dddddddddddd',
       'YE-DL-993316', current_date + 400, 'C', null
     ) $$,
  '23505',
  null,
  'and an invitation that was never accepted has no licence to attach'
);

-- The operator who invited the driver may correct the number without touching the photo.
select is(
  public.cmd_set_driver_licence(
    'dddd0003-3333-4333-8333-dddddddddddd',
    'dddd00b0-0000-4000-8000-dddddddddddd',
    'YE-DL-993311-A',
    current_date + 400,
    'C',
    'dddd0001-1111-4111-8111-dddddddddddd/licence-1.jpg',
    null,
    null
  ) ->> 'verificationStatus',
  'pending',
  'the company owner may correct the licence, and it still needs review'
);

-- ---------------------------------------------------------------------------
-- 4. Saving the same values twice is not an event
-- ---------------------------------------------------------------------------

create temp table unchanged as
select public.cmd_set_driver_licence(
  'dddd0003-3333-4333-8333-dddddddddddd',
  'dddd00b0-0000-4000-8000-dddddddddddd',
  'YE-DL-993311-A',
  current_date + 400,
  'C',
  'dddd0001-1111-4111-8111-dddddddddddd/licence-1.jpg',
  null,
  null
) as result;

select is(
  ((select result from unchanged) ->> 'reverificationRequired')::boolean,
  false,
  'a no-op save does not claim to re-open anything'
);

select is(
  (
    select count(*)::int from audit.log
    where action = 'driver.setLicence'
      and entity_id = 'dddd00b0-0000-4000-8000-dddddddddddd'
  ),
  2,
  'and it writes no audit row of its own (two real changes, two rows)'
);

-- ---------------------------------------------------------------------------
-- 5. Who may read the folder
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub":"dddd0001-1111-4111-8111-dddddddddddd","role":"authenticated"}';
select is(
  app.can_read_driver_documents('dddd0001-1111-4111-8111-dddddddddddd'),
  true,
  'the driver reads their own licence'
);
select is(
  app.can_read_driver_documents('dddd0002-2222-4222-8222-dddddddddddd'),
  false,
  'but not another driver''s'
);

set local request.jwt.claims = '{"sub":"dddd0003-3333-4333-8333-dddddddddddd","role":"authenticated"}';
select is(
  app.can_read_driver_documents('dddd0001-1111-4111-8111-dddddddddddd'),
  true,
  'the owner of the company the driver works for reads it'
);

set local request.jwt.claims = '{"sub":"dddd0005-5555-4555-8555-dddddddddddd","role":"authenticated"}';
select is(
  app.can_read_driver_documents('dddd0001-1111-4111-8111-dddddddddddd'),
  false,
  'a stranger reads nothing'
);

set local request.jwt.claims = '{"sub":"dddd0004-4444-4444-8444-dddddddddddd","role":"authenticated"}';
select is(
  app.can_read_driver_documents('dddd0001-1111-4111-8111-dddddddddddd'),
  true,
  'and staff read it, because that is whose queue it is'
);

-- The storage policies themselves: the embedded test database does not grant `authenticated` use of
-- the `storage` schema, so the policy *definition* is what is asserted here — the dev stack smoke test
-- exercises the upload path end to end.
select is(
  (
    select count(*)::int
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'driver_documents_write_self'
      and cmd = 'INSERT'
      and roles @> array['authenticated']::name[]
  ),
  1,
  'a driver has an INSERT policy on the bucket'
);

select ok(
  (
    select qual || coalesce(with_check, '')
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'driver_documents_write_self'
  ) like '%can_read_driver_documents%'
    or (
      select coalesce(with_check, '')
      from pg_policies
      where schemaname = 'storage'
        and tablename = 'objects'
        and policyname = 'driver_documents_write_self'
    ) like '%app.uid()%',
  'and that policy is the one that pins the folder to the caller'
);

-- ---------------------------------------------------------------------------
-- 6. The invitation is visible to the person it names, and to nobody else
-- ---------------------------------------------------------------------------
-- Without this, the "accept" button cannot exist: an unaccepted invitation has `user_id = null`, and the
-- Phase 3 policy only let a caller read a row whose `user_id` was already theirs. The invitee saw nothing,
-- so the feature that turns an invitation into a driver was unreachable from every client.

set local role authenticated;
set local request.jwt.claims = '{"sub":"dddd0006-6666-4666-8666-dddddddddddd","role":"authenticated"}';

select is(
  (select count(*)::int from public.driver_profiles where user_id is null),
  1,
  'an invited driver sees their own unaccepted invitation'
);

select is(
  (select full_name from public.driver_profiles where user_id is null),
  'سائق مدعو',
  'and it is the row addressed to their phone'
);

set local request.jwt.claims = '{"sub":"dddd0001-1111-4111-8111-dddddddddddd","role":"authenticated"}';
select is(
  (select count(*)::int from public.driver_profiles where user_id is null),
  0,
  'a driver whose account is already bound sees no pending invitation for somebody else'
);

set local request.jwt.claims = '{"sub":"dddd0004-4444-4444-8444-dddddddddddd","role":"authenticated"}';
select is(
  (select count(*)::int from public.driver_profiles where status = 'invited'),
  1,
  'and staff still reach it through the staff policy, which is a different door'
);

reset role;

select * from finish();
rollback;
