import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { getLocales } from 'expo-localization';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  BOOKING_STATUS_KEY,
  bookingTone,
  departureLabel,
  formatMinor,
  ID_TYPE_KEY,
  isLocale,
  isPassengerCancellable,
  negotiateLocale,
  translate,
  type BookingStatus,
  type Locale,
  type TranslationKey,
  errorKey,
} from '@maak/core';
import {
  cancelBooking,
  createShareLink,
  loadBooking,
  setPassengerDocument,
  uploadPassengerId,
  type MobileBooking,
  type MobilePassengerDocument,
} from '../../lib/bookings';

const ID_TYPES = ['national_id', 'passport', 'iqama', 'other'] as const;

/**
 * One booking, on native: the ticket, the cancellation, and the ID the operator needs to see.
 *
 * The ticket is the booking code, large, with the departure beside it. There is deliberately no QR
 * renderer here yet: drawing one needs a native SVG module, and adding a native dependency to the app
 * shell is a release decision, not a screen decision — the operator can type a six-character code, and the
 * web ticket already carries a scannable QR.
 */
export default function BookingDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0])
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const rtl = locale === 'ar';

  const [booking, setBooking] = useState<MobileBooking | null>(null);
  const [document, setDocument] = useState<MobilePassengerDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Identity form
  const [idType, setIdType] = useState<(typeof ID_TYPES)[number]>('national_id');
  const [idNumber, setIdNumber] = useState('');
  const [birthPlace, setBirthPlace] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [photoPath, setPhotoPath] = useState<string | null>(null);

  const refresh = async (bookingId: string) => {
    const result = await loadBooking(bookingId);
    setBooking(result.booking);
    setDocument(result.document);
    if (result.document) {
      setIdType((result.document.idType as (typeof ID_TYPES)[number]) ?? 'national_id');
      setIdNumber(result.document.idNumber);
      setBirthPlace(result.document.birthPlace ?? '');
      setBirthDate(result.document.birthDate ?? '');
      setPhotoPath(result.document.photoPath);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (id) void refresh(String(id));
  }, [id]);

  if (loading) {
    return (
      <View style={styles.page}>
        <ActivityIndicator accessibilityLabel={t('common.loading')} />
      </View>
    );
  }

  if (!booking) {
    return (
      <View style={[styles.page, { direction: rtl ? 'rtl' : 'ltr' }]}>
        <Text style={styles.title}>{t('bookings.empty')}</Text>
        <Pressable
          onPress={() => router.replace('/bookings')}
          accessibilityRole="button"
          style={styles.primary}
        >
          <Text style={styles.primaryText}>{t('bookings.myTitle')}</Text>
        </Pressable>
      </View>
    );
  }

  const when = booking.trip ? departureLabel(booking.trip.departureAt, locale) : null;
  const live = booking.status === 'pending' || booking.status === 'accepted';

  const confirmCancel = () => {
    Alert.alert(t('bookings.cancel'), t('bookings.cancelConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('bookings.cancelYes'),
        style: 'destructive',
        onPress: () => void doCancel(),
      },
    ]);
  };

  const doCancel = async () => {
    setBusy(true);
    setError(null);
    const result = await cancelBooking({
      action: 'booking.cancelByPassenger',
      bookingId: booking.id,
      reason: null,
    });
    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    await refresh(booking.id);
    setNotice(t('bookings.cancel'));
  };

  const shareWithOperator = async () => {
    setBusy(true);
    setError(null);
    const result = await createShareLink({ action: 'booking.shareLink', bookingId: booking.id });
    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    const path = (result.data as { path?: string }).path ?? '';
    // A share link is only useful as an absolute URL. `EXPO_PUBLIC_SITE_URL` is the web origin the app is
    // paired with; without it the raw path is still sent, rather than a guessed domain.
    const site = process.env.EXPO_PUBLIC_SITE_URL?.replace(/\/$/, '');
    const url = site ? `${site}${path}` : path;
    const message = `${t('bookings.shareId')} — ${booking.code}\n${url}`;
    const whatsapp = `whatsapp://send?text=${encodeURIComponent(message)}`;
    try {
      await Linking.openURL(whatsapp);
    } catch {
      setNotice(url);
    }
  };

  const takePhoto = async () => {
    setError(null);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      const picked = await ImagePicker.launchImageLibraryAsync({ quality: 0.6 });
      if (!picked.canceled && picked.assets[0]) {
        upload(picked.assets[0].uri);
      }
      return;
    }
    const shot = await ImagePicker.launchCameraAsync({ quality: 0.6 });
    if (!shot.canceled && shot.assets[0]) upload(shot.assets[0].uri);
  };

  const upload = async (uri: string) => {
    setBusy(true);
    const result = await uploadPassengerId(uri, booking.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPhotoPath(result.path);
    setNotice(t('common.upload'));
  };

  const saveIdentity = async () => {
    setBusy(true);
    setError(null);
    const result = await setPassengerDocument({
      action: 'booking.setDocument',
      bookingId: booking.id,
      idType,
      idNumber: idNumber.trim(),
      birthPlace: birthPlace.trim() ? birthPlace.trim() : null,
      birthDate: birthDate.trim() ? birthDate.trim() : null,
      photoPath,
    });
    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    await refresh(booking.id);
    setNotice(t('common.save'));
  };

  return (
    <ScrollView contentContainerStyle={[styles.page, { direction: rtl ? 'rtl' : 'ltr' }]}>
      <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.back}>
        <Text style={styles.backText}>← {t('bookings.myTitle')}</Text>
      </Pressable>

      <Text style={styles.title}>
        {booking.trip
          ? `${booking.trip.originName ?? ''} ← ${booking.trip.destinationName ?? ''}`
          : booking.code}
      </Text>
      <Text style={[styles.badge, toneStyle(bookingTone(booking.status))]}>
        {t(BOOKING_STATUS_KEY[booking.status as BookingStatus] ?? 'bookings.status.pending')}
      </Text>

      {live ? (
        <View style={styles.card}>
          <Text style={styles.label}>{t('bookings.ticket')}</Text>
          <Text style={styles.code}>{booking.code}</Text>
          <Text style={styles.hint}>{t('bookings.ticketHint')}</Text>
        </View>
      ) : null}

      {live && booking.paymentStatus !== 'paid' ? (
        <View style={styles.card}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: true }}
            disabled
            style={[styles.secondary, styles.secondaryOff]}
          >
            <Text style={styles.secondaryText}>{t('bookings.uploadReceipt')}</Text>
          </Pressable>
          <Text style={styles.hint}>{t('bookings.receiptPending')}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Row label={t('bookings.departure')} value={when ? `${when.date} · ${when.time}` : '—'} />
        <Row label={t('bookings.seats')} value={String(booking.seats)} />
        <Row label={t('bookings.total')} value={formatMinor(booking.totalYer, 'YER', { locale })} />
        <Row
          label={t('bookings.paymentStatus')}
          value={t(`bookings.payment.${booking.paymentStatus}` as TranslationKey)}
        />
      </View>

      {booking.rejectReason ? (
        <Text style={styles.error}>
          {t('bookings.rejectedReason')}: {booking.rejectReason}
        </Text>
      ) : null}
      {booking.cancelReason ? (
        <Text style={styles.hint}>
          {t('bookings.cancelReason')}: {booking.cancelReason}
        </Text>
      ) : null}
      {booking.refundYer > 0 ? (
        <Text style={styles.hint}>
          {t('bookings.refundDue', { amount: formatMinor(booking.refundYer, 'YER', { locale }) })}
        </Text>
      ) : null}

      {live ? (
        <>
          <Pressable
            onPress={() => void shareWithOperator()}
            disabled={busy}
            accessibilityRole="button"
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>{t('bookings.shareWhatsApp')}</Text>
          </Pressable>

          <Text style={styles.label}>{t('bookings.shareId')}</Text>
          <Text style={styles.hint}>{t('bookings.shareExplain')}</Text>

          <View style={styles.chips}>
            {ID_TYPES.map((value) => (
              <Pressable
                key={value}
                onPress={() => setIdType(value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: idType === value }}
                style={[styles.chip, idType === value ? styles.chipOn : null]}
              >
                <Text style={idType === value ? styles.chipTextOn : styles.chipText}>
                  {t(ID_TYPE_KEY[value] ?? 'bookings.id.other')}
                </Text>
              </Pressable>
            ))}
          </View>

          <TextInput
            value={idNumber}
            onChangeText={setIdNumber}
            accessibilityLabel={t('bookings.idNumber')}
            style={[styles.input, { textAlign: rtl ? 'right' : 'left' }]}
          />
          <TextInput
            value={birthPlace}
            onChangeText={setBirthPlace}
            accessibilityLabel={t('bookings.birthPlace')}
            style={styles.input}
          />
          <TextInput
            value={birthDate}
            onChangeText={setBirthDate}
            accessibilityLabel={t('bookings.birthDate')}
            placeholder="YYYY-MM-DD"
            style={[styles.input, { textAlign: rtl ? 'right' : 'left' }]}
          />

          <Pressable
            onPress={() => void takePhoto()}
            accessibilityRole="button"
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>
              {photoPath ? `${t('common.upload')} ✓` : t('bookings.idPhoto')}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => void saveIdentity()}
            disabled={busy || idNumber.trim().length < 4}
            accessibilityRole="button"
            style={[styles.primary, busy || idNumber.trim().length < 4 ? styles.primaryOff : null]}
          >
            <Text style={styles.primaryText}>{t('common.save')}</Text>
          </Pressable>

          {isPassengerCancellable(booking.status) ? (
            <Pressable
              onPress={confirmCancel}
              disabled={busy}
              accessibilityRole="button"
              style={styles.danger}
            >
              <Text style={styles.dangerText}>{t('bookings.cancel')}</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      {notice ? <Text style={styles.hint}>{notice}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {document ? <Text style={styles.hint}>{t('bookings.idSaved')}</Text> : null}
    </ScrollView>
  );
}

function toneStyle(tone: string) {
  switch (tone) {
    case 'success':
      return { backgroundColor: '#e5f4ee', color: '#0b7a5a' };
    case 'warning':
      return { backgroundColor: '#fdf1dc', color: '#8a5a00' };
    case 'danger':
      return { backgroundColor: '#fbe9e7', color: '#b3261e' };
    default:
      return { backgroundColor: '#eef1f5', color: '#3b4452' };
  }
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 8 },
  back: { minHeight: 44, justifyContent: 'center' },
  backText: { color: '#0b7a5a', fontWeight: '700' },
  title: { fontSize: 20, fontWeight: '800' },
  hint: { color: '#5b6472', fontSize: 13 },
  label: { fontWeight: '700', marginTop: 8 },
  code: { fontSize: 28, fontWeight: '800', letterSpacing: 3 },
  card: { borderWidth: 1, borderColor: '#e1e6ee', borderRadius: 12, padding: 12, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowLabel: { color: '#5b6472', fontSize: 13 },
  rowValue: { fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: '700',
    overflow: 'hidden',
  },
  input: {
    borderWidth: 1,
    borderColor: '#c9d2dd',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 44,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#c9d2dd',
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: '#0b7a5a', borderColor: '#0b7a5a' },
  chipText: { fontWeight: '600' },
  chipTextOn: { fontWeight: '700', color: '#ffffff' },
  error: { color: '#b3261e', fontSize: 13, fontWeight: '600' },
  primary: {
    marginTop: 12,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#0b7a5a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryOff: { backgroundColor: '#9fb3ac' },
  primaryText: { color: '#ffffff', fontWeight: '800', fontSize: 16 },
  secondary: {
    marginTop: 12,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#0b7a5a',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  // A control that exists to be discoverable, not to be used yet: still 44pt, visibly inert.
  secondaryOff: { borderColor: '#c9d2dd', opacity: 0.6 },
  secondaryText: { color: '#0b7a5a', fontWeight: '700' },
  danger: {
    marginTop: 12,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#b3261e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerText: { color: '#b3261e', fontWeight: '700' },
});
