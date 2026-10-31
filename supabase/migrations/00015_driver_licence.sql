-- 00015 — Phase 3.1: the driver's licence, photographed
--
-- `driver_profiles.licence_photo_path` has existed since 00013 and nothing ever wrote it. The licence was
-- a pair of strings an operator typed at invitation, and the person holding the card had no way to show
-- it. That is the one place where Phase 3's wording ("licence capture", "mobile: licence upload") was
-- not met, and it is closed here:
--
--   1. a **private** bucket, `driver-documents`, one folder per driver account;
--   2. exactly **one writer** — `cmd_set_driver_licence` — so the rules cannot be bypassed by a client
--      that talks to storage directly (the bucket policy only lets a driver write inside their own
--      folder, and the command refuses a path that is not there);
--   3. **re-verification**: changing the licence on an approved driver puts them back in the staff
--      queue. An approval is a decision about a document, so replacing the document invalidates it —
--      the same rule `cmd_update_vehicle` applies to a substantive vehicle edit.
--
-- Nothing here adds a notification kind: staff already receive `verification_submitted`, which is
-- exactly what a new licence to review is.

-- ---------------------------------------------------------------------------
-- 1. Storage: driver documents (private, one folder per driver account)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'driver-documents', 'driver-documents', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

/**
 * May the caller read this driver's documents?
 *
 * Path convention is `<driver-user-id>/<file>`, so the folder *is* the answer to "whose licence is
 * this": the driver themselves, the operator who invited them or whose company they drive for, and
 * platform staff. Anyone else gets nothing, and the check is a security-definer function so a policy
 * can ask it without granting read access to `driver_profiles` as a side effect.
 */
create or replace function app.can_read_driver_documents(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_owner is not null
    and (
      p_owner = app.uid()
      or app.is_platform_staff()
      or exists (
        select 1
        from public.driver_profiles d
        where d.user_id = p_owner
          and (
            d.invited_by = app.uid()
            or (d.org_id is not null and app.org_role(d.org_id, app.uid()) is not null)
          )
      )
    ),
    false
  );
$$;

/**
 * May this actor edit this driver's licence?
 *
 * The driver themselves, the operator who invited them, a manager/owner of the company they drive for,
 * or staff. Deliberately *not* `app.is_org_member()`: an accountant reads the fleet, they do not rewrite
 * a driver's documents.
 */
create or replace function app.manages_driver(p_actor uuid, p_driver_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_actor is not null
    and exists (
      select 1
      from public.driver_profiles d
      where d.id = p_driver_id
        and (
          d.user_id = p_actor
          or d.invited_by = p_actor
          or app.is_platform_staff(p_actor)
          or (d.org_id is not null and app.org_role(d.org_id, p_actor) in ('owner', 'manager'))
        )
    ),
    false
  );
$$;

create policy driver_documents_read_authorised on storage.objects
  for select to authenticated
  using (
    bucket_id = 'driver-documents'
    and app.can_read_driver_documents(app.safe_uuid((storage.foldername(name))[1]))
  );

-- Only the driver writes into their own folder. An operator who has the card in hand photographs it
-- through the driver's account, or types the number — there is no path where one account uploads a
-- document into another person's folder.
create policy driver_documents_write_self on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'driver-documents'
    and app.safe_uuid((storage.foldername(name))[1]) = app.uid()
  );

-- ---------------------------------------------------------------------------
-- 2. The single write path
-- ---------------------------------------------------------------------------

