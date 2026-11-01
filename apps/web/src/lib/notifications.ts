/**
 * Notification reads — RLS, the visitor's own cookie, no service role.
 *
 * Writes go through the gateway (`dispatch`), because marking a notification read is a write and every write
 * in this product is one command. Reads are direct: the Phase 11 policies expose exactly the caller's own
 * rows, and a page that needs its own inbox should not need a round trip through an edge function to get it.
 *
 * The one thing that is *not* read here is `notification_settings` before the user has saved it — the absence
 * of a row is the default, and inventing a row to represent a default is how "22:00–06:00" silently became
 * whatever the last seed said.
 */

import { callGateway } from './gateway';
import { getServerClient } from './supabase/server';
import type {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationPriority,
} from '@maak/core';

export interface InboxItem {
  readonly id: string;
  readonly kind: string;
  readonly titleKey: string;
  readonly params: Record<string, string | number>;
  readonly link: string | null;
  readonly priority: NotificationPriority;
  readonly readAt: string | null;
  readonly createdAt: string;
  /** One entry per channel a decision was made for. Absent = the event never offered that channel. */
  readonly channels: Partial<Record<NotificationChannel, NotificationDeliveryStatus>>;
}

export interface InboxPage {
  readonly configured: boolean;
  readonly items: readonly InboxItem[];
  readonly unread: number;
  readonly nextCursor: string | null;
}

export interface NotificationSettingsView {
  readonly quietHoursEnabled: boolean;
  readonly quietStart: string;
  readonly quietEnd: string;
  readonly timezone: string;
  readonly saved: boolean;
}

export interface NotificationEventView {
  readonly kind: string;
  readonly priority: NotificationPriority;
  readonly defaultChannels: readonly NotificationChannel[];
  /** Explicit user deviations only; everything else follows the catalogue. */
  readonly overrides: Partial<Record<NotificationChannel, boolean>>;
}

export interface DeviceView {
  readonly id: string;
  readonly platform: 'ios' | 'android' | 'web';
  readonly lastSeenAt: string;
}

export interface PreferencesView {
  readonly configured: boolean;
  readonly settings: NotificationSettingsView;
  readonly events: readonly NotificationEventView[];
  readonly devices: readonly DeviceView[];
}

export const DEFAULT_SETTINGS: NotificationSettingsView = {
  quietHoursEnabled: true,
  quietStart: '22:00',
  quietEnd: '06:00',
  timezone: 'Asia/Aden',
  saved: false,
};

export async function loadInbox(options: { limit?: number } = {}): Promise<InboxPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const client = await getServerClient();
  if (!client) return { configured: false, items: [], unread: 0, nextCursor: null };

  const [notificationResult, unreadResult] = await Promise.all([
    client
      .from('notifications')
      .select('id, kind, title_key, params, link, priority, read_at, created_at')
      .order('created_at', { ascending: false })
      .limit(limit),
    client.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
  ]);

  const rows = (notificationResult.data ?? []) as unknown as Record<string, unknown>[];
  const ids = rows.map((row) => String(row.id));

  // One query for every delivery of the page, then grouped in memory: a per-row query is how an inbox of 50
  // items becomes 51 round trips.
  const deliveryResult = ids.length
    ? await client
        .from('notification_deliveries')
        .select('notification_id, channel, status')
        .in('notification_id', ids)
    : { data: [] as unknown[] };

  const byNotification = new Map<
    string,
    Partial<Record<NotificationChannel, NotificationDeliveryStatus>>
  >();
  for (const delivery of (deliveryResult.data ?? []) as unknown as Record<string, unknown>[]) {
    const key = String(delivery.notification_id);
    const current = byNotification.get(key) ?? {};
    current[String(delivery.channel) as NotificationChannel] = String(
      delivery.status,
    ) as NotificationDeliveryStatus;
    byNotification.set(key, current);
  }

  const items: InboxItem[] = rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind ?? ''),
    titleKey: String(row.title_key ?? ''),
    params: (row.params as Record<string, string | number>) ?? {},
    link: typeof row.link === 'string' ? row.link : null,
    priority: (row.priority as NotificationPriority) ?? 'normal',
    readAt: typeof row.read_at === 'string' ? row.read_at : null,
    createdAt: String(row.created_at ?? ''),
    channels: byNotification.get(String(row.id)) ?? {},
  }));

  return {
    configured: true,
    items,
    unread: unreadResult.count ?? items.filter((item) => !item.readAt).length,
    nextCursor: rows.length === limit ? (items[items.length - 1]?.createdAt ?? null) : null,
  };
}

