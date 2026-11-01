import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_JOB_FN,
  SAMPLE_PARAMS,
  describeSavedSearch,
  emailMessage,
  expoPushMessages,
  inQuietWindow,
  minutesOfDay,
  notificationActionSchema,
  notificationCommandArgs,
  notificationJobSchema,
  notificationScope,
  notificationText,
  pluralCategory,
  quietResumeClock,
  sampleParamsFor,
  splitBidi,
  translateCount,
  whatsappDeepLink,
  type ClaimedDelivery,
  type Locale,
  type NotificationAction,
} from '../src/api/notifications';
import { notificationKindSchema } from '../src/api/notifications';
import { translate, type TranslationKey } from '../src/i18n/dictionaries';

const kindOptions = notificationKindSchema.options;

const actor = '11111111-1111-4111-8111-111111111111';
const deliveryId = '22222222-2222-4222-8222-222222222222';
const audit = { p_request_id: 'req-1', p_ip: null } as const;

function parse(input: unknown): NotificationAction {
  return notificationActionSchema.parse(input);
}

const delivery: ClaimedDelivery = {
  deliveryId,
  notificationId: '33333333-3333-4333-8333-333333333333',
  userId: '44444444-4444-4444-8444-444444444444',
  channel: 'push',
  attempts: 1,
  maxAttempts: 5,
  kind: 'booking_accepted',
  priority: 'normal',
  titleKey: 'notifications.bookingAccepted',
  params: { code: 'BK-7F3A9C', tripCode: 'SA-AD-7K2Q' },
  link: '/account/bookings/abc',
  locale: 'ar',
  tokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'],
  phone: null,
  createdAt: '2026-03-06T20:00:00.000Z',
};

/**
 * Rendering is the part of notifications that reaches a person, so it is tested against the real
 * dictionaries rather than a fixture: a key that exists in one locale and not the other is the bug this
 * suite exists to catch.
 */
