-- 00006 — identity, accounts and verification (Phase 1)
--
-- Adds what Phase 0 deliberately left out: organizations, membership, the verification queue,
-- documents and in-app notifications. Rules that make this schema safe:
--   · one profile per auth user, created by a trigger (00004)
--   · organizations are owned by exactly one profile; membership is a separate table with roles
--   · a verification request is an immutable submission + a decision (who, when, why)
--   · every table is read-only for clients; all writes go through cmd_* (ADR-17)
--   · PII (national id) is readable by its owner and by platform staff only

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.plan_code as enum ('basic', 'pro', 'business');

create type public.org_kind as enum ('company', 'agency');

create type public.member_role as enum ('owner', 'manager', 'accountant', 'dispatcher');

create type public.member_status as enum ('invited', 'active', 'suspended', 'removed');

create type public.verification_subject as enum ('individual', 'organization');

create type public.verification_request_status as enum ('pending', 'approved', 'rejected', 'withdrawn');

create type public.verification_outcome as enum ('approve', 'reject');

create type public.notification_kind as enum (
  'verification_submitted',
  'verification_approved',
  'verification_rejected',
  'verification_invalidated',
  'member_invited',
  'member_joined',
  'member_removed',
  'role_granted',
  'role_revoked'
);

-- ---------------------------------------------------------------------------
-- Profile: the identity fields a verification needs
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column email              text,
  add column national_id_type   text check (national_id_type in ('national_id', 'passport', 'residence')),
  add column national_id_number text,
  add column birth_place        text,
  add column date_of_birth      date,
  add column avatar_path        text,
  add column verification_note  text,
  add column onboarded_at       timestamptz,
  add column last_seen_at       timestamptz;

comment on column public.profiles.email is
  'Denormalised from auth.users at signup so commands can match invites without reading auth schema.';

comment on column public.profiles.national_id_number is
  'PII. Visible to the owner and platform staff only (RLS). Never logged, never in notifications.';
comment on column public.profiles.verification_note is
  'Free-text note from the verifier shown to the applicant when a request is rejected.';

-- The signup trigger now also records the e-mail, so invite matching never has to read auth.users.
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, phone, email, preferred_language)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.phone, ''),
    nullif(new.email, ''),
    coalesce(nullif(new.raw_user_meta_data ->> 'locale', ''), 'ar')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------------

