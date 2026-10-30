-- 00009 — the geography we can state with confidence, seeded idempotently.
--
-- Scope of this seed (deliberately honest):
--   · **all 22 governorates** with ISO 3166-2 codes and approximate centres;
--   · the **districts of Aden, Sana'a City, Hadramaut's main towns and a few landmarks** that are
--     unambiguous, as a working starter set;
--   · well-known places (airports, ports, border crossings, markets) used by the picker.
--
-- It is NOT the 333-district OCHA list. Those P-codes cannot be invented: a wrong admin-2 code is
-- worse than a missing one, because trips get validated against it. `scripts/geo/import-districts.mjs`
-- loads the official CSV with a dry-run diff, and is the documented path to completeness
-- (docs/phase-2-report.md §5). Rows here are marked so the difference is visible: seeded districts
-- have `pcode = null` unless the code is certain.
--
-- Idempotency: every statement upserts on a natural key (code / governorate+norm name), so re-running
-- the migration changes nothing.

-- ---------------------------------------------------------------------------
-- Governorates (22) — ISO 3166-2:YE
-- ---------------------------------------------------------------------------

insert into public.governorates (code, name_ar, name_en, region_hint, center_lat, center_lng)
values
  ('YE-SA', 'صنعاء',        'Sana''a',        'highlands', 15.3694, 44.1910),
  ('YE-AM', 'عمران',        'Amran',          'highlands', 15.6594, 43.9439),
  ('YE-SD', 'صعدة',         'Sa''dah',        'highlands', 16.9402, 43.7639),
  ('YE-HJ', 'حجة',          'Hajjah',         'highlands', 15.6943, 43.6012),
  ('YE-MW', 'المحويت',      'Al Mahwit',      'highlands', 15.4700, 43.5448),
  ('YE-RA', 'ريمة',         'Raymah',         'highlands', 14.6300, 43.6100),
  ('YE-DA', 'الضالع',       'Al Dhale''e',    'highlands', 13.6959, 44.7314),
  ('YE-DH', 'ذمار',         'Dhamar',         'highlands', 14.5428, 44.4053),
  ('YE-IB', 'إب',           'Ibb',            'highlands', 13.9667, 44.1667),
  ('YE-TA', 'تعز',          'Taiz',           'highlands', 13.5795, 44.0209),
  ('YE-BA', 'البيضاء',      'Al Bayda',       'highlands', 13.9850, 45.5727),
  ('YE-MA', 'مأرب',         'Marib',          'desert',    15.4624, 45.3258),
  ('YE-JA', 'الجوف',        'Al Jawf',        'desert',    16.5193, 45.1513),
  ('YE-SH', 'شبوة',         'Shabwah',        'desert',    14.5304, 46.8319),
  ('YE-HU', 'الحديدة',      'Al Hudaydah',    'coast',     14.7978, 42.9545),
  ('YE-AD', 'عدن',          'Aden',           'coast',     12.7855, 45.0187),
  ('YE-LA', 'لحج',          'Lahij',          'coast',     13.0585, 44.8832),
  ('YE-AB', 'أبين',         'Abyan',          'coast',     13.0100, 45.3800),
  ('YE-HD', 'حضرموت',       'Hadramaut',      'east',      15.9372, 48.7873),
  ('YE-MR', 'المهرة',       'Al Mahrah',      'east',      16.5210, 51.8300),
  ('YE-SU', 'أرخبيل سقطرى', 'Socotra',        'islands',   12.5022, 53.8600),
  ('YE-AS', 'أمانة العاصمة', 'Amanat Al Asimah', 'highlands', 15.3547, 44.2066)
on conflict (code) do update
  set name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      region_hint = excluded.region_hint,
      center_lat = excluded.center_lat,
      center_lng = excluded.center_lng;

-- ---------------------------------------------------------------------------
-- Districts — starter set (see the note at the top of this file)
-- ---------------------------------------------------------------------------

