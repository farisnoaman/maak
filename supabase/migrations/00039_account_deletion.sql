-- 00039_account_deletion.sql — the request gets an executor.
--
-- `00007` shipped `cmd_request_account_deletion`, which sets `deletion_requested_at` and tells the user their
-- request was received. `docs/admin-guide.md` and `/account` both show it back to them. Nothing ever completed
-- one: the column's own comment promised "a staff action (Phase 7)" and Phase 7 shipped without it. That left a
-- support queue that could accept a request it had no tool to answer — the kind of gap a privacy policy makes
-- legally load-bearing and a screenshot makes embarrassing.
--
-- This is that staff action, and it is deliberately an **anonymisation, not a DELETE**:
--
--   · `bookings.passenger_id` and `booked_by`, `trips.owner_user_id`, `invoices.owner_user_id` and
--     `payouts.requested_by` are all `on delete restrict`, because financial history is the books. Deleting the
--     row is not on the table;
--   · the books also have to keep adding up, which means the ledger's foreign keys must keep resolving;
--   · so the person is removed and the *records* stay — the profile row survives as an unnamed shell that the
--     financial tables point at.
--
-- What is erased, and what is not, is written down in the function's comment so a support agent can answer the
-- question without reading SQL. Two rules shape it:
--
--   1. **Nothing that identifies a human survives.** Name, phone, email, national id, birth details, photo and
--      avatar paths, licence and bank details, ID photographs, push tokens and notification bodies all go.
--   2. **Nothing that carries money or an audit trail is touched.** Bookings, invoices, payouts, refunds,
--      journal entries, subscriptions and the audit log stay, with the amounts they always had.
--
-- It refuses while that would be a lie — live bookings, live trips, vehicles or an organization still in the
-- person's name, or money still owed — because anonymising those would strand someone else's trip or an
-- unreconciled riyal. And it refuses to be run by the account's own owner: a deletion is a second pair of eyes.

begin;

alter table public.profiles
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles (id) on delete set null;

comment on column public.profiles.deleted_at is
  'Set when a platform_admin completed a deletion (00039). Every identifying column is null by then; the row '
  'survives because bookings, trips, invoices and payouts reference it with ON DELETE RESTRICT.';
comment on column public.profiles.deleted_by is
  'The admin who ran the deletion. Never the account itself: cmd_delete_account refuses self-service.';

-- An anonymised row is not a person anyone lists. Cheap, and it keeps the support views honest.
create index if not exists profiles_deleted_idx on public.profiles (deleted_at) where deleted_at is not null;