describe('notificationText', () => {
  it('renders a complete Arabic sentence from the key and its values', () => {
    expect(notificationText('ar', delivery)).toBe('تم قبول حجزك BK-7F3A9C على الرحلة SA-AD-7K2Q.');
  });

  it('renders the same event in English', () => {
    expect(notificationText('en', delivery)).toBe(
      'Your booking BK-7F3A9C on trip SA-AD-7K2Q was accepted.',
    );
  });

  it('leaves no placeholder behind when every value is present', () => {
    const text = notificationText('ar', delivery);
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it('translates identifier-shaped parameters instead of printing the enum', () => {
    // The database stores `finance_exports`; the reader must see «التصديرات شهريًا».
    const text = notificationText('ar', {
      kind: 'quota_threshold',
      titleKey: 'notifications.quotaReached',
      params: { metric: 'finance_exports', used: 10, limit: 10 },
    });
    expect(text).toContain('التصديرات شهريًا');
    expect(text).not.toContain('finance_exports');
  });

  it('falls back to a generic label for a metric it does not know', () => {
    const text = notificationText('en', {
      kind: 'quota_threshold',
      titleKey: 'notifications.quotaWarning',
      params: { metric: 'something_new', used: 4, limit: 5, percent: 80 },
    });
    expect(text).toContain('Another metric');
    expect(text).not.toContain('something_new');
  });

  it('translates the verification subject type', () => {
    const text = notificationText('ar', {
      kind: 'verification_sla',
      titleKey: 'notifications.verificationSla',
      params: { subjectType: 'organization', ageHours: 72 },
    });
    expect(text).toContain('شركة');
    expect(text).not.toContain('organization');
  });

  it('keeps an unknown placeholder visible rather than printing undefined', () => {
    const text = notificationText('en', {
      kind: 'booking_accepted',
      titleKey: 'notifications.bookingAccepted',
      params: { code: 'BK-1' },
    });
    expect(text).toContain('{tripCode}');
    expect(text).not.toContain('undefined');
  });
});

describe('quiet hours', () => {
  const window = { enabled: true, start: '22:00', end: '06:00' };

  it('reads a clock string as minutes since midnight', () => {
    expect(minutesOfDay('00:00')).toBe(0);
    expect(minutesOfDay('06:30')).toBe(390);
    expect(minutesOfDay('23:59')).toBe(1439);
  });

  it('treats a bad clock as midnight rather than NaN', () => {
    expect(minutesOfDay('not a time')).toBe(0);
  });

  it('is quiet at 23:00 and not at 21:30', () => {
    expect(inQuietWindow(window, { hours: 23, minutes: 0 })).toBe(true);
    expect(inQuietWindow(window, { hours: 21, minutes: 30 })).toBe(false);
  });

  it('covers the hours after midnight, which is the whole point of a wrap-around window', () => {
    expect(inQuietWindow(window, { hours: 3, minutes: 0 })).toBe(true);
    expect(inQuietWindow(window, { hours: 6, minutes: 0 })).toBe(false);
  });

  it('handles a window that does not wrap', () => {
    const midday = { enabled: true, start: '12:00', end: '14:00' };
    expect(inQuietWindow(midday, { hours: 13, minutes: 0 })).toBe(true);
    expect(inQuietWindow(midday, { hours: 15, minutes: 0 })).toBe(false);
    expect(inQuietWindow(midday, { hours: 23, minutes: 0 })).toBe(false);
  });

  it('is never quiet when the switch is off', () => {
    expect(inQuietWindow({ ...window, enabled: false }, { hours: 23, minutes: 0 })).toBe(false);
  });

  it('promises the 06:00 the server would use', () => {
    expect(quietResumeClock(window, { hours: 23, minutes: 0 })).toEqual({
      clock: '06:00',
      nextDay: true,
    });
    expect(quietResumeClock(window, { hours: 3, minutes: 0 })).toEqual({
      clock: '06:00',
      nextDay: false,
    });
  });
});

describe('transport payloads', () => {
  it('sends one push per device, with the sentence as the body', () => {
    const messages = expoPushMessages(delivery, 'تم قبول حجزك BK-7F3A9C.');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      to: 'ExponentPushToken[a]',
      title: '',
      body: 'تم قبول حجزك BK-7F3A9C.',
      sound: 'default',
      priority: 'high',
      data: { notificationId: delivery.notificationId, link: delivery.link },
    });
  });

  it('silences a low-priority message instead of buzzing for it', () => {
    const [message] = expoPushMessages({ ...delivery, priority: 'low' }, 'x');
    expect(message?.sound).toBeNull();
    expect(message?.priority).toBe('default');
  });

  it('carries the link in the email body, because a week-old email is read on a laptop', () => {
    const mail = emailMessage(delivery, 'Your booking was accepted.', {
      baseUrl: 'https://maak.test',
    });
    expect(mail.subject).toBe('Your booking was accepted.');
    expect(mail.text).toContain('https://maak.test/ar/account/bookings/abc');
  });

  it('builds a WhatsApp deep link, not a promise that WhatsApp delivered anything', () => {
    expect(whatsappDeepLink('+967 733 940 001', 'رحلتك غدًا')).toBe(
      'https://wa.me/967733940001?text=%D8%B1%D8%AD%D9%84%D8%AA%D9%83%20%D8%BA%D8%AF%D9%8B%D8%A7',
    );
  });
});

describe('describeSavedSearch', () => {
  it('describes route, price cap and directness in one line', () => {
    const text = describeSavedSearch(
      { priceMax: 5000, direct: true },
      { origin: 'عدن', destination: 'صنعاء' },
      { locale: 'ar' },
    );
    expect(text).toContain('عدن');
    expect(text).toContain('صنعاء');
    expect(text).toContain('5');
    expect(text).toContain('بدون توقف');
  });

  it('says "any trip" when nothing is set', () => {
    expect(describeSavedSearch({}, {}, { locale: 'en' })).toBe('any trip');
  });

  it('keeps a free-text query quoted, so it is not confused with a place', () => {
    const text = describeSavedSearch({ q: 'هايس' }, {}, { locale: 'ar' });
    expect(text).toBe('«هايس»');
  });
});

