/**
 * Notifications — the contract between the inbox, the preferences screen, the saved searches, the
 * dispatcher and the gateway (Phase 11).
 *
 * One edge function (`dispatch`) answers on `action`, and every action maps to exactly one `cmd_*` from
 * migration 00032. The interesting part of this file is not the dispatch table; it is the three pure
 * helpers at the bottom, and the reason they are here rather than in a component:
 *
 *   1. **`notificationText`** renders a notification from its key and its values. The database stores a key
 *      and JSON, never a translated sentence, so one row can be read in Arabic and English — and every
 *      screen that shows a notification must render it the same way. The parameter names that are
 *      *identifiers* (`metric`, `subjectType`) are translated here, because a support agent reading
 *      `finance_exports` in an Arabic sentence is reading a database column, not a message.
 *   2. **`quietWindow`** is the arithmetic the UI previews and the SQL enforces. It lives in TypeScript as
 *      well because the settings screen has to say "your 23:00 notification will arrive at 06:00" before
 *      the user saves anything, and it must agree with the server.
 *   3. **`describeSavedSearch`** turns a filter payload into «عدن ← صنعاء · حتى 5,000 ر.ي» — the sentence a
 *      user recognises as the search they saved, rather than the JSON they typed.
 */

import { z } from 'zod';

import { translate, type TranslationKey } from '../i18n/dictionaries';
import type { Locale } from '../i18n/locale';
import type { Resource } from '../domain/policy';
import { compactTripFilters, tripFiltersSchema } from './trips';

const uuid = z.string().uuid();

/** Kept in step with the `notification_kind` enum after 00032. */
export const notificationKindSchema = z.enum([
  'verification_submitted',
  'verification_approved',
  'verification_rejected',
  'verification_invalidated',
  'member_invited',
  'member_joined',
  'member_removed',
  'role_granted',
  'role_revoked',
  'booking_requested',
  'booking_accepted',
  'booking_rejected',
  'booking_cancelled',
  'vehicle_maintenance_due',
  'vehicle_maintenance_overdue',
  'vehicle_fuel_anomaly',
  'payment_submitted',
  'payment_confirmed',
  'payment_rejected',
  'refund_decided',
  'payout_decided',
  'invoice_issued',
  'subscription_activated',
  'subscription_past_due',
  'subscription_expired',
  'finance_alert',
  'saved_search_match',
  'trip_reminder',
  'quota_threshold',
  'subscription_expiring',
  'verification_sla',
]);

export type NotificationKind = z.infer<typeof notificationKindSchema>;

export const notificationChannelSchema = z.enum(['in_app', 'push', 'email', 'whatsapp']);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const notificationPrioritySchema = z.enum(['critical', 'normal', 'low']);
export type NotificationPriority = z.infer<typeof notificationPrioritySchema>;

export const notificationDeliveryStatusSchema = z.enum([
  'pending',
  'sending',
  'sent',
  'skipped',
  'failed',
  'dead',
]);
export type NotificationDeliveryStatus = z.infer<typeof notificationDeliveryStatusSchema>;

/** `HH:MM`, because that is what a time input produces and what the command accepts. */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

export const listNotificationsSchema = z.object({
  action: z.literal('notifications.list'),
  limit: z.number().int().min(1).max(100).default(30),
  /** Cursor from the previous page: `createdAt` of the oldest item shown. */
  before: z
    .string()
    .datetime({ offset: true })
    .nullish()
    .transform((value) => value ?? null),
});

export const readNotificationsSchema = z.object({
  action: z.literal('notifications.read'),
  /** `null` = everything unread. */
  ids: z
    .array(uuid)
    .max(200)
    .nullish()
    .transform((value) => value ?? null),
});

export const notificationSettingsSchema = z.object({
  action: z.literal('notifications.settings'),
});

export const setPreferenceSchema = z.object({
  action: z.literal('notifications.preference.set'),
  kind: notificationKindSchema,
  // `in_app` is refused by the command, not by the schema: the reason ("it is the record of the event")
  // belongs in one place, and the SQL already owns it.
  channel: notificationChannelSchema,
  enabled: z.boolean(),
});

export const resetPreferenceSchema = z.object({
  action: z.literal('notifications.preference.reset'),
  kind: notificationKindSchema,
});

