import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { getLocales } from 'expo-localization';
import * as ImagePicker from 'expo-image-picker';
import {
  DRIVER_STATUS_KEY,
  VERIFICATION_KEY,
  errorKey,
  fleetCommandSpec,
  isLocale,
  negotiateLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { getApiClient, isBackendConfigured, uploadDriverLicence } from '../../lib/api';
import { getMobileClient } from '../../lib/supabase';

interface DriverRow {
  id: string;
  full_name: string;
  invited_phone: string;
  licence_no: string | null;
  licence_expiry: string | null;
  licence_photo_path: string | null;
  status: string;
  verification_status: string;
  verification_note: string | null;
}

interface AssignmentRow {
  vehicle_id: string;
  vehicles: { make: string; model: string; model_year: number; plate_number: string } | null;
}

/**
 * The driver's own screen on the phone.
 *
 * A driver is invited by phone, so this screen is where an invitation becomes an account: `driver.accept`
 * links the invited row to the signed-in user, and from then on the assigned vehicle appears below. The
 * verification badge is read from the database, never inferred locally — the same rule as web.
 */
export default function DriverProfileScreen() {
  const router = useRouter();
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0] ?? '')
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const align = { textAlign: locale === 'ar' ? ('right' as const) : ('left' as const) };

  const [loading, setLoading] = useState(true);
  const [driver, setDriver] = useState<DriverRow | null>(null);
  const [assignment, setAssignment] = useState<AssignmentRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = getMobileClient();
    if (!supabase) {
      setLoading(false);
      setError(t('verification.notConfigured'));
      return;
    }
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) {
      setLoading(false);
      router.replace('/sign-in');
      return;
    }

    // Two rows can matter here and they are not the same: the profile already bound to this account, and an
    // *unbound invitation* addressed to this phone. The screen used to query only the first, so an invited
    // driver — whose row has `user_id = null` until they accept — could never see the accept button that
    // this screen exists to show. RLS (00018) narrows the second case to invitations for this number.
    const { data: driverRows } = await supabase
      .from('driver_profiles')
      .select(
        'id, full_name, invited_phone, licence_no, licence_expiry, licence_photo_path, status, verification_status, verification_note',
      )
      .or(`user_id.eq.${userId},and(user_id.is.null,status.eq.invited)`)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1);
    const row = (driverRows?.[0] as DriverRow | undefined) ?? null;
    setDriver(row);

    if (row) {
      const { data: assignmentRows } = await supabase
        .from('vehicle_driver_assignments')
        .select('vehicle_id, vehicles(make, model, model_year, plate_number)')
        .eq('driver_id', row.id)
        .is('unassigned_at', null)
        .limit(1);
      setAssignment((assignmentRows?.[0] as AssignmentRow | undefined) ?? null);
    } else {
      setAssignment(null);
    }
    setLoading(false);
  }, [router, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function accept() {
    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await client.call(fleetCommandSpec, { action: 'driver.accept' } as never);
    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code as never)));
      return;
    }
    setNotice(t('fleet.accepted'));
    void load();
  }

  /**
   * Photograph the licence, push it to private storage, then record the path through the one command
   * that may write it. The order matters: the command refuses a path to a file that was never uploaded,
   * so a failed upload cannot leave a driver "verified" against a document that does not exist.
   */
  async function captureLicence() {
    const client = getApiClient();
    if (!client || !driver) {
      setError(t('verification.notConfigured'));
      return;
    }

    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError(t('errors.FORBIDDEN'));
      return;
    }
    const shot = await ImagePicker.launchCameraAsync({ quality: 0.7, allowsEditing: false });
    if (shot.canceled || !shot.assets[0]) return;

    setPhotoBusy(true);
    setError(null);
    setNotice(null);

    const upload = await uploadDriverLicence(shot.assets[0].uri);
    if (!upload.ok) {
      setPhotoBusy(false);
      setError(t('errors.NETWORK'));
      return;
    }

    const result = await client.call(fleetCommandSpec, {
      action: 'driver.setLicence',
      driverId: driver.id,
      licenceNo: driver.licence_no,
      licenceExpiry: driver.licence_expiry,
      photoPath: upload.path,
    } as never);
    setPhotoBusy(false);

    if (!result.ok) {
      setError(t(errorKey(result.error.code as never)));
      return;
    }
    setNotice(t('fleet.licenceUploaded'));
    void load();
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={styles.hint}>{t('common.loading')}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={[styles.title, align]}>{t('fleet.driverProfile')}</Text>
      <Text style={[styles.hint, align]}>{t('fleet.driverProfileSubtitle')}</Text>

      {!isBackendConfigured() ? (
        <Text style={[styles.error, align]}>{t('verification.notConfigured')}</Text>
      ) : null}

      {driver ? (
        <View style={styles.card}>
          <Text style={[styles.name, align]}>{driver.full_name}</Text>
          <Text style={[styles.hint, align]}>{driver.invited_phone}</Text>
          <Text style={[styles.hint, align]}>
            {t('fleet.driverLicence')}: {driver.licence_no ?? t('fleet.unknown')}
            {driver.licence_expiry ? ` · ${driver.licence_expiry}` : ''}
          </Text>
          <View style={styles.badges}>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {t(DRIVER_STATUS_KEY[driver.status] ?? 'fleet.driverInvited')}
              </Text>
            </View>
            <View
              style={[
                styles.badge,
                driver.verification_status === 'verified' ? styles.badgeOk : styles.badgeWarn,
              ]}
            >
              <Text style={styles.badgeText}>
                {t(VERIFICATION_KEY[driver.verification_status] ?? 'fleet.badgeUnverified')}
              </Text>
            </View>
          </View>
          {driver.status === 'invited' ? (
            <Pressable style={styles.primary} onPress={() => void accept()} disabled={busy}>
              <Text style={styles.primaryText}>{t('fleet.acceptInvite')}</Text>
            </Pressable>
          ) : null}

          <Text style={[styles.hint, align]}>
            {driver.licence_photo_path
              ? t('fleet.licenceUploaded')
              : t('fleet.licencePhotoMissing')}
          </Text>
          <Pressable
            style={styles.secondary}
            onPress={() => void captureLicence()}
            disabled={photoBusy}
            accessibilityRole="button"
            accessibilityLabel={t('fleet.uploadLicence')}
          >
            <Text style={styles.secondaryText}>
              {photoBusy ? t('common.loading') : t('fleet.uploadLicence')}
            </Text>
          </Pressable>
          <Text style={[styles.hint, align]}>{t('fleet.licenceNeedsReview')}</Text>
          {driver.verification_note ? (
            <Text style={[styles.error, align]}>
              {t('fleet.rejectReason')}: {driver.verification_note}
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={[styles.name, align]}>{t('fleet.noDriverProfile')}</Text>
          <Text style={[styles.hint, align]}>{t('fleet.driverInvitePending')}</Text>
        </View>
      )}

      <Text style={[styles.section, align]}>{t('fleet.currentDriver')}</Text>
      {assignment?.vehicles ? (
        <Pressable
          style={styles.card}
          onPress={() => router.push(`/driver/vehicle/${assignment.vehicle_id}`)}
        >
          <Text style={[styles.name, align]}>
            {assignment.vehicles.make} {assignment.vehicles.model} ·{' '}
            {assignment.vehicles.model_year}
          </Text>
          <Text style={[styles.hint, align]}>{assignment.vehicles.plate_number}</Text>
          <Text style={[styles.link, align]}>{t('fleet.viewVehicle')}</Text>
        </Pressable>
      ) : (
        <Text style={[styles.hint, align]}>{t('fleet.noDriver')}</Text>
      )}

      {notice ? <Text style={[styles.success, align]}>{notice}</Text> : null}
      {error ? <Text style={[styles.error, align]}>{error}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  title: { fontSize: 24, fontWeight: '800' },
  section: { fontSize: 16, fontWeight: '700', marginTop: 12 },
  name: { fontSize: 17, fontWeight: '700' },
  hint: { fontSize: 13, opacity: 0.65 },
  link: { fontSize: 13, fontWeight: '700', color: '#0d7a5f' },
  card: {
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#fff',
    gap: 6,
    borderWidth: 1,
    borderColor: '#ececec',
  },
  badges: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#eef2f0',
  },
  badgeOk: { backgroundColor: '#e9f6ee' },
  badgeWarn: { backgroundColor: '#fdf3e2' },
  badgeText: { fontSize: 12, fontWeight: '700' },
  primary: {
    marginTop: 6,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#0d7a5f',
    alignItems: 'center',
  },
  primaryText: { color: '#fff', fontWeight: '700' },
  secondary: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#0d7a5f',
    alignItems: 'center',
  },
  secondaryText: { color: '#0d7a5f', fontWeight: '700' },
  success: { color: '#0a6550', fontSize: 13, fontWeight: '700' },
  error: { color: '#8c1d1d', fontSize: 13 },
});