create or replace function public.cmd_delete_account(
  p_actor uuid,
  p_user_id uuid,
  p_reason text,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := coalesce(p_actor, app.uid());
  v_profile public.profiles%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_live_bookings integer;
  v_live_trips integer;
  v_orgs integer;
  v_vehicles integer;
  v_balance bigint;
  v_documents text[] := '{}';
  v_counts jsonb := '{}'::jsonb;
  v_rows integer;
  v_auth boolean := false;
begin
  if v_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  -- `platform_admin`, not "staff": this is the one command in the system that cannot be undone, and the role
  -- that can grant roles is the role that should be able to spend it.
  if not app.has_role('platform_admin', v_actor) then
    raise exception 'FORBIDDEN: account deletion is a platform_admin action' using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'VALIDATION_FAILED: which account?' using errcode = '22023';
  end if;

  if p_user_id = v_actor then
    raise exception 'FORBIDDEN: a deletion needs a second pair of eyes' using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception 'VALIDATION_FAILED: a deletion needs a reason on the record' using errcode = '22023';
  end if;

  select * into v_profile from public.profiles p where p.id = p_user_id;
  if not found then
    raise exception 'VALIDATION_FAILED: no such account' using errcode = '22023';
  end if;

  -- Idempotent on purpose: a retried request must not fail, and must not erase anything twice.
  if v_profile.deleted_at is not null then
    return jsonb_build_object(
      'deleted', false, 'alreadyDeleted', true, 'userId', p_user_id, 'deletedAt', v_profile.deleted_at
    );
  end if;

  -- ---------------------------------------------------------------------------------------------
  -- Refusals. Each one is a thing an admin can fix for the user, and each one would be a lie if the
  -- deletion went ahead: somebody's trip with no operator, a booking nobody can settle, or a riyal with
  -- nowhere to go.
  -- ---------------------------------------------------------------------------------------------

  select count(*) into v_live_bookings
  from public.bookings b
  where (b.passenger_id = p_user_id or b.booked_by = p_user_id)
    and b.status in ('pending', 'accepted');
  if v_live_bookings > 0 then
    raise exception 'CONFLICT: % live booking(s) — settle or cancel them first', v_live_bookings
      using errcode = '23505';
  end if;

  select count(*) into v_live_trips
  from public.trips t
  where t.owner_user_id = p_user_id
    and t.status in ('draft', 'pending', 'published', 'in_progress');
  if v_live_trips > 0 then
    raise exception 'CONFLICT: % trip(s) are still live — finish or cancel them first', v_live_trips
      using errcode = '23505';
  end if;

  select count(*) into v_orgs from public.organizations o where o.owner_id = p_user_id;
  if v_orgs > 0 then
    raise exception 'CONFLICT: transfer your organizations first' using errcode = '23505';
  end if;

  select count(*) into v_vehicles from public.vehicles v where v.owner_user_id = p_user_id;
  if v_vehicles > 0 then
    raise exception 'CONFLICT: % vehicle(s) are registered to this account — sell or archive them first', v_vehicles
      using errcode = '23505';
  end if;

  v_balance := app.owner_available_yer(p_user_id, null);
  if coalesce(v_balance, 0) <> 0 then
    raise exception 'CONFLICT: % YER is still owed or held on this account — settle it first', v_balance
      using errcode = '23505';
  end if;

  -- ---------------------------------------------------------------------------------------------
  -- Documents first: the rows are ours, the objects in Storage are not, so their paths go back to the
  -- caller in the audit payload and on the result. A file nobody can point at is a file somebody deletes.
  -- ---------------------------------------------------------------------------------------------

  select coalesce(array_agg(d.storage_path), '{}') into v_documents
  from public.verification_documents d
  join public.verification_requests r on r.id = d.request_id
  where r.requested_by = p_user_id;

  delete from public.verification_documents d
  using public.verification_requests r
  where r.id = d.request_id and r.requested_by = p_user_id;
  get diagnostics v_rows = row_count;
  v_counts := v_counts || jsonb_build_object('verificationDocuments', v_rows);

  select coalesce(v_documents || array_agg(d.photo_path), v_documents) into v_documents
  from public.passenger_documents d
  join public.bookings b on b.id = d.booking_id
  where b.passenger_id = p_user_id and d.photo_path is not null;

  delete from public.passenger_documents d
  using public.bookings b
  where b.id = d.booking_id and b.passenger_id = p_user_id;
  get diagnostics v_rows = row_count;
  v_counts := v_counts || jsonb_build_object('passengerDocuments', v_rows);

  -- The request rows stay: they are the verification history of an account, not the account's identity, and
  -- the documents that were attached to them are gone. Their notes are the one place free text could repeat
  -- what was just erased, so they are emptied too.
  update public.verification_requests
  set note = null, decision_note = null, snapshot = '{}'::jsonb
  where requested_by = p_user_id and (note is not null or decision_note is not null or snapshot <> '{}'::jsonb);

  -- ---------------------------------------------------------------------------------------------
  -- Behaviour and delivery: personal, and nothing downstream needs them.
  -- ---------------------------------------------------------------------------------------------

  delete from public.device_tokens where user_id = p_user_id;
  get diagnostics v_rows = row_count;
  v_counts := v_counts || jsonb_build_object('deviceTokens', v_rows);

  delete from public.notification_delivery_attempts
  where delivery_id in (select d.id from public.notification_deliveries d where d.user_id = p_user_id);
  delete from public.notification_deliveries where user_id = p_user_id;
  delete from public.notifications where user_id = p_user_id;
  get diagnostics v_rows = row_count;
  v_counts := v_counts || jsonb_build_object('notifications', v_rows);

  delete from public.notification_preferences where user_id = p_user_id;
  delete from public.notification_settings where user_id = p_user_id;

  delete from public.saved_search_matches
  where saved_search_id in (select s.id from public.saved_searches s where s.user_id = p_user_id);
  delete from public.saved_searches where user_id = p_user_id;
  get diagnostics v_rows = row_count;
  v_counts := v_counts || jsonb_build_object('savedSearches', v_rows);

  delete from public.booking_share_tokens where created_by = p_user_id;
  delete from public.geo_assignments where user_id = p_user_id;

  update public.user_roles
  set revoked_at = now(), revoked_by = v_actor, reason = 'account deleted'
  where user_id = p_user_id and revoked_at is null;
  get diagnostics v_rows = row_count;
  v_counts := v_counts || jsonb_build_object('rolesRevoked', v_rows);

  -- ---------------------------------------------------------------------------------------------
  -- Rows that must survive, scrubbed in place. The constraints are what choose the placeholders: a name
  -- that is two characters or more, a phone that normalises to six digits or more, an account number of
  -- three — the same rules a real person's row had to satisfy.
  -- ---------------------------------------------------------------------------------------------

  update public.driver_profiles
  set full_name = 'محذوف',
      invited_phone = '000000',
      licence_no = null,
      licence_photo_path = null,
      verification_note = null,
      is_active = false
  where user_id = p_user_id;
  get diagnostics v_rows = row_count;
  v_counts := v_counts || jsonb_build_object('driverProfiles', v_rows);

  update public.payment_accounts
  set account_number = 'redacted-' || left(replace(id::text, '-', ''), 8),
      holder_name = 'محذوف',
      verification_document_path = null,
      is_default = false,
      status = 'archived',
      archived_at = coalesce(archived_at, now()),
      archive_reason = 'account deleted'
  where owner_user_id = p_user_id;
  get diagnostics v_rows = row_count;
  v_counts := v_counts || jsonb_build_object('paymentAccounts', v_rows);

  -- Past bookings keep their money and lose their name: the contact fields exist so an operator could phone
  -- somebody, and after this there is nobody to phone. Live ones cannot reach here (refused above).
  update public.bookings
  set contact_name = 'محذوف',
      contact_phone = '+967000000000',
      note = null,
      passenger_gender = null
  where (passenger_id = p_user_id or booked_by = p_user_id);
  get diagnostics v_rows = row_count;
  v_counts := v_counts || jsonb_build_object('bookings', v_rows);

  update public.profiles
  set full_name = null,
      phone = null,
      phone_verified_at = null,
      email = null,
      national_id_type = null,
      national_id_number = null,
      birth_place = null,
      date_of_birth = null,
      avatar_path = null,
      verification_note = null,
      verification_status = 'unverified',
      last_seen_at = null,
      deletion_requested_at = null,
      deletion_reason = null,
      deleted_at = now(),
      deleted_by = v_actor
  where id = p_user_id;

  -- ---------------------------------------------------------------------------------------------
  -- The login itself lives in `auth`, which belongs to the platform. Scrub what is there, ban the user when
  -- the column exists (Supabase), and *record whether it worked* instead of assuming: on a project whose
  -- `auth.users` is not writable by this role the anonymisation still stands, and the audit row says the
  -- ban is outstanding so the operator completes it in the dashboard.
  -- ---------------------------------------------------------------------------------------------

  begin
    if exists (
      select 1 from pg_attribute a
      where a.attrelid = 'auth.users'::regclass and a.attname = 'banned_until' and not a.attisdropped
    ) then
      execute format(
        'update auth.users set email = null, phone = null, raw_user_meta_data = %L::jsonb, banned_until = %L where id = %L',
        '{}', 'infinity', p_user_id
      );
    else
      execute format(
        'update auth.users set email = null, phone = null, raw_user_meta_data = %L::jsonb where id = %L',
        '{}', p_user_id
      );
    end if;
    v_auth := true;
  exception when others then
    v_auth := false;
  end;

  -- The audit row is the record that the deletion happened. Its `before` deliberately carries *no* personal
  -- data — only the shape of what was there — because an immutable log is the one place an erasure could
  -- quietly survive: it holds flags, not the name, phone or email that were just removed.
  perform app.write_audit(
    v_actor, 'account.deleted', 'profile', p_user_id::text,
    jsonb_build_object(
      'hadName', v_profile.full_name is not null,
      'hadPhone', v_profile.phone is not null,
      'hadEmail', v_profile.email is not null,
      'hadNationalId', v_profile.national_id_number is not null,
      'verificationStatus', v_profile.verification_status,
      'deletionRequestedAt', v_profile.deletion_requested_at
    ),
    jsonb_build_object(
      'deletedAt', now(),
      'authScrubbed', v_auth,
      'documentsToErase', to_jsonb(v_documents),
      'erased', v_counts
    ),
    v_reason, p_request_id, p_ip
  );

  return jsonb_build_object(
    'deleted', true,
    'userId', p_user_id,
    'deletedAt', now(),
    'authScrubbed', v_auth,
    'documentsToErase', to_jsonb(v_documents),
    'erased', v_counts
  );
end;
$$;

comment on function public.cmd_delete_account(uuid, uuid, text, text, inet) is
  'Completes an account deletion as an anonymisation: erases names, phones, emails, national ids, licence and '
  'bank details, ID photographs, push tokens and notification bodies; keeps bookings, invoices, payouts, refunds, '
  'ledger entries and the audit trail because they are the books. Refuses live bookings, live trips, vehicles, '
  'organizations and an outstanding balance, and refuses to be run by the account itself.';

-- Same access shape as every other command: no client grant, the gateway resolves the actor and calls it with
-- the service role.
revoke all on function public.cmd_delete_account(uuid, uuid, text, text, inet) from public, anon, authenticated;
grant execute on function public.cmd_delete_account(uuid, uuid, text, text, inet) to service_role;

commit;
