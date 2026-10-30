-- 0004 — Phase 2: geography, places and supervisor scoping
--
-- The promises verified here:
--   1. reference data is complete and Arabic is folded identically to @maak/core
--   2. a place can never point at a district in another governorate (the trigger fills gaps, never guesses)
--   3. a private gathering point stays private — to other users, in search, and to guests
--   4. ranking prefers an exact name, honours the locale, and clamps the limit
--   5. regions nest at most three deep, cannot form cycles, and replace coverage wholesale
--   6. a supervisor's scope is exactly the districts of their regions, and revocation is immediate
--   7. only staff create reference places; user submissions wait in a queue and are decided with a reason
--   8. imports are dry-run by default, and clients cannot reach any cmd_* function
--
-- Run with: supabase test db   (requires Docker)

begin;

create extension if not exists pgtap;

select plan(67);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, phone, raw_user_meta_data)
values
  ('aaaa0001-1111-4111-8111-aaaaaaaaaaaa', 'admin@example.test', '+967733100001', '{"locale":"ar"}'),
  ('aaaa0002-2222-4222-8222-aaaaaaaaaaaa', 'staff@example.test', '+967733100002', '{"locale":"ar"}'),
  ('aaaa0003-3333-4333-8333-aaaaaaaaaaaa', 'verified@example.test', '+967733100003', '{"locale":"ar"}'),
  ('aaaa0004-4444-4444-8444-aaaaaaaaaaaa', 'unverified@example.test', '+967733100004', '{"locale":"ar"}'),
  ('aaaa0005-5555-4555-8555-aaaaaaaaaaaa', 'supervisor@example.test', '+967733100005', '{"locale":"ar"}'),
  ('aaaa0006-6666-4666-8666-aaaaaaaaaaaa', 'other@example.test', '+967733100006', '{"locale":"ar"}');

insert into public.user_roles (user_id, role)
values
  ('aaaa0001-1111-4111-8111-aaaaaaaaaaaa', 'platform_admin'),
  ('aaaa0002-2222-4222-8222-aaaaaaaaaaaa', 'platform_staff');

update public.profiles
set verification_status = 'verified'
where id = 'aaaa0003-3333-4333-8333-aaaaaaaaaaaa';

-- ---------------------------------------------------------------------------
-- 1. Seed completeness and Arabic folding
-- ---------------------------------------------------------------------------

select is((select count(*)::int from public.governorates), 22, 'all 22 Yemeni governorates are seeded');

select is(
  (select count(*)::int from public.governorates where code is null or code !~ '^YE-[A-Z]{2}$'),
  0,
  'every governorate carries an ISO 3166-2 code (the join key for imports)'
);

select is(app.normalize_arabic('  عَدَن  '), 'عدن', 'harakat are stripped and the string is trimmed');

select is(app.normalize_arabic('إبّ'), 'اب', 'alef variants fold to bare alef');

select is(app.normalize_arabic('مصطفى'), 'مصطفي', 'alef maqsura folds to yeh');

select is(app.normalize_arabic('٠١٢٣'), '0123', 'Arabic-Indic digits become Western digits');

select is(app.normalize_arabic('  Sana''A   City '), 'sana''a city', 'Latin is lower-cased and spaces collapse');

select is(
  (select count(*)::int
   from public.districts d
   join public.governorates g on g.id = d.governorate_id
   where g.code = 'YE-AD' and d.name_ar_norm = app.normalize_arabic('عَدَن')),
  0,
  'a diacritic-heavy lookup never silently matches the wrong district'
);

-- ---------------------------------------------------------------------------
-- 2. Place ↔ geography integrity
-- ---------------------------------------------------------------------------

create temporary table t_geo on commit drop as
select
  (select id from public.governorates where code = 'YE-AD') as aden,
  (select id from public.governorates where code = 'YE-SA') as sanaa,
  (select d.id from public.districts d where d.name_ar_norm = app.normalize_arabic('كريتر') limit 1) as crater,
  (select d.id from public.districts d where d.name_ar_norm = app.normalize_arabic('المكلا') limit 1) as mukalla;

-- RLS tests below switch to the `authenticated` role; temporary tables need their own grant.
grant select on t_geo to authenticated, anon;

insert into public.places (kind, name_ar, name_en, district_id, lat, lng, is_public, verification_status)
select 'landmark', 'ساعة عدن', 'Aden Clock', crater, 12.7749, 45.0369, true, 'verified'::public.verification_status
from t_geo;

