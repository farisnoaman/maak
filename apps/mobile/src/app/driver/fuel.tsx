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
import { useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { getLocales } from 'expo-localization';
import {
  errorKey,
  fleetCommandSpec,
  isLocale,
  negotiateLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { getApiClient, isBackendConfigured, uploadVehicleOpsFile } from '../../lib/api';
import { getMobileClient } from '../../lib/supabase';

interface AssignedVehicle {
  id: string;
  make: string;
  model: string;
  plate_number: string;
  odometer_km: number;
}

/**
 * Fuel and odometer, from the phone of the person standing next to the van.
 *
 * This is the screen the phase exists for: the driver is at the pump, not at a laptop, and a fill that
 * is logged in the evening is a fill that arrives with the wrong odometer reading. Everything the screen
 * needs to know about the vehicle comes from the driver's own assignment (`vehicle_driver_assignments`
 * through RLS), so it cannot be pointed at somebody else's van by editing a field.
 *
 * It calls the `fleet` gateway, not the SQL: `cmd_log_fuel` is service-role only, and the edge function
 * is where the policy check and the rate limit live. Same body as the web form — one schema in
 * `@maak/core`, deliberately.
 */
export default function DriverFuelScreen() {
  // Arriving from a trip screen carries the trip code, so the fill is attributed to the run it fuelled.
  const { trip } = useLocalSearchParams<{ trip?: string }>();
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0] ?? '')
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const align = { textAlign: locale === 'ar' ? ('right' as const) : ('left' as const) };

  const [loading, setLoading] = useState(true);
  const [vehicle, setVehicle] = useState<AssignedVehicle | null>(null);
  const [mode, setMode] = useState<'fuel' | 'odometer'>('fuel');
  const [odometer, setOdometer] = useState('');
  const [litres, setLitres] = useState('');
  const [price, setPrice] = useState('');
  const [fullTank, setFullTank] = useState(true);
  const [station, setStation] = useState('');
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [anomaly, setAnomaly] = useState(false);

  const load = useCallback(async () => {
    const supabase = getMobileClient();
    if (!supabase) {
      setLoading(false);
      setError(t('verification.notConfigured'));
      return;
    }
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user?.id) {
      setLoading(false);
      setError(t('errors.UNAUTHENTICATED'));
      return;
    }

    // The assignment is the authorisation: a driver sees exactly the vehicle they were put on.
    const { data, error: queryError } = await supabase
      .from('vehicle_driver_assignments')
      .select('vehicle_id, vehicles(id, make, model, plate_number, odometer_km)')
      .is('unassigned_at', null)
      .order('assigned_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    setLoading(false);
    if (queryError) {
      setError(t('errors.INTERNAL'));
      return;
    }
    const row = (data as { vehicles?: AssignedVehicle | null } | null)?.vehicles ?? null;
    setVehicle(row);
    if (row) setOdometer(String(row.odometer_km));
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The receipt, photographed where it is printed.
   *
   * `launchCameraAsync` only after the OS permission is granted, exactly like the verification screen —
   * and the upload happens *before* the command, because `cmd_log_fuel` stores the object path it is given
   * and a path that does not exist is a receipt nobody can open.
   */
  async function captureReceipt() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError(t('errors.FORBIDDEN'));
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.6, allowsEditing: false });
    if (!result.canceled && result.assets[0]) setReceipt(result.assets[0].uri);
  }

  async function submit() {
    if (!vehicle) return;
    const client = getApiClient();
    if (!client || !isBackendConfigured()) {
      setError(t('verification.notConfigured'));
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    setAnomaly(false);

    let receiptPath: string | null = null;
    if (mode === 'fuel' && receipt) {
      const uploaded = await uploadVehicleOpsFile(receipt, vehicle.id, 'receipt');
      if (!uploaded.ok) {
        setBusy(false);
        setError(t('fleetOps.photoUploadFailed'));
        return;
      }
      receiptPath = uploaded.path;
    }

    // A fill needs litres and a price; a bare reading needs neither. Two actions, one screen.
    const result =
      mode === 'fuel'
        ? await client.call(fleetCommandSpec, {
            action: 'fuel.log',
            vehicleId: vehicle.id,
            odometerKm: Number(odometer),
            litres: Number(litres),
            pricePerLitreYer: Number(price),
            isFullTank: fullTank,
            stationName: station.trim() || null,
            receiptPath,
            // The command resolves the code against *this* vehicle, so a typo cannot attribute a fill to
            // somebody else's run.
            tripCode: trip ?? null,
          } as never)
        : await client.call(fleetCommandSpec, {
            action: 'odometer.record',
            vehicleId: vehicle.id,
            odometerKm: Number(odometer),
          } as never);

    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code as never)));
      return;
    }

    const payload = result.data as { anomaly?: boolean };
    setAnomaly(payload.anomaly === true);
    setMessage(mode === 'fuel' ? t('fleetOps.fuelSaved') : t('fleetOps.readingSaved'));
    setLitres('');
    setPrice('');
    setStation('');
    setReceipt(null);
    setVehicle({ ...vehicle, odometer_km: Number(odometer) });
  }

  if (loading) {
    return (
      <View style={styles.page}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.title}>{t('fleetOps.logFuel')}</Text>
      <Text style={styles.hint}>{t('fleetOps.odometerHint')}</Text>

      {vehicle ? (
        <View style={styles.card}>
          <Text style={styles.plate}>{vehicle.plate_number}</Text>
          <Text style={styles.cardBody}>
            {vehicle.make} {vehicle.model} · {t('fleetOps.odometerNow')}: {vehicle.odometer_km}
          </Text>
        </View>
      ) : (
        <Text style={styles.hint}>{t('fleet.notAssigned')}</Text>
      )}

      <View style={styles.tabs}>
        {(['fuel', 'odometer'] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            onPress={() => setMode(value)}
            style={[styles.tab, mode === value && styles.tabActive]}
          >
            <Text style={mode === value ? styles.tabTextActive : styles.tabText}>
              {value === 'fuel' ? t('fleetOps.logFuel') : t('fleetOps.odometerTitle')}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>{t('fleet.odometerKm')}</Text>
      <TextInput
        style={[styles.input, align]}
        value={odometer}
        onChangeText={setOdometer}
        keyboardType="number-pad"
        editable={Boolean(vehicle)}
      />

      {mode === 'fuel' ? (
        <>
          <Text style={styles.label}>{t('fleetOps.litres')}</Text>
          <TextInput
            style={[styles.input, align]}
            value={litres}
            onChangeText={setLitres}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor="#999"
          />

          <Text style={styles.label}>{t('fleetOps.pricePerLitre')}</Text>
          <TextInput
            style={[styles.input, align]}
            value={price}
            onChangeText={setPrice}
            keyboardType="number-pad"
            placeholder="0"
            placeholderTextColor="#999"
          />

          <Text style={styles.label}>{t('fleetOps.station')}</Text>
          <TextInput
            style={[styles.input, align]}
            value={station}
            onChangeText={setStation}
            placeholder={t('fleetOps.stationNone')}
            placeholderTextColor="#999"
          />

          <Pressable
            accessibilityRole="button"
            onPress={() => void captureReceipt()}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>
              {receipt ? t('fleetOps.attachmentUploaded') : t('fleetOps.attachment')}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: fullTank }}
            onPress={() => setFullTank((value) => !value)}
            style={styles.check}
          >
            <Text style={styles.checkBox}>{fullTank ? '☑' : '☐'}</Text>
            <Text style={styles.checkText}>{t('fleetOps.fullTank')}</Text>
          </Pressable>
        </>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {message ? <Text style={styles.success}>{message}</Text> : null}
      {anomaly ? <Text style={styles.warning}>{t('fleetOps.anomaly')}</Text> : null}

      <Pressable
        accessibilityRole="button"
        onPress={() => void submit()}
        disabled={busy || !vehicle || odometer === '' || (mode === 'fuel' && (!litres || !price))}
        style={[
          styles.button,
          (busy || !vehicle || odometer === '' || (mode === 'fuel' && (!litres || !price))) &&
            styles.buttonDisabled,
        ]}
      >
        <Text style={styles.buttonText}>
          {busy ? '…' : mode === 'fuel' ? t('fleetOps.saveFuel') : t('fleetOps.saveReading')}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 8 },
  title: { fontSize: 22, fontWeight: '700' },
  hint: { fontSize: 13, color: '#555', lineHeight: 20 },
  card: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    gap: 4,
  },
  plate: { fontSize: 18, fontWeight: '700' },
  cardBody: { fontSize: 13, color: '#555' },
  tabs: { flexDirection: 'row', gap: 8, marginTop: 8 },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    alignItems: 'center',
  },
  tabActive: { backgroundColor: '#12352b', borderColor: '#12352b' },
  tabText: { color: '#333', fontSize: 14 },
  tabTextActive: { color: '#fff', fontSize: 14, fontWeight: '600' },
  label: { fontSize: 13, color: '#333', marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  check: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  checkBox: { fontSize: 18 },
  checkText: { fontSize: 14 },
  button: {
    marginTop: 12,
    backgroundColor: '#12352b',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  secondary: {
    marginTop: 8,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ccc',
    alignItems: 'center',
  },
  secondaryText: { color: '#12352b', fontSize: 14, fontWeight: '600' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#a01b1b', fontSize: 14 },
  success: { color: '#136138', fontSize: 14 },
  warning: { color: '#8a5a00', fontSize: 14 },
});
