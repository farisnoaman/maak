import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { getLocales } from 'expo-localization';
import {
  DRIVE_TYPE_KEY,
  FUEL_TYPE_KEY,
  TRANSMISSION_KEY,
  VEHICLE_BODY_TYPE_KEY,
  isLocale,
  isVehicleOperational,
  negotiateLocale,
  translate,
  vehicleBadges,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { getMobileClient } from '../../../lib/supabase';

interface VehicleRow {
  id: string;
  make: string;
  model: string;
  model_year: number;
  plate_number: string;
  body_type: string;
  fuel_type: string;
  drive_type: string | null;
  transmission: string | null;
  seats_passenger: number;
  odometer_km: number;
  status: string;
  verification_status: string;
  insurance_expiry: string | null;
  inspection_expiry: string | null;
  registration_expiry: string | null;
  transport_permit_expiry: string | null;
}

/**
 * The driver's quick view of the vehicle they are assigned to.
 *
 * Read-only by design: a driver confirms what they are about to drive, they do not edit the fleet. The
 * "may it be used" answer comes from `isVehicleOperational()` — the same function Phase 4 will call
 * before a trip can start, so the phone cannot promise a trip the server would refuse.
 */
export default function DriverVehicleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0] ?? '')
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const align = { textAlign: locale === 'ar' ? ('right' as const) : ('left' as const) };

  const [loading, setLoading] = useState(true);
  const [vehicle, setVehicle] = useState<VehicleRow | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      router.replace('/sign-in');
      return;
    }

    // RLS does the real work: this returns a row only if the caller is the assigned driver (or staff).
    const { data, error: queryError } = await supabase
      .from('vehicles')
      .select(
        'id, make, model, model_year, plate_number, body_type, fuel_type, drive_type, transmission, seats_passenger, odometer_km, status, verification_status, insurance_expiry, inspection_expiry, registration_expiry, transport_permit_expiry',
      )
      .eq('id', id)
      .maybeSingle();

    if (queryError) setError(queryError.message);
    setVehicle((data as VehicleRow | null) ?? null);
    setLoading(false);
  }, [id, router, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={styles.hint}>{t('common.loading')}</Text>
      </View>
    );
  }

  if (!vehicle) {
    return (
      <View style={styles.center}>
        <Text style={styles.name}>{t('errors.NOT_FOUND')}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.link} onPress={() => router.replace('/driver/profile')}>
          {t('fleet.driverProfile')}
        </Text>
      </View>
    );
  }

  const badges = vehicleBadges(vehicle);
  const operational = isVehicleOperational(vehicle);

  const rows: [TranslationKey, string][] = [
    ['fleet.modelYear', String(vehicle.model_year)],
    ['fleet.plateNumber', vehicle.plate_number],
    ['fleet.bodyType', t(VEHICLE_BODY_TYPE_KEY[vehicle.body_type] ?? 'fleet.bodyOther')],
    ['fleet.fuelType', t(FUEL_TYPE_KEY[vehicle.fuel_type] ?? 'fleet.fuelOther')],
    [
      'fleet.driveType',
      vehicle.drive_type
        ? t(DRIVE_TYPE_KEY[vehicle.drive_type] ?? 'fleet.unknown')
        : t('fleet.unknown'),
    ],
    [
      'fleet.transmission',
      vehicle.transmission
        ? t(TRANSMISSION_KEY[vehicle.transmission] ?? 'fleet.unknown')
        : t('fleet.unknown'),
    ],
    ['fleet.seatsPassenger', String(vehicle.seats_passenger)],
    ['fleet.odometerKm', String(vehicle.odometer_km)],
  ];

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={[styles.title, align]}>
        {vehicle.make} {vehicle.model}
      </Text>
      <Text style={[styles.plate, align]}>{vehicle.plate_number}</Text>

      <View style={styles.badges}>
        {badges.map((badge) => (
          <View
            key={`${badge.code}-${badge.days ?? ''}`}
            style={[
              styles.badge,
              badge.tone === 'ok'
                ? styles.badgeOk
                : badge.tone === 'bad'
                  ? styles.badgeBad
                  : styles.badgeWarn,
            ]}
          >
            <Text style={styles.badgeText}>
              {t(
                badge.labelKey,
                badge.days === undefined ? undefined : { days: Math.abs(badge.days) },
              )}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.card}>
        {rows.map(([key, value]) => (
          <View key={key} style={styles.row}>
            <Text style={[styles.hint, align]}>{t(key)}</Text>
            <Text style={[styles.value, align]}>{value}</Text>
          </View>
        ))}
      </View>

      <Text style={[styles.hint, align]}>
        {operational ? t('fleet.operational') : t('fleet.warningVehicleUnverified')}
      </Text>
      <Text style={[styles.hint, align]}>{t('fleet.tripComingSoon')}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  title: { fontSize: 24, fontWeight: '800' },
  plate: { fontSize: 16, fontWeight: '700', letterSpacing: 1 },
  name: { fontSize: 17, fontWeight: '700' },
  hint: { fontSize: 13, opacity: 0.65 },
  value: { fontSize: 14, fontWeight: '600' },
  link: { fontSize: 14, fontWeight: '700', color: '#0d7a5f' },
  card: {
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#fff',
    gap: 8,
    borderWidth: 1,
    borderColor: '#ececec',
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  badges: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#eef2f0',
  },
  badgeOk: { backgroundColor: '#e9f6ee' },
  badgeWarn: { backgroundColor: '#fdf3e2' },
  badgeBad: { backgroundColor: '#fdeaea' },
  badgeText: { fontSize: 12, fontWeight: '700' },
  error: { color: '#8c1d1d', fontSize: 13 },
});
