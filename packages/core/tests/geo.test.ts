import { describe, expect, it } from 'vitest';
import {
  boundingBox,
  descendantRegionIds,
  EMPTY_SELECTION,
  expandCoverage,
  formatDistanceKm,
  haversineKm,
  inScope,
  isSelectionComplete,
  isWithinYemen,
  isValidLatitude,
  isValidLongitude,
  normalizeArabic,
  rankPlaces,
  reducePicker,
  scorePlace,
  supervisorScope,
  trigramSimilarity,
  USER_CREATABLE_KINDS,
  validateCoverage,
  type DistrictRef,
  type GovernorateRef,
  type PlaceRef,
  type RegionNode,
} from '../src/domain/geo';

const place = (over: Partial<PlaceRef> = {}): PlaceRef => ({
  id: 'p1',
  kind: 'city',
  nameAr: 'عدن',
  nameEn: 'Aden',
  governorateId: 'g-aden',
  districtId: 'd-crater',
  lat: 12.7855,
  lng: 45.0187,
  isPublic: true,
  ...over,
});

describe('Arabic normalisation', () => {
  it('folds alef, teh marbuta, alef maqsura, hamza carriers', () => {
    expect(normalizeArabic('أحمد')).toBe('احمد');
    expect(normalizeArabic('إب')).toBe('اب');
    expect(normalizeArabic('آمن')).toBe('امن');
    expect(normalizeArabic('ٱلله')).toBe('الله');
    expect(normalizeArabic('مكّة')).toBe('مكه');
    expect(normalizeArabic('مصطفى')).toBe('مصطفي');
    expect(normalizeArabic('مؤمن')).toBe('مومن');
    expect(normalizeArabic('قائد')).toBe('قايد');
  });

  it('strips diacritics and tatweel', () => {
    expect(normalizeArabic('عَـدَن')).toBe('عدن');
    expect(normalizeArabic('صَنْعَاء')).toBe('صنعاء');
  });

  it('folds Arabic-Indic digits and collapses whitespace', () => {
    expect(normalizeArabic('شارع ٥')).toBe('شارع 5');
    expect(normalizeArabic('  حي   الشيخ   عثمان ')).toBe('حي الشيخ عثمان');
  });

  it('lowercases Latin and handles empty input', () => {
    expect(normalizeArabic('AL MUKALLA')).toBe('al mukalla');
    expect(normalizeArabic(null)).toBe('');
    expect(normalizeArabic('   ')).toBe('');
  });

  it('treats the same place written three ways as one key', () => {
    const variants = ['عدن', 'عَدَنْ', 'عـدن', 'أدن'.replace('أ', 'ع')];
    const keys = new Set(variants.map(normalizeArabic));
    expect(keys.size).toBe(1);
  });
});

describe('trigram similarity and ranking', () => {
  it('scores an exact match above a prefix above a substring', () => {
    const aden = place();
    expect(scorePlace('عدن', aden)).toBeGreaterThan(100); // exact text + city weight
    expect(scorePlace('عد', aden)).toBeGreaterThan(0);
    expect(scorePlace('دن', aden)).toBeGreaterThan(0);
    expect(scorePlace('عد', aden)).toBeGreaterThan(scorePlace('دن', aden));
  });

  it('matches English names and aliases', () => {
    const mukalla = place({ nameAr: 'المكلا', nameEn: 'Al Mukalla', aliasesEn: ['Mukalla'] });
    expect(scorePlace('mukalla', mukalla)).toBeGreaterThan(0);
    expect(scorePlace('المكلا', mukalla)).toBeGreaterThan(0);
  });

  it('returns zero for an unrelated query', () => {
    expect(scorePlace('zzzzz', place())).toBe(0);
    expect(scorePlace('', place())).toBe(0);
  });

  it('computes Jaccard trigram similarity symmetrically', () => {
    expect(trigramSimilarity('عدن', 'عدن')).toBe(1);
    expect(trigramSimilarity('عدن', 'صنعاء')).toBeLessThan(0.3);
    expect(trigramSimilarity('', 'عدن')).toBe(0);
  });

  it('ranks, filters and caps the result list', () => {
    const places = [
      place({ id: 'c', kind: 'station', nameAr: 'عدن', governorateId: 'g-aden' }),
      place({ id: 'a', kind: 'city', nameAr: 'عدن', governorateId: 'g-aden' }),
      place({ id: 'b', kind: 'city', nameAr: 'صنعاء', governorateId: 'g-sanaa' }),
      place({
        id: 'd',
        kind: 'town',
        nameAr: 'عدن الصغرى',
        governorateId: 'g-aden',
        districtId: 'd-tawahi',
      }),
    ];

    const all = rankPlaces('عدن', places).map((entry) => entry.id);
    expect(all[0]).toBe('a'); // city beats station at equal text
    expect(all).not.toContain('b');

    expect(rankPlaces('عدن', places, { governorateId: 'g-aden', limit: 2 }).length).toBe(2);
    expect(rankPlaces('عدن', places, { districtId: 'd-tawahi' }).map((p) => p.id)).toEqual(['d']);
    expect(rankPlaces('عدن', places, { kind: 'station' }).map((p) => p.id)).toEqual(['c']);
  });
});

