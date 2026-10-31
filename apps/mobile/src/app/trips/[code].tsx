import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getLocales } from 'expo-localization';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  departureLabel,
  formatMinor,
  isLocale,
  negotiateLocale,
  translate,
  TRIP_GENDER_KEY,
  TRIP_PAYMENT_KEY,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { getTripDetail, type MobileTripDetail } from '../../lib/trips';

/**
 * Trip detail on native.
 *
 * Same source as the web page (`get_trip_public`), same formatting helpers, same dictionaries — the
 * screen is only the native layout. The fare shown is the one the database computed, so a per-stop trip
 * cannot advertise its cheapest stop here and its flat fare on the web.
 */
export default function TripDetailScreen() {
  const router = useRouter();
  const { code } = useLocalSearchParams<{ code: string }>();
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0])
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const rtl = locale === 'ar';

  const [trip, setTrip] = useState<MobileTripDetail | null>(null);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getTripDetail(String(code ?? ''), locale);
      if (cancelled) return;
      setTrip(result.trip);
      setConfigured(result.configured);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [code, locale]);

  if (loading) {
    return (
      <View style={styles.page}>
        <ActivityIndicator accessibilityLabel={t('common.continue')} />
      </View>
    );
  }

  if (!trip) {
    return (
      <View style={[styles.page, { direction: rtl ? 'rtl' : 'ltr' }]}>
        <Text style={styles.title}>{t('trips.detail.notFound')}</Text>
        <Pressable
          onPress={() => router.push('/trips')}
          accessibilityRole="button"
          style={styles.back}
        >
          <Text style={styles.backText}>{t('trips.search.title')}</Text>
        </Pressable>
      </View>
    );
  }

  const when = departureLabel(trip.departureAt, locale);

  return (
    <ScrollView contentContainerStyle={[styles.page, { direction: rtl ? 'rtl' : 'ltr' }]}>
      <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.back}>
        <Text style={styles.backText}>← {t('common.back')}</Text>
      </Pressable>

      <Text style={styles.code}>{trip.code}</Text>
      <Text style={styles.title}>
        {trip.origin.name} ← {trip.destination.name}
      </Text>
      <Text style={styles.hint}>
        {when.date} · {when.time}
      </Text>
      {!configured ? <Text style={styles.hint}>{t('verification.notConfigured')}</Text> : null}

      {/* Phase 8: the person on that bus is the one at the pump. The code carries through so the fill can
          be named against this trip; the id lookup happens server-side. */}
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push(`/driver/fuel?trip=${trip.code}`)}
        style={styles.card}
      >
        <Text style={styles.primaryText}>{t('fleetOps.logFuel')}</Text>
      </Pressable>

      <View style={styles.card}>
        <Row label={t('trips.vehicle')} value={trip.vehicleLabel ?? '—'} />
        <Row
          label={t('trips.seats')}
          value={t('trips.seatsAvailable', { count: trip.seatsAvailable })}
        />
        <Row
          label={t('trips.genderPolicy')}
          value={t(TRIP_GENDER_KEY[trip.genderPolicy] ?? 'trips.gender.any')}
        />
        <Row
          label={t('trips.paymentPolicy')}
          value={t(TRIP_PAYMENT_KEY[trip.paymentPolicy] ?? 'trips.payment.cash')}
        />
        {trip.arriveEstimateMinutes > 0 ? (
          <Row
            label={t('trips.arriveEstimate')}
            value={t('trips.minutes', { count: trip.arriveEstimateMinutes })}
          />
        ) : null}
        {trip.fareTotalMinor != null ? (
          <Row
            label={t('trips.pricePerSeat')}
            value={formatMinor(trip.fareTotalMinor, 'YER', { locale })}
            strong
          />
        ) : null}
      </View>

      <Text style={styles.label}>{t('trips.stops')}</Text>
      {trip.stops.length === 0 ? (
        <Text style={styles.hint}>{t('trips.search.direct')}</Text>
      ) : (
        trip.stops.map((stop) => (
          <View key={`${stop.seq}-${stop.name}`} style={styles.stop}>
            <Text style={styles.stopSeq}>{stop.seq}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.stopName}>{stop.name}</Text>
              <Text style={styles.hint}>
                {t('trips.stopOffsetValue', { minutes: stop.arriveOffsetMinutes })}
                {stop.priceFromOriginYer != null
                  ? ` · ${formatMinor(stop.priceFromOriginYer, 'YER', { locale })}`
                  : ''}
              </Text>
            </View>
          </View>
        ))
      )}

      {trip.notes ? <Text style={styles.hint}>{trip.notes}</Text> : null}

      <View style={styles.card}>
        <Row label={t('trips.detail.operator')} value={trip.operatorName ?? '—'} />
        {trip.operatorVerified ? (
          <Text style={styles.verified}>{t('trips.detail.operatorVerified')}</Text>
        ) : null}
      </View>

      {trip.seatsAvailable >= 1 ? (
        <Pressable
          onPress={() => router.push(`/book/${trip.code}`)}
          accessibilityRole="button"
          style={styles.primary}
        >
          <Text style={styles.primaryText}>{t('trips.detail.bookCta')}</Text>
        </Pressable>
      ) : (
        <Text style={styles.hint}>{t('bookings.noSeatsLeft')}</Text>
      )}
    </ScrollView>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={strong ? styles.rowValueStrong : styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 8 },
  back: { minHeight: 44, justifyContent: 'center' },
  backText: { color: '#0b7a5a', fontWeight: '700' },
  code: { color: '#5b6472', fontSize: 12, letterSpacing: 1 },
  title: { fontSize: 20, fontWeight: '800' },
  hint: { color: '#5b6472', fontSize: 13 },
  label: { fontWeight: '700', marginTop: 12 },
  card: { borderWidth: 1, borderColor: '#e1e6ee', borderRadius: 12, padding: 12, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowLabel: { color: '#5b6472', fontSize: 13 },
  rowValue: { fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  rowValueStrong: { fontSize: 15, fontWeight: '800', flexShrink: 1, textAlign: 'right' },
  stop: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 6 },
  stopSeq: {
    width: 24,
    textAlign: 'center',
    fontWeight: '800',
    color: '#0b7a5a',
  },
  stopName: { fontWeight: '600' },
  verified: { color: '#0b7a5a', fontSize: 12, fontWeight: '700' },
  primary: {
    marginTop: 16,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#0b7a5a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: '#ffffff', fontWeight: '800', fontSize: 16 },
});
