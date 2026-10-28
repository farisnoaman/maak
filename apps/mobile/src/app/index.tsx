import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { getLocales } from 'expo-localization';
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
 * Phase 0 mobile shell.
 *
 * Proves the shared package works on native: same pricing function, same dictionaries,
 * same money formatting as web and edge — no duplicated rules.
 */
export default function HomeScreen() {
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

      <Text style={styles.note}>
        {LOCALE_LABEL[locale]} · {t('common.phase')} 0
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
  note: { marginTop: 24, color: '#8592a5', fontSize: 12 },
});