export const updateNotificationSettingsSchema = z.object({
  action: z.literal('notifications.settings.update'),
  quietHoursEnabled: z.boolean(),
  quietStart: clockTime,
  quietEnd: clockTime,
});

export const registerDeviceSchema = z.object({
  action: z.literal('notifications.device.register'),
  platform: z.enum(['ios', 'android', 'web']),
  token: z.string().trim().min(8).max(400),
});

export const revokeDeviceSchema = z.object({
  action: z.literal('notifications.device.revoke'),
  deviceId: uuid,
});

export const notificationHealthSchema = z.object({
  action: z.literal('notifications.health'),
});

/** The filters are the marketplace's, imported rather than re-declared so the two vocabularies cannot drift. */
export const saveSearchSchema = z.object({
  action: z.literal('search.save'),
  filters: tripFiltersSchema,
  label: z
    .string()
    .trim()
    .max(80)
    .nullish()
    .transform((value) => (value == null || value === '' ? null : value))
    .optional(),
  notify: z.boolean().default(true),
});

export const listSearchesSchema = z.object({
  action: z.literal('search.list'),
});

export const updateSearchSchema = z.object({
  action: z.literal('search.update'),
  id: uuid,
  notify: z.boolean().optional(),
  label: z
    .string()
    .trim()
    .max(80)
    .nullish()
    .transform((value) => (value == null || value === '' ? null : value))
    .optional(),
});

export const deleteSearchSchema = z.object({
  action: z.literal('search.delete'),
  id: uuid,
});

/** The worker. One claim per call; the transport then records what happened. */
export const claimNotificationsSchema = z.object({
  action: z.literal('notifications.dispatch'),
  limit: z.number().int().min(1).max(200).default(20),
});

export const recordDeliverySchema = z.object({
  action: z.literal('notifications.delivery.record'),
  deliveryId: uuid,
  outcome: z.enum(['sent', 'failed', 'skipped']),
  error: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((value) => (value == null || value === '' ? null : value)),
  providerRef: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((value) => (value == null || value === '' ? null : value)),
});

export const notificationJobSchema = z.object({
  action: z.literal('notifications.job.run'),
  job: z.enum([
    'saved-searches',
    'trip-reminders',
    'quota',
    'expiring',
    'verification-sla',
    'retry',
  ]),
  limit: z.number().int().min(1).max(1000).default(200),
  /** `trip-reminders` only: how far ahead the reminder looks. */
  hours: z.number().int().min(1).max(72).default(24),
});

export const notificationActionSchema = z.discriminatedUnion('action', [
  listNotificationsSchema,
  readNotificationsSchema,
  notificationSettingsSchema,
  setPreferenceSchema,
  resetPreferenceSchema,
  updateNotificationSettingsSchema,
  registerDeviceSchema,
  revokeDeviceSchema,
  notificationHealthSchema,
  saveSearchSchema,
  listSearchesSchema,
  updateSearchSchema,
  deleteSearchSchema,
  claimNotificationsSchema,
  recordDeliverySchema,
  notificationJobSchema,
]);

export type NotificationAction = z.infer<typeof notificationActionSchema>;
export type NotificationJob = z.infer<typeof notificationJobSchema>['job'];

export interface NotificationCommand {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}

/**
 * Which rows the action is about, for the policy check.
 *
 * Everything here is "my own rows": the command derives the user from the session, so there is no owner to
 * name and nothing to scope. The worker and the health view are the exceptions, and their capability is
 * what gates them.
 */
export function notificationScope(_input: NotificationAction): Resource {
  return {};
}

