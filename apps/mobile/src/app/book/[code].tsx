import { useEffect, useState } from 'react';
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
import {
  errorKey,
  formatMinor,
  MAX_SEATS_PER_BOOKING,
  isLocale,
  negotiateLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { createBooking, tripIdByCode } from '../../lib/bookings';
import { getTripDetail, type MobileTripDetail } from '../../lib/trips';

/**
 * The booking wizard, on one screen.
 *
 * A phone at a bus stop does not scroll through seven steps: seats, who is travelling, and the price are
 * the whole decision, so they are all visible at once and the primary button stays at the bottom. The fare
 * shown is computed from the trip the server returned and then *sent back as a claim* — `booking.create`
 * recomputes it and refuses the request with `PRICE_CHANGED` if the two disagree, which is what makes it
 * safe to compute it here at all.
 */
export default function BookScreen() {
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
  const [loading, setLoading] = useState(true);
  const [seats, setSeats] = useState(1);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState<'male' | 'female' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getTripDetail(String(code ?? ''), locale).then((result) => {
      if (cancelled) return;
      setTrip(result.trip);
      setLoading(false);
    });
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
        <Text style={styles.title}>{t('bookings.closedTitle')}</Text>
        <Text style={styles.hint}>{t('bookings.closedBody')}</Text>
      </View>
    );
  }

  const wholeTrip = trip.bookingMode === 'whole_trip';
  const unit = wholeTrip ? (trip.wholeTripPriceYer ?? 0) : (trip.fareTotalMinor ?? 0);
  const total = wholeTrip ? unit : unit * seats;
  const maxSeats = Math.max(1, Math.min(MAX_SEATS_PER_BOOKING, trip.seatsAvailable));
  const needsGender = trip.genderPolicy !== 'any';
  const canSubmit =
    !busy &&
    name.trim().length >= 2 &&
    phone.trim().length >= 6 &&
    (!needsGender || gender !== null) &&
    trip.seatsAvailable >= 1;

  const submit = async () => {
    setBusy(true);
    setError(null);

    const tripId = await tripIdByCode(String(code));
    if (!tripId) {
      setBusy(false);
      setError(t('bookings.closedBody'));
      return;
    }

    const result = await createBooking({
      action: 'booking.create',
      tripId,
      seats: wholeTrip ? 1 : seats,
      destinationStopId: null,
      claimedTotalMinor: total,
      contactName: name.trim(),
      contactPhone: phone.trim(),
      gender: needsGender ? gender : null,
      note: note.trim() ? note.trim() : null,
    });

    setBusy(false);
    if (!result.ok) {
      // A translated sentence, never `error.detail`: that field is English support text and belongs in
      // a log, not in front of an Arabic-speaking passenger at a bus stop.
      setError(t(errorKey(result.error.code)));
      return;
    }

    const booking = (result.data as { booking?: { code?: string } }).booking;
    setDone(booking?.code ?? '—');
  };

  if (done) {
    return (
      <View style={[styles.page, { direction: rtl ? 'rtl' : 'ltr' }]}>
        <Text style={styles.title}>{t('bookings.requested')}</Text>
        <Text style={styles.code}>{done}</Text>
        <Text style={styles.hint}>{t('bookings.holdExplain', { minutes: 30 })}</Text>
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

  return (
    <ScrollView contentContainerStyle={[styles.page, { direction: rtl ? 'rtl' : 'ltr' }]}>
      <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.back}>
        <Text style={styles.backText}>← {t('common.back')}</Text>
      </Pressable>

      <Text style={styles.title}>{t('bookings.bookTitle', { code: trip.code })}</Text>
      <Text style={styles.hint}>{t('bookings.bookSubtitle')}</Text>

      {trip.seatsAvailable < 1 ? (
        <Text style={styles.error}>{t('bookings.noSeatsLeft')}</Text>
      ) : null}

      <Text style={styles.label}>{t('bookings.seats')}</Text>
      <View style={styles.stepper}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('bookings.seats')}
          onPress={() => setSeats((value) => Math.max(1, value - 1))}
          style={styles.step}
        >
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <Text style={styles.count}>
          {wholeTrip ? t('bookings.wholeTripHint') : t('bookings.seatsCount', { count: seats })}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('bookings.seats')}
          onPress={() => setSeats((value) => Math.min(maxSeats, value + 1))}
          style={styles.step}
        >
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>

      <Text style={styles.label}>{t('bookings.contactName')}</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        accessibilityLabel={t('bookings.contactName')}
        autoComplete="name"
        style={styles.input}
      />

      <Text style={styles.label}>{t('bookings.contactPhone')}</Text>
      <TextInput
        value={phone}
        onChangeText={setPhone}
        accessibilityLabel={t('bookings.contactPhone')}
        inputMode="tel"
        autoComplete="tel"
        keyboardType="phone-pad"
        style={[styles.input, { textAlign: rtl ? 'right' : 'left' }]}
      />

      {needsGender ? (
        <>
          <Text style={styles.label}>{t('bookings.gender')}</Text>
          <Text style={styles.hint}>{t('bookings.genderRequired')}</Text>
          <View style={styles.chips}>
            {(['female', 'male'] as const).map((value) => (
              <Pressable
                key={value}
                onPress={() => setGender(value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: gender === value }}
                style={[styles.chip, gender === value ? styles.chipOn : null]}
              >
                <Text style={gender === value ? styles.chipTextOn : styles.chipText}>
                  {value === 'female' ? t('bookings.genderFemale') : t('bookings.genderMale')}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}

      <Text style={styles.label}>{t('bookings.note')}</Text>
      <TextInput
        value={note}
        onChangeText={setNote}
        accessibilityLabel={t('bookings.note')}
        placeholder={t('bookings.noteHint')}
        multiline
        style={[styles.input, styles.textarea]}
      />

      <View style={styles.totalRow}>
        <Text style={styles.label}>{t('bookings.total')}</Text>
        <Text style={styles.total}>{formatMinor(total, 'YER', { locale })}</Text>
      </View>
      {trip.paymentPolicy === 'cash' ? (
        <Text style={styles.hint}>{t('bookings.cashHint')}</Text>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        onPress={() => void submit()}
        disabled={!canSubmit}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canSubmit, busy }}
        style={[styles.primary, !canSubmit ? styles.primaryOff : null]}
      >
        <Text style={styles.primaryText}>{busy ? t('common.loading') : t('bookings.reserve')}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 8 },
  back: { minHeight: 44, justifyContent: 'center' },
  backText: { color: '#0b7a5a', fontWeight: '700' },
  title: { fontSize: 20, fontWeight: '800' },
  hint: { color: '#5b6472', fontSize: 13 },
  label: { fontWeight: '700', marginTop: 12 },
  code: { fontSize: 24, fontWeight: '800', letterSpacing: 2 },
  input: {
    borderWidth: 1,
    borderColor: '#c9d2dd',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 44,
  },
  textarea: { minHeight: 72, textAlignVertical: 'top' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  step: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#c9d2dd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { fontSize: 20, fontWeight: '800' },
  count: { fontSize: 15, fontWeight: '700' },
  chips: { flexDirection: 'row', gap: 8 },
  chip: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#c9d2dd',
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: '#0b7a5a', borderColor: '#0b7a5a' },
  chipText: { fontWeight: '600' },
  chipTextOn: { fontWeight: '700', color: '#ffffff' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  total: { fontSize: 18, fontWeight: '800' },
  error: { color: '#b3261e', fontSize: 13, fontWeight: '600' },
  primary: {
    marginTop: 16,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#0b7a5a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryOff: { backgroundColor: '#9fb3ac' },
  primaryText: { color: '#ffffff', fontWeight: '800', fontSize: 16 },
});