describe('notification actions', () => {
  it('maps the inbox to the listing command with a bounded limit', () => {
    const input = parse({ action: 'notifications.list' });
    expect(notificationCommandArgs(input, actor, audit)).toEqual({
      fn: 'cmd_list_notifications',
      args: { p_actor: actor, p_limit: 30, p_before: null },
    });
  });

  it('rejects a limit that would let a client page the whole table', () => {
    expect(() => parse({ action: 'notifications.list', limit: 500 })).toThrow();
  });

  it('maps a preference switch to one row per event and channel', () => {
    const input = parse({
      action: 'notifications.preference.set',
      kind: 'booking_accepted',
      channel: 'email',
      enabled: false,
    });
    expect(notificationCommandArgs(input, actor, audit).args).toEqual({
      p_actor: actor,
      p_kind: 'booking_accepted',
      p_channel: 'email',
      p_enabled: false,
      p_request_id: 'req-1',
      p_ip: null,
    });
  });

  it('refuses a channel the enum does not know', () => {
    expect(() =>
      parse({
        action: 'notifications.preference.set',
        kind: 'booking_accepted',
        channel: 'sms',
        enabled: true,
      }),
    ).toThrow();
  });

  it('requires an HH:MM quiet window, not a free-text time', () => {
    const base = { action: 'notifications.settings.update', quietHoursEnabled: true };
    expect(() => parse({ ...base, quietStart: '10pm', quietEnd: '06:00' })).toThrow();
    const input = parse({ ...base, quietStart: '22:30', quietEnd: '05:45' });
    expect(notificationCommandArgs(input, actor, audit).args).toMatchObject({
      p_quiet_start: '22:30',
      p_quiet_end: '05:45',
    });
  });

  it('compacts the saved-search filters the same way the marketplace does', () => {
    const input = parse({
      action: 'search.save',
      filters: {
        origin: [],
        destination: ['b0a1b0a1-b0a1-4b0a-8b0a-b0a1b0a1b0a1'],
        priceMax: 5000,
      },
    });
    const { fn, args } = notificationCommandArgs(input, actor, audit);
    expect(fn).toBe('cmd_save_search');
    expect(args.p_filters).toEqual({
      destination: ['b0a1b0a1-b0a1-4b0a-8b0a-b0a1b0a1b0a1'],
      priceMax: 5000,
    });
    expect(args.p_notify).toBe(true);
  });

  it('maps the worker claim to the claim command', () => {
    const input = parse({ action: 'notifications.dispatch', limit: 5 });
    expect(notificationCommandArgs(input, actor, audit)).toEqual({
      fn: 'cmd_claim_notifications',
      args: { p_actor: actor, p_limit: 5, p_request_id: 'req-1', p_ip: null },
    });
  });

  it('maps every job to its own command', () => {
    const map = {} as Record<string, string>;
    for (const job of [
      'saved-searches',
      'trip-reminders',
      'quota',
      'expiring',
      'verification-sla',
      'retry',
      'payments-expiry',
      'payment-reminders',
      'agent-settlements',
    ] as const) {
      map[job] = notificationCommandArgs(parse({ action: 'notifications.job.run', job }), actor).fn;
    }
    expect(map).toEqual({
      'saved-searches': 'cmd_match_saved_searches',
      'trip-reminders': 'cmd_send_trip_reminders',
      quota: 'cmd_notify_quota_thresholds',
      expiring: 'cmd_notify_subscription_expiring',
      'verification-sla': 'cmd_notify_pending_verifications',
      retry: 'cmd_retry_notifications',
      'payments-expiry': 'cmd_expire_stale_payment_intents',
      'payment-reminders': 'cmd_notify_payment_reminders',
      'agent-settlements': 'cmd_notify_agent_settlements',
    });
  });

  it('scopes nothing: every action is about the caller’s own rows', () => {
    expect(notificationScope(parse({ action: 'notifications.list' }))).toEqual({});
    expect(notificationScope(parse({ action: 'search.list' }))).toEqual({});
  });

  it('records a delivery outcome with an optional provider receipt', () => {
    const input = parse({
      action: 'notifications.delivery.record',
      deliveryId,
      outcome: 'sent',
      providerRef: 'expo:ticket-1',
    });
    expect(notificationCommandArgs(input, actor, audit).args).toMatchObject({
      p_delivery_id: deliveryId,
      p_outcome: 'sent',
      p_provider_ref: 'expo:ticket-1',
      p_error: null,
    });
  });
});