insert into public.districts (governorate_id, name_ar, name_en, center_lat, center_lng)
select g.id, d.name_ar, d.name_en, d.lat, d.lng
from (values
  -- Aden (the eight districts of the governorate)
  ('YE-AD', 'كريتر',        'Crater',          12.7749, 45.0369),
  ('YE-AD', 'المعلا',       'Al Mualla',       12.7896, 45.0094),
  ('YE-AD', 'التواهي',      'Tawahi',          12.7865, 44.9973),
  ('YE-AD', 'خور مكسر',     'Khormaksar',      12.8310, 45.0270),
  ('YE-AD', 'الشيخ عثمان',  'Sheikh Othman',   12.8790, 45.0040),
  ('YE-AD', 'دار سعد',      'Dar Sa''ad',      12.9050, 44.9780),
  ('YE-AD', 'المنصورة',     'Al Mansura',      12.8600, 45.0230),
  ('YE-AD', 'البريقة',      'Al Buraiqeh',     12.8300, 44.9200),
  -- Amanat Al Asimah (the historic nine)
  ('YE-AS', 'صنعاء القديمة', 'Old Sana''a',     15.3510, 44.2140),
  ('YE-AS', 'شعوب',         'Shu''aub',        15.3900, 44.2000),
  ('YE-AS', 'معين',         'Ma''in',          15.3600, 44.1800),
  ('YE-AS', 'الصافية',      'As Safiyah',      15.3400, 44.2100),
  ('YE-AS', 'الثورة',       'Ath Thawrah',     15.3800, 44.2300),
  ('YE-AS', 'السبعين',      'As Sab''in',      15.3300, 44.2000),
  ('YE-AS', 'بني الحارث',   'Bani Al Harith',  15.4200, 44.2400),
  ('YE-AS', 'الوحدة',       'Al Wahdah',       15.3700, 44.2200),
  -- Hadramaut (the main towns)
  ('YE-HD', 'المكلا',       'Al Mukalla',      14.5425, 49.1242),
  ('YE-HD', 'الشحر',        'Ash Shihr',       14.7600, 49.6060),
  ('YE-HD', 'سيئون',        'Sayun',           15.9430, 48.7873),
  ('YE-HD', 'تريم',         'Tarim',           16.0570, 49.0000),
  ('YE-HD', 'شبام',         'Shibam',          15.9260, 48.6340),
  -- Taiz, Hudaydah, Lahij, Marib, Abyan: the cities everyone names
  ('YE-TA', 'المظفر',       'Al Mudhaffar',    13.5900, 44.0100),
  ('YE-TA', 'القاهرة',      'Al Qahirah',      13.5700, 44.0300),
  ('YE-HU', 'الحوك',        'Al Hawak',        14.8000, 42.9500),
  ('YE-HU', 'الميناء',      'Al Mina',         14.8200, 42.9300),
  ('YE-LA', 'الحوطة',       'Al Hawtah',       13.0585, 44.8832),
  ('YE-MA', 'مدينة مأرب',   'Marib City',      15.4624, 45.3258),
  ('YE-AB', 'زنجبار',       'Zinjibar',        13.1280, 45.3800),
  ('YE-SH', 'عتق',          'Ataq',            14.5304, 46.8319)
) as d(gov_code, name_ar, name_en, lat, lng)
join public.governorates g on g.code = d.gov_code
on conflict (governorate_id, name_ar_norm) do nothing;

-- ---------------------------------------------------------------------------
-- Places: airports, ports, crossings, markets and the obvious cities
-- ---------------------------------------------------------------------------

insert into public.places (kind, name_ar, name_en, aliases_ar, aliases_en, district_id, lat, lng)
select
  p.kind, p.name_ar, p.name_en, p.aliases_ar, p.aliases_en,
  d.id, p.lat, p.lng
