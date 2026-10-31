import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { getLocales } from 'expo-localization';
import { isLocale, negotiateLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { getMobileClient } from '../lib/supabase';

interface ProfileRow {
  full_name: string | null;
  phone: string | null;
  email: string | null;
  verification_status: 'unverified' | 'pending' | 'verified' | 'rejected';
  verification_note: string | null;
}

interface OrganizationRow {
  id: string;
  name: string;
  role: string;
  verification_status: string;
}

/**
 * Profile + account switcher on native.
 *
 * The same rule as web: the screen renders what the database says, and the verification badge is a
 * fact from `profiles.verification_status` — never a local toggle.
 */
export default function ProfileScreen() {
  const router = useRouter();
  const deviceLocale = getLocales()[0]?.languageTag ?? 'ar';
  const locale: Locale = isLocale(deviceLocale.split('-')[0] ?? '')
    ? (deviceLocale.split('-')[0] as Locale)
    : negotiateLocale(null);
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const isRtl = locale === 'ar';
  const align = { textAlign: isRtl ? ('right' as const) : ('left' as const) };

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationRow[]>([]);
  const [error, setError] = useState<string | null>(null);

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

    const [profileResult, membershipResult] = await Promise.all([
      supabase
        .from('profiles')
        .select('full_name, phone, email, verification_status, verification_note')
        .eq('id', userId)
        .maybeSingle(),
      supabase
        .from('organization_members')
        .select('role, organizations(id, name, verification_status)')
        .eq('user_id', userId)
        .eq('status', 'active'),
    ]);

    if (profileResult.error) setError(profileResult.error.message);
    setProfile((profileResult.data as ProfileRow | null) ?? null);
    setOrganizations(
      (
        (membershipResult.data ?? []) as unknown as {
          role: string;
          organizations: OrganizationRow | null;
        }[]
      )
        .filter((row) => row.organizations)
        .map((row) => ({
          id: row.organizations!.id,
          name: row.organizations!.name,
          role: row.role,
          verification_status: row.organizations!.verification_status,
        })),
    );
    setLoading(false);
  }, [router, t]);

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

  const status = profile?.verification_status ?? 'unverified';

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={[styles.title, align]}>{t('account.title')}</Text>
      <Text style={[styles.hint, align]}>{t('account.subtitle')}</Text>

      <View style={styles.card}>
        <Text style={[styles.name, align]}>{profile?.full_name ?? t('account.personal')}</Text>
        <Text style={[styles.hint, align]}>{profile?.email ?? profile?.phone ?? ''}</Text>
        <View style={[styles.badge, status === 'verified' ? styles.badgeOk : styles.badgeWarn]}>
          <Text style={styles.badgeText}>
            {t(`verification.status.${status}` as TranslationKey)}
          </Text>
        </View>
        {status === 'rejected' && profile?.verification_note ? (
          <Text style={[styles.error, align]}>
            {t('verification.rejectedNote', { reason: profile.verification_note })}
          </Text>
        ) : null}
      </View>

      <Pressable style={styles.primary} onPress={() => router.push('/verification')}>
        <Text style={styles.primaryText}>{t('verification.title')}</Text>
      </Pressable>

      <Text style={[styles.section, align]}>{t('account.organizations')}</Text>
      {organizations.length === 0 ? (
        <Text style={[styles.hint, align]}>{t('account.noOrganizations')}</Text>
      ) : (
        organizations.map((organization) => (
          <View key={organization.id} style={styles.card}>
            <Text style={[styles.name, align]}>{organization.name}</Text>
            <Text style={[styles.hint, align]}>
              {t(`org.role.${organization.role}` as TranslationKey)} ·{' '}
              {organization.verification_status}
            </Text>
          </View>
        ))
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
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
  card: {
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#fff',
    gap: 6,
    borderWidth: 1,
    borderColor: '#ececec',
  },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  badgeOk: { backgroundColor: '#e9f6ee' },
  badgeWarn: { backgroundColor: '#fdf3e2' },
  badgeText: { fontSize: 12, fontWeight: '700' },
  primary: { padding: 14, borderRadius: 12, backgroundColor: '#0d7a5f', alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '700' },
  error: { color: '#8c1d1d', fontSize: 13 },
});
