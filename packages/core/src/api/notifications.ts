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

// Re-exported because every helper below takes one: a caller of the templates should not need a second import.
export type { Locale };

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
  // Added after the first pass: §6.10 named these and no earlier phase could send them.
  'subscription_plan_changed',
  'agent_cash_in_settled',
  'no_show_alert',
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
  /** One summary a day instead of a message per trip. Optional, because a client that does not care omits it. */
  digest: z.boolean().optional(),
});

export const listSearchesSchema = z.object({
  action: z.literal('search.list'),
});

export const updateSearchSchema = z.object({
  action: z.literal('search.update'),
  id: uuid,
  notify: z.boolean().optional(),
  digest: z.boolean().optional(),
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
    'search-digest',
    'trip-reminders',
    'no-shows',
    'quota',
    'expiring',
    'verification-sla',
    'retry',
  ]),
  limit: z.number().int().min(1).max(1000).default(200),
  /**
   * `trip-reminders` only. The three bands are the plan's three reminders: "tomorrow", "in 2 h" and
   * "departing now". Omitted means all three, which is what the scheduler should ask for.
   */
  bands: z
    .array(z.enum(['tomorrow', 'soon', 'departure']))
    .min(1)
    .max(3)
    .nullish()
    .transform((value) => (value == null ? null : value)),
});

/** Staff: the event catalogue behind the admin preview screen. */
export const notificationCatalogueSchema = z.object({
  action: z.literal('notifications.catalogue'),
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
  notificationCatalogueSchema,
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
          p_digest: input.digest ?? false,
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
          p_digest: input.digest ?? null,
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
    case 'notifications.catalogue':
      return { fn: 'cmd_get_notification_catalogue', args: { p_actor: actorId } };
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
    case 'search-digest':
      return { fn: 'cmd_digest_saved_searches', args: { p_actor: actorId } };
    case 'trip-reminders':
      return {
        fn: 'cmd_send_trip_reminders',
        args: { p_actor: actorId, p_bands: input.bands },
      };
    case 'no-shows':
      return {
        fn: 'cmd_notify_no_shows',
        args: { p_actor: actorId, p_grace: '45 minutes' },
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
  // A plan code in the middle of a sentence is a leak, exactly like a metric name: `pro` is not a word.
  plan: { prefix: 'plan.', fallback: 'plan.basic' },
  from: { prefix: 'plan.', fallback: 'plan.basic' },
  to: { prefix: 'plan.', fallback: 'plan.basic' },
  status: { prefix: 'sub.status.', fallback: 'sub.status.active' },
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

  const target = options.fallbackLocale ?? locale;
  const baseKey = item.titleKey as TranslationKey;
  const count = typeof params.count === 'number' ? params.count : Number(params.count);

  // A count-bearing event carries one base key and six forms (`.zero` … `.other`): Arabic needs all six, and
  // the template with the right agreement is chosen here so no call site has to remember the rules.
  if (Number.isFinite(count)) {
    for (const key of [
      `${baseKey}.${pluralCategory(target, count)}`,
      `${baseKey}.other`,
    ] as const) {
      const text = translate(target, key as TranslationKey, params);
      if (text !== key) return text;
    }
  }

  return translate(target, baseKey, params);
}

// ---------------------------------------------------------------------------------------------
// Plurals
// ---------------------------------------------------------------------------------------------

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/**
 * CLDR plural categories, written out instead of imported.
 *
 * `Intl.PluralRules` exists in Node and in browsers but not reliably in Hermes (the engine behind the mobile
 * app), and the rules for the two locales this product ships are six lines. A hand-written rule that a test can
 * pin beats a platform feature that silently falls back to English in the app.
 */
export function pluralCategory(locale: Locale, count: number): PluralCategory {
  const n = Math.abs(Math.trunc(count));
  if (locale === 'ar') {
    if (n === 0) return 'zero';
    if (n === 1) return 'one';
    if (n === 2) return 'two';
    const mod100 = n % 100;
    if (mod100 >= 3 && mod100 <= 10) return 'few';
    if (mod100 >= 11 && mod100 <= 99) return 'many';
    return 'other';
  }
  return n === 1 ? 'one' : 'other';
}

/**
 * A count-bearing string, in the form its number asks for: `translateCount('ar', 'notifications.unread', 2)`.
 *
 * Falls back to `<key>.other` and then to the bare key, so a string with no plural forms still renders.
 */
export function translateCount(
  locale: Locale,
  /** The base key; the caller may pass one that is not a literal (`notifications.unread`), hence `string`. */
  baseKey: string,
  count: number,
  vars: Record<string, string | number> = {},
): string {
  const params = { count, ...vars };
  for (const key of [`${baseKey}.${pluralCategory(locale, count)}`, `${baseKey}.other`]) {
    const text = translate(locale, key as TranslationKey, params);
    if (text !== key) return text;
  }
  return translate(locale, baseKey as TranslationKey, params);
}

// ---------------------------------------------------------------------------------------------
// Bidi
// ---------------------------------------------------------------------------------------------

export interface TextSegment {
  readonly text: string;
  /** True for a run that is Latin/digits — a trip code, a price, a date — inside Arabic prose. */
  readonly latin: boolean;
}

/**
 * Splits a rendered sentence into Arabic and Latin runs.
 *
 * `BK-3C9923` inside an Arabic sentence is bidirectionally ambiguous: without isolation the hyphen and the
 * digits can reorder, so «حجزك BK-3C9923 على…» can render with the code's tail in the wrong place. The web
 * renderer wraps the Latin runs in `<bdi>`; this function is the split, so the decision is testable without a
 * browser.
 */
export function splitBidi(text: string): readonly TextSegment[] {
  const segments: TextSegment[] = [];
  const pattern = /[A-Za-z0-9][A-Za-z0-9\-_/:.,%+()#]*/g;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    // A full stop after a code belongs to the sentence, not to the code: isolating it would move the Arabic
    // sentence's punctuation to the end of a left-to-right run.
    const trailing = /[.,:;]+$/.exec(match[0])?.[0] ?? '';
    const run = match[0].slice(0, match[0].length - trailing.length);
    if (start > cursor) segments.push({ text: text.slice(cursor, start), latin: false });
    if (run !== '') segments.push({ text: run, latin: true });
    if (trailing !== '') segments.push({ text: trailing, latin: false });
    cursor = start + match[0].length;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), latin: false });
  return segments;
}

