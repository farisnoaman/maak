-- 00008 — geography: governorates, districts, places, regions and geo assignments (Phase 2)
--
-- Design decision (recorded here because it is load-bearing):
--   **Scope is relational, not geometric.** A supervisor's coverage is a *set of districts* expanded
--   from the regions they are assigned to. That is an indexed join, it is testable, and it cannot be
--   defeated by a malformed polygon. Coordinates are stored as plain numerics for maps and distance;
--   PostGIS geometry is only added where a spatial query genuinely beats the alternative (live
--   tracking, Phase 6). The one PostGIS statement below is therefore optional and guarded, so the
--   whole schema can be built and tested on a stock PostgreSQL as well as on Supabase.
--
-- Arabic search: every searchable name gets a normalised twin (`*_norm`) computed by
-- `app.normalize_arabic`, which mirrors `normalizeArabic()` in packages/core. A test pins both.

-- ---------------------------------------------------------------------------
-- PostGIS: optional at build time, required by Supabase (present there by default)
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'postgis') then
    execute 'create extension if not exists postgis';
  else
    raise notice 'postgis unavailable: geometry columns will be skipped (map/distance use lat/lng)';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Arabic normalisation: the SQL half of a contract that also exists in TypeScript
--   · alef variants  أ إ آ ٱ → ا
--   · ة → ه        · ى → ي        · ؤ → و        · ئ → ي
--   · drop harakat (U+064B..U+0652) and tatweel (U+0640)
--   · Arabic-Indic digits → Western
--   · lower-case Latin, collapse whitespace
-- ---------------------------------------------------------------------------

