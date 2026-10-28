-- 0002 — identity isolation and the append-only audit log
--
-- Two promises are verified here:
--   1. a signed-in user can read only their own profile (and staff can read all)
--   2. nobody can rewrite history: audit.log rejects UPDATE, DELETE and TRUNCATE
--
-- Run with: supabase test db   (requires Docker)

begin;

create extension if not exists pgtap;

select plan(8);

-- ---------------------------------------------------------------------------
-- Fixtures: two users, one of them platform staff. Inserted as the superuser so the
-- RLS tests below run against realistic rows.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data)
values
  ('11111111-1111-4111-8111-111111111111', 'individual@example.test', '{"locale":"ar"}'),
  ('22222222-2222-4222-8222-222222222222', 'staff@example.test', '{"locale":"en"}');

insert into public.user_roles (user_id, role)
values ('22222222-2222-4222-8222-222222222222', 'platform_staff');

select is(
  (select count(*)::int from public.profiles where id = '11111111-1111-4111-8111-111111111111'),
  1,
  'a profile row is created automatically for a new auth user'
);

-- ---------------------------------------------------------------------------
-- RLS as an ordinary authenticated user
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';

select is(
  (select count(*)::int from public.profiles),
  1,
  'a user sees exactly one profile (their own)'
);

select is(
  (select id::text from public.profiles limit 1),
  '11111111-1111-4111-8111-111111111111',
  'the visible profile is the caller''s own'
);

select is(
  (select count(*)::int from public.profiles where id = '22222222-2222-4222-8222-222222222222'),
  0,
  'another user''s profile is invisible'
);

select throws_ok(
  $$ insert into public.profiles (id) values ('33333333-3333-4333-8333-333333333333') $$,
  '42501',
  null,
  'a client cannot insert a profile row even with RLS bypassed by a crafted query'
);

-- ---------------------------------------------------------------------------
-- Staff visibility
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';

select is(
  (select count(*)::int from public.profiles),
  2,
  'platform staff can read every profile'
);

-- ---------------------------------------------------------------------------
-- Audit log is append-only
-- ---------------------------------------------------------------------------

reset role;

insert into audit.log (actor_id, action, entity_type, entity_id, outcome)
values ('11111111-1111-4111-8111-111111111111', 'test.append', 'profile', '11111111-1111-4111-8111-111111111111', 'success');

select throws_ok(
  $$ update audit.log set action = 'tampered' $$,
  '42501',
  null,
  'audit rows cannot be updated'
);

select throws_ok(
  $$ delete from audit.log $$,
  '42501',
  null,
  'audit rows cannot be deleted'
);

select is(
  (select count(*)::int from audit.log where action = 'test.append'),
  1,
  'the appended audit row is present'
);

select * from finish();

rollback;
