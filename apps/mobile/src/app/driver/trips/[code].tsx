import { useCallback, useEffect, useState } from 'react';
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
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import {
  departureLabel,
  errorKey,
  isLocale,
  negotiateLocale,
  translate,
  tripsCommandSpec,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { getApiClient } from '../../../lib/api';
import { loadDriverTrip, type DriverTripDetail } from '../../../lib/driver';

/**
 * Running one trip, from the phone that is actually on the bus.
 *
 * The four things a driver does — start with an odometer reading, report a position, mark a stop, end with an
 * odometer reading — are the same four `cmd_*` commands the web console calls, through the same `@maak/core`
 * action builder. What is different here is only the transport: `expo-location` instead of
 * `navigator.geolocation`, because a browser tab in a pocket is suspended the moment the screen locks.
 *
 * Background cadence is deliberately *not* here. A 10-minute background task needs `expo-task-manager`, an
 * Android foreground service and an iOS "always" permission conversation, and shipping the button that
 * demonstrably works is better than shipping the cadence that silently does not. `docs/operator-guide.md` says
 * the driver taps "share position" at each stop until that lands.
 */
export default function DriverTripScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string }>();
  const code = typeof params.code === 'string' ? params.code : '';

  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0] ?? '')
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const rtl = locale === 'ar';

  const [trip, setTrip] = useState<DriverTripDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [odometer, setOdometer] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!code) return;
    const found = await loadDriverTrip(code);
    setTrip(found);
    setOdometer((current) => current || (found ? '' : ''));
    setLoading(false);
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(busyKey: string, action: Record<string, unknown>, done?: TranslationKey) {
    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(busyKey);
    setError(null);
    setNotice(null);
    const result = await client.call(tripsCommandSpec, action as never);
    setBusy(null);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    if (done) setNotice(t(done));
    await load();
  }

  async function sharePosition() {
    if (!trip) return;
    setBusy('position');
    setError(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setError(t('driver.positionDenied'));
        return;
      }
      // `Balanced` rather than `High`: a ping every so often does not need GPS-precision, and a high-accuracy
      // fix on a moving bus is the fastest way to a flat battery and a driver who turns the feature off.
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await run(
        'position',
        {
          action: 'trip.recordPing',
          tripId: trip.id,
          lat: fix.coords.latitude,
          lng: fix.coords.longitude,
          accuracyM: fix.coords.accuracy ?? null,
          recordedAt: new Date(fix.timestamp).toISOString(),
          source: 'app',
        },
        'driver.positionSent',
      );
    } catch {
      setError(t('driver.positionDenied'));
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator accessibilityLabel={t('common.loading')} />
      </View>
    );
  }

  if (!trip) {
    return (
      <View style={styles.centre}>
        <Text style={styles.emptyTitle}>{t('driver.notYours')}</Text>
        <Pressable accessibilityRole="button" onPress={() => router.replace('/driver/trips')}>
          <Text style={styles.link}>{t('driver.back')}</Text>
        </Pressable>
      </View>
    );
  }

  const running = trip.status === 'in_progress';
  const finished = trip.status === 'completed';
  const cancelled = trip.status === 'cancelled';
  const nextStop = trip.stops.find((stop) => !stop.reached);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Pressable accessibilityRole="link" onPress={() => router.replace('/driver/trips')}>
        <Text style={styles.link}>{t('driver.back')}</Text>
      </Pressable>

      <Text style={[styles.title, rtl ? styles.alignEnd : styles.alignStart]}>
        {trip.origin} → {trip.destination}
      </Text>
      <Text style={styles.code}>{trip.code}</Text>

      <View style={styles.card}>
        <Row
          label={t('driver.status')}
          value={running ? t('driver.running') : t('driver.notStarted')}
          rtl={rtl}
        />
        <Row
          label={t('driver.departure')}
          value={`${departureLabel(trip.departureAt, locale).date} · ${departureLabel(trip.departureAt, locale).time}`}
          rtl={rtl}
        />
        <Row label={t('driver.vehicle')} value={trip.vehicleLabel} rtl={rtl} />
        <Row
          label={t('driver.passengers')}
          value={t('driver.passengerCount', { count: trip.bookedSeats })}
          rtl={rtl}
        />
      </View>

      {cancelled ? <Text style={styles.hint}>{t('driver.cancelled')}</Text> : null}
      {finished ? <Text style={styles.hint}>{t('driver.completed')}</Text> : null}

      {!running && !finished && !cancelled ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{t('driver.startTitle')}</Text>
          <Text style={styles.hint}>{t('driver.startBody')}</Text>
          <TextInput
            accessibilityLabel={t('driver.odoLabel')}
            style={styles.input}
            value={odometer}
            onChangeText={setOdometer}
            keyboardType="number-pad"
            inputMode="numeric"
            placeholder={t('driver.odoLabel')}
          />
          <Button
            label={t('driver.start')}
            busy={busy === 'start'}
            onPress={() =>
              void run(
                'start',
                {
                  action: 'trip.start',
                  tripId: trip.id,
                  odoKm: Number.isFinite(Number(odometer)) ? Math.round(Number(odometer)) : 0,
                },
                'driver.running',
              )
            }
          />
        </View>
      ) : null}

      {running ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{t('driver.running')}</Text>
          <Text style={styles.hint}>{t('driver.runningBody')}</Text>
          <Button
            label={t('driver.sharePosition')}
            busy={busy === 'position'}
            onPress={() => void sharePosition()}
          />
          {nextStop ? (
            <Button
              label={t('driver.stopReached', { name: nextStop.name })}
              variant="secondary"
              busy={busy === 'stop'}
              onPress={() =>
                void run(
                  'stop',
                  { action: 'trip.stopReached', tripId: trip.id, seq: nextStop.seq },
                  'driver.stopDone',
                )
              }
            />
          ) : null}

          <Text style={styles.sectionTitle}>{t('driver.stops')}</Text>
          {trip.stops.map((stop) => (
            <View key={stop.seq} style={styles.stopRow}>
              <Text style={[styles.stopName, stop.reached ? styles.stopDone : null]}>
                {stop.name}
              </Text>
              <Text style={styles.hint}>
                {stop.reached ? '✓' : String(stop.arriveOffsetMinutes ?? '')}
              </Text>
            </View>
          ))}

          <Text style={styles.sectionTitle}>{t('driver.endTitle')}</Text>
          <Text style={styles.hint}>{t('driver.endBody')}</Text>
          <TextInput
            accessibilityLabel={t('driver.odoLabel')}
            style={styles.input}
            value={odometer}
            onChangeText={setOdometer}
            keyboardType="number-pad"
            inputMode="numeric"
            placeholder={t('driver.odoLabel')}
          />
          <Button
            label={t('driver.end')}
            busy={busy === 'end'}
            onPress={() =>
              void run(
                'end',
                {
                  action: 'trip.end',
                  tripId: trip.id,
                  odoKm: Number.isFinite(Number(odometer)) ? Math.round(Number(odometer)) : 0,
                },
                'driver.ended',
              )
            }
          />
        </View>
      ) : null}

      {notice ? (
        <Text style={styles.success} accessibilityLiveRegion="polite">
          {notice}
        </Text>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="assertive">
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function Row({ label, value, rtl }: { label: string; value: string; rtl: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, rtl ? styles.alignEnd : styles.alignStart]}>{value}</Text>
    </View>
  );
}

