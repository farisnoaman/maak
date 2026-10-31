-- 00004 — identity core (the minimum the gateway needs in Phase 0)
--
-- Phase 1 grows this into organizations, members, verification requests and storage policies.
-- Kept deliberately small so the write-path lockdown is testable end to end now.

create type public.verification_status as enum ('unverified', 'pending', 'verified', 'rejected');

create type public.platform_role as enum (
  'platform_admin',
  'platform_staff',
  'finance_officer',
  'geo_supervisor'
);

create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  full_name           text,
  phone               text,
  phone_verified_at   timestamptz,
  preferred_language  text not null default 'ar' check (preferred_language in ('ar', 'en')),
  preferred_numerals  text not null default 'western' check (preferred_numerals in ('western', 'arabic_indic')),
  verification_status public.verification_status not null default 'unverified',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function app.set_updated_at();

create table public.user_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       public.platform_role not null,
  granted_by uuid references public.profiles (id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id),
  reason     text
);

create unique index user_roles_active_unique
  on public.user_roles (user_id, role)
  where revoked_at is null;

create index user_roles_user_idx on public.user_roles (user_id) where revoked_at is null;

-- A profile row is created by the database, never by the client.
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, phone, preferred_language)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.phone, ''),
    coalesce(nullif(new.raw_user_meta_data ->> 'locale', ''), 'ar')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

-- Staff predicate (used by RLS policies and commands).
create or replace function app.is_platform_staff(p_uid uuid default app.uid())
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_uid is null then
    return false;
  end if;
  return exists (
    select 1
    from public.user_roles ur
    where ur.user_id = p_uid
      and ur.role in ('platform_staff', 'platform_admin')
      and ur.revoked_at is null
  );
end;
$$;

create or replace function app.is_verified(p_uid uuid default app.uid())
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_uid is null then
    return false;
  end if;
  return exists (
    select 1 from public.profiles p
    where p.id = p_uid and p.verification_status = 'verified'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: identity-based, no business logic (ADR-0001)
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.user_roles enable row level security;
alter table public.user_roles force row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = app.uid());

create policy profiles_select_staff on public.profiles
  for select to authenticated
  using (app.is_platform_staff());

create policy user_roles_select_own on public.user_roles
  for select to authenticated
  using (user_id = app.uid());

create policy user_roles_select_staff on public.user_roles
  for select to authenticated
  using (app.is_platform_staff());

-- Reads only. Writes are revoked globally (00003) and happen exclusively through cmd_* commands.
grant select on public.profiles to authenticated;
grant select on public.user_roles to authenticated;
revoke insert, update, delete on public.profiles, public.user_roles from anon, authenticated;

comment on table public.profiles is 'One row per auth user. Created by trigger; mutated only via commands.';
