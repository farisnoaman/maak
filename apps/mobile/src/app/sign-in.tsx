import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { getLocales } from 'expo-localization';
import {
  PHONE_PLACEHOLDER,
  isLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { getMobileClient } from '../lib/supabase';

/**
 * Mobile sign-in: email/password and phone OTP.
 * Every string is localized and the layout is direction-aware, so RTL needs no restart.
 */
export default function SignInScreen() {
  const deviceLocale = getLocales()[0]?.languageTag.split('-')[0] ?? 'ar';
  const locale: Locale = isLocale(deviceLocale) ? deviceLocale : 'ar';
  const isRtl = locale === 'ar';
  const t = (key: TranslationKey) => translate(locale, key);

  const router = useRouter();
  const client = getMobileClient();

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    if (!client) return;
    setBusy(true);
    setError(null);
    const { error: authError } = await client.auth.signInWithOtp({ phone });
    setBusy(false);
    if (authError) {
      setError(t('errors.INTERNAL'));
      return;
    }
    setCodeSent(true);
  }

  async function verify() {
    if (!client) return;
    setBusy(true);
    setError(null);
    const { error: authError } = await client.auth.verifyOtp({ phone, token: code, type: 'sms' });
    setBusy(false);
    if (authError) {
      setError(t('errors.VALIDATION_FAILED'));
      return;
    }
    router.replace('/');
  }

  const align = { textAlign: isRtl ? ('right' as const) : ('left' as const) };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={[styles.title, align]}>{t('auth.title')}</Text>
      <Text style={[styles.subtitle, align]}>{t('auth.subtitle')}</Text>

      {!client ? <Text style={styles.notice}>{t('auth.notConfigured')}</Text> : null}

      <Text style={[styles.label, align]}>{t('auth.phone')}</Text>
      <TextInput
        style={[styles.input, align]}
        value={phone}
        onChangeText={setPhone}
        placeholder={PHONE_PLACEHOLDER}
        keyboardType="phone-pad"
        autoComplete="tel"
        editable={Boolean(client)}
        accessibilityLabel={t('auth.phone')}
      />

      {codeSent ? (
        <>
          <Text style={[styles.label, align]}>{t('auth.code')}</Text>
          <TextInput
            style={[styles.input, align]}
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            autoComplete="sms-otp"
            accessibilityLabel={t('auth.code')}
          />
        </>
      ) : null}

      {error ? (
        <Text style={[styles.error, align]} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      <Pressable
        style={[styles.button, (!client || busy) && styles.buttonDisabled]}
        onPress={codeSent ? verify : sendCode}
        disabled={!client || busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: !client || busy, busy }}
      >
        {busy ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={styles.buttonLabel}>{codeSent ? t('auth.verify') : t('auth.sendCode')}</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, padding: 24, gap: 8, justifyContent: 'center', backgroundColor: '#ffffff' },
  title: { fontSize: 24, fontWeight: '800', color: '#0b1220' },
  subtitle: { fontSize: 14, color: '#5b6b80', marginBottom: 16 },
  label: { fontSize: 13, fontWeight: '600', color: '#3d4d61', marginTop: 12 },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: '#eef2f0',
    borderRadius: 10,
    paddingHorizontal: 14,
    backgroundColor: '#f6f8f7',
    color: '#0b1220',
  },
  error: { color: '#b4232a', fontSize: 13, marginTop: 10, fontWeight: '600' },
  notice: {
    backgroundColor: '#fdfaf3',
    borderColor: '#e8d5a8',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    color: '#3d4d61',
    fontSize: 12,
    marginBottom: 8,
  },
  button: {
    marginTop: 20,
    minHeight: 50,
    borderRadius: 12,
    backgroundColor: '#0b7f60',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.55 },
  buttonLabel: { color: '#ffffff', fontWeight: '700', fontSize: 15 },
});