create or replace function app.normalize_arabic(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(
    regexp_replace(
      lower(
        translate(
          translate(
            regexp_replace(
              regexp_replace(
                translate(
                  coalesce(p_text, ''),
                  U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669',
                  '0123456789'
                ),
                U&'\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9',
                '0123456789'
              ),
              -- drop harakat and tatweel
              U&'[\064B-\0652\0640]',
              '',
              'g'
            ),
            -- unify the letter shapes
            U&'\0623\0625\0622\0671\0629\0649\0624\0626',
            U&'\0627\0627\0627\0627\0647\064A\0648\064A'
          ),
          ' ', ' '
        )
      ),
      '\s+',
      ' ',
      'g'
    )
  );
$$;

-- `array_to_string()` is STABLE (it depends on output functions), so it cannot appear inside a
-- generated column directly. Wrapping it in an IMMUTABLE function makes the intent explicit.
create or replace function app.normalize_aliases(p_ar text[], p_en text[])
returns text
language sql
immutable
set search_path = ''
as $$
  select app.normalize_arabic(
    coalesce(array_to_string(p_ar, ' '), '') || ' ' || coalesce(array_to_string(p_en, ' '), '')
  );
$$;

comment on function app.normalize_arabic(text) is
  'Comparison key for Arabic names. Mirrors normalizeArabic() in @maak/core — change both together.';

-- ---------------------------------------------------------------------------
-- Governorates (22) and districts
-- ---------------------------------------------------------------------------

create table public.governorates (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^YE-[A-Z]{2}$'),
  name_ar     text not null check (length(btrim(name_ar)) between 2 and 80),
  name_en     text not null check (length(btrim(name_en)) between 2 and 80),
  name_ar_norm text generated always as (app.normalize_arabic(name_ar)) stored,
  name_en_norm text generated always as (lower(name_en)) stored,
  region_hint text,
  center_lat  double precision check (center_lat is null or center_lat between -90 and 90),
  center_lng  double precision check (center_lng is null or center_lng between -180 and 180),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index governorates_name_ar_trgm on public.governorates using gin (name_ar_norm gin_trgm_ops);
create index governorates_name_en_trgm on public.governorates using gin (name_en_norm gin_trgm_ops);

create trigger governorates_set_updated_at
  before update on public.governorates
  for each row execute function app.set_updated_at();

create table public.districts (
  id             uuid primary key default gen_random_uuid(),
  governorate_id uuid not null references public.governorates (id) on delete restrict,
  pcode          text unique,
  name_ar        text not null check (length(btrim(name_ar)) between 2 and 120),
  name_en        text not null check (length(btrim(name_en)) between 2 and 120),
  name_ar_norm   text generated always as (app.normalize_arabic(name_ar)) stored,
  name_en_norm   text generated always as (lower(name_en)) stored,
  center_lat     double precision check (center_lat is null or center_lat between -90 and 90),
  center_lng     double precision check (center_lng is null or center_lng between -180 and 180),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index districts_governorate_idx on public.districts (governorate_id);
create index districts_name_ar_trgm on public.districts using gin (name_ar_norm gin_trgm_ops);
create index districts_name_en_trgm on public.districts using gin (name_en_norm gin_trgm_ops);

create unique index districts_name_unique on public.districts (governorate_id, name_ar_norm);

create trigger districts_set_updated_at
  before update on public.districts
  for each row execute function app.set_updated_at();

comment on column public.districts.pcode is
  'OCHA admin-2 P-code, e.g. YE1712. Nullable until the official list is imported (scripts/geo).';

-- ---------------------------------------------------------------------------
-- Places: cities, landmarks, ports, stations… and user-created gathering points
-- ---------------------------------------------------------------------------

create table public.places (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in (
                        'city', 'town', 'village', 'district_centre', 'landmark', 'station',
                        'airport', 'port', 'border_crossing', 'market', 'hospital',
                        'gathering_point', 'other'
                      )),
  name_ar             text not null check (length(btrim(name_ar)) between 2 and 160),
  name_en             text,
  name_ar_norm        text generated always as (app.normalize_arabic(name_ar)) stored,
  name_en_norm        text generated always as (lower(coalesce(name_en, ''))) stored,
  aliases_ar          text[] not null default '{}',
  aliases_en          text[] not null default '{}',
  -- Flattened + normalised aliases: a trigram index needs a scalar, not an array.
  aliases_norm        text generated always as (
                        app.normalize_aliases(aliases_ar, aliases_en)
                      ) stored,
  governorate_id      uuid references public.governorates (id) on delete restrict,
  district_id         uuid references public.districts (id) on delete restrict,
  lat                 double precision check (lat is null or lat between -90 and 90),
  lng                 double precision check (lng is null or lng between -180 and 180),
  is_public           boolean not null default true,
  created_by          uuid references public.profiles (id) on delete set null,
  created_by_org      uuid references public.organizations (id) on delete set null,
  verification_status public.verification_status not null default 'verified',
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint places_private_has_owner
    check (is_public or created_by is not null or created_by_org is not null),
  constraint places_user_created_is_private
    check (kind <> 'gathering_point' or is_public or created_by is not null or created_by_org is not null)
);

create index places_governorate_idx on public.places (governorate_id);
create index places_district_idx on public.places (district_id);
create index places_kind_idx on public.places (kind) where is_active;
create index places_creator_idx on public.places (created_by) where created_by is not null;
create index places_org_idx on public.places (created_by_org) where created_by_org is not null;
create index places_name_ar_trgm on public.places using gin (name_ar_norm gin_trgm_ops);
create index places_name_en_trgm on public.places using gin (name_en_norm gin_trgm_ops);
create index places_aliases_trgm on public.places using gin (aliases_norm gin_trgm_ops);

create trigger places_set_updated_at
  before update on public.places
  for each row execute function app.set_updated_at();

comment on table public.places is
  'Every selectable point: cities, districts centres, landmarks, ports — and private gathering points
   created by a user or a company. Private rows are visible only to their creator/organization.';

-- Guard: a place may not claim a district from a different governorate.
create or replace function app.assert_place_geography()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_district_governorate uuid;
begin
  if new.district_id is not null then
    select d.governorate_id into v_district_governorate
    from public.districts d where d.id = new.district_id;

    if v_district_governorate is null then
      raise exception 'VALIDATION_FAILED: unknown district' using errcode = '22023';
    end if;
    if new.governorate_id is not null and new.governorate_id <> v_district_governorate then
      raise exception 'VALIDATION_FAILED: district does not belong to governorate' using errcode = '22023';
    end if;
    -- Fill in the governorate when only the district was given: fewer ways for data to disagree.
    new.governorate_id := v_district_governorate;
  end if;
  return new;
end;
$$;

create trigger places_assert_geography
  before insert or update of district_id, governorate_id on public.places
  for each row execute function app.assert_place_geography();

-- ---------------------------------------------------------------------------
-- Regions and sub-regions (self-referencing tree, max depth 3)
-- ---------------------------------------------------------------------------

create type public.region_kind as enum ('region', 'sub_region');

create table public.regions (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid references public.regions (id) on delete restrict,
  kind       public.region_kind not null default 'region',
  name_ar    text not null check (length(btrim(name_ar)) between 2 and 120),
  name_en    text not null check (length(btrim(name_en)) between 2 and 120),
  name_ar_norm text generated always as (app.normalize_arabic(name_ar)) stored,
  description text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint regions_not_own_parent check (parent_id is distinct from id)
);

create unique index regions_name_unique on public.regions (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name_ar_norm);
create index regions_parent_idx on public.regions (parent_id);

create trigger regions_set_updated_at
  before update on public.regions
  for each row execute function app.set_updated_at();

create table public.region_governorates (
  region_id      uuid not null references public.regions (id) on delete cascade,
  governorate_id uuid not null references public.governorates (id) on delete cascade,
  primary key (region_id, governorate_id)
);

create table public.region_districts (
  region_id   uuid not null references public.regions (id) on delete cascade,
  district_id uuid not null references public.districts (id) on delete cascade,
  primary key (region_id, district_id)
);

-- Depth guard: a region tree deeper than three levels is a modelling mistake, not a feature.
create or replace function app.assert_region_depth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_depth int := 0;
  v_cursor uuid := new.parent_id;
begin
  while v_cursor is not null loop
    v_depth := v_depth + 1;
    if v_depth > 2 then
      raise exception 'VALIDATION_FAILED: region nesting deeper than 3 levels' using errcode = '22023';
    end if;
    select parent_id into v_cursor from public.regions where id = v_cursor;
    if v_cursor = new.id then
      raise exception 'VALIDATION_FAILED: region cycle' using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;

create trigger regions_assert_depth
  before insert or update of parent_id on public.regions
  for each row execute function app.assert_region_depth();

-- ---------------------------------------------------------------------------
-- Supervisor assignments
-- ---------------------------------------------------------------------------

create table public.geo_assignments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  region_id  uuid not null references public.regions (id) on delete cascade,
  granted_by uuid references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id) on delete set null,
  reason     text
);

