import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { getLocales } from 'expo-localization';
import {
  errorKey,
  identityCommandSpec,
  isLocale,
  negotiateLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { getApiClient, isBackendConfigured, uploadDocument } from '../lib/api';
import { getMobileClient } from '../lib/supabase';

/**
 * Verification submission on native.
 *
 * The camera opens only after the OS permission is granted, and each capture uploads straight into
 * the caller's own storage prefix; the command then links the two paths. Identical rules to web —
 * one shared schema, one shared command.
 */
export default function VerificationScreen() {
  const router = useRouter();
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0] ?? '')
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey) => translate(locale, key);
  const isRtl = locale === 'ar';
  const align = { textAlign: isRtl ? ('right' as const) : ('left' as const) };

  const [fullName, setFullName] = useState('');
  const [nationalIdNumber, setNationalIdNumber] = useState('');
  const [birthPlace, setBirthPlace] = useState('');
  const [frontUri, setFrontUri] = useState<string | null>(null);
  const [backUri, setBackUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function capture(setter: (uri: string) => void) {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError(t('errors.FORBIDDEN'));
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, allowsEditing: false });
    if (!result.canceled && result.assets[0]) setter(result.assets[0].uri);
  }

  async function submit() {
    const client = getApiClient();
    const supabase = getMobileClient();
    if (!client || !supabase || !isBackendConfigured()) {
      setError(t('verification.notConfigured'));
      return;
    }
    if (!frontUri || !backUri) {
      setError(t('errors.MISSING_DOCUMENT'));
      return;
    }

    setBusy(true);
    setError(null);

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) {
      setBusy(false);
      router.replace('/sign-in');
      return;
    }

    const [front, back] = await Promise.all([
      uploadDocument(frontUri, 'national_id_front'),
      uploadDocument(backUri, 'national_id_back'),
    ]);

    if (!front.ok || !back.ok) {
      setBusy(false);
      setError(t('errors.NETWORK'));
      return;
    }

    const profileUpdate = await client.call(identityCommandSpec, {
      action: 'profile.update',
      fullName: fullName.trim(),
      nationalIdType: 'national_id',
      nationalIdNumber: nationalIdNumber.trim(),
      birthPlace: birthPlace.trim(),
    });

    if (!profileUpdate.ok) {
      setBusy(false);
      setError(t(errorKey(profileUpdate.error.code)));
      return;
    }

    const submission = await client.call(identityCommandSpec, {
      action: 'verification.submit',
      subjectType: 'individual',
      subjectId: userId,
      documents: [
        { kind: 'national_id_front', path: front.path },
        { kind: 'national_id_back', path: back.path },
      ],
    });

    setBusy(false);
    if (!submission.ok) {
      setError(t(errorKey(submission.error.code)));
      return;
    }
    setMessage(t('verification.submitted'));
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={[styles.title, align]}>{t('verification.title')}</Text>
      <Text style={[styles.hint, align]}>{t('verification.subtitle')}</Text>

      <Text style={[styles.label, align]}>{t('verification.fullName')}</Text>
      <TextInput
        style={styles.input}
        value={fullName}
        onChangeText={setFullName}
        autoComplete="name"
        accessibilityLabel={t('verification.fullName')}
      />

      <Text style={[styles.label, align]}>{t('verification.nationalIdNumber')}</Text>
      <TextInput
        style={styles.input}
        value={nationalIdNumber}
        onChangeText={setNationalIdNumber}
        keyboardType="number-pad"
        accessibilityLabel={t('verification.nationalIdNumber')}
      />

      <Text style={[styles.label, align]}>{t('verification.birthPlace')}</Text>
      <TextInput
        style={styles.input}
        value={birthPlace}
        onChangeText={setBirthPlace}
        accessibilityLabel={t('verification.birthPlace')}
      />

      <Pressable style={styles.secondary} onPress={() => capture(setFrontUri)}>
        <Text style={styles.secondaryText}>
          {t('verification.front')} {frontUri ? '✓' : ''}
        </Text>
      </Pressable>
      <Pressable style={styles.secondary} onPress={() => capture(setBackUri)}>
        <Text style={styles.secondaryText}>
          {t('verification.back')} {backUri ? '✓' : ''}
        </Text>
      </Pressable>

      <Pressable style={styles.primary} onPress={submit} disabled={busy}>
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryText}>{t('verification.submit')}</Text>
        )}
      </Pressable>

      {message ? <Text style={styles.success}>{message}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 8 },
  title: { fontSize: 22, fontWeight: '800' },
  hint: { fontSize: 13, opacity: 0.65, marginBottom: 8 },
  label: { fontSize: 13, fontWeight: '700', marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#dcdcdc',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    fontSize: 15,
  },
  primary: {
    marginTop: 16,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#0d7a5f',
    alignItems: 'center',
  },
  primaryText: { color: '#fff', fontWeight: '700' },
  secondary: {
    marginTop: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#0d7a5f',
  },
  secondaryText: { color: '#0d7a5f', fontWeight: '700', textAlign: 'center' },
  success: { marginTop: 10, color: '#1c5b36', fontWeight: '700' },
  error: { marginTop: 10, color: '#8c1d1d', fontWeight: '700' },
});
