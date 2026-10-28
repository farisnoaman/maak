-- 0001 — the write-path lockdown (acceptance criterion, ADR-017)
--
-- Proves that a client can never mutate data directly: every INSERT/UPDATE/DELETE must go through
-- an Edge Function calling a cmd_* function with the service role.
--
-- Run with: supabase test db   (requires Docker)

begin;

create extension if not exists pgtap;

select plan(9);

-- ---------------------------------------------------------------------------
-- 1. No client write grants on any table in the exposed schema
-- ---------------------------------------------------------------------------

select is(
  (
    select count(*)::int
    from information_schema.role_table_grants g
    where g.table_schema = 'public'
      and g.grantee in ('anon', 'authenticated')
      and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ),
  0,
  'anon/authenticated hold no write grants on public tables'
);

-- The runtime audit: if a future migration re-opens a write path, this returns rows.
select is(
  (select count(*)::int from app.audit_client_write_grants()),
  0,
  'app.audit_client_write_grants() reports zero write grants'
);

-- ---------------------------------------------------------------------------
-- 2. The grants we DO want: reads for authenticated, nothing for anon
-- ---------------------------------------------------------------------------

select ok(
  has_table_privilege('authenticated', 'public.profiles', 'SELECT'),
  'authenticated may SELECT profiles (RLS still filters rows)'
);

select ok(
  not has_table_privilege('anon', 'public.profiles', 'SELECT'),
  'anon cannot SELECT profiles at all'
);

select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'INSERT'),
  'authenticated cannot INSERT profiles'
);

select ok(
  not has_table_privilege('authenticated', 'public.user_roles', 'UPDATE'),
  'authenticated cannot UPDATE user_roles (no privilege escalation)'
);

-- ---------------------------------------------------------------------------
-- 3. Commands are service-role only
-- ---------------------------------------------------------------------------

select ok(
  has_function_privilege('service_role', 'public.app_consume_rate_limit(uuid, text, integer, integer)', 'EXECUTE'),
  'service_role may execute the rate-limit command'
);

select ok(
  not has_function_privilege('authenticated', 'public.app_consume_rate_limit(uuid, text, integer, integer)', 'EXECUTE'),
  'authenticated may not execute the rate-limit command'
);

select ok(
  not has_function_privilege('anon', 'public.app_write_audit(uuid, text, text, text, jsonb, jsonb, text, text, inet, text)', 'EXECUTE'),
  'anon may not write audit rows'
);

select * from finish();

rollback;