create or replace function public.cmd_set_driver_licence(
  p_actor uuid,
  p_driver_id uuid,
  p_licence_no text default null,
  p_licence_expiry date default null,
  p_licence_class text default null,
  p_photo_path text default null,
  p_request_id text default null,
  p_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver public.driver_profiles%rowtype;
  v_no text := nullif(btrim(coalesce(p_licence_no, '')), '');
  v_class text := nullif(btrim(coalesce(p_licence_class, '')), '');
  v_photo text := nullif(btrim(coalesce(p_photo_path, '')), '');
  v_before jsonb;
  v_after jsonb;
  v_changed boolean;
  v_status public.verification_status;
  v_staff uuid;
begin
  if p_actor is null then
    raise exception 'UNAUTHENTICATED: missing actor' using errcode = '28000';
  end if;

  select * into v_driver from public.driver_profiles where id = p_driver_id for update;
  if not found then
    raise exception 'NOT_FOUND: driver' using errcode = 'P0002';
  end if;

  if not app.manages_driver(p_actor, p_driver_id) then
    raise exception 'FORBIDDEN: not your driver' using errcode = '42501';
  end if;

  -- A licence belongs to an account. Before the invitation is accepted there is no account to attach a
  -- photo to, and the operator already captured the number at invite time.
  if v_driver.user_id is null or v_driver.status = 'invited' then
    raise exception 'CONFLICT: the driver has not accepted the invitation yet' using errcode = '23505';
  end if;

  if v_no is not null and length(v_no) not between 3 and 60 then
    raise exception 'VALIDATION_FAILED: licence number length' using errcode = '22023';
  end if;
  if v_class is not null and length(v_class) > 10 then
    raise exception 'VALIDATION_FAILED: licence class length' using errcode = '22023';
  end if;

  -- An expired licence cannot be uploaded as evidence of a valid one; `cmd_verify_driver` applies the
  -- same rule at decision time, so a document that would be refused later is refused now.
  if p_licence_expiry is not null and p_licence_expiry < current_date then
    raise exception 'VALIDATION_FAILED: licence has expired' using errcode = '22023';
  end if;

  if v_photo is not null then
    -- The folder must be the driver's own account, `..` is not a path component, and the object must
    -- actually exist: a command that stores a pointer to nothing is worse than one that refuses.
    if v_photo like '%..%'
       or length(v_photo) > 300
       or v_photo not like v_driver.user_id::text || '/%'
    then
      raise exception 'VALIDATION_FAILED: licence photo path' using errcode = '22023';
    end if;
    if not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'driver-documents' and o.name = v_photo
    ) then
      raise exception 'VALIDATION_FAILED: licence photo is not uploaded' using errcode = '22023';
    end if;
  end if;

  v_changed :=
    (v_no is distinct from v_driver.licence_no)
    or (p_licence_expiry is distinct from v_driver.licence_expiry)
    or (v_class is distinct from v_driver.licence_class)
    or (v_photo is distinct from v_driver.licence_photo_path);

  v_before := jsonb_build_object(
    'licenceNo', v_driver.licence_no,
    'licenceExpiry', v_driver.licence_expiry,
    'licenceClass', v_driver.licence_class,
    'licencePhotoPath', v_driver.licence_photo_path,
    'verificationStatus', v_driver.verification_status
  );

  -- Saving the same values twice is not an event: no re-verification, no notification, no audit row.
  if not v_changed then
    return jsonb_build_object(
      'driverId', p_driver_id,
      'licencePhotoPath', v_driver.licence_photo_path,
      'verificationStatus', v_driver.verification_status,
      'reverificationRequired', false
    );
  end if;

  v_status := 'pending';

  update public.driver_profiles
  set licence_no = v_no,
      licence_expiry = p_licence_expiry,
      licence_class = v_class,
      licence_photo_path = v_photo,
      verification_status = v_status,
      verified_by = null,
      verified_at = null,
      verification_note = null
  where id = p_driver_id;

  v_after := jsonb_build_object(
    'licenceNo', v_no,
    'licenceExpiry', p_licence_expiry,
    'licenceClass', v_class,
    'licencePhotoPath', v_photo,
    'verificationStatus', v_status
  );

  for v_staff in
    select ur.user_id
    from public.user_roles ur
    where ur.role in ('platform_staff', 'platform_admin') and ur.revoked_at is null
  loop
    perform app.notify(
      v_staff,
      'verification_submitted'::public.notification_kind,
      'notifications.driverPending',
      jsonb_build_object('name', v_driver.full_name),
      '/staff/vehicles'
    );
  end loop;

  perform app.write_audit(
    p_actor, 'driver.setLicence', 'driver', p_driver_id::text,
    v_before, v_after, null, p_request_id, p_ip
  );

  return jsonb_build_object(
    'driverId', p_driver_id,
    'licenceNo', v_no,
    'licenceExpiry', p_licence_expiry,
    'licencePhotoPath', v_photo,
    'verificationStatus', v_status,
    'reverificationRequired', v_driver.verification_status in ('verified', 'rejected')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.cmd_set_driver_licence(
  uuid, uuid, text, date, text, text, text, inet
) from public, anon, authenticated;
grant execute on function public.cmd_set_driver_licence(
  uuid, uuid, text, date, text, text, text, inet
) to service_role;

-- Predicates: executed as the querying role by the storage policies, and by the command above.
revoke all on function app.can_read_driver_documents(uuid) from public, anon;
revoke all on function app.manages_driver(uuid, uuid) from public, anon;
grant execute on function app.can_read_driver_documents(uuid) to authenticated, service_role;
grant execute on function app.manages_driver(uuid, uuid) to service_role;
