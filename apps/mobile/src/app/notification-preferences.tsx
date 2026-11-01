import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { getLocales } from 'expo-localization';
import {
  errorKey,
  isLocale,
  negotiateLocale,
  notificationCommandSpec,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { getApiClient } from '../lib/api';
import { registerForPush } from '../lib/push';

type Channel = 'in_app' | 'push' | 'email' | 'whatsapp';

interface EventRow {
  kind: string;
  titleKey: string;
  priority: 'critical' | 'normal' | 'low';
  customised: boolean;
  channels: Record<Channel, boolean>;
}

interface DeviceRow {
  id: string;
  platform: string;
  lastSeenAt: string | null;
}

interface Settings {
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  timezone: string;
}

const CHANNELS: readonly Channel[] = ['push', 'email', 'whatsapp'];

/**
 * What the phone is allowed to tell you, and when.
 *
 * The same 31 events the web preferences page lists — the rows come from the server, not from a local
 * list, so adding a notification kind in SQL cannot leave a screen behind. `in_app` is not a switch:
 * turning off the record of what happened is how a support case becomes unanswerable.
 */
export default function NotificationPreferencesScreen() {
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
  const [events, setEvents] = useState<EventRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);

  const load = useCallback(async () => {
    const client = getApiClient();
    if (!client) {
      setLoading(false);
      setError(t('verification.notConfigured'));
      return;
    }
    const result = await client.call(notificationCommandSpec, { action: 'notifications.settings' });
    setLoading(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    const data = result.data as unknown as {
      events: EventRow[];
      devices: DeviceRow[];
      settings: Settings;
    };
    setEvents(data.events ?? []);
    setDevices(data.devices ?? []);
    setSettings(data.settings ?? null);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(kind: string, channel: Channel, enabled: boolean) {
    const client = getApiClient();
    if (!client) return;
    setBusyKind(`${kind}:${channel}`);
    setError(null);
    const result = await client.call(notificationCommandSpec, {
      action: 'notifications.preference.set',
      kind: kind as never,
      channel,
      enabled,
    });
    setBusyKind(null);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setEvents((current) =>
      current.map((row) =>
        row.kind === kind
          ? { ...row, customised: true, channels: { ...row.channels, [channel]: enabled } }
          : row,
      ),
    );
  }

  async function enablePush() {
    setError(null);
    setNotice(null);
    const result = await registerForPush();
    if (!result.ok) {
      setError(
        t(
          result.reason === 'permission'
            ? ('notifications.pushDenied' as TranslationKey)
            : ('notifications.pushUnavailable' as TranslationKey),
        ),
      );
      return;
    }
    setNotice(t('notifications.pushRegistered'));
    await load();
  }

  async function revoke(id: string) {
    const client = getApiClient();
    if (!client) return;
    const result = await client.call(notificationCommandSpec, {
      action: 'notifications.device.revoke',
      deviceId: id,
    });
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setDevices((current) => current.filter((row) => row.id !== id));
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
        <Text style={styles.link}>{t('common.back')}</Text>
      </Pressable>

      <Text style={[styles.title, align]}>{t('notifications.preferencesTitle')}</Text>
      <Text style={[styles.hint, align]}>{t('notifications.preferencesSubtitle')}</Text>

      {loading ? <ActivityIndicator /> : null}
      {error ? <Text style={[styles.error, align]}>{error}</Text> : null}
      {notice ? <Text style={[styles.ok, align]}>{notice}</Text> : null}

      {settings ? (
        <View style={styles.card}>
          <Text style={[styles.cardTitle, align]}>{t('notifications.quietHours')}</Text>
          <Text style={[styles.hint, align]}>
            {settings.quietHoursEnabled
              ? `${t('notifications.quietStart')} ${settings.quietStart} · ${t(
                  'notifications.quietEnd',
                )} ${settings.quietEnd}`
              : t('notifications.quietOffNote')}
          </Text>
          <Text style={[styles.hint, align]}>
            {`${t('notifications.quietTimezone')} · ${settings.timezone}`}
          </Text>
          <Text style={[styles.hint, align]}>{t('notifications.quietHoursHint')}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={[styles.cardTitle, align]}>{t('notifications.devices')}</Text>
        {devices.length === 0 ? (
          <Text style={[styles.hint, align]}>{t('notifications.devicesEmpty')}</Text>
        ) : null}
        {devices.map((device) => (
          <View key={device.id} style={styles.deviceRow}>
            <Text style={styles.deviceName}>
              {`${device.platform} · ${(device.lastSeenAt ?? '').slice(0, 10)}`}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => void revoke(device.id)}>
              <Text style={styles.link}>{t('notifications.deviceRevoke')}</Text>
            </Pressable>
          </View>
        ))}
        <Pressable
          accessibilityRole="button"
          onPress={() => void enablePush()}
          style={styles.action}
        >
          <Text style={styles.actionText}>{t('notifications.deviceRegister')}</Text>
        </Pressable>
      </View>

      {events.map((row) => (
        <View key={row.kind} style={styles.card}>
          <View style={styles.headRow}>
            <Text style={[styles.cardTitle, align]}>{t(row.titleKey as TranslationKey)}</Text>
            {row.priority === 'critical' ? (
              <Text style={styles.badge}>{t('notifications.criticalBadge')}</Text>
            ) : null}
          </View>
          {CHANNELS.map((channel) => {
            const on = row.channels[channel] ?? false;
            const busy = busyKind === `${row.kind}:${channel}`;
            return (
              <View key={channel} style={styles.switchRow}>
                <Text style={styles.switchLabel}>
                  {t(`notifications.channel.${channel}` as TranslationKey)}
                </Text>
                <Switch
                  accessibilityLabel={`${t(row.titleKey as TranslationKey)} ${t(
                    `notifications.channel.${channel}` as TranslationKey,
                  )}`}
                  value={on}
                  disabled={busy}
                  onValueChange={(next) => void toggle(row.kind, channel, next)}
                  trackColor={{ false: '#d1d5db', true: '#0f766e' }}
                />
              </View>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 48, gap: 12 },
  back: { minHeight: 44, justifyContent: 'center' },
  link: { color: '#0f766e', fontSize: 15 },
  title: { fontSize: 22, fontWeight: '700' },
  hint: { fontSize: 13, color: '#6b7280' },
  error: { fontSize: 14, color: '#b91c1c' },
  ok: { fontSize: 14, color: '#15803d' },
  card: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 12, gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  badge: {
    fontSize: 11,
    color: '#b91c1c',
    borderWidth: 1,
    borderColor: '#fecaca',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 44,
  },
  switchLabel: { fontSize: 14 },
  deviceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 44,
  },
  deviceName: { fontSize: 14 },
  action: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f766e',
    borderRadius: 10,
    marginTop: 4,
  },
  actionText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