export async function loadNotificationPreferences(): Promise<PreferencesView> {
  const client = await getServerClient();
  if (!client) {
    return { configured: false, settings: DEFAULT_SETTINGS, events: [], devices: [] };
  }

  const [settingsResult, eventResult, preferenceResult, deviceResult] = await Promise.all([
    client
      .from('notification_settings')
      .select('quiet_hours_enabled, quiet_start, quiet_end, timezone')
      .maybeSingle(),
    client
      .from('notification_events')
      .select('kind, priority, default_channels, is_active')
      .eq('is_active', true),
    client.from('notification_preferences').select('kind, channel, enabled'),
    client
      .from('device_tokens')
      .select('id, platform, last_seen_at')
      .is('revoked_at', null)
      .order('last_seen_at', { ascending: false }),
  ]);

  const settingsRow = settingsResult.data as unknown as Record<string, unknown> | null;
  const settings: NotificationSettingsView = settingsRow
    ? {
        quietHoursEnabled: Boolean(settingsRow.quiet_hours_enabled),
        quietStart: String(settingsRow.quiet_start ?? '22:00').slice(0, 5),
        quietEnd: String(settingsRow.quiet_end ?? '06:00').slice(0, 5),
        timezone: String(settingsRow.timezone ?? 'Asia/Aden'),
        saved: true,
      }
    : DEFAULT_SETTINGS;

  const overrides = new Map<string, Partial<Record<NotificationChannel, boolean>>>();
  for (const row of (preferenceResult.data ?? []) as unknown as Record<string, unknown>[]) {
    const current = overrides.get(String(row.kind)) ?? {};
    current[String(row.channel) as NotificationChannel] = Boolean(row.enabled);
    overrides.set(String(row.kind), current);
  }

  const events: NotificationEventView[] = (
    (eventResult.data ?? []) as unknown as Record<string, unknown>[]
  )
    .map((row) => ({
      kind: String(row.kind),
      priority: (row.priority as NotificationPriority) ?? 'normal',
      defaultChannels: (row.default_channels as NotificationChannel[]) ?? ['in_app'],
      overrides: overrides.get(String(row.kind)) ?? {},
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind));

  const devices: DeviceView[] = (
    (deviceResult.data ?? []) as unknown as Record<string, unknown>[]
  ).map((row) => ({
    id: String(row.id),
    platform: (row.platform as DeviceView['platform']) ?? 'web',
    lastSeenAt: String(row.last_seen_at ?? ''),
  }));

  return { configured: true, settings, events, devices };
}

export interface SavedSearchView {
  readonly id: string;
  readonly label: string | null;
  readonly filters: Record<string, unknown>;
  readonly notify: boolean;
  readonly digest: boolean;
  readonly matches: number;
  readonly lastMatchedAt: string | null;
  readonly createdAt: string;
}

export async function loadSavedSearches(): Promise<readonly SavedSearchView[]> {
  const client = await getServerClient();
  if (!client) return [];

  const { data } = await client
    .from('saved_searches')
    .select('id, label, filters, notify, digest, last_matched_at, created_at')
    .order('created_at', { ascending: false });

  const searches = (data ?? []) as unknown as Record<string, unknown>[];
  if (searches.length === 0) return [];

  const { data: matchRows } = await client
    .from('saved_search_matches')
    .select('saved_search_id')
    .in(
      'saved_search_id',
      searches.map((row) => String(row.id)),
    );

  const counts = new Map<string, number>();
  for (const match of (matchRows ?? []) as unknown as Record<string, unknown>[]) {
    const key = String(match.saved_search_id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return searches.map((row) => ({
    id: String(row.id),
    label: typeof row.label === 'string' ? row.label : null,
    filters: (row.filters as Record<string, unknown>) ?? {},
    notify: Boolean(row.notify),
    digest: Boolean(row.digest),
    matches: counts.get(String(row.id)) ?? 0,
    lastMatchedAt: typeof row.last_matched_at === 'string' ? row.last_matched_at : null,
    createdAt: String(row.created_at ?? ''),
  }));
}

export interface CatalogueEvent {
  readonly kind: string;
  readonly titleKey: string;
  readonly priority: 'critical' | 'normal' | 'low';
  readonly channels: readonly string[];
  readonly critical: boolean;
}

/**
 * The event catalogue for the admin preview.
 *
 * Read through the `dispatch` action rather than the table: the policy is enforced in one place, and the
 * preview shows what the sender would see rather than what a client is allowed to guess. A non-staff session
 * gets an empty list and the page renders its "staff only" state.
 */
export async function loadNotificationCatalogue(): Promise<{
  readonly configured: boolean;
  readonly timezone: string;
  readonly events: readonly CatalogueEvent[];
}> {
  // Server-side, so the gateway proxy rather than the browser client: `getApiClient` is a `'use client'`
  // module and calling it from a server component throws at render time (it did, on this page).
  const result = await callGateway<{ timezone?: string; items?: CatalogueEvent[] }>('dispatch', {
    action: 'notifications.catalogue',
  });
  if (!result.ok) return { configured: false, timezone: 'Asia/Aden', events: [] };
  const data = result.data;

  return {
    configured: true,
    timezone: data.timezone ?? 'Asia/Aden',
    events: data.items ?? [],
  };
}