/**
 * Every action, one row: the function it calls and whether the actor travels. A missing mapping is a runtime
 * 500 the type system cannot see, so the table is exhaustive rather than illustrative.
 */
describe('action table', () => {
  const cases: readonly [NotificationAction, string][] = [
    [parse({ action: 'notifications.read', ids: null }), 'cmd_mark_notifications_read'],
    [parse({ action: 'notifications.settings' }), 'cmd_get_notification_settings'],
    [
      parse({ action: 'notifications.preference.reset', kind: 'booking_accepted' }),
      'cmd_reset_notification_preference',
    ],
    [parse({ action: 'notifications.health' }), 'cmd_get_notification_health'],
    [parse({ action: 'search.list' }), 'cmd_list_saved_searches'],
    [parse({ action: 'search.update', id: deliveryId, notify: false }), 'cmd_update_saved_search'],
    [parse({ action: 'search.delete', id: deliveryId }), 'cmd_delete_saved_search'],
  ];

  for (const [input, fn] of cases) {
    it(`${input.action} → ${fn}`, () => {
      const command = notificationCommandArgs(input, actor, audit);
      expect(command.fn).toBe(fn);
      expect(command.args.p_actor).toBe(actor);
    });
  }

  it('registers a device with the platform the app actually runs on', () => {
    const input = parse({
      action: 'notifications.device.register',
      platform: 'android',
      token: 'ExponentPushToken[abc]',
    });
    expect(notificationCommandArgs(input, actor, audit).args).toMatchObject({
      p_platform: 'android',
      p_token: 'ExponentPushToken[abc]',
    });
  });

  it('revokes a device by id, not by token', () => {
    const input = parse({ action: 'notifications.device.revoke', deviceId: deliveryId });
    expect(notificationCommandArgs(input, actor, audit).args).toEqual({
      p_actor: actor,
      p_id: deliveryId,
      p_request_id: 'req-1',
      p_ip: null,
    });
  });

  it('refuses a device token that is too short to be one', () => {
    expect(() =>
      parse({ action: 'notifications.device.register', platform: 'ios', token: 'short' }),
    ).toThrow();
  });

  it('nulls an empty search label instead of storing whitespace', () => {
    const input = parse({ action: 'search.save', filters: { q: 'عدن' }, label: '   ' });
    expect(notificationCommandArgs(input, actor, audit).args.p_label).toBeNull();
  });

  it('runs every reminder band when the caller does not choose', () => {
    const input = parse({ action: 'notifications.job.run', job: 'trip-reminders' });
    expect(notificationCommandArgs(input, actor, audit).args).toEqual({
      p_actor: actor,
      p_bands: null,
    });
  });
});

/**
 * The kinds are a contract between five places: the enum in SQL, the type in `database.types.ts`, the
 * preferences matrix, the dictionaries, and the job that raises the event. This test is the cheapest place
 * to notice a sixth place disagreeing.
 */
