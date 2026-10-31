import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { getLocales } from 'expo-localization';
import { useRouter } from 'expo-router';
import {
  BOOKING_STATUS_KEY,
  bookingTone,
  departureLabel,
  formatMinor,
  isLocale,
  negotiateLocale,
  translate,
  type BookingStatus,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { loadMyBookings, type MobileBooking } from '../../lib/bookings';

/**
 * My bookings, on native.
 *
 * Two sections, because that is how a passenger thinks about them: what is coming, and what happened. The
 * split is decided by the trip's departure, not by the booking's status — a cancelled booking for next week
 * and a cancelled booking from last month are different stories, and only the date tells them apart.
 */
export default function BookingsScreen() {
  const router = useRouter();
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0])
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const rtl = locale === 'ar';

  const [items, setItems] = useState<readonly MobileBooking[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void loadMyBookings().then((result) => {
      if (cancelled) return;
      setItems(result.items);
      setConfigured(result.configured);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <View style={styles.page}>
        <ActivityIndicator accessibilityLabel={t('common.loading')} />
      </View>
    );
  }

  const now = Date.now();
  const upcoming = items.filter(
    (item) => !item.trip?.departureAt || new Date(item.trip.departureAt).getTime() >= now,
  );
  const past = items.filter(
    (item) => item.trip?.departureAt && new Date(item.trip.departureAt).getTime() < now,
  );

  const renderCard = (booking: MobileBooking) => {
    const when = booking.trip ? departureLabel(booking.trip.departureAt, locale) : null;
    return (
      <Pressable
        key={booking.id}
        onPress={() => router.push(`/bookings/${booking.id}`)}
        accessibilityRole="button"
        style={styles.card}
      >
        <View style={styles.cardHead}>
          <Text style={styles.route}>
            {booking.trip
              ? `${booking.trip.originName ?? ''} ← ${booking.trip.destinationName ?? ''}`
              : booking.code}
          </Text>
          <Badge tone={bookingTone(booking.status)} label={t(statusKey(booking.status))} />
        </View>
        <Text style={styles.hint}>
          {when ? `${when.date} · ${when.time}` : '—'} · {booking.trip?.code ?? booking.code}
        </Text>
        <Text style={styles.meta}>
          {t('bookings.seatsCount', { count: booking.seats })} ·{' '}
          {formatMinor(booking.totalYer, 'YER', { locale })}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={[styles.page, { direction: rtl ? 'rtl' : 'ltr' }]}>
      <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.back}>
        <Text style={styles.backText}>← {t('common.back')}</Text>
      </Pressable>
      <Text style={styles.title}>{t('bookings.myTitle')}</Text>
      <Text style={styles.hint}>{t('bookings.mySubtitle')}</Text>
      {!configured ? <Text style={styles.hint}>{t('verification.notConfigured')}</Text> : null}

      {items.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{t('bookings.empty')}</Text>
          <Text style={styles.hint}>{t('bookings.emptyHint')}</Text>
          <Pressable
            onPress={() => router.push('/trips')}
            accessibilityRole="button"
            style={styles.primary}
          >
            <Text style={styles.primaryText}>{t('trips.search.title')}</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={[...upcoming, ...past]}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => renderCard(item)}
          ListHeaderComponent={
            <Text style={styles.label}>
              {upcoming.length > 0 ? t('bookings.upcoming') : t('bookings.past')}
            </Text>
          }
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

function statusKey(status: string): TranslationKey {
  return BOOKING_STATUS_KEY[status as BookingStatus] ?? 'bookings.status.pending';
}

function Badge({ label, tone }: { readonly label: string; readonly tone: string }) {
  const palette: Record<string, { readonly bg: string; readonly fg: string }> = {
    success: { bg: '#e5f4ee', fg: '#0b7a5a' },
    warning: { bg: '#fdf1dc', fg: '#8a5a00' },
    danger: { bg: '#fbe9e7', fg: '#b3261e' },
    neutral: { bg: '#eef1f5', fg: '#3b4452' },
  };
  const colors = palette[tone] ?? { bg: '#eef1f5', fg: '#3b4452' };
  return (
    <View style={[styles.badge, { backgroundColor: colors.bg }]}>
      <Text style={[styles.badgeText, { color: colors.fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 8, flex: 1 },
  back: { minHeight: 44, justifyContent: 'center' },
  backText: { color: '#0b7a5a', fontWeight: '700' },
  title: { fontSize: 22, fontWeight: '800' },
  hint: { color: '#5b6472', fontSize: 13 },
  label: { fontWeight: '700', marginTop: 12, marginBottom: 4 },
  list: { gap: 10, paddingBottom: 32 },
  card: {
    borderWidth: 1,
    borderColor: '#e1e6ee',
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' },
  route: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  meta: { fontSize: 12, color: '#3b4452' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  empty: { gap: 8, marginTop: 24 },
  emptyTitle: { fontSize: 17, fontWeight: '800' },
  primary: {
    marginTop: 12,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#0b7a5a',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  primaryText: { color: '#ffffff', fontWeight: '800', fontSize: 16 },
});