export function notificationCommandArgs(
  input: NotificationAction,
  actorId: string,
  audit: { p_request_id?: string | null; p_ip?: string | null } = {},
): NotificationCommand {
  switch (input.action) {
    case 'notifications.list':
      return {
        fn: 'cmd_list_notifications',
        args: { p_actor: actorId, p_limit: input.limit, p_before: input.before },
      };
    case 'notifications.read':
      return {
        fn: 'cmd_mark_notifications_read',
        args: { p_actor: actorId, p_ids: input.ids, p_request_id: audit.p_request_id ?? null },
      };
    case 'notifications.settings':
      return { fn: 'cmd_get_notification_settings', args: { p_actor: actorId } };
    case 'notifications.preference.set':
      return {
        fn: 'cmd_set_notification_preference',
        args: {
          p_actor: actorId,
          p_kind: input.kind,
          p_channel: input.channel,
          p_enabled: input.enabled,
          ...audit,
        },
      };
    case 'notifications.preference.reset':
      return {
        fn: 'cmd_reset_notification_preference',
        args: { p_actor: actorId, p_kind: input.kind, ...audit },
      };
    case 'notifications.settings.update':
      return {
        fn: 'cmd_update_notification_settings',
        args: {
          p_actor: actorId,
          p_quiet_hours_enabled: input.quietHoursEnabled,
          p_quiet_start: input.quietStart,
          p_quiet_end: input.quietEnd,
          ...audit,
        },
      };
    case 'notifications.device.register':
      return {
        fn: 'cmd_register_device_token',
        args: { p_actor: actorId, p_platform: input.platform, p_token: input.token, ...audit },
      };
    case 'notifications.device.revoke':
      return {
        fn: 'cmd_revoke_device_token',
        args: { p_actor: actorId, p_id: input.deviceId, ...audit },
      };
    case 'notifications.health':
      return { fn: 'cmd_get_notification_health', args: { p_actor: actorId } };
    case 'search.save':
      return {
        fn: 'cmd_save_search',
        args: {
          p_actor: actorId,
          // The same compaction the marketplace applies, so an empty array and an absent key mean the same
          // search here and there — and the fingerprint matches what the user actually searched.
          p_filters: compactTripFilters(input.filters),
          p_label: input.label,
          p_notify: input.notify,
          ...audit,
        },
      };
    case 'search.list':
      return { fn: 'cmd_list_saved_searches', args: { p_actor: actorId } };
    case 'search.update':
      return {
        fn: 'cmd_update_saved_search',
        args: {
          p_actor: actorId,
          p_id: input.id,
          p_notify: input.notify ?? null,
          p_label: input.label,
          ...audit,
        },
      };
    case 'search.delete':
      return {
        fn: 'cmd_delete_saved_search',
        args: { p_actor: actorId, p_id: input.id, ...audit },
      };
    case 'notifications.dispatch':
      return {
        fn: 'cmd_claim_notifications',
        args: { p_actor: actorId, p_limit: input.limit, ...audit },
      };
    case 'notifications.delivery.record':
      return {
        fn: 'cmd_record_notification_delivery',
        args: {
          p_actor: actorId,
          p_delivery_id: input.deliveryId,
          p_outcome: input.outcome,
          p_error: input.error,
          p_provider_ref: input.providerRef,
          ...audit,
        },
      };
    case 'notifications.job.run':
      return jobArgs(input.job, input, actorId);
  }
}