// ---------------------------------------------------------------------------------------------
// Preview samples
// ---------------------------------------------------------------------------------------------

/**
 * One realistic payload per event, for the admin preview and for the placeholder test.
 *
 * This is the "template registry" in the form that cannot rot: a template whose placeholders are not covered
 * here fails a test, so an event cannot ship with `{reason}` in it and no idea where `reason` comes from.
 */
export const SAMPLE_PARAMS: Record<NotificationKind, Readonly<Record<string, string | number>>> = {
  verification_submitted: {},
  verification_approved: {},
  verification_rejected: {},
  verification_invalidated: {},
  member_invited: {},
  member_joined: {},
  member_removed: {},
  role_granted: {},
  role_revoked: {},
  booking_requested: { code: 'BK-3C9923', tripCode: 'AD-SA-2988', seats: 2 },
  booking_accepted: { code: 'BK-3C9923', tripCode: 'AD-SA-2988' },
  booking_rejected: { code: 'BK-3C9923', tripCode: 'AD-SA-2988', reason: 'المقاعد لم تعد متاحة' },
  booking_cancelled: { code: 'BK-3C9923', tripCode: 'AD-SA-2988' },
  vehicle_maintenance_due: { plate: 'عدن 12-345', due: '2026-11-20' },
  vehicle_maintenance_overdue: { plate: 'عدن 12-345', due: '2026-10-30' },
  vehicle_fuel_anomaly: { plate: 'عدن 12-345', value: '18,500', baseline: '9,200' },
  payment_submitted: { amount: '2,500', code: 'BK-3C9923' },
  payment_confirmed: { amount: '2,500', code: 'BK-3C9923' },
  payment_rejected: { code: 'BK-3C9923', reason: 'المبلغ لا يطابق الإيصال' },
  refund_decided: { amount: '2,500', code: 'BK-3C9923' },
  payout_decided: { code: 'PO-EE386F', amount: '48,000' },
  invoice_issued: { code: 'INV-684967', amount: '7,500' },
  subscription_activated: { plan: 'pro', status: 'active' },
  subscription_past_due: { plan: 'pro' },
  subscription_expired: { plan: 'business' },
  finance_alert: { failed: 2 },
  saved_search_match: {
    origin: 'عدن',
    destination: 'صنعاء',
    departureAt: '2026-11-06T07:30',
    price: '4,500',
    seats: 3,
    tripCode: 'AD-SA-2988',
  },
  trip_reminder: {
    tripCode: 'AD-SA-2988',
    bookingCode: 'BK-3C9923',
    band: 'tomorrow',
    origin: 'عدن',
    destination: 'صنعاء',
    departureAt: '2026-11-06T07:30',
  },
  quota_threshold: { percent: 80, metric: 'finance_exports', used: 8, limit: 10 },
  subscription_expiring: { endsAt: '2026-11-08' },
  verification_sla: { subjectType: 'organization', ageHours: 52 },
  subscription_plan_changed: { from: 'pro', to: 'business', effective: '2026-11-01' },
  agent_cash_in_settled: { amount: '120,000', balance: '35,000' },
  no_show_alert: { tripCode: 'AD-SA-2988', count: 3, minutes: 45 },
};

/** The sample payload for one event, or an empty object for a kind the client does not know yet. */
export function sampleParamsFor(kind: NotificationKind | string): Record<string, string | number> {
  const samples = SAMPLE_PARAMS[kind as NotificationKind];
  return samples ? { ...samples } : {};
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
  'search-digest': 'cmd_digest_saved_searches',
  'trip-reminders': 'cmd_send_trip_reminders',
  'no-shows': 'cmd_notify_no_shows',
  quota: 'cmd_notify_quota_thresholds',
  expiring: 'cmd_notify_subscription_expiring',
  'verification-sla': 'cmd_notify_pending_verifications',
  retry: 'cmd_retry_notifications',
} as const satisfies Record<NotificationJob, string>;