describe('notification kinds', () => {
  const kinds = notificationKindSchema.options;

  it('has a label in both locales for every kind', () => {
    for (const kind of kinds) {
      const key = `notifications.event.${kind}` as const;
      expect(translate('ar', key as never), `${kind} (ar)`).not.toBe(key);
      expect(translate('en', key as never), `${kind} (en)`).not.toBe(key);
    }
  });

  it('covers the five events Phase 11 introduces', () => {
    expect(kinds).toEqual(
      expect.arrayContaining([
        'saved_search_match',
        'trip_reminder',
        'quota_threshold',
        'subscription_expiring',
        'verification_sla',
      ]),
    );
  });

  it('has a unique label per kind, because two rows reading the same is a settings bug', () => {
    const labels = kinds.map((kind) => translate('en', `notifications.event.${kind}` as never));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

/**
 * The template registry, checked rather than declared.
 *
 * Every event has a sample payload and every `{placeholder}` in its Arabic and English sentence is filled by
 * that payload. This is the acceptance criterion "no missing variables" in executable form: a template that
 * grows a variable nobody supplies fails here, not on a passenger's phone with `{reason}` on screen.
 */
describe('templates', () => {
  const placeholders = (text: string): string[] =>
    [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);

  it('has a sample payload for every kind', () => {
    for (const kind of notificationKindSchema.options) {
      expect(SAMPLE_PARAMS[kind]).toBeDefined();
    }
    expect(Object.keys(SAMPLE_PARAMS)).toHaveLength(notificationKindSchema.options.length);
  });

  for (const kind of notificationKindSchema.options) {
    it(`${kind} renders with no unresolved variable in either locale`, () => {
      const item = {
        kind,
        titleKey: `notifications.event.${kind}` as TranslationKey,
        params: sampleParamsFor(kind),
      };
      // The sentence key is the catalogue's, which the SQL seeds; the client's kind→title map lives in the
      // dictionary under `notifications.event.*`, so the sample is rendered against that label here.
      for (const locale of ['ar', 'en'] as const) {
        const text = translate(locale, item.titleKey as TranslationKey, item.params);
        expect(text).not.toMatch(/\{\w+\}/);
      }
    });
  }

  it('fills every placeholder in the real sentence templates', () => {
    // The catalogue's title keys, mirrored here because the samples are the thing under test.
    const titles: Record<string, TranslationKey> = {
      booking_requested: 'notifications.bookingRequested',
      booking_accepted: 'notifications.bookingAccepted',
      booking_rejected: 'notifications.bookingRejected',
      booking_cancelled: 'notifications.bookingCancelled',
      vehicle_maintenance_due: 'notifications.vehicleMaintenanceDue',
      vehicle_maintenance_overdue: 'notifications.vehicleMaintenanceOverdue',
      vehicle_fuel_anomaly: 'notifications.vehicleFuelAnomaly',
      payment_submitted: 'notifications.paymentSubmitted',
      payment_confirmed: 'notifications.paymentConfirmed',
      payment_rejected: 'notifications.paymentRejected',
      refund_decided: 'notifications.refundApproved',
      payout_decided: 'notifications.payoutApproved',
      invoice_issued: 'notifications.invoiceIssued',
      subscription_activated: 'notifications.subscriptionActivated',
      subscription_past_due: 'notifications.subscriptionPastDue',
      subscription_expired: 'notifications.subscriptionExpired',
      finance_alert: 'notifications.integrityAlert',
      saved_search_match: 'notifications.savedSearchMatch',
      trip_reminder: 'notifications.tripReminderTomorrow',
      quota_threshold: 'notifications.quotaWarning',
      subscription_expiring: 'notifications.subscriptionExpiring7',
      verification_sla: 'notifications.verificationSla',
      subscription_plan_changed: 'notifications.planChanged',
      agent_cash_in_settled: 'notifications.agentCashInSettled',
      no_show_alert: 'notifications.noShowAlert',
    };

    for (const [kind, titleKey] of Object.entries(titles)) {
      const params = sampleParamsFor(kind);
      for (const locale of ['ar', 'en'] as const) {
        const text = notificationText(locale, { kind, titleKey, params });
        const missing = placeholders(text);
        expect(missing, `${kind} in ${locale}`).toEqual([]);
      }
    }
  });

  it('translates an identifier-shaped parameter instead of printing the enum', () => {
    const text = notificationText('ar', {
      kind: 'subscription_plan_changed',
      titleKey: 'notifications.planChanged',
      params: sampleParamsFor('subscription_plan_changed'),
    });
    expect(text).toContain('الاحترافية');
    expect(text).toContain('الأعمال');
    expect(text).not.toContain('{from}');
  });

  it('renders the deadline sentence with plan names for an expiring subscription', () => {
    const text = notificationText('en', {
      kind: 'subscription_expired',
      titleKey: 'notifications.subscriptionExpired',
      params: sampleParamsFor('subscription_expired'),
    });
    expect(text).toContain('Business');
  });
});

describe('plurals', () => {
  it('uses the six Arabic categories', () => {
    expect(pluralCategory('ar', 0)).toBe('zero');
    expect(pluralCategory('ar', 1)).toBe('one');
    expect(pluralCategory('ar', 2)).toBe('two');
    expect(pluralCategory('ar', 3)).toBe('few');
    expect(pluralCategory('ar', 10)).toBe('few');
    expect(pluralCategory('ar', 11)).toBe('many');
    expect(pluralCategory('ar', 99)).toBe('many');
    expect(pluralCategory('ar', 100)).toBe('other');
    expect(pluralCategory('ar', 103)).toBe('few');
    expect(pluralCategory('ar', 111)).toBe('many');
  });

  it('uses one and other in English', () => {
    expect(pluralCategory('en', 0)).toBe('other');
    expect(pluralCategory('en', 1)).toBe('one');
    expect(pluralCategory('en', 2)).toBe('other');
  });

  it('writes the unread count the way each language writes it', () => {
    expect(translateCount('ar', 'notifications.unread', 0)).toBe('لا شيء غير مقروء');
    expect(translateCount('ar', 'notifications.unread', 1)).toBe('تنبيه واحد غير مقروء');
    expect(translateCount('ar', 'notifications.unread', 2)).toBe('تنبيهان غير مقروءين');
    expect(translateCount('ar', 'notifications.unread', 5)).toBe('5 تنبيهات غير مقروءة');
    expect(translateCount('ar', 'notifications.unread', 15)).toBe('15 تنبيهًا غير مقروءًا');
    expect(translateCount('en', 'notifications.unread', 1)).toBe('1 unread');
    expect(translateCount('en', 'notifications.unread', 4)).toBe('4 unread');
  });

  it('falls back to `other` for a key with no plural forms', () => {
    expect(translateCount('ar', 'notifications.pageTitle', 3)).toBe('مركز التنبيهات');
  });

  it('renders the digest with the agreement its count asks for', () => {
    const render = (count: number, locale: Locale) =>
      notificationText(locale, {
        kind: 'saved_search_match',
        titleKey: 'notifications.savedSearchDigest',
        params: { count },
      });
    expect(render(1, 'ar')).toBe('رحلة جديدة واحدة تطابق بحثك المحفوظ.');
    expect(render(2, 'ar')).toBe('رحلتان جديدتان تطابقان بحثك المحفوظ.');
    expect(render(4, 'ar')).toContain('4 رحلات');
    expect(render(2, 'en')).toBe('2 new trips match your saved search.');
  });
});

describe('bidi', () => {
  it('isolates a trip code inside an Arabic sentence', () => {
    const segments = splitBidi('حجزك BK-3C9923 على الرحلة AD-TA-56DD.');
    expect(segments.filter((segment) => segment.latin).map((segment) => segment.text)).toEqual([
      'BK-3C9923',
      'AD-TA-56DD',
    ]);
    // Every character survives the split: isolation must not rewrite the sentence.
    expect(segments.map((segment) => segment.text).join('')).toBe(
      'حجزك BK-3C9923 على الرحلة AD-TA-56DD.',
    );
  });

  it('treats a pure Arabic sentence as one segment', () => {
    expect(splitBidi('تم قبول حجزك.')).toEqual([{ text: 'تم قبول حجزك.', latin: false }]);
  });

  it('keeps a price with its digits together', () => {
    const segments = splitBidi('حتى 5,000 ر.ي');
    expect(segments[0]).toEqual({ text: 'حتى ', latin: false });
    expect(segments[1]?.latin).toBe(true);
    expect(segments[1]?.text).toContain('5');
  });
});

describe('the events and jobs the first pass left out', () => {
  it('offers the three new events as preference rows', () => {
    for (const kind of ['subscription_plan_changed', 'agent_cash_in_settled', 'no_show_alert']) {
      expect(notificationKindSchema.safeParse(kind).success).toBe(true);
      expect(kindOptions).toContain(kind);
    }
  });

  it('runs the no-show job', () => {
    const input = parse({ action: 'notifications.job.run', job: 'no-shows' });
    expect(notificationCommandArgs(input, actor, audit)).toEqual({
      fn: 'cmd_notify_no_shows',
      args: { p_actor: actor, p_grace: '45 minutes' },
    });
  });

  it('runs the digest job', () => {
    const input = parse({ action: 'notifications.job.run', job: 'search-digest' });
    expect(notificationCommandArgs(input, actor, audit).fn).toBe('cmd_digest_saved_searches');
  });

  it('asks for all three reminder bands by default', () => {
    const input = parse({ action: 'notifications.job.run', job: 'trip-reminders' });
    expect(notificationCommandArgs(input, actor, audit).args.p_bands).toBeNull();
  });

  it('passes an explicit band list through', () => {
    const input = parse({
      action: 'notifications.job.run',
      job: 'trip-reminders',
      bands: ['soon', 'departure'],
    });
    expect(notificationCommandArgs(input, actor, audit).args.p_bands).toEqual([
      'soon',
      'departure',
    ]);
  });

  it('refuses a band name the job does not know', () => {
    expect(() =>
      parse({ action: 'notifications.job.run', job: 'trip-reminders', bands: ['later'] }),
    ).toThrow();
  });

  it('saves a digest search and defaults it off', () => {
    const input = parse({ action: 'search.save', filters: { q: 'عدن' } });
    expect(notificationCommandArgs(input, actor, audit).args.p_digest).toBe(false);
  });

  it('turns a digest on for an existing search', () => {
    const input = parse({ action: 'search.update', id: deliveryId, digest: true });
    expect(notificationCommandArgs(input, actor, audit).args.p_digest).toBe(true);
  });

  it('reads the catalogue through the staff action', () => {
    const input = parse({ action: 'notifications.catalogue' });
    expect(notificationCommandArgs(input, actor, audit)).toEqual({
      fn: 'cmd_get_notification_catalogue',
      args: { p_actor: actor },
    });
  });
});

describe('the job map the worker schedules from', () => {
  const jobs = notificationJobSchema.shape.job.options;

  it('names every job the API accepts, and nothing else', () => {
    // The worker iterates this map instead of keeping its own list, so a job missing here is a job no cron
    // ever runs — which is exactly how `search-digest` and `no-shows` were shipped and not scheduled.
    expect(Object.keys(NOTIFICATION_JOB_FN).sort()).toEqual([...jobs].sort());
  });

  it('points each job at a command, and no two jobs at the same command', () => {
    const fns = Object.values(NOTIFICATION_JOB_FN);
    expect(fns.every((fn) => fn.startsWith('cmd_'))).toBe(true);
    expect(new Set(fns).size).toBe(fns.length);
  });

  it('routes every job through the command builder with the actor it was given', () => {
    // `payments-expiry` is the exception, and it is a real distinction: it closes intents nobody finished and
    // sends nothing, so it has no actor to attribute a notification to. Every job that *notifies* carries one.
    const housekeeping = new Set(['payments-expiry']);
    for (const job of jobs) {
      const parsed = notificationJobSchema.parse({ action: 'notifications.job.run', job });
      const command = notificationCommandArgs(parsed, 'actor-1');
      expect(command.fn).toBe(NOTIFICATION_JOB_FN[job]);
      if (housekeeping.has(job)) expect(command.args.p_actor).toBeUndefined();
      else expect(command.args.p_actor).toBe('actor-1');
    }
  });

  it('passes the three reminder bands through, and asks for all of them by default', () => {
    const all = notificationCommandArgs(
      notificationJobSchema.parse({ action: 'notifications.job.run', job: 'trip-reminders' }),
      'actor-1',
    );
    expect(all.args.p_bands).toBeNull();

    const one = notificationCommandArgs(
      notificationJobSchema.parse({
        action: 'notifications.job.run',
        job: 'trip-reminders',
        bands: ['soon'],
      }),
      'actor-1',
    );
    expect(one.args.p_bands).toEqual(['soon']);
  });
});