select is(
  (select p.governorate_id::text from public.places p where p.name_ar = 'ساعة عدن'),
  (select aden::text from t_geo),
  'giving only a district fills in its governorate (the trigger never guesses)'
);

select throws_ok(
  $$insert into public.places (kind, name_ar, governorate_id, district_id)
    select 'landmark', 'مستحيل', t.sanaa, t.crater from t_geo t$$,
  '22023',
  'a district from another governorate is rejected'
);

select throws_ok(
  $$insert into public.places (kind, name_ar, district_id)
    values ('landmark', 'مديرية وهمية', gen_random_uuid())$$,
  '22023',
  'an unknown district is rejected, not silently nulled'
);

-- ---------------------------------------------------------------------------
-- 3. Private gathering points
-- ---------------------------------------------------------------------------

create temporary table t_place on commit drop as
select public.cmd_create_place(
  'aaaa0003-3333-4333-8333-aaaaaaaaaaaa',
  'gathering_point', 'نقطة تجمع الشارع الخامس', 'Fifth Street gathering point',
  (select aden from t_geo), (select crater from t_geo), 12.7801, 45.0302,
  array['الشارع الخامس'], array['fifth street'], null, 'test-request-1', null
) as payload;

grant select on t_place to authenticated, anon;

select is(
  (select p.is_public::text || '/' || p.verification_status::text
   from public.places p
   where p.id = ((select payload -> 'place' ->> 'id' from t_place)::uuid)),
  'false/pending',
  'a user-created gathering point starts private and pending review'
);

select throws_ok(
  $$select public.cmd_create_place(
      'aaaa0004-4444-4444-8444-aaaaaaaaaaaa', 'gathering_point', 'نقطة تجمع غير موثق')$$,
  '42501',
  'an unverified account cannot add a place'
);

select throws_ok(
  $$select public.cmd_create_place(
      'aaaa0003-3333-4333-8333-aaaaaaaaaaaa', 'city', 'مدينة من مستخدم')$$,
  '42501',
  'a verified account cannot invent a reference city (staff-only kind)'
);

