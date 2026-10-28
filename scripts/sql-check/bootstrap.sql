-- Bootstrap for the SQL harness: a *minimal* Supabase stand-in.
--
-- This file is NOT part of the product schema. It recreates just enough of the platform for the
-- real migrations to run against a real PostgreSQL:
--   · the roles Supabase uses (anon / authenticated / service_role)
--   · auth.users (the trigger in 00004/00006 listens on it)
--   · storage.buckets / storage.objects / storage.foldername() (migration 00006 writes policies)
--   · a pgTAP-compatible shim (plan / ok / is / throws_ok / finish) so the committed pgTAP files run
--     unmodified. On Supabase CI the genuine `pgtap` extension is used instead.
--
-- Anything stubbed here is visibly a *platform* concern, never a Maak rule.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    create role supabase_admin nologin;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth.users (subset: the columns our triggers read)
-- ---------------------------------------------------------------------------

create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key,
  email              text,
  phone              text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Storage (subset used by the bucket + policy definitions)
-- ---------------------------------------------------------------------------

create schema if not exists storage;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text not null,
  owner      uuid,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

-- Same contract as Supabase: the folder path, without the file name.
create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1];
$$;

-- ---------------------------------------------------------------------------
-- pgTAP shim (only when the real extension is absent)
--
-- Two roles to play:
--   · assertion helpers (plan/ok/is/finish) only *record* results, so they are SECURITY DEFINER and
--     work no matter which role the test switched to;
--   · throws_ok/lives_ok must execute the statement AS THE CALLER (that is the whole point of an RLS
--     test), so they stay SECURITY INVOKER and delegate only the recording.
-- ---------------------------------------------------------------------------

create schema if not exists tap;

create or replace function tap.state_init()
returns void
language plpgsql
security definer
set search_path = tap, pg_temp
as $$
begin
  create temp table if not exists tap_state (planned int, ran int) on commit drop;
end;
$$;

create or replace function tap.plan(n int)
returns text
language plpgsql
security definer
set search_path = tap, pg_temp
as $$
begin
  perform tap.state_init();
  delete from tap_state;
  insert into tap_state values (n, 0);
  return format('1..%s', n);
end;
$$;

create or replace function tap.finish()
returns text
language plpgsql
security definer
set search_path = tap, pg_temp
as $$
declare
  v_planned int;
  v_ran int;
begin
  select planned, ran into v_planned, v_ran from tap_state;
  if v_ran <> v_planned then
    raise exception 'TAP_PLAN_MISMATCH: planned % but ran %', v_planned, v_ran;
  end if;
  return format('1..%s (all %s assertions ran)', v_planned, v_ran);
end;
$$;

-- Records one assertion. SECURITY DEFINER: it must be able to write tap_state after SET ROLE.
create or replace function tap.record(condition boolean, description text)
returns text
language plpgsql
security definer
set search_path = tap, pg_temp
as $$
declare
  v_n int;
begin
  update tap_state set ran = ran + 1 returning ran into v_n;
  if v_n is null then
    raise exception 'TAP_NO_PLAN: assertion called before plan()';
  end if;
  if condition then
    return format('ok %s - %s', v_n, description);
  end if;
  return format('not ok %s - %s', v_n, description);
end;
$$;

create or replace function tap.ok(condition boolean, description text)
returns text
language plpgsql
as $$
begin
  return tap.record(condition, description);
end;
$$;

create or replace function tap.is(have anyelement, want anyelement, description text)
returns text
language plpgsql
as $$
begin
  return tap.record(
    have is not distinct from want,
    description || format(' [have: %s, want: %s]', coalesce(have::text, 'NULL'), coalesce(want::text, 'NULL'))
  );
end;
$$;

create or replace function tap.isnt(have anyelement, want anyelement, description text)
returns text
language plpgsql
as $$
begin
  return tap.record(have is distinct from want, description || ' [values are equal]');
end;
$$;

create or replace function tap.throws_ok(statement text, expected_sqlstate text, description text)
returns text
language plpgsql
as $$
begin
  begin
    execute statement;
  exception when others then
    if expected_sqlstate is null or sqlstate = expected_sqlstate then
      return tap.record(true, description);
    end if;
    return tap.record(false, description || format(' [raised %s: %s]', sqlstate, sqlerrm));
  end;
  return tap.record(false, description || ' [no exception raised]');
end;
$$;

create or replace function tap.throws_ok(statement text, expected_sqlstate text, expected_message text, description text)
returns text
language plpgsql
as $$
begin
  begin
    execute statement;
  exception when others then
    if (expected_sqlstate is null or sqlstate = expected_sqlstate)
       and (expected_message is null or sqlerrm = expected_message) then
      return tap.record(true, description);
    end if;
    return tap.record(false, description || format(' [raised %s: %s]', sqlstate, sqlerrm));
  end;
  return tap.record(false, description || ' [no exception raised]');
end;
$$;

create or replace function tap.lives_ok(statement text, description text)
returns text
language plpgsql
as $$
begin
  begin
    execute statement;
  exception when others then
    return tap.record(false, description || format(' [raised %s: %s]', sqlstate, sqlerrm));
  end;
  return tap.record(true, description);
end;
$$;

do $$
begin
  grant usage on schema tap to public, anon, authenticated, service_role;
  grant execute on all functions in schema tap to public, anon, authenticated, service_role;
  grant usage on schema auth to authenticated, anon, service_role;
end
$$;

comment on schema tap is
  'pgTAP-compatible shim used when the real extension is unavailable (see scripts/sql-check.mjs).';
