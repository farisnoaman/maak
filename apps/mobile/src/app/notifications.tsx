import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { getLocales } from 'expo-localization';
import {
  errorKey,
  isLocale,
  negotiateLocale,
  notificationCommandSpec,
  notificationText,
  translate,
  translateCount,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { getApiClient } from '../lib/api';
import { getMobileClient } from '../lib/supabase';

interface NotificationRow {
  id: string;
  kind: string;
  title_key: string;
  params: Record<string, string | number> | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

/**
 * The native inbox.
 *
 * Push is only useful if the message is still there when the phone is unlocked, so this screen reads the same
 * rows the bell on web reads — one source, two surfaces. "Mark all read" goes through the gateway because it
 * is a write (ADR-018), not because the list is precious.
 */
export default function NotificationsScreen() {
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
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const supabase = getMobileClient();
    if (!supabase) {
      setLoading(false);
      setError(t('verification.notConfigured'));
      return;
    }
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      setLoading(false);
      router.replace('/sign-in');
      return;
    }

    const { data, error: readError } = await supabase
      .from('notifications')
      .select('id, kind, title_key, params, link, read_at, created_at')
      .order('created_at', { ascending: false })
      .limit(50);

    setLoading(false);
    if (readError) {
      setError(readError.message);
      return;
    }
    setRows((data ?? []) as unknown as NotificationRow[]);
  }, [router, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  async function markAllRead() {
    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);
    // The dispatch function owns the inbox: one action, one command.
    const result = await client.call(notificationCommandSpec, {
      action: 'notifications.read',
      ids: null,
    });
    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    const now = new Date().toISOString();
    setRows((current) => current.map((row) => (row.read_at ? row : { ...row, read_at: now })));
  }

  const unread = rows.filter((row) => !row.read_at).length;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={[styles.title, align]}>{t('notifications.pageTitle')}</Text>
      <Pressable
        accessibilityRole="link"
        onPress={() => router.push('/notification-preferences')}
        style={styles.metaLink}
      >
        <Text style={styles.link}>{t('notifications.preferencesTitle')}</Text>
      </Pressable>
      <Text style={[styles.hint, align]}>
        {translateCount(locale, 'notifications.unread', unread)}
      </Text>

      {loading ? <ActivityIndicator /> : null}

      {!loading && rows.length === 0 ? (
        <Text style={[styles.hint, align]}>{t('account.noNotifications')}</Text>
      ) : null}

      {rows.map((row) => (
        <View key={row.id} style={[styles.card, row.read_at ? null : styles.cardUnread]}>
          <Text style={[styles.body, align]}>
            {notificationText(locale, {
              kind: row.kind,
              titleKey: row.title_key,
              params: row.params,
            })}
          </Text>
          <Text style={[styles.meta, align]}>
            {`${t(`notifications.event.${row.kind}` as TranslationKey)} · ${row.created_at.slice(0, 10)}`}
          </Text>
        </View>
      ))}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy || unread === 0 }}
        disabled={busy || unread === 0}
        onPress={markAllRead}
        style={styles.action}
      >
        <Text style={styles.actionText}>{t('account.markAllRead')}</Text>
      </Pressable>

      <Pressable
        accessibilityRole="link"
        onPress={() => router.push('/profile')}
        style={styles.action}
      >
        <Text style={styles.actionText}>{t('notifications.preferencesTitle')}</Text>
      </Pressable>

      {error ? (
        <Text style={[styles.error, align]} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, padding: 20, gap: 12 },
  metaLink: { minHeight: 44, justifyContent: 'center' },
  link: { fontSize: 14, color: '#0f766e' },
  title: { fontSize: 22, fontWeight: '700' },
  hint: { fontSize: 13, opacity: 0.75 },
  card: {
    borderWidth: 1,
    borderColor: '#d8d5cd',
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  cardUnread: { borderColor: '#0f766e', backgroundColor: '#f0fdfa' },
  body: { fontSize: 15 },
  meta: { fontSize: 12, opacity: 0.7 },
  action: {
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#0f766e',
    paddingHorizontal: 12,
  },
  actionText: { color: '#0f766e', fontWeight: '600' },
  error: { color: '#b91c1c', fontSize: 13 },
});
