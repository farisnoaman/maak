import { describe, expect, it } from 'vitest';
import {
  describeSavedSearch,
  emailMessage,
  expoPushMessages,
  inQuietWindow,
  minutesOfDay,
  notificationActionSchema,
  notificationCommandArgs,
  notificationScope,
  notificationText,
  quietResumeClock,
  whatsappDeepLink,
  type ClaimedDelivery,
  type NotificationAction,
} from '../src/api/notifications';
import { notificationKindSchema } from '../src/api/notifications';
import { translate } from '../src/i18n/dictionaries';

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

  it('passes the reminder lead time through, because "tomorrow" is a choice', () => {
    const input = parse({ action: 'notifications.job.run', job: 'trip-reminders', hours: 6 });
    expect(notificationCommandArgs(input, actor, audit).args).toEqual({
      p_actor: actor,
      p_hours: 6,
      p_band: '1 hour',
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
