-- 00001 — schemas, extensions and shared helpers
--
-- Layout (ADR-0001):
--   public  domain tables (RLS-protected reads; writes only via cmd_* commands)
--   app     private helpers (auth predicates, invariants) — not exposed to clients
--   audit   append-only trail; insert-only, no update/delete for anyone

create extension if not exists postgis;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

create schema if not exists app;
create schema if not exists audit;

comment on schema app is 'Private helpers. Never exposed through the API.';
comment on schema audit is 'Append-only audit trail.';

revoke all on schema app from anon, authenticated;
grant usage on schema app to service_role;
grant usage on schema audit to service_role;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function app.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function app.set_updated_at is 'Trigger helper: stamps updated_at on every UPDATE.';

-- The authenticated user id, read from the JWT. Returns null for anon.
create or replace function app.uid()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

comment on function app.uid is 'Current auth user id from the JWT, or null when anonymous.';

-- Money guard: every *_minor column must be a non-negative integer.
create or replace function app.assert_non_negative(p_value bigint, p_field text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or p_value < 0 then
    raise exception 'INVALID_AMOUNT: % must be >= 0 (received %)', p_field, p_value
      using errcode = '22023';
  end if;
end;
$$;