create table public.organizations (
  id                  uuid primary key default gen_random_uuid(),
  kind                public.org_kind not null default 'company',
  name                text not null check (length(btrim(name)) between 2 and 120),
  name_en             text check (name_en is null or length(btrim(name_en)) between 2 and 120),
  registration_no     text check (registration_no is null or length(btrim(registration_no)) >= 3),
  tax_no              text,
  phone               text,
  email               text,
  logo_path           text,
  owner_id            uuid not null references public.profiles (id) on delete restrict,
  verification_status public.verification_status not null default 'unverified',
  plan                public.plan_code not null default 'basic',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index organizations_owner_idx on public.organizations (owner_id);
create index organizations_status_idx on public.organizations (verification_status);

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function app.set_updated_at();

comment on table public.organizations is
  'Company or agency account. One owner profile; collaborators live in organization_members.';
comment on column public.organizations.verification_status is
  'Verified by platform staff. Editing legal identity fields resets this to unverified.';

create table public.organization_members (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete cascade,
  user_id           uuid references public.profiles (id) on delete cascade,
  role              public.member_role not null default 'manager',
  status            public.member_status not null default 'invited',
  invited_by        uuid references public.profiles (id) on delete set null,
  invited_email     text,
  invited_phone     text,
  invite_token_hash text,
  invite_expires_at timestamptz,
  joined_at         timestamptz,
  removed_at        timestamptz,
  removed_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint organization_members_contact_required
    check (user_id is not null or invited_email is not null or invited_phone is not null),
  constraint organization_members_no_owner_invite
    check (role <> 'owner' or status <> 'invited')
);

create unique index organization_members_active_unique
  on public.organization_members (org_id, user_id)
  where user_id is not null and status <> 'removed';

create unique index organization_members_invite_email_unique
  on public.organization_members (org_id, lower(invited_email))
  where status = 'invited' and invited_email is not null;

create unique index organization_members_invite_phone_unique
  on public.organization_members (org_id, invited_phone)
  where status = 'invited' and invited_phone is not null;

create index organization_members_user_idx
  on public.organization_members (user_id) where status = 'active';

create trigger organization_members_set_updated_at
  before update on public.organization_members
  for each row execute function app.set_updated_at();

comment on column public.organization_members.invite_token_hash is
  'sha256 of the invite token. The raw token is returned once, to the inviter.';

-- ---------------------------------------------------------------------------
-- Verification requests and documents
-- ---------------------------------------------------------------------------

create table public.verification_requests (
  id            uuid primary key default gen_random_uuid(),
  subject_type  public.verification_subject not null,
  subject_id    uuid not null,
  requested_by  uuid not null references public.profiles (id) on delete cascade,
  status        public.verification_request_status not null default 'pending',
  note          text check (note is null or length(note) <= 2000),
  snapshot      jsonb not null default '{}'::jsonb,
  decision_by   uuid references public.profiles (id) on delete set null,
  decision_at   timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 2000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One open request per subject: no queue spam, and no two staff deciding different outcomes.
create unique index verification_requests_one_pending
  on public.verification_requests (subject_type, subject_id)
  where status = 'pending';

create index verification_requests_queue_idx
  on public.verification_requests (status, created_at);

create index verification_requests_subject_idx
  on public.verification_requests (subject_type, subject_id, created_at desc);

create trigger verification_requests_set_updated_at
  before update on public.verification_requests
  for each row execute function app.set_updated_at();

comment on column public.verification_requests.snapshot is
  'The identity fields exactly as submitted, so a later profile edit cannot rewrite history.';

create table public.verification_documents (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.verification_requests (id) on delete cascade,
  kind        text not null check (
                kind in ('national_id_front', 'national_id_back', 'passport',
                         'commercial_registration', 'tax_card', 'selfie', 'other')
              ),
  storage_path text not null,
  mime        text,
  size_bytes  integer check (size_bytes is null or (size_bytes > 0 and size_bytes <= 10485760)),
  created_at  timestamptz not null default now(),
  constraint verification_documents_path_normalised
    check (storage_path not like '/%' and storage_path not like '%..%')
);

create index verification_documents_request_idx on public.verification_documents (request_id);

comment on column public.verification_documents.storage_path is
  'Object path in the private verification-docs bucket, always under <submitter-uuid>/…';

-- ---------------------------------------------------------------------------
-- Notifications (in-app only in Phase 1; channels land in Phase 11)
-- ---------------------------------------------------------------------------

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       public.notification_kind not null,
  title_key  text not null,
  params     jsonb not null default '{}'::jsonb,
  link       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

comment on column public.notifications.title_key is
  'i18n key, not text: the same row renders in Arabic and English (BR-43).';

-- ---------------------------------------------------------------------------
-- Helpers (security definer: they must see rows the caller cannot read directly)
-- ---------------------------------------------------------------------------

create or replace function app.has_role(p_role public.platform_role, p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = p_uid and ur.role = p_role and ur.revoked_at is null
  );
$$;

create or replace function app.is_platform_admin(p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_role('platform_admin', p_uid);
$$;

create or replace function app.my_orgs(p_uid uuid default app.uid())
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id
  from public.organization_members m
  where m.user_id = p_uid and m.status = 'active';
$$;

create or replace function app.is_org_member(p_org uuid, p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
    where m.org_id = p_org and m.user_id = p_uid and m.status = 'active'
  );
$$;

create or replace function app.org_role(p_org uuid, p_uid uuid default app.uid())
returns public.member_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.organization_members m
  where m.org_id = p_org and m.user_id = p_uid and m.status = 'active'
  limit 1;
$$;

create or replace function app.org_is_verified(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organizations o
    where o.id = p_org and o.verification_status = 'verified'
  );
$$;

-- "May this actor operate at all?" — the gate every Phase 3+ command re-checks.
-- A verified individual OR an active member of a verified organization qualifies.
create or replace function app.is_verified_actor(p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1 from public.profiles p
      where p.id = p_uid and p.verification_status = 'verified'
    )
    or exists (
      select 1
      from public.organization_members m
      join public.organizations o on o.id = m.org_id
      where m.user_id = p_uid and m.status = 'active' and o.verification_status = 'verified'
    ),
    false
  );
$$;

-- Phase 1 plan stub (BR-37). Always the LOWEST plan: a bug here under-grants, never over-grants.
-- Phase 10 replaces the body with a subscriptions lookup; callers do not change.
create or replace function app.owner_effective_plan(p_uid uuid default app.uid())
returns public.plan_code
language sql
stable
security definer
set search_path = ''
as $$
  select 'basic'::public.plan_code;
$$;

create or replace function app.org_effective_plan(p_org uuid)
returns public.plan_code
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select o.plan from public.organizations o where o.id = p_org), 'basic'::public.plan_code);
$$;

create or replace function app.can_view_verification(p_request uuid, p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.verification_requests r
    where r.id = p_request
      and (
        app.is_platform_staff(p_uid)
        or app.is_platform_admin(p_uid)
        or r.requested_by = p_uid
        or (r.subject_type = 'individual' and r.subject_id = p_uid)
        or (r.subject_type = 'organization' and app.is_org_member(r.subject_id, p_uid))
      )
  );
$$;