describe('distance', () => {
  it('measures Sana’a → Aden (~300 km) and a zero distance', () => {
    const sanaa = { lat: 15.3694, lng: 44.191 };
    const aden = { lat: 12.7855, lng: 45.0187 };
    expect(haversineKm(sanaa, aden)).toBeGreaterThan(280);
    expect(haversineKm(sanaa, aden)).toBeLessThan(330);
    expect(haversineKm(sanaa, sanaa)).toBe(0);
  });

  it('formats distances in both directions', () => {
    expect(formatDistanceKm(12.44, 'en')).toBe('12 km');
    expect(formatDistanceKm(3.14159, 'en')).toBe('3.1 km');
    expect(formatDistanceKm(12.44, 'ar')).toContain('كم');
    expect(formatDistanceKm(0, 'ar')).toContain('0');
  });

  it('validates coordinates and the country bounding box', () => {
    expect(isValidLatitude(12.7)).toBe(true);
    expect(isValidLatitude(91)).toBe(false);
    expect(isValidLatitude(Number.NaN)).toBe(false);
    expect(isValidLongitude(45)).toBe(true);
    expect(isValidLongitude(-200)).toBe(false);
    expect(isWithinYemen({ lat: 12.79, lng: 45.02 })).toBe(true);
    expect(isWithinYemen({ lat: 45.02, lng: 12.79 })).toBe(false); // swapped
    expect(isWithinYemen({ lat: 0, lng: 0 })).toBe(false);
  });

  it('computes a bounding box and refuses an empty one', () => {
    expect(
      boundingBox([
        { lat: 12, lng: 44 },
        { lat: 15, lng: 49 },
      ]),
    ).toEqual({
      minLat: 12,
      maxLat: 15,
      minLng: 44,
      maxLng: 49,
    });
    expect(boundingBox([])).toBeNull();
    expect(boundingBox([{ lat: 99, lng: 999 }])).toBeNull();
  });
});

describe('region coverage', () => {
  const governorates: GovernorateRef[] = [
    { id: 'g-aden', code: 'YE-AD', nameAr: 'عدن', nameEn: 'Aden' },
    { id: 'g-sanaa', code: 'YE-SA', nameAr: 'صنعاء', nameEn: 'Sanaa' },
    { id: 'g-taiz', code: 'YE-TA', nameAr: 'تعز', nameEn: 'Taiz' },
  ];
  const districts: DistrictRef[] = [
    { id: 'd-crater', governorateId: 'g-aden', nameAr: 'كريتر', nameEn: 'Crater' },
    { id: 'd-tawahi', governorateId: 'g-aden', nameAr: 'التواهي', nameEn: 'Tawahi' },
    { id: 'd-sanaa', governorateId: 'g-sanaa', nameAr: 'صنعاء القديمة', nameEn: 'Old Sanaa' },
    { id: 'd-taiz', governorateId: 'g-taiz', nameAr: 'المظفر', nameEn: 'Al Mudhaffar' },
  ];

  it('accepts governorates plus extra districts from elsewhere', () => {
    expect(
      validateCoverage(
        { governorateIds: ['g-sanaa', 'g-taiz'], districtIds: ['d-crater'] },
        governorates,
        districts,
      ),
    ).toEqual([]);
  });

  it('rejects an empty region', () => {
    expect(
      validateCoverage({ governorateIds: [], districtIds: [] }, governorates, districts)[0]?.code,
    ).toBe('EMPTY');
  });

  it('rejects unknown and misplaced ids', () => {
    expect(
      validateCoverage({ governorateIds: ['g-nope'], districtIds: [] }, governorates, districts)[0]
        ?.code,
    ).toBe('UNKNOWN_GOVERNORATE');
    expect(
      validateCoverage({ governorateIds: [], districtIds: ['d-nope'] }, governorates, districts)[0]
        ?.code,
    ).toBe('UNKNOWN_DISTRICT');
  });

  it('expands whole governorates to their districts without duplicates', () => {
    const expanded = expandCoverage(
      { governorateIds: ['g-aden'], districtIds: ['d-crater', 'd-taiz'] },
      districts,
    );
    expect(expanded.sort()).toEqual(['d-crater', 'd-taiz', 'd-tawahi']);
  });
});

