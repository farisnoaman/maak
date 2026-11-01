import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getLocales } from 'expo-localization';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  departureLabel,
  formatMinor,
  isLocale,
  negotiateLocale,
  readTripFilters,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import {
  filtersFromState,
  searchTrips,
  type MobileFacet,
  type MobileTripCard,
} from '../../lib/trips';

/**
 * Trip search on native.
 *
 * One scrollable result list, a search field pinned above it, and a filter *sheet* rather than a sidebar —
 * a phone has no room for a persistent 16rem column, and a sheet keeps the filters one thumb-tap away
 * without hiding the results. Everything the sheet sends goes through `publicTripsArgs`, the same builder
 * the web marketplace uses, so «بدون توقف» filters the same trips in both clients.
 *
 * Cursors are kept in state: an infinite list that re-fetches page one on every keystroke is the usual
 * way a search screen starts dropping rows.
 */
export default function TripsScreen() {
  const router = useRouter();
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0])
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const rtl = locale === 'ar';

  // A saved-search alert links to `/trips?<the same filters>`; `readTripFilters` is the parser the web page
  // uses, so the app opens the search the person saved rather than an empty list. The signature is the
  // dependency, not the params object: expo-router hands a fresh object on every render, and an effect keyed
  // on it would reset the filters under the person's fingers.
  const params = useLocalSearchParams();
  const signature = JSON.stringify(params);
  const seed = useMemo(
    () => readTripFilters(JSON.parse(signature) as Record<string, string | string[] | undefined>),
    [signature],
  );

  const [q, setQ] = useState(seed.q ?? '');
  const [direct, setDirect] = useState(seed.direct ?? false);
  const [gender, setGender] = useState<'any' | 'women_only' | 'men_only' | null>(null);
  const [origin, setOrigin] = useState<string | null>(seed.origin?.[0] ?? null);
  const [destination, setDestination] = useState<string | null>(seed.destination?.[0] ?? null);
  const [sort, setSort] = useState<'soonest' | 'cheapest' | 'featured'>(seed.sort ?? 'soonest');

  // A second tap on a different alert while this screen is already open arrives as new params on a live
  // screen, so the seed has to be applied, not just read once.
  useEffect(() => {
    setQ(seed.q ?? '');
    setDirect(seed.direct ?? false);
    setOrigin(seed.origin?.[0] ?? null);
    setDestination(seed.destination?.[0] ?? null);
    if (seed.sort) setSort(seed.sort);
    const policy = seed.gender?.[0];
    setGender(policy === 'women_only' || policy === 'men_only' ? policy : null);
  }, [seed]);

  const [items, setItems] = useState<readonly MobileTripCard[]>([]);
  const [origins, setOrigins] = useState<readonly MobileFacet[]>([]);
  const [destinations, setDestinations] = useState<readonly MobileFacet[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);

  const filters = useMemo(
    () =>
      filtersFromState({
        q: q.trim() === '' ? undefined : q.trim(),
        direct: direct || undefined,
        gender: gender ? [gender] : undefined,
        origin: origin ? [origin] : undefined,
        destination: destination ? [destination] : undefined,
      }),
    [q, direct, gender, origin, destination],
  );

  const load = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      setLoading(true);
      const result = await searchTrips(locale, filters, { sort, cursor: nextCursor, limit: 12 });
      setConfigured(result.configured);
      setTotal(result.total);
      setCursor(result.nextCursor);
      setOrigins(result.origins);
      setDestinations(result.destinations);
      setItems((current) => (append ? [...current, ...result.items] : result.items));
      setLoading(false);
    },
    [filters, locale, sort],
  );

  // One request per settled filter change: the 250 ms debounce is about typing, not about the network.
  useEffect(() => {
    const timer = setTimeout(() => {
      void load(null, false);
    }, 250);
    return () => clearTimeout(timer);
  }, [load]);

  const activeFilters =
    (direct ? 1 : 0) + (gender ? 1 : 0) + (origin ? 1 : 0) + (destination ? 1 : 0);

  return (
    <View style={[styles.page, { direction: rtl ? 'rtl' : 'ltr' }]}>
      <Text style={styles.title}>{t('trips.search.title')}</Text>
      <Text style={styles.hint}>{t('trips.search.subtitle')}</Text>

      <View style={styles.searchRow}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder={t('trips.search.q')}
          style={[styles.input, styles.searchInput, { textAlign: rtl ? 'right' : 'left' }]}
          accessibilityLabel={t('trips.search.q')}
          returnKeyType="search"
        />
        <Pressable
          onPress={() => setSheetOpen(true)}
          style={styles.filterButton}
          accessibilityRole="button"
          accessibilityLabel={
            activeFilters > 0
              ? `${t('trips.search.filter')} (${activeFilters})`
              : t('trips.search.filter')
          }
        >
          <Text style={styles.filterButtonText}>
            {t('trips.search.filter')}
            {activeFilters > 0 ? ` · ${activeFilters}` : ''}
          </Text>
        </Pressable>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        {(['soonest', 'cheapest', 'featured'] as const).map((value) => (
          <Pressable
            key={value}
            onPress={() => setSort(value)}
            style={[styles.chip, sort === value && styles.chipActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: sort === value }}
          >
            <Text style={sort === value ? styles.chipTextActive : styles.chipText}>
              {t(`trips.sort.${value}` as TranslationKey)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {!configured ? <Text style={styles.hint}>{t('verification.notConfigured')}</Text> : null}
      <Text style={styles.hint}>{t('trips.search.results', { count: total })}</Text>

      {loading && items.length === 0 ? (
        <ActivityIndicator accessibilityLabel={t('common.continue')} />
      ) : (
        <FlatList
          data={items as MobileTripCard[]}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (cursor && !loading) void load(cursor, true);
          }}
          ListEmptyComponent={<Text style={styles.hint}>{t('trips.search.noResults')}</Text>}
          renderItem={({ item }) => {
            const when = departureLabel(item.departureAt, locale);
            return (
              <Pressable
                onPress={() => router.push(`/trips/${item.code}`)}
                style={styles.card}
                accessibilityRole="button"
                accessibilityLabel={`${item.origin.name} ← ${item.destination.name}، ${when.date} ${when.time}`}
              >
                <View style={styles.cardHead}>
                  <Text style={styles.cardRoute}>
                    {item.origin.name} ← {item.destination.name}
                  </Text>
                  {item.isFeatured ? (
                    <Text style={styles.badge}>{t('trips.badgeFeatured')}</Text>
                  ) : null}
                  {item.seatsAvailable > 0 && item.seatsAvailable <= 2 ? (
                    <Text style={[styles.badge, styles.badgeWarn]}>
                      {t('trips.badgeLastSeats')}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.cardMeta}>
                  {when.date} · {when.time} ·{' '}
                  {t('trips.seatsAvailable', { count: item.seatsAvailable })}
                </Text>
                <Text style={styles.cardMeta}>
                  {item.operatorName ?? '—'} · {item.vehicleLabel ?? '—'}
                  {item.stopCount === 0 ? ` · ${t('trips.search.direct')}` : ''}
                </Text>
                <Text style={styles.price}>
                  {item.priceFromYer == null
                    ? '—'
                    : formatMinor(item.priceFromYer, 'YER', { locale })}{' '}
                  <Text style={styles.priceUnit}>{t('trips.pricePerSeat')}</Text>
                </Text>
              </Pressable>
            );
          }}
        />
      )}

      <Modal visible={sheetOpen} animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <ScrollView contentContainerStyle={[styles.page, { direction: rtl ? 'rtl' : 'ltr' }]}>
          <Text style={styles.title}>{t('trips.search.filter')}</Text>

          <Text style={styles.label}>{t('trips.origin')}</Text>
          <View style={styles.chips}>
            <Chip
              label={t('trips.search.any')}
              active={origin === null}
              onPress={() => setOrigin(null)}
            />
            {origins.map((facet) => (
              <Chip
                key={facet.id}
                label={`${facet.name} (${facet.count})`}
                active={origin === facet.id}
                onPress={() => setOrigin(origin === facet.id ? null : facet.id)}
              />
            ))}
          </View>

          <Text style={styles.label}>{t('trips.destination')}</Text>
          <View style={styles.chips}>
            <Chip
              label={t('trips.search.any')}
              active={destination === null}
              onPress={() => setDestination(null)}
            />
            {destinations.map((facet) => (
              <Chip
                key={facet.id}
                label={`${facet.name} (${facet.count})`}
                active={destination === facet.id}
                onPress={() => setDestination(destination === facet.id ? null : facet.id)}
              />
            ))}
          </View>

          <Text style={styles.label}>{t('trips.genderPolicy')}</Text>
          <View style={styles.chips}>
            <Chip
              label={t('trips.search.any')}
              active={gender === null}
              onPress={() => setGender(null)}
            />
            {(['any', 'women_only', 'men_only'] as const).map((value) => (
              <Chip
                key={value}
                label={t(`trips.gender.${value}` as TranslationKey)}
                active={gender === value}
                onPress={() => setGender(gender === value ? null : value)}
              />
            ))}
          </View>

          <Text style={styles.label}>{t('trips.search.direct')}</Text>
          <View style={styles.chips}>
            <Chip
              label={t('trips.search.direct')}
              active={direct}
              onPress={() => setDirect((current) => !current)}
            />
          </View>

          <View style={styles.sheetActions}>
            <Pressable
              onPress={() => {
                setDirect(false);
                setGender(null);
                setOrigin(null);
                setDestination(null);
                setSheetOpen(false);
              }}
              style={[styles.chip, styles.clear]}
              accessibilityRole="button"
            >
              <Text style={styles.chipText}>{t('trips.search.clear')}</Text>
            </Pressable>
            <Pressable
              onPress={() => setSheetOpen(false)}
              style={[styles.chip, styles.chipActive]}
              accessibilityRole="button"
            >
              <Text style={styles.chipTextActive}>{t('common.continue')}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </Modal>
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={active ? styles.chipTextActive : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 10, flex: 1 },
  title: { fontSize: 22, fontWeight: '800' },
  hint: { color: '#5b6472', fontSize: 13 },
  searchRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  searchInput: { flex: 1 },
  input: { borderWidth: 1, borderColor: '#c8d0dc', borderRadius: 10, padding: 10 },
  filterButton: {
    borderWidth: 1,
    borderColor: '#0b7a5a',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: 'center',
  },
  filterButtonText: { color: '#0b7a5a', fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#c8d0dc',
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  clear: { borderColor: '#c8d0dc' },
  chipActive: { backgroundColor: '#0b7a5a', borderColor: '#0b7a5a' },
  chipText: { color: '#243040' },
  chipTextActive: { color: '#ffffff' },
  label: { fontWeight: '700', marginTop: 12 },
  list: { gap: 10, paddingBottom: 40 },
  card: { borderWidth: 1, borderColor: '#e1e6ee', borderRadius: 12, padding: 12, gap: 4 },
  cardHead: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  cardRoute: { fontSize: 16, fontWeight: '700' },
  cardMeta: { color: '#5b6472', fontSize: 13 },
  badge: {
    backgroundColor: '#eaf6f2',
    color: '#0b7a5a',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 11,
    overflow: 'hidden',
  },
  badgeWarn: { backgroundColor: '#fff4e5', color: '#9a5b00' },
  price: { fontSize: 15, fontWeight: '800', marginTop: 4 },
  priceUnit: { fontSize: 12, fontWeight: '400', color: '#5b6472' },
  sheetActions: { flexDirection: 'row', gap: 8, marginTop: 20 },
});