create unique index geo_assignments_active_unique
  on public.geo_assignments (user_id, region_id)
  where revoked_at is null;

create index geo_assignments_user_idx on public.geo_assignments (user_id) where revoked_at is null;
create index geo_assignments_region_idx on public.geo_assignments (region_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Scope helpers (security definer: they read rows the caller cannot see directly)
-- ---------------------------------------------------------------------------

create or replace function app.region_descendants(p_root uuid)
returns table (region_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive tree as (
    select r.id, r.parent_id
    from public.regions r
    where r.id = p_root and r.is_active
    union all
    select child.id, child.parent_id
    from public.regions child
    join tree parent on child.parent_id = parent.id
    where child.is_active
  )
  select tree.id from tree;
$$;

comment on function app.region_descendants(uuid) is
  'A region and every sub-region beneath it. Recursive, so a re-parented sub-region is picked up
   without touching assignments.';

create or replace function app.geo_scope_districts(p_uid uuid default app.uid())
returns table (district_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with assigned as (
    select ga.region_id
    from public.geo_assignments ga
    where ga.user_id = p_uid and ga.revoked_at is null
  ),
  covered_regions as (
    select distinct d.region_id
    from assigned a
    cross join lateral app.region_descendants(a.region_id) d
  ),
  from_governorates as (
    select ds.id
    from public.region_governorates rg
    join public.districts ds on ds.governorate_id = rg.governorate_id
    where rg.region_id in (select region_id from covered_regions)
      and ds.is_active
  ),
  from_districts as (
    select rd.district_id as id
    from public.region_districts rd
    join public.districts ds on ds.id = rd.district_id
    where rd.region_id in (select region_id from covered_regions)
      and ds.is_active
  )
  select id from from_governorates
  union
  select id from from_districts;
$$;

create or replace function app.in_geo_scope(p_district uuid, p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.geo_scope_districts(p_uid) scope where scope.district_id = p_district
  );
$$;

create or replace function app.in_geo_scope_gov(p_governorate uuid, p_uid uuid default app.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.geo_scope_districts(p_uid) scope
    join public.districts d on d.id = scope.district_id
    where d.governorate_id = p_governorate
  );
$$;

create or replace function app.geo_scope_size(p_uid uuid default app.uid())
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from app.geo_scope_districts(p_uid);
$$;

-- ---------------------------------------------------------------------------
-- Search (read-only RPC; the one public function a client may execute)
-- ---------------------------------------------------------------------------

create or replace function public.search_places(
  p_query text,
  p_locale text default 'ar',
  p_governorate uuid default null,
  p_district uuid default null,
  p_kind text default null,
  p_limit int default 20
)
returns table (
  id uuid,
  kind text,
  name text,
  name_ar text,
  name_en text,
  governorate_id uuid,
  governorate_name text,
  district_id uuid,
  district_name text,
  lat double precision,
  lng double precision,
  is_public boolean,
  score real
)
language sql
stable
security definer
set search_path = ''
as $$
  with q as (
    select app.normalize_arabic(p_query) as norm
  ),
  candidates as (
    select
      pl.id, pl.kind, pl.name_ar, pl.name_en, pl.governorate_id, pl.district_id,
      pl.lat, pl.lng, pl.is_public,
      g.name_ar as gov_ar, g.name_en as gov_en,
      d.name_ar as dist_ar, d.name_en as dist_en,
      pl.name_ar_norm, pl.name_en_norm, pl.aliases_norm
    from public.places pl
    left join public.governorates g on g.id = pl.governorate_id
    left join public.districts d on d.id = pl.district_id
    where pl.is_active
      and (pl.is_public or pl.created_by = app.uid())
      and (p_governorate is null or pl.governorate_id = p_governorate)
      and (p_district is null or pl.district_id = p_district)
      and (p_kind is null or pl.kind = p_kind)
  ),
  scored as (
    select
      c.*,
      greatest(
        case when c.name_ar_norm = (select norm from q) then 100
             when c.name_ar_norm like (select norm from q) || '%' then 80
             when c.name_ar_norm like '%' || (select norm from q) || '%' then 60
             else 0 end,
        case when c.name_en_norm = (select norm from q) then 100
             when c.name_en_norm like (select norm from q) || '%' then 80
             when c.name_en_norm like '%' || (select norm from q) || '%' then 60
             else 0 end,
        case when c.aliases_norm like '%' || (select norm from q) || '%' then 55 else 0 end,
        case when public.similarity(c.aliases_norm, (select norm from q)) >= 0.4
             then round(public.similarity(c.aliases_norm, (select norm from q)) * 40)::int else 0 end,
        case when public.similarity(c.name_ar_norm, (select norm from q)) >= 0.4
             then round(public.similarity(c.name_ar_norm, (select norm from q)) * 55)::int else 0 end,
        case when public.similarity(c.name_en_norm, (select norm from q)) >= 0.4
             then round(public.similarity(c.name_en_norm, (select norm from q)) * 55)::int else 0 end
      ) as text_score
    from candidates c
  )
  select
    s.id,
    s.kind,
    case when p_locale = 'en' then coalesce(s.name_en, s.name_ar) else s.name_ar end as name,
    s.name_ar,
    coalesce(s.name_en, ''),
    s.governorate_id,
    case when p_locale = 'en' then coalesce(s.gov_en, s.gov_ar) else s.gov_ar end,
    s.district_id,
    case when p_locale = 'en' then coalesce(s.dist_en, s.dist_ar) else s.dist_ar end,
    s.lat,
    s.lng,
    s.is_public,
    (
      s.text_score
      + case s.kind
          when 'city' then 6 when 'district_centre' then 4 when 'town' then 3
          when 'landmark' then 2 when 'station' then 1 when 'airport' then 1
          when 'port' then 1 when 'border_crossing' then 1 when 'market' then 1
          when 'hospital' then 1 else 0
        end
    )::real as score
  from scored s
  where s.text_score > 0
  order by score desc, s.name_ar asc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

comment on function public.search_places is
  'Localised, ranked place search. Read-only and explicitly granted to authenticated; private
   gathering points are only ever returned to their creator. Mirrors rankPlaces() in @maak/core.';

-- ---------------------------------------------------------------------------
-- RLS: reads only. Writes go through cmd_* (Phase 2 commands live in 00009).
-- ---------------------------------------------------------------------------

alter table public.governorates      enable row level security;
alter table public.districts         enable row level security;
alter table public.places            enable row level security;
alter table public.regions           enable row level security;
alter table public.region_governorates enable row level security;
alter table public.region_districts  enable row level security;
alter table public.geo_assignments   enable row level security;

alter table public.governorates      force row level security;
alter table public.districts         force row level security;
alter table public.places            force row level security;
alter table public.regions           force row level security;
alter table public.region_governorates force row level security;
alter table public.region_districts  force row level security;
alter table public.geo_assignments   force row level security;

-- Reference data is public: it is the same for everyone and has no PII.
create policy governorates_read_all on public.governorates
  for select to anon, authenticated using (true);

create policy districts_read_all on public.districts
  for select to anon, authenticated using (true);

create policy regions_read_all on public.regions
  for select to authenticated using (true);

create policy region_governorates_read_all on public.region_governorates
  for select to authenticated using (true);

create policy region_districts_read_all on public.region_districts
  for select to authenticated using (true);

-- A place is visible when it is public, when you created it, or when your organization did.
-- Guests see public places only: `app.uid()` costs an EXECUTE grant we do not want to hand to anon.
create policy places_read_public on public.places
  for select to anon
  using (is_active and is_public);

create policy places_read_public_or_own on public.places
  for select to authenticated
  using (
    is_active
    and (
      is_public
      or created_by = app.uid()
      or (created_by_org is not null and created_by_org in (select app.my_orgs()))
    )
  );

-- Reviewers must see a user-submitted gathering point even though it is private to its creator.
create policy places_read_staff on public.places
  for select to authenticated
  using (app.is_platform_staff());

create policy geo_assignments_read_own_or_staff on public.geo_assignments
  for select to authenticated
  using (user_id = app.uid() or app.is_platform_staff());

grant select on public.governorates to anon, authenticated;
grant select on public.districts to anon, authenticated;
grant select on public.places to anon, authenticated;
grant select on public.regions to authenticated;
grant select on public.region_governorates to authenticated;
grant select on public.region_districts to authenticated;
grant select on public.geo_assignments to authenticated;

revoke insert, update, delete on
  public.governorates, public.districts, public.places, public.regions,
  public.region_governorates, public.region_districts, public.geo_assignments
  from anon, authenticated;

-- The search RPC is the single read function a client executes directly.
revoke all on function public.search_places(text, text, uuid, uuid, text, int) from public, anon, authenticated;
grant execute on function public.search_places(text, text, uuid, uuid, text, int) to authenticated;

-- Scope helpers are needed by RLS-adjacent code, but never by a browser: keep them private.
revoke all on function app.region_descendants(uuid) from public, anon, authenticated;
revoke all on function app.geo_scope_districts(uuid) from public, anon, authenticated;
revoke all on function app.in_geo_scope(uuid, uuid) from public, anon, authenticated;
revoke all on function app.in_geo_scope_gov(uuid, uuid) from public, anon, authenticated;
revoke all on function app.geo_scope_size(uuid) from public, anon, authenticated;

-- `app.my_orgs()` is evaluated inside the places policy, so `authenticated` must be able to call it.
grant execute on function app.my_orgs(uuid) to authenticated;

grant execute on function app.region_descendants(uuid) to service_role;
grant execute on function app.geo_scope_districts(uuid) to service_role;
grant execute on function app.in_geo_scope(uuid, uuid) to service_role;
grant execute on function app.in_geo_scope_gov(uuid, uuid) to service_role;
grant execute on function app.geo_scope_size(uuid) to service_role;