describe('regions, sub-regions and supervisor scope', () => {
  const districts: DistrictRef[] = [
    { id: 'd-crater', governorateId: 'g-aden', nameAr: 'كريتر', nameEn: 'Crater' },
    { id: 'd-tawahi', governorateId: 'g-aden', nameAr: 'التواهي', nameEn: 'Tawahi' },
    { id: 'd-sanaa', governorateId: 'g-sanaa', nameAr: 'صنعاء القديمة', nameEn: 'Old Sanaa' },
    { id: 'd-taiz', governorateId: 'g-taiz', nameAr: 'المظفر', nameEn: 'Al Mudhaffar' },
  ];

  const regions: RegionNode[] = [
    {
      id: 'r-highlands',
      parentId: null,
      nameAr: 'إقليم المرتفعات',
      nameEn: 'Highlands',
      kind: 'region',
      coverage: { governorateIds: ['g-sanaa', 'g-taiz'], districtIds: [] },
    },
    {
      id: 'r-highlands-south',
      parentId: 'r-highlands',
      nameAr: 'مرتفعات الجنوب',
      nameEn: 'Southern Highlands',
      kind: 'sub_region',
      coverage: { governorateIds: [], districtIds: ['d-taiz'] },
    },
    {
      id: 'r-coast',
      parentId: null,
      nameAr: 'إقليم الساحل',
      nameEn: 'Coast',
      kind: 'region',
      coverage: { governorateIds: ['g-aden'], districtIds: [] },
    },
  ];

  it('walks the region tree once, cycle-safe', () => {
    expect(descendantRegionIds(regions, 'r-highlands')).toEqual(['r-highlands-south']);
    expect(descendantRegionIds(regions, 'r-coast')).toEqual([]);

    const cyclic: RegionNode[] = [
      { ...regions[0]!, id: 'a', parentId: 'b', coverage: { governorateIds: [], districtIds: [] } },
      { ...regions[0]!, id: 'b', parentId: 'a', coverage: { governorateIds: [], districtIds: [] } },
    ];
    expect(descendantRegionIds(cyclic, 'a')).toEqual(['b']);
  });

  it('gives a supervisor the districts of a region and its sub-regions', () => {
    const scope = supervisorScope(regions, ['r-highlands'], districts);
    expect(scope.sort()).toEqual(['d-sanaa', 'd-taiz']);
  });

  it('unions several assigned regions', () => {
    const scope = supervisorScope(regions, ['r-highlands', 'r-coast'], districts);
    expect(scope.sort()).toEqual(['d-crater', 'd-sanaa', 'd-taiz', 'd-tawahi']);
  });

  it('gives an unassigned supervisor nothing at all', () => {
    expect(supervisorScope(regions, [], districts)).toEqual([]);
    expect(inScope('d-crater', [])).toBe(false);
    expect(inScope(null, ['d-crater'])).toBe(false);
    expect(inScope('d-crater', ['d-crater'])).toBe(true);
  });
});

describe('picker state machine', () => {
  it('clears the district and place when the governorate changes', () => {
    const selected = reducePicker(EMPTY_SELECTION, { type: 'governorate', id: 'g-aden' });
    const withDistrict = reducePicker(selected, { type: 'district', id: 'd-crater' });
    const moved = reducePicker(withDistrict, { type: 'governorate', id: 'g-sanaa' });

    expect(moved.governorateId).toBe('g-sanaa');
    expect(moved.districtId).toBeNull();
    expect(moved.placeId).toBeNull();
  });

  it('keeps a custom name and a place mutually exclusive', () => {
    const custom = reducePicker(EMPTY_SELECTION, { type: 'custom', name: 'نقطة تجمع المسجد' });
    expect(custom.customName).toBe('نقطة تجمع المسجد');

    const picked = reducePicker(custom, { type: 'place', id: 'p1' });
    expect(picked.placeId).toBe('p1');
    expect(picked.customName).toBeNull();

    const back = reducePicker(picked, { type: 'custom', name: 'اسم آخر' });
    expect(back.placeId).toBeNull();
  });

  it('resets completely', () => {
    const selected = reducePicker(
      reducePicker(EMPTY_SELECTION, { type: 'governorate', id: 'g-aden' }),
      { type: 'district', id: 'd-crater' },
    );
    expect(reducePicker(selected, { type: 'reset' })).toEqual(EMPTY_SELECTION);
  });

  it('is complete only with a place or a meaningful custom name', () => {
    expect(isSelectionComplete(EMPTY_SELECTION)).toBe(false);
    expect(isSelectionComplete({ ...EMPTY_SELECTION, placeId: 'p1' })).toBe(true);
    expect(isSelectionComplete({ ...EMPTY_SELECTION, customName: 'حي' })).toBe(false);
    expect(isSelectionComplete({ ...EMPTY_SELECTION, customName: 'باب اليمن' })).toBe(true);
  });

  it('lets users create only the kinds they are allowed to', () => {
    expect(USER_CREATABLE_KINDS).toContain('gathering_point');
    expect(USER_CREATABLE_KINDS).not.toContain('city');
  });
});