function Button({
  label,
  onPress,
  busy,
  variant = 'primary',
}: {
  label: string;
  onPress: () => void;
  busy: boolean;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'secondary' ? styles.buttonSecondary : null,
        pressed ? styles.pressed : null,
        busy ? styles.disabled : null,
      ]}
    >
      <Text
        style={[styles.buttonText, variant === 'secondary' ? styles.buttonTextSecondary : null]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, padding: 20, gap: 12, backgroundColor: '#ffffff' },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#ffffff',
  },
  title: { fontSize: 24, fontWeight: '800', color: '#053b30' },
  code: { fontSize: 12, color: '#8592a5' },
  // Text alignment follows the direction of the script, not the screen: `alignEnd` is the reading edge.
  alignEnd: { textAlign: 'right' },
  alignStart: { textAlign: 'left' },
  hint: { fontSize: 13, color: '#5b6b80' },
  card: { borderRadius: 16, borderWidth: 1, borderColor: '#eef2f0', padding: 16, gap: 10 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#0b1220', marginTop: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  label: { fontSize: 13, color: '#5b6b80' },
  value: { fontSize: 13, color: '#0b1220', flexShrink: 1 },
  input: {
    borderWidth: 1,
    borderColor: '#d7e0dc',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#0b1220',
  },
  button: {
    borderRadius: 12,
    backgroundColor: '#0b7a5a',
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonSecondary: { backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#0b7a5a' },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.55 },
  buttonText: { color: '#ffffff', fontWeight: '700' },
  buttonTextSecondary: { color: '#0b7a5a' },
  stopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  stopName: { fontSize: 14, color: '#0b1220', flexShrink: 1 },
  stopDone: { color: '#0b7a5a', fontWeight: '700' },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#0b1220' },
  link: { color: '#0b7a5a', fontWeight: '700', paddingVertical: 8 },
  success: { color: '#0b7a5a', fontWeight: '600' },
  error: { color: '#b42318', fontWeight: '600' },
});