function jobArgs(
  job: NotificationJob,
  input: z.infer<typeof notificationJobSchema>,
  actorId: string,
): NotificationCommand {
  switch (job) {
    case 'saved-searches':
      return {
        fn: 'cmd_match_saved_searches',
        args: { p_actor: actorId, p_limit: input.limit, p_per_search: 3 },
      };
    case 'trip-reminders':
      return {
        fn: 'cmd_send_trip_reminders',
        args: { p_actor: actorId, p_hours: input.hours, p_band: '1 hour' },
      };
    case 'quota':
      return { fn: 'cmd_notify_quota_thresholds', args: { p_actor: actorId, p_period: null } };
    case 'expiring':
      return { fn: 'cmd_notify_subscription_expiring', args: { p_actor: actorId } };
    case 'verification-sla':
      return {
        fn: 'cmd_notify_pending_verifications',
        args: { p_actor: actorId, p_sla: '48 hours' },
      };
    case 'retry':
      return { fn: 'cmd_retry_notifications', args: { p_actor: actorId, p_max_age: '7 days' } };
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

export interface NotificationLike {
  readonly kind: NotificationKind | string;
  readonly titleKey: string;
  readonly params: Record<string, unknown> | null;
}

/**
 * Parameter names whose *value* is an identifier, not a word.
 *
 * The database cannot localise these — it has no dictionary and should not grow one — so the rendering step
 * does it. A value with no translation falls back to a generic label rather than printing the raw enum:
 * `finance_exports` in the middle of an Arabic sentence is a leak, not a message.
 */
const PARAM_LABELS: Record<string, { prefix: string; fallback: TranslationKey }> = {
  metric: { prefix: 'metric.', fallback: 'metric.other' },
  subjectType: { prefix: 'staff.type.', fallback: 'staff.type.individual' },
};

/**
 * The rendered sentence, with identifier-shaped parameters translated first.
 *
 * Interpolation keeps unknown placeholders visible (`{code}`), so a missing variable is a visible bug in QA
 * rather than the word `undefined` on a passenger's phone.
 */
export function notificationText(
  locale: Locale,
  item: NotificationLike,
  options: { fallbackLocale?: Locale } = {},
): string {
  const params: Record<string, string | number> = {};

  for (const [name, value] of Object.entries(item.params ?? {})) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const label = PARAM_LABELS[name];
    if (label && typeof value === 'string') {
      // `translate` answers with the key itself when it does not know it, which is the test for "no such
      // metric" — the fallback exists so the sentence still reads as a sentence.
      const translated = translate(locale, `${label.prefix}${value}` as TranslationKey);
      params[name] = translated.startsWith(label.prefix)
        ? translate(locale, label.fallback)
        : translated;
      continue;
    }
    params[name] = value;
  }

  return translate(options.fallbackLocale ?? locale, item.titleKey as TranslationKey, params);
}

// ---------------------------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------------------------

export interface QuietWindow {
  readonly enabled: boolean;
  /** `HH:MM`, 24-hour, Aden time. */
  readonly start: string;
  readonly end: string;
}

/** Minutes since midnight for an `HH:MM` string. Total, so callers never handle a bad value. */
export function minutesOfDay(clock: string): number {
  const [rawHours = '0', rawMinutes = '0'] = clock.split(':');
  const hours = Number.parseInt(rawHours, 10);
  const minutes = Number.parseInt(rawMinutes, 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return Math.min(23, Math.max(0, hours)) * 60 + Math.min(59, Math.max(0, minutes));
}

/**
 * Is `at` inside the window? Handles the wrap past midnight as two comparisons, the same way the SQL does —
 * a window of 22:00–06:00 is "late tonight or early tomorrow", and one clever modulo expression is how that
 * becomes "late tonight only".
 */
export function inQuietWindow(
  window: QuietWindow,
  at: { hours: number; minutes: number },
): boolean {
  if (!window.enabled) return false;
  const start = minutesOfDay(window.start);
  const end = minutesOfDay(window.end);
  const now = at.hours * 60 + at.minutes;
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

/**
 * When a message raised at 23:00 will actually arrive.
 *
 * Returns the clock time of the next `end`, which is what the settings screen promises: "anything normal
 * waits until 06:00".
 */
export function quietResumeClock(
  window: QuietWindow,
  at: { hours: number; minutes: number },
): { clock: string; nextDay: boolean } {
  // Before the resume hour we are in the tail of last night's window; after it, the window that is open now
  // ends tomorrow morning — which is the difference between "in six hours" and "in thirty hours".
  return { clock: window.end, nextDay: minutesOfDay(window.end) <= at.hours * 60 + at.minutes };
}

// ---------------------------------------------------------------------------------------------
// Saved searches
// ---------------------------------------------------------------------------------------------

export interface SavedSearchLabels {
  readonly origin?: string;
  readonly destination?: string;
}

export type SavedSearchFilters = z.infer<typeof tripFiltersSchema>;

/**
 * «عدن ← صنعاء · حتى 5,000 ر.ي · بدون توقف»
 *
 * Built from the same filter payload the marketplace uses, so the chip the user sees on their saved-search
 * card is the search they will actually get alerts for. Place names are resolved by the caller (it has the
 * gazetteer); everything else is derived here.
 */
export function describeSavedSearch(
  filters: Partial<SavedSearchFilters>,
  labels: SavedSearchLabels = {},
  options: { locale?: Locale } = {},
): string {
  const locale = options.locale ?? 'ar';
  const parts: string[] = [];
  const from = labels.origin;
  const to = labels.destination;
  if (from || to) {
    parts.push(`${from ?? '—'} ← ${to ?? '—'}`);
  }
  if (typeof filters.priceMax === 'number') {
    // Latin digits even in Arabic: the product's default is western numerals (`profiles.preferred_numerals`),
    // and a price that flips between ٥٬٠٠٠ and 5,000 across two screens is a support call.
    const amount = new Intl.NumberFormat(locale === 'ar' ? 'ar-YE-u-nu-latn' : 'en-US', {
      maximumFractionDigits: 0,
      useGrouping: true,
    }).format(filters.priceMax);
    parts.push(translate(locale, 'search.upTo', { amount }));
  }
  if (filters.direct === true) parts.push(translate(locale, 'search.directOnly'));
  if (filters.dateFrom) {
    parts.push(`${translate(locale, 'search.from')} ${filters.dateFrom}`);
  }
  if (filters.q) parts.push(`«${filters.q}»`);
  return parts.length > 0 ? parts.join(' · ') : translate(locale, 'search.anyTrip');
}

/**
 * The tone a delivery status deserves in the UI.
 *
 * `skipped` is deliberately neutral, not a warning: the user asked for it, and colouring it red is how a
 * preference becomes a support ticket.
 */
export function deliveryStatusTone(
  status: NotificationDeliveryStatus,
): 'success' | 'info' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'sent':
      return 'success';
    case 'pending':
    case 'sending':
      return 'info';
    case 'skipped':
      return 'neutral';
    case 'failed':
      return 'warning';
    case 'dead':
      return 'danger';
  }
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

/**
 * What the worker claimed. Mirrors the item shape `cmd_claim_notifications` returns, so the worker does not
 * need a second type for the same row.
 */
export interface ClaimedDelivery {
  readonly deliveryId: string;
  readonly notificationId: string;
  readonly userId: string;
  readonly channel: NotificationChannel;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly kind: NotificationKind | string;
  readonly priority: NotificationPriority;
  readonly titleKey: string;
  readonly params: Readonly<Record<string, unknown>> | null;
  readonly link: string | null;
  readonly locale: string;
  readonly tokens: readonly string[];
  readonly phone: string | null;
  readonly createdAt: string;
}

export interface ExpoPushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly sound: 'default' | null;
  readonly priority: 'default' | 'high';
  readonly data: { readonly notificationId: string; readonly link: string | null };
}

/**
 * What Expo receives for one delivery.
 *
 * The body is the notification's own sentence — the same string the inbox shows — because a push that says
 * "you have a new notification" is a push people learn to ignore. `sound` is null for `low` priority: a
 * maintenance reminder may wait for the phone to be picked up, and a silent banner is the honest version of
 * "not urgent".
 */
export function expoPushMessages(
  item: ClaimedDelivery,
  text: string,
  options: { appName?: string } = {},
): ExpoPushMessage[] {
  const low = item.priority === 'low';
  return item.tokens.map((to) => ({
    to,
    title: options.appName ?? '',
    body: text,
    sound: low ? null : 'default',
    priority: low ? 'default' : 'high',
    data: { notificationId: item.notificationId, link: item.link },
  }));
}

export interface EmailMessage {
  readonly subject: string;
  readonly text: string;
}

/**
 * Email is the channel that has to survive being read on a laptop a week later, so it carries the link in
 * plain text rather than as a button that needs a renderer. The subject is the sentence: an inbox is a list
 * of subjects, and "Maak notification" tells the reader nothing.
 */
export function emailMessage(
  item: ClaimedDelivery,
  text: string,
  options: { appName?: string; baseUrl?: string } = {},
): EmailMessage {
  const url = item.link ? `${options.baseUrl ?? ''}/${item.locale}${item.link}` : null;
  return {
    subject: text,
    text: url ? `${text}\n\n${url}` : text,
  };
}

/**
 * WhatsApp is a *deep link*, not an API call: the platform does not have a WhatsApp Business account, and
 * pretending to send would be a lie in the delivery trail. The worker records this as sent-with-a-link and
 * the operator's client opens it.
 */
export function whatsappDeepLink(phone: string, text: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export const notificationResultSchema = z.record(z.string(), z.unknown());

export const notificationCommandSpec = {
  path: 'dispatch',
  input: notificationActionSchema,
  output: notificationResultSchema,
  mutating: true,
} as const;

/** The jobs a cron may run, named once so the worker script and the edge function agree. */
export const NOTIFICATION_JOB_FN = {
  'saved-searches': 'cmd_match_saved_searches',
  'trip-reminders': 'cmd_send_trip_reminders',
  quota: 'cmd_notify_quota_thresholds',
  expiring: 'cmd_notify_subscription_expiring',
  'verification-sla': 'cmd_notify_pending_verifications',
  retry: 'cmd_retry_notifications',
} as const;
