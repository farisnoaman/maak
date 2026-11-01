import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { getLocales } from 'expo-localization';
import { useRouter } from 'expo-router';
import {
  departureLabel,
  isLocale,
  negotiateLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { loadDriverTrips, type DriverTripSummary } from '../../../lib/driver';

/**
 * The driver's day, on the phone.
 *
 * This is the screen the web console could not be: a driver is standing next to a bus, not sitting at a laptop,
 * and until this existed "start the trip" meant remembering a URL. The list is deliberately short — trips that
 * are published or running, soonest first — because the driver's question is "what is next", never "what
 * happened".
 */
export default function DriverTripsScreen() {
  const router = useRouter();
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0] ?? '')
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const rtl = locale === 'ar';

  const [trips, setTrips] = useState<readonly DriverTripSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [configured, setConfigured] = useState(true);

  const load = useCallback(async () => {
    const result = await loadDriverTrips();
    setTrips(result.trips);
    setConfigured(result.configured);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator accessibilityLabel={t('common.loading')} />
      </View>
    );
  }

  return (
    <FlatList
      data={trips}
      keyExtractor={(trip) => trip.id}
      contentContainerStyle={styles.page}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load();
          }}
        />
      }
      ListHeaderComponent={
        <View style={{ gap: 6 }}>
          <Text style={[styles.title, rtl ? styles.alignEnd : styles.alignStart]}>
            {t('driver.title')}
          </Text>
          <Text style={[styles.hint, rtl ? styles.alignEnd : styles.alignStart]}>
            {t('driver.subtitle')}
          </Text>
        </View>
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>
            {configured ? t('driver.empty') : t('verification.notConfigured')}
          </Text>
          {configured ? <Text style={styles.hint}>{t('driver.emptyBody')}</Text> : null}
        </View>
      }
      renderItem={({ item }) => {
        const running = item.status === 'in_progress';
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.origin} → ${item.destination}, ${item.code}`}
            onPress={() => router.push(`/driver/trips/${item.code}`)}
            style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
          >
            <View style={styles.cardHead}>
              <Text style={styles.route}>
                {item.origin} → {item.destination}
              </Text>
              <View style={[styles.badge, running ? styles.badgeLive : styles.badgeSoon]}>
                <Text style={[styles.badgeText, running ? styles.badgeTextLive : null]}>
                  {running ? t('driver.running') : t('driver.notStarted')}
                </Text>
              </View>
            </View>
            <Text style={styles.code}>{item.code}</Text>
            <Text style={styles.hint}>
              {t('driver.departure')}: {departureLabel(item.departureAt, locale).date} ·{' '}
              {departureLabel(item.departureAt, locale).time}
            </Text>
            <Text style={styles.hint}>
              {t('driver.passengerCount', { count: item.bookedSeats })} · {item.vehicleLabel}
            </Text>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, padding: 20, gap: 12, backgroundColor: '#ffffff' },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffffff' },
  title: { fontSize: 26, fontWeight: '800', color: '#053b30' },
  hint: { fontSize: 13, color: '#5b6b80' },
  // Text alignment follows the direction of the script, not the screen: `alignEnd` is the reading edge.
  alignEnd: { textAlign: 'right' },
  alignStart: { textAlign: 'left' },
  empty: { marginTop: 32, gap: 6, alignItems: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#0b1220' },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#eef2f0',
    padding: 16,
    gap: 4,
    backgroundColor: '#ffffff',
  },
  pressed: { backgroundColor: '#f6faf8' },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  route: { fontSize: 16, fontWeight: '700', color: '#0b1220', flexShrink: 1 },
  code: { fontSize: 12, color: '#8592a5' },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeLive: { backgroundColor: '#0b7a5a' },
  badgeSoon: { backgroundColor: '#eef2f0' },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#0b1220' },
  badgeTextLive: { color: '#ffffff' },
});
