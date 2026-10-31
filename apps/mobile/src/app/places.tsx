import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getLocales } from 'expo-localization';
import {
  EMPTY_SELECTION,
  isLocale,
  isSelectionComplete,
  negotiateLocale,
  rankPlaces,
  reducePicker,
  translate,
  type Locale,
  type PlaceKind,
  type PlaceRef,
  type PickerSelection,
  type TranslationKey,
} from '@maak/core';
import { getMobileClient } from '../lib/supabase';

interface GovernorateRow {
  id: string;
  name_ar: string;
  name_en: string;
}

interface DistrictRow {
  id: string;
  governorate_id: string;
  name_ar: string;
  name_en: string;
}

interface PlaceRow {
  id: string;
  kind: string;
  name_ar: string;
  name_en: string | null;
  governorate_id: string | null;
  district_id: string | null;
  lat: number | null;
  lng: number | null;
  is_public: boolean;
}

/**
 * Place picker on native.
 *
 * The state machine (`reducePicker`) and the ranking (`rankPlaces`) are the *same functions* web and
 * edge use — this screen is only the native rendering of them. Without a configured project it
 * falls back to a small built-in set, so the screen is reviewable offline.
 */
const FALLBACK_GOVERNORATES: GovernorateRow[] = [
  { id: 'g-aden', name_ar: 'عدن', name_en: 'Aden' },
  { id: 'g-sanaa', name_ar: 'صنعاء', name_en: "Sana'a" },
  { id: 'g-mukalla', name_ar: 'حضرموت', name_en: 'Hadramaut' },
];

const FALLBACK_DISTRICTS: DistrictRow[] = [
  { id: 'd-crater', governorate_id: 'g-aden', name_ar: 'كريتر', name_en: 'Crater' },
  { id: 'd-mansura', governorate_id: 'g-aden', name_ar: 'المنصورة', name_en: 'Al Mansura' },
  { id: 'd-old', governorate_id: 'g-sanaa', name_ar: 'صنعاء القديمة', name_en: "Old Sana'a" },
  { id: 'd-mukalla', governorate_id: 'g-mukalla', name_ar: 'المكلا', name_en: 'Mukalla' },
];

const FALLBACK_PLACES: PlaceRef[] = [
  {
    id: 'p-aden',
    kind: 'city',
    nameAr: 'عدن',
    nameEn: 'Aden',
    governorateId: 'g-aden',
    districtId: 'd-crater',
    lat: 12.7855,
    lng: 45.0187,
    isPublic: true,
    aliasesAr: ['عدن الصغرى'],
  },
  {
    id: 'p-station',
    kind: 'station',
    nameAr: 'موقف عدن المركزي',
    nameEn: 'Aden Central Station',
    governorateId: 'g-aden',
    districtId: 'd-crater',
    lat: 12.7799,
    lng: 45.0345,
    isPublic: true,
  },
  {
    id: 'p-sanaa',
    kind: 'city',
    nameAr: 'صنعاء',
    nameEn: "Sana'a",
    governorateId: 'g-sanaa',
    districtId: 'd-old',
    lat: 15.3694,
    lng: 44.191,
    isPublic: true,
  },
  {
    id: 'p-mukalla',
    kind: 'city',
    nameAr: 'المكلا',
    nameEn: 'Mukalla',
    governorateId: 'g-mukalla',
    districtId: 'd-mukalla',
    lat: 14.5421,
    lng: 49.1242,
    isPublic: true,
  },
];

