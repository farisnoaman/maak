import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { getLocales } from 'expo-localization';
import { useLocalSearchParams } from 'expo-router';
import {
  errorKey,
  formatMinor,
  isLocale,
  negotiateLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import {
  loadPaymentIntent,
  submitPaymentProof,
  uploadPaymentProof,
  type MobilePaymentIntent,
} from '../../lib/payments';

/**
 * Paying a booking on native: the account to send to, the receipt, the reference.
 *
 * One screen, because that is the whole job — a rider standing in a money-transfer shop does not want a
 * wizard. The receipt is picked from the camera roll or the camera, hashed on the device (so one image
 * cannot pay for two bookings) and uploaded into the intent's own folder before the command is called.
 *
 * The amount is shown, never sent as an instruction: `claimedAmountYer` travels with the proof only so the
 * command can refuse a stale screen with `PRICE_CHANGED`.
 */
export default function PayScreen() {
  const { intent: intentId } = useLocalSearchParams<{ intent: string }>();
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0])
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [intent, setIntent] = useState<MobilePaymentIntent | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState('');

  const reload = useCallback(async () => {
    if (!intentId) return;
    setLoading(true);
    const loaded = await loadPaymentIntent(String(intentId));
    setIntent(loaded);
    setReference(loaded?.referenceNo ?? '');
    setLoading(false);
  }, [intentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function attachAndSend(useCamera: boolean) {
    if (!intent) return;
    const permission = useCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(t('pay.uploadFailed'));
      return;
    }

    const picked = useCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.7 })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7 });
    if (picked.canceled || !picked.assets[0]) return;

    setBusy(true);
    const upload = await uploadPaymentProof(picked.assets[0].uri, intent.id);
    if (!upload.ok) {
      setBusy(false);
      Alert.alert(t('pay.uploadFailed'), upload.error);
      return;
    }

    const result = await submitPaymentProof({
      intentId: intent.id,
      proofPath: upload.path,
      proofHash: upload.hash,
      referenceNo: reference.trim() === '' ? null : reference.trim(),
      claimedAmountYer: intent.amountYer,
    });
    setBusy(false);

    if (!result.ok) {
      Alert.alert(
        t('pay.status'),
        translate(locale, errorKey(result.error.code as never) as TranslationKey),
      );
      return;
    }
    await reload();
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!intent) {
    return (
      <View style={styles.center}>
        <Text style={styles.hint}>{t('pay.noAccount')}</Text>
      </View>
    );
  }

  const instructions =
    locale === 'ar'
      ? (intent.instructionsAr ?? intent.instructionsEn)
      : (intent.instructionsEn ?? intent.instructionsAr);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.title}>{t('pay.title')}</Text>
      <Text style={styles.code}>{intent.code}</Text>

      <View style={styles.card}>
        <Text style={styles.label}>{t('pay.amountDue')}</Text>
        <Text style={styles.amount}>{formatMinor(intent.amountYer, 'YER', { locale })}</Text>
        <Text style={styles.label}>{t('pay.method')}</Text>
        <Text style={styles.value}>{t(`payments.method.${intent.method}` as TranslationKey)}</Text>
        {intent.accountNumber ? (
          <>
            <Text style={styles.label}>{t('pay.toAccount')}</Text>
            <Text style={styles.value}>{intent.accountNumber}</Text>
            <Text style={styles.hint}>{intent.holderName ?? ''}</Text>
          </>
        ) : null}
        {instructions ? <Text style={styles.hint}>{instructions}</Text> : null}
        <Text style={styles.label}>{t('pay.status')}</Text>
        <Text style={styles.value}>{t(`pay.status.${intent.status}` as TranslationKey)}</Text>
        {intent.status === 'rejected' && intent.rejectedReason ? (
          <Text style={styles.error}>
            {t('pay.rejectedReason', { reason: intent.rejectedReason })}
          </Text>
        ) : null}
      </View>

      {intent.status === 'awaiting_proof' ? (
        <View style={styles.card}>
          <Text style={styles.label}>{t('pay.referenceNo')}</Text>
          <TextInput
            style={styles.input}
            value={reference}
            onChangeText={setReference}
            maxLength={80}
            autoCapitalize="characters"
            placeholder="TRX-…"
          />
          <Text style={styles.hint}>{t('pay.hashNote')}</Text>

          <Pressable
            style={[styles.button, busy && styles.buttonBusy]}
            disabled={busy}
            onPress={() => void attachAndSend(true)}
          >
            <Text style={styles.buttonText}>{busy ? t('common.loading') : t('pay.submit')}</Text>
          </Pressable>
          <Pressable
            style={styles.secondary}
            disabled={busy}
            onPress={() => void attachAndSend(false)}
          >
            <Text style={styles.secondaryText}>{t('common.choose')}</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={styles.hint}>
          {intent.status === 'awaiting_confirmation'
            ? t('pay.submitted')
            : intent.status === 'confirmed'
              ? t('pay.confirmedNote')
              : t('pay.expiredNote')}
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 24, fontWeight: '800' },
  code: { fontSize: 14, opacity: 0.6 },
  card: { gap: 6, padding: 16, borderRadius: 16, backgroundColor: '#fff' },
  label: { fontSize: 12, fontWeight: '700', opacity: 0.55, marginTop: 8 },
  value: { fontSize: 15 },
  amount: { fontSize: 26, fontWeight: '800' },
  hint: { fontSize: 13, opacity: 0.75 },
  error: { fontSize: 13, color: '#a3231f' },
  input: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d8d6cf',
  },
  button: {
    marginTop: 12,
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f6e58',
  },
  buttonBusy: { opacity: 0.6 },
  buttonText: { color: '#fff', fontWeight: '700' },
  secondary: { marginTop: 8, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontWeight: '700' },
});
