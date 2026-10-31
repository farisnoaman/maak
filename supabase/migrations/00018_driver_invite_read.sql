-- ---------------------------------------------------------------------------
-- 00018 — an invited driver can see the invitation
--
-- `cmd_accept_driver_invite` links an invitation to an account by matching the phone number, and it does
-- so correctly. The problem was one layer up: `driver_profiles_read_own_or_org_or_staff` (00013) only lets
-- a caller read a row whose `user_id` is already theirs, and an unaccepted invitation has `user_id = null`.
-- So the invitation was invisible to the person it addressed — which is why the mobile driver screen's
-- "accept" button was unreachable: it renders inside `{driver ? …}`, and `driver` could never load.
--
-- This policy closes exactly that hole and nothing else: a signed-in user may read an *unbound, invited,
-- active* row whose `invited_phone` is their own number. It grants no access to a bound driver's record,
-- no access to a suspended or revoked one, and no access to anybody else's invitation.
--
-- The comparison runs inside a security-definer predicate for one reason: `app.normalize_phone` is not
-- executable by `authenticated` (00006 revoked it, correctly — a client has no business normalizing phone
-- numbers), and a policy is evaluated in the caller's session. The predicate answers exactly one question
-- about exactly one row — "is this unclaimed invitation addressed to my number" — and takes no phone, so it
-- cannot be used to test somebody else's.
-- ---------------------------------------------------------------------------

create or replace function app.owns_unclaimed_invite(p_driver_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from public.driver_profiles d
      where d.id = p_driver_id
        and d.user_id is null
        and d.status = 'invited'
        and d.is_active
        and app.normalize_phone(d.invited_phone) = app.normalize_phone(
          (select p.phone from public.profiles p where p.id = app.uid())
        )
    ),
    false
  );
$$;

revoke all on function app.owns_unclaimed_invite(uuid) from public, anon;
grant execute on function app.owns_unclaimed_invite(uuid) to authenticated, service_role;

create policy driver_profiles_read_own_invite on public.driver_profiles
  for select to authenticated
  using (app.owns_unclaimed_invite(id));
