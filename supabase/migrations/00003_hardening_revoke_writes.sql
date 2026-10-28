-- 00003 — the write-path lockdown (ADR-17, ADR-18)
--
-- Supabase grants anon/authenticated broad table privileges by default. Maak does not want that:
-- the ONLY way to mutate data is an Edge Function calling a single cmd_* SQL command with the
-- service role. This migration removes every client write privilege and makes the default
-- privileges apply to future tables too, so a new migration cannot silently re-open the door.
--
-- Reads stay available (RLS decides visibility). Writes do not.

-- 1. Existing tables in the exposed schema.
revoke insert, update, delete, truncate, references, trigger on all tables in schema public
  from anon, authenticated;

-- 2. Future tables created by the migration role.
alter default privileges in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;

-- 3. Sequences: clients must never be able to advance them.
revoke usage, select, update on all sequences in schema public from anon, authenticated;
alter default privileges in schema public
  revoke usage, select, update on sequences from anon, authenticated;

-- 4. Functions in public: nothing is callable by a client unless explicitly granted later
--    (public/anon/authenticated lose EXECUTE). Command functions live in public as cmd_* but are
--    granted to service_role only.
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;

-- 5. Belt and braces: anon must not read auth.users, ever.
revoke all on table auth.users from anon, authenticated;

comment on schema public is
  'Domain schema. Clients may SELECT (RLS-filtered) only. All writes go through cmd_* functions
   invoked by Edge Functions with the service role (ADR-17).';

-- 6. A guard for future migrations: this function reports any table in public that still
--    grants writes to a client role. CI runs it; a non-empty result fails the build.
create or replace function app.audit_client_write_grants()
returns table (table_name text, grantee text, privilege text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.relname::text, g.grantee::text, g.privilege_type::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) as g
  where n.nspname = 'public'
    and c.relkind = 'r'
    and g.grantee::regrole::text in ('anon', 'authenticated')
    and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  order by 1, 2, 3;
$$;

revoke all on function app.audit_client_write_grants() from public, anon, authenticated;
grant execute on function app.audit_client_write_grants() to service_role;
