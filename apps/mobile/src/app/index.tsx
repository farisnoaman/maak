import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getLocales } from 'expo-localization';
import { useRouter } from 'expo-router';
import {
  LOCALE_LABEL,
  computePrice,
  formatMinor,
  isLocale,
  negotiateLocale,
  translate,
  type Locale,
} from '@maak/core';

/**
 * Mobile shell.
 *
 * Proves the shared package works on native: same pricing function, same dictionaries,
 * same money formatting as web and edge — no duplicated rules. The place picker (`/places`) uses
 * the same `reducePicker` / `rankPlaces` functions as the web picker.
 */
export default function HomeScreen() {
  const router = useRouter();
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0])
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);

  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

  const breakdown = computePrice({
    bookingMode: 'per_seat',
    pricingMode: 'flat',
    seats: 2,
    pricePerSeatMinor: 5000,
    discount: { kind: 'percent', value: 1000, scope: 'all' },
  });

  const isRtl = locale === 'ar';

  return (
    <ScrollView contentContainerStyle={[styles.page, { direction: isRtl ? 'rtl' : 'ltr' }]}>
      <Text style={[styles.brand, { textAlign: isRtl ? 'right' : 'left' }]}>
        {t('common.appName')}
      </Text>
      <Text style={[styles.tagline, { textAlign: isRtl ? 'right' : 'left' }]}>
        {t('common.tagline')}
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t('calc.title')}</Text>
        <View style={styles.row}>
          <Text style={styles.label}>{t('calc.subtotal')}</Text>
          <Text style={styles.value}>
            {formatMinor(breakdown.subtotalMinor, 'YER', { locale })}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>{t('calc.discountAmount')}</Text>
          <Text style={styles.value}>
            {formatMinor(breakdown.discountMinor, 'YER', { locale })}
          </Text>
        </View>
        <View style={[styles.row, styles.rowTotal]}>
          <Text style={styles.totalLabel}>{t('calc.total')}</Text>
          <Text style={styles.totalValue}>
            {formatMinor(breakdown.totalMinor, 'YER', { locale })}
          </Text>
        </View>
      </View>

      <Pressable
        accessibilityRole="link"
        onPress={() => router.push('/places')}
        style={styles.link}
      >
        <Text style={styles.linkText}>{t('picker.title')}</Text>
      </Pressable>

      {/* Phase 3: the driver's own screens. A driver is invited by phone, so this is the entry point. */}
      <Pressable
        accessibilityRole="link"
        onPress={() => router.push('/driver/profile')}
        style={styles.link}
      >
        <Text style={styles.linkText}>{t('fleet.driverProfile')}</Text>
      </Pressable>

      {/* Phase 4: search is the passenger's door into the product. */}
      <Pressable accessibilityRole="link" onPress={() => router.push('/trips')} style={styles.link}>
        <Text style={styles.linkText}>{t('trips.search.title')}</Text>
      </Pressable>

      <Text style={styles.note}>
        {LOCALE_LABEL[locale]} · {t('common.phase')} 4
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingVertical: 48,
    gap: 8,
    backgroundColor: '#ffffff',
  },
  brand: { fontSize: 30, fontWeight: '800', color: '#053b30' },
  tagline: { fontSize: 14, color: '#5b6b80', marginBottom: 24 },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#eef2f0',
    padding: 20,
    gap: 10,
    backgroundColor: '#ffffff',
  },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#0b1220', marginBottom: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowTotal: { borderTopWidth: 1, borderTopColor: '#eef2f0', paddingTop: 10 },
  label: { color: '#5b6b80', fontSize: 14 },
  value: { color: '#0b1220', fontSize: 14, fontVariant: ['tabular-nums'] },
  totalLabel: { color: '#0b1220', fontSize: 16, fontWeight: '800' },
  totalValue: { color: '#0a6550', fontSize: 16, fontWeight: '800' },
  link: {
    marginTop: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#0b7a5a',
    paddingVertical: 12,
    alignItems: 'center',
  },
  linkText: { color: '#0b7a5a', fontWeight: '700' },
  note: { marginTop: 12, color: '#8592a5', fontSize: 12 },
});