-- Notifications are written by commands, never by clients.
create or replace function app.notify(
  p_user uuid,
  p_kind public.notification_kind,
  p_title_key text,
  p_params jsonb default '{}'::jsonb,
  p_link text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_user is null then
    return null;
  end if;
  insert into public.notifications (user_id, kind, title_key, params, link)
  values (p_user, p_kind, p_title_key, coalesce(p_params, '{}'::jsonb), p_link)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function app.has_role(public.platform_role, uuid) from public, anon, authenticated;
revoke all on function app.is_platform_admin(uuid) from public, anon, authenticated;
revoke all on function app.my_orgs(uuid) from public, anon, authenticated;
revoke all on function app.is_org_member(uuid, uuid) from public, anon, authenticated;
revoke all on function app.org_role(uuid, uuid) from public, anon, authenticated;
revoke all on function app.org_is_verified(uuid) from public, anon, authenticated;
revoke all on function app.is_verified_actor(uuid) from public, anon, authenticated;
revoke all on function app.owner_effective_plan(uuid) from public, anon, authenticated;
revoke all on function app.org_effective_plan(uuid) from public, anon, authenticated;
revoke all on function app.can_view_verification(uuid, uuid) from public, anon, authenticated;
revoke all on function app.notify(uuid, public.notification_kind, text, jsonb, text) from public, anon, authenticated;

-- RLS policy expressions are evaluated as the *calling* role, so the predicates a policy uses must
-- be reachable by `authenticated`: schema USAGE plus EXECUTE on those specific functions only.
-- Everything else in `app` (notify, plan lookup, role checks used inside commands) stays private.
-- The exposed predicates take no user argument by default, so a client cannot ask "is user X staff?".
grant usage on schema app to authenticated;

-- New helpers must be private by default: a future `app.*` function gets no client EXECUTE unless a
-- migration grants it deliberately.
alter default privileges in schema app revoke execute on functions from public, anon, authenticated;
grant execute on function app.uid() to authenticated;
grant execute on function app.is_platform_staff(uuid) to authenticated;
grant execute on function app.is_org_member(uuid, uuid) to authenticated;
grant execute on function app.can_view_verification(uuid, uuid) to authenticated;

grant execute on function app.has_role(public.platform_role, uuid) to service_role;
grant execute on function app.is_platform_admin(uuid) to service_role;
grant execute on function app.my_orgs(uuid) to service_role;
grant execute on function app.is_org_member(uuid, uuid) to service_role;
grant execute on function app.org_role(uuid, uuid) to service_role;
grant execute on function app.org_is_verified(uuid) to service_role;
grant execute on function app.is_verified_actor(uuid) to service_role;
grant execute on function app.owner_effective_plan(uuid) to service_role;
grant execute on function app.org_effective_plan(uuid) to service_role;
grant execute on function app.can_view_verification(uuid, uuid) to service_role;
grant execute on function app.notify(uuid, public.notification_kind, text, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- RLS: who may READ what. Writes are impossible for clients (00003).
-- ---------------------------------------------------------------------------

alter table public.organizations          enable row level security;
alter table public.organization_members   enable row level security;
alter table public.verification_requests  enable row level security;
alter table public.verification_documents enable row level security;
alter table public.notifications          enable row level security;

alter table public.organizations          force row level security;
alter table public.organization_members   force row level security;
alter table public.verification_requests  force row level security;
alter table public.verification_documents force row level security;
alter table public.notifications          force row level security;

create policy organizations_select_member on public.organizations
  for select to authenticated
  using (app.is_org_member(id) or app.is_platform_staff());

create policy organization_members_select_self_or_org on public.organization_members
  for select to authenticated
  using (user_id = app.uid() or app.is_org_member(org_id) or app.is_platform_staff());

-- Interviews: only the applicant, their organization's members, and staff.
create policy verification_requests_select on public.verification_requests
  for select to authenticated
  using (
    app.is_platform_staff()
    or requested_by = app.uid()
    or (subject_type = 'individual' and subject_id = app.uid())
    or (subject_type = 'organization' and app.is_org_member(subject_id))
  );

create policy verification_documents_select on public.verification_documents
  for select to authenticated
  using (app.can_view_verification(request_id));

create policy notifications_select_own on public.notifications
  for select to authenticated
  using (user_id = app.uid());

grant select on public.organizations to authenticated;
grant select on public.organization_members to authenticated;
grant select on public.verification_requests to authenticated;
grant select on public.verification_documents to authenticated;
grant select on public.notifications to authenticated;

revoke insert, update, delete on
  public.organizations,
  public.organization_members,
  public.verification_requests,
  public.verification_documents,
  public.notifications
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage buckets: avatars (public) and verification documents (private)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp']),
  ('verification-docs', 'verification-docs', false, 10485760,
   array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

-- Uploads are the one client-facing write that cannot go through a command (it is a blob, not a
-- row). The policies below confine every upload to the caller's own uuid prefix, and the bucket
-- caps size and mime type. A document only becomes evidence when cmd_submit_verification links it,
-- and that command re-checks the prefix.
create policy avatars_read on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars');

create policy avatars_write_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = app.uid()::text);

create policy avatars_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = app.uid()::text);

create policy verification_docs_read_own_or_staff on storage.objects
  for select to authenticated
  using (
    bucket_id = 'verification-docs'
    and ((storage.foldername(name))[1] = app.uid()::text or app.is_platform_staff())
  );

create policy verification_docs_write_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'verification-docs'
    and (storage.foldername(name))[1] = app.uid()::text
  );
