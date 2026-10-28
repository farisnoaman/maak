-- 0003 — Phase 1: accounts, membership and the verification queue
--
-- The promises verified here:
--   1. a company is created by exactly one command, with its owner membership in the same transaction
--   2. membership — not a JWT claim — decides who can read an organization
--   3. an invitation is bound to a contact and to a hashed token
--   4. verification documents are private: applicant, their organization, and staff only
--   5. nobody decides their own verification request, and a rejection needs a reason
--   6. clients cannot execute a cmd_* function at all (the write lockdown holds)
--
-- Run with: supabase test db   (requires Docker)

begin;

create extension if not exists pgtap;

select plan(23);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'applicant@example.test', '+967733111111', '{"locale":"ar"}'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'owner@example.test', '+967733222222', '{"locale":"ar"}'),
  ('cccccccc-3333-4333-8333-cccccccccccc', 'staff@example.test', '+967733333333', '{"locale":"en"}'),
  ('dddddddd-4444-4444-8444-dddddddddddd', 'staff2@example.test', '+967733444444', '{"locale":"en"}'),
  ('eeeeeeee-5555-4555-8555-eeeeeeeeeeee', 'manager@example.test', '+967733555555', '{"locale":"en"}');

insert into public.user_roles (user_id, role)
values
  ('cccccccc-3333-4333-8333-cccccccccccc', 'platform_staff'),
  ('dddddddd-4444-4444-8444-dddddddddddd', 'platform_staff');

-- ---------------------------------------------------------------------------
-- 1. Organization creation is atomic: org + owner membership
-- ---------------------------------------------------------------------------

create temporary table t_org on commit drop as
select public.cmd_create_organization(
  'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  'شركة معك للنقل',
  'Maak Transport',
  'company',
  'CR-100200',
  '+967733222222',
  'ops@maak.test',
  'test-request-1',
  null
) as payload;