select is(
  (select count(*)::int from public.notifications
   where user_id = 'aaaa0003-3333-4333-8333-aaaaaaaaaaaa' and title_key = 'notifications.placePending'),
  1,
  'submitting a gathering point notifies the submitter that it is queued'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaa0006-6666-4666-8666-aaaaaaaaaaaa","role":"authenticated"}';

select is(
  (select count(*)::int from public.places
   where id = ((select payload -> 'place' ->> 'id' from t_place)::uuid)),
  0,
  'another authenticated user cannot read the private gathering point'
);

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaa0003-3333-4333-8333-aaaaaaaaaaaa","role":"authenticated"}';

select is(
  (select count(*)::int from public.places
   where id = ((select payload -> 'place' ->> 'id' from t_place)::uuid)),
  1,
  'the creator can read their own gathering point'
);

reset role;

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select is(
  (select count(*)::int from public.places
   where id = ((select payload -> 'place' ->> 'id' from t_place)::uuid)),
  0,
  'a guest never sees a private gathering point'
);

select ok(
  (select count(*)::int from public.places) > 0,
  'a guest still sees the public reference places'
);

reset role;

-- ---------------------------------------------------------------------------
-- 4. Search: ranking, locale, filters, limits
-- ---------------------------------------------------------------------------

select is(
  (select name_ar from public.search_places('عدن', 'ar', null, null, null, 5) limit 1),
  'عدن',
  'an exact Arabic name ranks first'
);

select ok(
  (select score >= 100 from public.search_places('عدن', 'ar', null, null, null, 5) limit 1),
  'an exact match scores at least the base 100'
);

select is(
  (select name from public.search_places('عدن', 'en', null, null, null, 5) limit 1),
  'Aden',
  'the English locale returns the English name'
);

select is(
  (select count(*)::int from public.search_places('ا', 'ar', (select aden from t_geo), null, null, 50)
   where governorate_id is distinct from (select aden from t_geo)),
  0,
  'the governorate filter is applied before ranking'
);

select ok(
  (select count(*)::int from public.search_places('ا', 'ar', null, null, null, 1000)) <= 50,
  'the result limit is clamped to 50'
);

select ok(
  (select count(*)::int from public.search_places('', 'ar', (select aden from t_geo), null, null, 50)) > 0,
  'an empty query browses a governorate instead of returning nothing'
);

select is(
  (select count(*)::int from public.search_places('', 'ar', null, null, null, 1000)),
  (select count(*)::int from public.search_places('', 'ar', null, null, null, 50)),
  'browsing is still clamped by the limit'
);

select is(
  (select count(*)::int from public.search_places('نقطة تجمع الشارع الخامس', 'ar', null, null, null, 10)),
  0,
  'search never leaks another user''s private place'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaa0003-3333-4333-8333-aaaaaaaaaaaa","role":"authenticated"}';

select is(
  (select count(*)::int from public.search_places('نقطة تجمع الشارع الخامس', 'ar', null, null, null, 10)),
  1,
  'the creator finds their own gathering point in search'
);

reset role;

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select throws_ok(
  $$select * from public.search_places('عدن')$$,
  '42501',
  'a guest session cannot execute search_places (sign-in is required for search)'
);

reset role;

-- ---------------------------------------------------------------------------
-- 5. Regions: depth, cycles, coverage
-- ---------------------------------------------------------------------------

create temporary table t_region on commit drop as
select p as payload, (p -> 'region' ->> 'id')::uuid as id
from (select public.cmd_upsert_region(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa', null, null, 'region',
  'إقليم عدن للاختبار', 'Aden Test Region', null,
  array[(select aden from t_geo)], '{}'::uuid[], 'test-request-2', null
) as p) s;

select is(
  (select count(*)::int from public.region_governorates rg
   where rg.region_id = ((select payload -> 'region' ->> 'id' from t_region)::uuid)),
  1,
  'creating a region records its governorate coverage'
);

select public.cmd_upsert_region(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa',
  (select id from t_region),
  null, 'region', 'إقليم عدن للاختبار', 'Aden Test Region', null,
  '{}'::uuid[], array[(select mukalla from t_geo)], 'test-request-3', null
);

select is(
  (select count(*)::int from public.region_governorates rg
   where rg.region_id = ((select payload -> 'region' ->> 'id' from t_region)::uuid))
  || '/' ||
  (select count(*)::int from public.region_districts rd
   where rd.region_id = ((select payload -> 'region' ->> 'id' from t_region)::uuid)),
  '0/1',
  'coverage is replaced wholesale, never merged (a governorate and its districts cannot disagree)'
);

select throws_ok(
  format(
    $$select public.cmd_upsert_region('aaaa0001-1111-4111-8111-aaaaaaaaaaaa', null, null, 'region',
        'إقليم بمديرية مجهولة', 'Unknown District Region', null, '{}'::uuid[], array[%L]::uuid[])$$,
    gen_random_uuid()
  ),
  '22023',
  'an unknown district id is a validation error, not a silent skip'
);

select throws_ok(
  $$select public.cmd_upsert_region('aaaa0003-3333-4333-8333-aaaaaaaaaaaa', null, null, 'region',
      'إقليم بلا صلاحية', 'Unauthorised Region', null, '{}'::uuid[], '{}'::uuid[])$$,
  '42501',
  'only platform admins manage regions'
);

create temporary table t_chain on commit drop as
select p as payload, (p -> 'region' ->> 'id')::uuid as id
from (select public.cmd_upsert_region(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa', null, null, 'region',
  'مستوى أول', 'Level One', null, array[(select aden from t_geo)], '{}'::uuid[], 'test-request-4', null
) as p) s;

grant select on t_chain to authenticated;

select public.cmd_upsert_region(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa', null,
  (select id from t_chain), 'sub_region',
  'مستوى ثانٍ', 'Level Two', null, '{}'::uuid[], array[(select crater from t_geo)], 'test-request-5', null
);

create temporary table t_level2 on commit drop as
select id, parent_id from public.regions where name_ar = 'مستوى ثانٍ';

grant select on t_level2 to authenticated;

select public.cmd_upsert_region(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa', null,
  (select id from t_level2), 'sub_region',
  'مستوى ثالث', 'Level Three', null, '{}'::uuid[], array[(select crater from t_geo)], 'test-request-6', null
);

select is(
  (select count(*)::int from public.regions where name_ar = 'مستوى ثالث'),
  1,
  'a third level (region → sub-region → sub-region) is allowed'
);

select throws_ok(
  format(
    $$select public.cmd_upsert_region('aaaa0001-1111-4111-8111-aaaaaaaaaaaa', null, %L, 'sub_region',
        'مستوى رابع', 'Level Four', null, '{}'::uuid[], array[%L]::uuid[])$$,
    (select id from public.regions where name_ar = 'مستوى ثالث'),
    (select crater from t_geo)
  ),
  '22023',
  'a fourth level is rejected (regions nest at most three deep)'
);

create temporary table t_cycle on commit drop as
select p as payload, (p -> 'region' ->> 'id')::uuid as id
from (select public.cmd_upsert_region(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa', null, null, 'region',
  'حلقة أ', 'Cycle A', null, array[(select sanaa from t_geo)], '{}'::uuid[], 'test-request-7', null
) as p) s;

select public.cmd_upsert_region(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa', null,
  (select id from t_cycle), 'sub_region',
  'حلقة ب', 'Cycle B', null, '{}'::uuid[], array[(select crater from t_geo)], 'test-request-8', null
);

select throws_ok(
  format(
    $$update public.regions set parent_id = (select id from public.regions where name_ar = 'حلقة ب')
      where id = %L$$,
    (select id from t_cycle)
  ),
  '22023',
  'a region cannot be re-parented into a cycle'
);

select is(
  (select count(*)::int from app.region_descendants((select id from t_chain))),
  3,
  'region_descendants returns the whole subtree, however deep'
);

-- ---------------------------------------------------------------------------
-- 6. Supervisor scope
-- ---------------------------------------------------------------------------

select public.cmd_assign_geo_supervisor(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa',
  'aaaa0005-5555-4555-8555-aaaaaaaaaaaa',
  array[(select id from t_chain)],
  'تغطية اختبار', 'test-request-9', null
);

select ok(
  exists (
    select 1 from public.user_roles
    where user_id = 'aaaa0005-5555-4555-8555-aaaaaaaaaaaa'
      and role = 'geo_supervisor' and revoked_at is null
  ),
  'assigning a region also grants the geo_supervisor role'
);

select is(
  app.geo_scope_size('aaaa0005-5555-4555-8555-aaaaaaaaaaaa'),
  (select count(*)::int from public.districts where governorate_id = (select aden from t_geo)),
  'a governorate inside the region expands to all of its districts'
);

select ok(
  app.in_geo_scope((select crater from t_geo), 'aaaa0005-5555-4555-8555-aaaaaaaaaaaa'),
  'a district inside the scope is recognised'
);

select ok(
  not app.in_geo_scope((select mukalla from t_geo), 'aaaa0005-5555-4555-8555-aaaaaaaaaaaa'),
  'a district outside the scope is not'
);

select public.cmd_assign_geo_supervisor(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa',
  'aaaa0005-5555-4555-8555-aaaaaaaaaaaa',
  array[
    (select id from t_chain),
    (select id from t_region)
  ],
  null, 'test-request-10', null
);

select is(
  app.geo_scope_size('aaaa0005-5555-4555-8555-aaaaaaaaaaaa'),
  (select count(*)::int from public.districts where governorate_id = (select aden from t_geo))
    + (select count(*)::int from public.region_districts
       where region_id = ((select payload -> 'region' ->> 'id' from t_region)::uuid)),
  'a hand-picked district from another governorate is added to the scope'
);

select public.cmd_assign_geo_supervisor(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa',
  'aaaa0005-5555-4555-8555-aaaaaaaaaaaa',
  array[(select id from t_chain)],
  null, 'test-request-11', null
);

select is(
  (select count(*)::int from public.geo_assignments
   where user_id = 'aaaa0005-5555-4555-8555-aaaaaaaaaaaa' and revoked_at is null),
  1,
  're-assigning reconciles: a region dropped from the list is revoked'
);

select public.cmd_revoke_geo_supervisor(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa',
  'aaaa0005-5555-4555-8555-aaaaaaaaaaaa',
  'انتهاء التغطية', 'test-request-12', null
);

select is(
  app.geo_scope_size('aaaa0005-5555-4555-8555-aaaaaaaaaaaa'),
  0,
  'revocation takes effect immediately (scope is never cached)'
);

select throws_ok(
  $$select public.cmd_revoke_geo_supervisor(
      'aaaa0001-1111-4111-8111-aaaaaaaaaaaa', 'aaaa0005-5555-4555-8555-aaaaaaaaaaaa')$$,
  'P0002',
  'revoking nothing is an explicit not-found, not a silent success'
);

-- ---------------------------------------------------------------------------
-- 7. Staff places and the review queue
-- ---------------------------------------------------------------------------

create temporary table t_staff_place on commit drop as
select public.cmd_create_place(
  'aaaa0002-2222-4222-8222-aaaaaaaaaaaa',
  'station', 'موقف عدن المركزي', 'Aden Central Station',
  (select aden from t_geo), (select crater from t_geo), 12.7799, 45.0345,
  '{}'::text[], '{}'::text[], null, 'test-request-13', null
) as payload;

grant select on t_staff_place to authenticated;

select is(
  (select p.is_public::text || '/' || p.verification_status::text
   from public.places p
   where p.id = ((select payload -> 'place' ->> 'id' from t_staff_place)::uuid)),
  'true/verified',
  'staff-created reference places are public and verified immediately'
);

-- The review queue is read through RLS (`places_read_staff`), so the policy is what gets tested.
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaa0002-2222-4222-8222-aaaaaaaaaaaa","role":"authenticated"}';

select is(
  (select count(*)::int from public.places
   where id = ((select payload -> 'place' ->> 'id' from t_place)::uuid)
     and verification_status = 'pending'),
  1,
  'staff see the pending user submission through RLS'
);

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaa0006-6666-4666-8666-aaaaaaaaaaaa","role":"authenticated"}';

select is(
  (select count(*)::int from public.places where verification_status = 'pending' and not is_public),
  0,
  'a non-staff account sees no pending private place, not even to review it'
);

reset role;

reset request.jwt.claims;

select throws_ok(
  $$select public.cmd_decide_place('aaaa0002-2222-4222-8222-aaaaaaaaaaaa',
      (select (payload -> 'place' ->> 'id')::uuid from t_place), 'reject')$$,
  '22023',
  'rejecting a place without a reason is refused'
);

select public.cmd_decide_place(
  'aaaa0002-2222-4222-8222-aaaaaaaaaaaa',
  (select (payload -> 'place' ->> 'id')::uuid from t_place),
  'approve', 'مدقّق: الموقع صحيح', 'test-request-14', null
);

select is(
  (select p.is_public::text || '/' || p.verification_status::text
   from public.places p
   where p.id = ((select payload -> 'place' ->> 'id' from t_place)::uuid)),
  'true/verified',
  'approving promotes a gathering point to a public, verified place'
);

select ok(
  exists (
    select 1 from public.notifications
    where user_id = 'aaaa0003-3333-4333-8333-aaaaaaaaaaaa' and kind = 'verification_approved'
  ),
  'the submitter is notified of the decision'
);

-- ---------------------------------------------------------------------------
-- 8. Import: dry run by default
-- ---------------------------------------------------------------------------

select is(
  (select (payload ->> 'added')::int || '/' || (payload ->> 'skipped')::int
   from (select public.cmd_import_geo(
           'aaaa0001-1111-4111-8111-aaaaaaaaaaaa', 'districts',
           jsonb_build_array(jsonb_build_object(
             'governorate_code', 'YE-AD', 'name_ar', 'مديرية اختبار', 'name_en', 'Test District'
           )),
           true, 'test-request-15', null
         ) as payload) s),
  '1/0',
  'a dry run reports what it would add'
);

select is(
  (select count(*)::int from public.districts where name_ar = 'مديرية اختبار'),
  0,
  'a dry run writes nothing'
);

select public.cmd_import_geo(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa', 'districts',
  jsonb_build_array(jsonb_build_object(
    'governorate_code', 'YE-AD', 'name_ar', 'مديرية اختبار', 'name_en', 'Test District'
  )),
  false, 'test-request-16', null
);

select is(
  (select count(*)::int from public.districts where name_ar = 'مديرية اختبار'),
  1,
  'a committed import creates the district'
);

select is(
  (select count(*)::int
   from (select public.cmd_import_geo(
           'aaaa0001-1111-4111-8111-aaaaaaaaaaaa', 'districts',
           jsonb_build_array(jsonb_build_object(
             'governorate_ar', 'عَدَن', 'name_ar', 'مديرية اختبار', 'name_en', 'Test District'
           )),
           true, null, null
         ) as payload) s
   where (payload ->> 'updated') = '1' and (payload ->> 'added') = '0'),
  1,
  'imports match governorates by folded Arabic name as well as by code'
);

select throws_ok(
  $$select public.cmd_import_geo('aaaa0001-1111-4111-8111-aaaaaaaaaaaa', 'districts', '{"rows":1}'::jsonb)$$,
  '22023',
  'a payload that is not an array of rows is refused'
);

-- ---------------------------------------------------------------------------
-- 8b. Retiring reference data (deactivate / reactivate)
-- ---------------------------------------------------------------------------

select throws_ok(
  format(
    $$select public.cmd_set_region_active('aaaa0001-1111-4111-8111-aaaaaaaaaaaa', %L, false)$$,
    (select id from public.regions where name_ar = 'مستوى أول')
  ),
  '23505',
  'deactivating a region with an active sub-region is refused (no silent orphan)'
);

select public.cmd_set_region_active(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa',
  (select id from public.regions where name_ar = 'مستوى ثالث'),
  false, 'اختبار', 'test-request-17', null
);

select is(
  (select is_active from public.regions where name_ar = 'مستوى ثالث'),
  false,
  'a leaf region can be deactivated'
);

select public.cmd_set_region_active(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa',
  (select id from public.regions where name_ar = 'مستوى ثانٍ'),
  false, null, 'test-request-18', null
);

-- Re-assign the supervisor first: section 6 revoked everything, and retiring a region must tell
-- whoever still depends on it.
select public.cmd_assign_geo_supervisor(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa',
  'aaaa0005-5555-4555-8555-aaaaaaaaaaaa',
  array[(select id from t_chain)],
  null, 'test-request-19', null
);

select public.cmd_set_region_active(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa',
  (select id from public.regions where name_ar = 'مستوى أول'),
  false, null, 'test-request-20', null
);

select is(
  (select count(*)::int from app.region_descendants((select id from t_chain))),
  0,
  'an inactive region contributes no descendants (scope shrinks immediately)'
);

select is(
  (public.cmd_set_region_active(
    'aaaa0001-1111-4111-8111-aaaaaaaaaaaa',
    (select id from public.regions where name_ar = 'مستوى أول'),
    false, null, null, null
  ) ->> 'changed')::boolean,
  false,
  'deactivating twice is idempotent, not an error'
);

select public.cmd_set_region_active(
  'aaaa0001-1111-4111-8111-aaaaaaaaaaaa',
  (select id from public.regions where name_ar = 'مستوى أول'),
  true, null, 'test-request-20', null
);

select is(
  (select is_active from public.regions where name_ar = 'مستوى أول'),
  true,
  'a region can be reactivated'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaa0006-6666-4666-8666-aaaaaaaaaaaa","role":"authenticated"}';

select throws_ok(
  format(
    $$select public.cmd_set_place_active('aaaa0006-6666-4666-8666-aaaaaaaaaaaa', %L, false)$$,
    (select (payload -> 'place' ->> 'id')::uuid from t_staff_place)
  ),
  '42501',
  'a user cannot retire a place they did not create'
);

reset role;

select public.cmd_set_place_active(
  'aaaa0002-2222-4222-8222-aaaaaaaaaaaa',
  (select (payload -> 'place' ->> 'id')::uuid from t_staff_place),
  false, 'مكرر', 'test-request-21', null
);

select is(
  (select count(*)::int from public.search_places('موقف عدن المركزي', 'ar', null, null, null, 10)),
  0,
  'a retired place disappears from search immediately'
);

select ok(
  exists (select 1 from audit.log where action = 'place.deactivate')
  and exists (select 1 from audit.log where action = 'region.deactivate'),
  'retiring reference data is audited'
);

select ok(
  exists (
    select 1 from public.notifications
    where user_id = 'aaaa0005-5555-4555-8555-aaaaaaaaaaaa'
      and title_key = 'notifications.geoRegionRetired'
  ),
  'a supervisor is told when the region that gave them scope is retired'
);

-- ---------------------------------------------------------------------------
-- 9. Everything is audited, and clients cannot call commands
-- ---------------------------------------------------------------------------

select ok(
  exists (select 1 from audit.log where action = 'region.create')
  and exists (select 1 from audit.log where action = 'geo.assign')
  and exists (select 1 from audit.log where action = 'place.create'),
  'region, supervisor and place changes are all audited'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaa0001-1111-4111-8111-aaaaaaaaaaaa","role":"authenticated"}';

select throws_ok(
  $$select public.cmd_upsert_region('aaaa0001-1111-4111-8111-aaaaaaaaaaaa', null, null, 'region',
      'إقليم من العميل', 'Client Region', null, '{}'::uuid[], '{}'::uuid[])$$,
  '42501',
  'even a platform admin cannot execute a cmd_* function from a client session'
);

reset role;

select * from finish();

rollback;