export default function PlacesScreen() {
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0] ?? '')
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey) => translate(locale, key);
  const isRtl = locale === 'ar';
  const align = { textAlign: isRtl ? ('right' as const) : ('left' as const) };

  const [loading, setLoading] = useState(true);
  const [governorates, setGovernorates] = useState<GovernorateRow[]>(FALLBACK_GOVERNORATES);
  const [districts, setDistricts] = useState<DistrictRow[]>(FALLBACK_DISTRICTS);
  const [places, setPlaces] = useState<PlaceRef[]>(FALLBACK_PLACES);
  const [selection, setSelection] = useState<PickerSelection>(EMPTY_SELECTION);
  const [query, setQuery] = useState('');
  const [offline, setOffline] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const supabase = getMobileClient();
      if (!supabase) {
        setLoading(false);
        return;
      }
      const [govResult, distResult, placeResult] = await Promise.all([
        supabase.from('governorates').select('id, name_ar, name_en').eq('is_active', true),
        supabase
          .from('districts')
          .select('id, governorate_id, name_ar, name_en')
          .eq('is_active', true),
        supabase
          .from('places')
          .select('id, kind, name_ar, name_en, governorate_id, district_id, lat, lng, is_public')
          .eq('is_active', true)
          .limit(300),
      ]);
      if (cancelled) return;

      if (govResult.data && govResult.data.length > 0) {
        setGovernorates(govResult.data as GovernorateRow[]);
        setDistricts((distResult.data ?? []) as DistrictRow[]);
        setPlaces(
          ((placeResult.data ?? []) as PlaceRow[]).map((row) => ({
            id: row.id,
            kind: row.kind as PlaceKind,
            nameAr: row.name_ar,
            nameEn: row.name_en,
            governorateId: row.governorate_id,
            districtId: row.district_id,
            lat: row.lat,
            lng: row.lng,
            isPublic: row.is_public,
          })),
        );
        setOffline(false);
      }
      setLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const districtOptions = useMemo(
    () => districts.filter((district) => district.governorate_id === selection.governorateId),
    [districts, selection.governorateId],
  );

  const results = useMemo(
    () =>
      rankPlaces(query, places, {
        governorateId: selection.governorateId ?? undefined,
        districtId: selection.districtId ?? undefined,
        limit: 8,
      }),
    [places, query, selection.districtId, selection.governorateId],
  );

  const complete = isSelectionComplete(selection);
  const chosen = places.find((place) => place.id === selection.placeId);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={[styles.title, align]}>{t('picker.title')}</Text>
      <Text style={[styles.hint, align]}>
        {offline ? t('geo.previewNotice') : t('geo.subtitle')}
      </Text>

      {loading ? <ActivityIndicator /> : null}

      <Text style={[styles.label, align]}>{t('picker.governorate')}</Text>
      <View style={styles.chips}>
        {governorates.map((governorate) => {
          const active = selection.governorateId === governorate.id;
          return (
            <Pressable
              key={governorate.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() =>
                setSelection((current) =>
                  reducePicker(current, { type: 'governorate', id: governorate.id }),
                )
              }
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={active ? styles.chipTextActive : styles.chipText}>
                {locale === 'ar' ? governorate.name_ar : governorate.name_en}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {districtOptions.length > 0 ? (
        <>
          <Text style={[styles.label, align]}>{t('picker.district')}</Text>
          <View style={styles.chips}>
            {districtOptions.map((district) => {
              const active = selection.districtId === district.id;
              return (
                <Pressable
                  key={district.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() =>
                    setSelection((current) =>
                      reducePicker(current, { type: 'district', id: district.id }),
                    )
                  }
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={active ? styles.chipTextActive : styles.chipText}>
                    {locale === 'ar' ? district.name_ar : district.name_en}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}

      <Text style={[styles.label, align]}>{t('places.search')}</Text>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={t('places.searchPlaceholder')}
        style={[styles.input, align]}
        accessibilityLabel={t('places.search')}
      />

      {results.length === 0 ? (
        <Text style={[styles.hint, align]}>{t('places.noResults')}</Text>
      ) : null}

      {results.map((place) => {
        const active = selection.placeId === place.id;
        return (
          <Pressable
            key={place.id}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() =>
              setSelection((current) => reducePicker(current, { type: 'place', id: place.id }))
            }
            style={[styles.result, active && styles.resultActive]}
          >
            <Text style={align}>
              {locale === 'ar' ? place.nameAr : (place.nameEn ?? place.nameAr)}
            </Text>
            <Text style={styles.resultKind}>{place.kind}</Text>
          </Pressable>
        );
      })}

      <View style={[styles.summary, complete ? styles.summaryComplete : null]}>
        <Text style={align}>
          {complete
            ? `${t('picker.place')}: ${chosen ? (locale === 'ar' ? chosen.nameAr : (chosen.nameEn ?? chosen.nameAr)) : (selection.customName ?? '')}`
            : t('picker.required')}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 10 },
  title: { fontSize: 22, fontWeight: '800' },
  hint: { color: '#5b6472', fontSize: 13 },
  label: { fontWeight: '700', marginTop: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#c8d0dc',
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  chipActive: { backgroundColor: '#0b7a5a', borderColor: '#0b7a5a' },
  chipText: { color: '#243040' },
  chipTextActive: { color: '#ffffff' },
  input: { borderWidth: 1, borderColor: '#c8d0dc', borderRadius: 10, padding: 10 },
  result: { borderWidth: 1, borderColor: '#e1e6ee', borderRadius: 10, padding: 10, gap: 2 },
  resultActive: { borderColor: '#0b7a5a', backgroundColor: '#eaf6f2' },
  resultKind: { color: '#6b7484', fontSize: 11 },
  summary: { marginTop: 12, padding: 12, borderRadius: 10, backgroundColor: '#f3f5f8' },
  summaryComplete: { backgroundColor: '#eaf6f2' },
});