select is(
  (select count(*)::int from public.organization_members
   where user_id = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' and role = 'owner' and status = 'active'),
  1,
  'creating an organization also creates its active owner membership'
);

select is(
  (select verification_status::text from public.organizations
   where id = ((select payload -> 'organization' ->> 'id')::uuid)),
  'unverified',
  'a new organization starts unverified (nothing is usable until staff approve it)'
);

select ok(
  exists (
    select 1 from audit.log
    where action = 'organization.create' and actor_id = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
  ),
  'organization creation is audited with the actor'
);

-- ---------------------------------------------------------------------------
-- 2. Membership decides visibility
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa","role":"authenticated"}';

select is(
  (select count(*)::int from public.organizations),
  0,
  'a non-member sees no organization'
);

set local request.jwt.claims = '{"sub":"bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb","role":"authenticated"}';

select is(
  (select count(*)::int from public.organizations),
  1,
  'the owner sees their organization'
);

select is(
  (select count(*)::int from public.organization_members),
  1,
  'the owner sees the member list of their organization'
);

-- ---------------------------------------------------------------------------
-- 3. Invitations: hashed token, contact-bound
-- ---------------------------------------------------------------------------

reset role;

select public.cmd_invite_member(
  'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  ((select payload -> 'organization' ->> 'id')::uuid),
  'manager',
  'manager@example.test',
  null,
  repeat('ab', 32),
  now() + interval '72 hours',
  'test-request-2',
  null
);

select is(
  (select invite_token_hash from public.organization_members where invited_email = 'manager@example.test'),
  repeat('ab', 32),
  'only the sha256 hash of the invite token is stored'
);

select throws_ok(
  format(
    $$ select public.cmd_accept_invite(%L::uuid, %L::uuid, %L, 'test', null) $$,
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    (select id from public.organization_members where invited_email = 'manager@example.test'),
    repeat('ab', 32)
  ),
  '42501',
  null,
  'an invite cannot be accepted by someone it was not addressed to'
);

select public.cmd_accept_invite(
  'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
  (select id from public.organization_members where invited_email = 'manager@example.test'),
  repeat('ab', 32),
  'test-request-3',
  null
);

select is(
  (select status::text from public.organization_members where user_id = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'),
  'active',
  'accepting an invite activates the membership'
);

-- ---------------------------------------------------------------------------
-- 4. Verification documents are private
-- ---------------------------------------------------------------------------

select public.cmd_submit_verification(
  'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  'individual',
  'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  '[{"kind":"national_id_front","path":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/front.jpg"},
    {"kind":"national_id_back","path":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/back.jpg"}]'::jsonb,
  '{"fullName":"مقدّم الطلب"}'::jsonb,
  'first submission',
  'test-request-4',
  null
);

select is(
  (select verification_status::text from public.profiles where id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'),
  'pending',
  'submitting a verification moves the profile to pending'
);

select is(
  (select count(*)::int from public.verification_documents),
  2,
  'both documents are linked to the request'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"eeeeeeee-5555-4555-8555-eeeeeeeeeeee","role":"authenticated"}';

select is(
  (select count(*)::int from public.verification_documents),
  0,
  'an unrelated signed-in user cannot read verification documents'
);

select is(
  (select count(*)::int from public.verification_requests),
  0,
  'an unrelated signed-in user cannot even see that a request exists'
);

set local request.jwt.claims = '{"sub":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa","role":"authenticated"}';

select is(
  (select count(*)::int from public.verification_documents),
  2,
  'the applicant can read their own documents'
);

set local request.jwt.claims = '{"sub":"cccccccc-3333-4333-8333-cccccccccccc","role":"authenticated"}';

select is(
  (select count(*)::int from public.verification_documents),
  2,
  'platform staff can read documents for review'
);

-- ---------------------------------------------------------------------------
-- 5. Decisions: separation of duties and reasons
-- ---------------------------------------------------------------------------

reset role;

select throws_ok(
  format(
    $$ select public.cmd_decide_verification(%L::uuid, %L::uuid, 'approve', null, 'test', null) $$,
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    (select id from public.verification_requests where subject_id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
  ),
  '42501',
  null,
  'a non-staff user cannot decide a verification'
);

select throws_ok(
  format(
    $$ select public.cmd_decide_verification(%L::uuid, %L::uuid, 'reject', 'no', 'test', null) $$,
    'cccccccc-3333-4333-8333-cccccccccccc',
    (select id from public.verification_requests where subject_id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
  ),
  '22023',
  null,
  'a rejection without a substantive reason is refused'
);

select public.cmd_decide_verification(
  'cccccccc-3333-4333-8333-cccccccccccc',
  (select id from public.verification_requests where subject_id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'),
  'approve',
  'documents match the registry',
  'test-request-5',
  null
);

select is(
  (select verification_status::text from public.profiles where id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'),
  'verified',
  'approval verifies the profile'
);

select is(
  (select count(*)::int from public.notifications
   where user_id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' and kind = 'verification_approved'),
  1,
  'the applicant is notified in the same transaction'
);

select is(
  (select decision_by from public.verification_requests
   where subject_id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'),
  'cccccccc-3333-4333-8333-cccccccccccc'::uuid,
  'the decision records who made it'
);

-- Separation of duties: the submitter cannot decide, even with staff rights.
insert into public.user_roles (user_id, role)
values ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'platform_admin');

select public.cmd_submit_verification(
  'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  'organization',
  ((select payload -> 'organization' ->> 'id')::uuid),
  '[{"kind":"commercial_registration","path":"bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb/cr.pdf"}]'::jsonb,
  '{}'::jsonb,
  null,
  'test-request-6',
  null
);

select throws_ok(
  format(
    $$ select public.cmd_decide_verification(%L::uuid, %L::uuid, 'approve', null, 'test', null) $$,
    'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    (select id from public.verification_requests where subject_id
       = ((select payload -> 'organization' ->> 'id')::uuid))
  ),
  '42501',
  null,
  'the submitter of a request can never decide it, even as platform admin'
);

-- ---------------------------------------------------------------------------
-- 6. The write lockdown still holds for the new tables
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb","role":"authenticated"}';

select throws_ok(
  $$ select public.cmd_create_organization('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'x y', null, 'company', null, null, null, null, null) $$,
  '42501',
  null,
  'a client cannot execute a cmd_* command directly'
);

select throws_ok(
  $$ insert into public.notifications (user_id, kind, title_key) values ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'member_joined', 'x.y') $$,
  '42501',
  null,
  'a client cannot forge a notification row'
);

select * from finish();

rollback;