from (values
  ('city', 'عدن', 'Aden', array['عدن الصغرى']::text[], array['Aden City']::text[],
   'YE-AD', 'كريتر', 12.7855, 45.0187),
  ('city', 'صنعاء', 'Sana''a', array['صنعاء القديمة', 'الأمانة']::text[], array['Sanaa']::text[],
   'YE-AS', 'صنعاء القديمة', 15.3694, 44.1910),
  ('city', 'تعز', 'Taiz', array[]::text[], array[]::text[],
   'YE-TA', 'القاهرة', 13.5795, 44.0209),
  ('city', 'الحديدة', 'Al Hudaydah', array[]::text[], array['Hodeidah']::text[],
   'YE-HU', 'الحوك', 14.7978, 42.9545),
  ('city', 'إب', 'Ibb', array[]::text[], array[]::text[],
   'YE-IB', null, 13.9667, 44.1667),
  ('city', 'المكلا', 'Al Mukalla', array['مكلا']::text[], array['Mukalla']::text[],
   'YE-HD', 'المكلا', 14.5425, 49.1242),
  ('city', 'مأرب', 'Marib', array[]::text[], array['Ma''rib']::text[],
   'YE-MA', 'مدينة مأرب', 15.4624, 45.3258),
  ('city', 'سيئون', 'Sayun', array['سيون']::text[], array['Seiyun']::text[],
   'YE-HD', 'سيئون', 15.9430, 48.7873),
  ('city', 'ذمار', 'Dhamar', array[]::text[], array[]::text[],
   'YE-DH', null, 14.5428, 44.4053),
  ('city', 'الحوطة', 'Al Hawtah', array[]::text[], array['Hawtah']::text[],
   'YE-LA', 'الحوطة', 13.0585, 44.8832),
  ('city', 'زنجبار', 'Zinjibar', array[]::text[], array[]::text[],
   'YE-AB', 'زنجبار', 13.1280, 45.3800),
  ('city', 'عتق', 'Ataq', array[]::text[], array[]::text[],
   'YE-SH', 'عتق', 14.5304, 46.8319),
  ('city', 'الغيضة', 'Al Ghaydah', array[]::text[], array[]::text[],
   'YE-MR', null, 16.2100, 52.1700),
  ('city', 'صعدة', 'Sa''dah', array[]::text[], array[]::text[],
   'YE-SD', null, 16.9402, 43.7639),
  ('city', 'مأرب القديمة', 'Old Marib', array[]::text[], array[]::text[],
   'YE-MA', 'مدينة مأرب', 15.4300, 45.3400),
  ('airport', 'مطار عدن الدولي', 'Aden International Airport', array['مطار عدن']::text[], array['ADE']::text[],
   'YE-AD', 'خور مكسر', 12.8295, 45.0288),
  ('airport', 'مطار صنعاء الدولي', 'Sana''a International Airport', array['مطار صنعاء']::text[], array['SAH']::text[],
   'YE-AS', null, 15.4763, 44.2197),
  ('airport', 'مطار سيئون', 'Sayun Airport', array[]::text[], array['GXF']::text[],
   'YE-HD', 'سيئون', 15.9661, 48.7883),
  ('airport', 'مطار الريان', 'Riyan Airport', array[]::text[], array['RIY']::text[],
   'YE-HD', 'المكلا', 14.6626, 49.3750),
  ('port', 'ميناء عدن', 'Port of Aden', array['الميناء']::text[], array[]::text[],
   'YE-AD', 'التواهي', 12.7900, 44.9900),
  ('port', 'ميناء المكلا', 'Mukalla Port', array[]::text[], array[]::text[],
   'YE-HD', 'المكلا', 14.5200, 49.1400),
  ('port', 'ميناء الحديدة', 'Hudaydah Port', array[]::text[], array[]::text[],
   'YE-HU', 'الميناء', 14.8300, 42.9200),
  ('border_crossing', 'منفذ الوديعة', 'Al Wadea Crossing', array['الوديعة']::text[], array['Wadea']::text[],
   'YE-HD', null, 17.4500, 47.1000),
  ('border_crossing', 'منفذ الطوال', 'Al Tuwal Crossing', array[]::text[], array[]::text[],
   'YE-HJ', null, 16.7000, 43.1000),
  ('landmark', 'باب اليمن', 'Bab al-Yemen', array['باب اليمن الكبير']::text[], array['Yemen Gate']::text[],
   'YE-AS', 'صنعاء القديمة', 15.3515, 44.2147),
  ('landmark', 'صهاريج عدن', 'Cisterns of Aden', array['صهاريج الطويلة']::text[], array['Cisterns']::text[],
   'YE-AD', 'كريتر', 12.7710, 45.0330),
  ('landmark', 'جبل حديد', 'Jabal Hadid', array[]::text[], array[]::text[],
   'YE-AD', 'كريتر', 12.7800, 45.0300),
  ('market', 'سوق المكلا المركزي', 'Mukalla Central Market', array[]::text[], array[]::text[],
   'YE-HD', 'المكلا', 14.5390, 49.1270),
  ('gathering_point', 'نقطة تجمع ميناء عدن', 'Aden Port Meeting Point', array[]::text[], array[]::text[],
   'YE-AD', 'التواهي', 12.7880, 44.9930)
) as p(kind, name_ar, name_en, aliases_ar, aliases_en, gov_code, district_name, lat, lng)
join public.governorates g on g.code = p.gov_code
left join public.districts d on d.governorate_id = g.id and d.name_ar_norm = app.normalize_arabic(p.district_name)
where not exists (
  select 1 from public.places existing
  where existing.name_ar_norm = app.normalize_arabic(p.name_ar)
    and existing.kind = p.kind
);

-- ---------------------------------------------------------------------------
-- A first region, so the region builder and supervisor screens are not empty shells
-- (platform staff can rename or delete it; it demonstrates governorates + extra districts)
-- ---------------------------------------------------------------------------

insert into public.regions (kind, name_ar, name_en, description)
select 'region', 'إقليم عدن والساحل', 'Aden & the Coast',
       'مثال تمهيدي: محافظتا عدن ولحج مع بعض المديريات.'
where not exists (select 1 from public.regions where name_ar_norm = app.normalize_arabic('إقليم عدن والساحل'));

insert into public.region_governorates (region_id, governorate_id)
select r.id, g.id
from public.regions r
join public.governorates g on g.code in ('YE-AD', 'YE-LA')
where r.name_ar_norm = app.normalize_arabic('إقليم عدن والساحل')
on conflict do nothing;

insert into public.region_districts (region_id, district_id)
select r.id, d.id
from public.regions r
join public.districts d on d.name_ar_norm = app.normalize_arabic('المكلا')
where r.name_ar_norm = app.normalize_arabic('إقليم عدن والساحل')
on conflict do nothing;
