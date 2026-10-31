import { useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getLocales } from 'expo-localization';
import {
  departureLabel,
  isLocale,
  negotiateLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { getMobileClient } from '../../lib/supabase';

type ScanTrip = {
  id: string;
  code: string;
  status: string;
  departureAt: string;
  seatsTotal: number;
  bookedSeats: number;
  origin: string | null;
  destination: string | null;
  operatorName: string | null;
  vehicleLabel: string | null;
  driverName: string | null;
};

type ScanAnswer =
  { allowed: true; trip: ScanTrip } | { allowed: false; reason: string; code?: string | null };

const WEB_BASE = process.env.EXPO_PUBLIC_WEB_URL ?? '';

/**
 * The trip check, on a phone.
 *
 * A supervisor at a checkpoint has a phone, not a laptop, so the scan has to work here. It calls
 * `staff_scan` — the same session-bound read the web page calls — which is why this screen has no scope
 * logic of its own: the database decides, the phone only displays.
 *
 * There is no camera here. `expo-camera` is not in this build, and a native module that has never been
 * run on a device is worse than a text field that has: the 24-character token is printed under every QR
 * on the manifest for exactly this reason. Adding the camera is a `expo-camera` install plus a
 * `CameraView` with `barcodeScannerSettings`, and it belongs in a change that can be tested on hardware.
 */
export default function StaffScanScreen() {
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0])
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ScanAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    const trimmed = token.trim();
    if (trimmed === '') return;
    const client = getMobileClient();
    if (!client) {
      setError(t('errors.INTERNAL'));
      return;
    }

    setBusy(true);
    setError(null);
    setAnswer(null);

    const { data, error: rpcError } = await client.rpc('staff_scan', { p_token: trimmed });
    setBusy(false);

    if (rpcError) {
      // `42501` is the honest answer for "you are not staff"; anything else is a real failure.
      setError(/staff/i.test(rpcError.message) ? t('errors.FORBIDDEN') : t('errors.INTERNAL'));
      return;
    }

    const value = (data ?? {}) as Record<string, unknown>;
    if (value.allowed === true) {
      setAnswer({ allowed: true, trip: value.trip as ScanTrip });
      return;
    }

    const trip = (value.trip ?? null) as { code?: string } | null;
    setAnswer({
      allowed: false,
      reason: String(value.reason ?? 'NOT_FOUND'),
      code: trip?.code ?? null,
    });
  }

  const refusal =
    answer && !answer.allowed
      ? answer.reason === 'OUT_OF_SCOPE'
        ? { title: t('ops.outOfScope'), body: t('ops.outOfScopeBody') }
        : answer.reason === 'RATE_LIMITED'
          ? { title: t('ops.rateLimited'), body: t('ops.rateLimitedBody') }
          : { title: t('ops.notFound'), body: t('ops.notFoundBody') }
      : null;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.title}>{t('ops.scanTitle')}</Text>
      <Text style={styles.hint}>{t('ops.scanHint')}</Text>

      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={24}
        placeholder="000000000000000000000000"
        placeholderTextColor="#999"
        // The token is Latin hex: it must not be reordered by an RTL keyboard.
        textAlign="left"
      />
      <Pressable
        accessibilityRole="button"
        onPress={() => void scan()}
        disabled={busy || token.trim() === ''}
        style={[styles.button, (busy || token.trim() === '') && styles.buttonDisabled]}
      >
        <Text style={styles.buttonText}>{busy ? '…' : t('ops.scanSubmit')}</Text>
      </Pressable>

      {busy ? <ActivityIndicator /> : null}

      {error ? (
        <Text accessibilityRole="alert" style={styles.deny}>
          {error}
        </Text>
      ) : null}

      {refusal ? (
        <View style={styles.card}>
          <Text style={styles.deny}>{refusal.title}</Text>
          <Text style={styles.body}>{refusal.body}</Text>
          {answer && !answer.allowed && answer.code ? (
            <Text style={styles.code}>{answer.code}</Text>
          ) : null}
        </View>
      ) : null}

      {answer && answer.allowed ? (
        <View style={styles.card}>
          <Text style={styles.code}>{answer.trip.code}</Text>
          <Text style={styles.body}>
            {answer.trip.origin ?? '—'} → {answer.trip.destination ?? '—'}
          </Text>
          <Text style={styles.body}>
            {departureLabel(answer.trip.departureAt, locale).date} ·{' '}
            {departureLabel(answer.trip.departureAt, locale).time}
          </Text>
          <Text style={styles.body}>
            {t('ops.occupancyValue', {
              booked: answer.trip.bookedSeats,
              total: answer.trip.seatsTotal,
            })}
          </Text>
          <Text style={styles.body}>{answer.trip.operatorName ?? '—'}</Text>
          <Text style={styles.body}>
            {answer.trip.vehicleLabel ?? '—'} · {answer.trip.driverName ?? '—'}
          </Text>
          {WEB_BASE ? (
            <Pressable
              accessibilityRole="link"
              onPress={() =>
                void Linking.openURL(`${WEB_BASE}/${locale}/staff/trips/${answer.trip.id}/manifest`)
              }
            >
              <Text style={styles.link}>{t('ops.manifest')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { gap: 12, padding: 20 },
  title: { fontSize: 22, fontWeight: '700' },
  hint: { fontSize: 14, color: '#555' },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    letterSpacing: 2,
    fontFamily: 'monospace',
  },
  button: {
    backgroundColor: '#0b6b3a',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  card: { gap: 6, borderWidth: 1, borderColor: '#e2e2e2', borderRadius: 12, padding: 16 },
  code: { fontFamily: 'monospace', fontSize: 18, fontWeight: '700' },
  body: { fontSize: 15 },
  deny: { fontSize: 16, fontWeight: '700', color: '#a3231b' },
  link: { marginTop: 8, fontSize: 15, fontWeight: '700', color: '#0b6b3a' },
});
