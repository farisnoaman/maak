'use client';

import { useState } from 'react';
import {
  errorKey,
  inQuietWindow,
  minutesOfDay,
  notificationCommandSpec,
  quietResumeClock,
  translate,
  type Locale,
  type NotificationChannel,
  type NotificationKind,
  type TranslationKey,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { getApiClient } from '@/lib/api';
import type { DeviceView, NotificationEventView } from '@/lib/notifications';

const CHANNEL_ORDER: readonly NotificationChannel[] = ['push', 'email', 'whatsapp'];

const CHANNEL_LABEL: Record<NotificationChannel, TranslationKey> = {
  in_app: 'notifications.channel.in_app',
  push: 'notifications.channel.push',
  email: 'notifications.channel.email',
  whatsapp: 'notifications.channel.whatsapp',
};

/** What the switch currently means: an explicit choice, else the event's default. */
function enabled(event: NotificationEventView, channel: NotificationChannel): boolean {
  return event.overrides[channel] ?? event.defaultChannels.includes(channel);
}

/**
 * Preferences: one switch per event × channel, plus quiet hours.
 *
 * The matrix is the honest shape of the data — an event list with a single "on/off" would have to lie about
 * email and push being one decision, which is precisely the bug the acceptance criteria describe. In-app is
 * shown but not switchable: it is the record of the event, and a person who turns it off later asks support
 * why they never received anything.
 *
 * Quiet hours use the same arithmetic the server uses (`inQuietWindow`), so the sentence "a notification now
 * would arrive at 06:00" is not a guess.
 */
export function NotificationPreferences({
  locale,
  events,
  settings,
  devices,
  configured,
}: {
  readonly locale: Locale;
  readonly events: readonly NotificationEventView[];
  readonly settings: {
    readonly quietHoursEnabled: boolean;
    readonly quietStart: string;
    readonly quietEnd: string;
  };
  readonly devices: readonly DeviceView[];
  readonly configured: boolean;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [matrix, setMatrix] = useState(events);
  const [quietEnabled, setQuietEnabled] = useState(settings.quietHoursEnabled);
  const [quietStart, setQuietStart] = useState(settings.quietStart);
  const [quietEnd, setQuietEnd] = useState(settings.quietEnd);
  const [deviceRows, setDeviceRows] = useState(devices);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const now = new Date();
  const held = inQuietWindow(
    { enabled: quietEnabled, start: quietStart, end: quietEnd },
    { hours: now.getHours(), minutes: now.getMinutes() },
  );
  const resume = quietResumeClock(
    { enabled: quietEnabled, start: quietStart, end: quietEnd },
    { hours: now.getHours(), minutes: now.getMinutes() },
  );

  async function toggle(kind: string, channel: NotificationChannel, next: boolean) {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(`${kind}:${channel}`);
    setError(null);
    setMessage(null);

    const result = await client.call(notificationCommandSpec, {
      action: 'notifications.preference.set',
      kind: kind as NotificationKind,
      channel,
      enabled: next,
    });

    setBusy(null);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setMatrix((current) =>
      current.map((event) =>
        event.kind === kind
          ? { ...event, overrides: { ...event.overrides, [channel]: next } }
          : event,
      ),
    );
  }

  async function saveQuietHours() {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy('quiet');
    setError(null);
    setMessage(null);

    const result = await client.call(notificationCommandSpec, {
      action: 'notifications.settings.update',
      quietHoursEnabled: quietEnabled,
      quietStart,
      quietEnd,
    });

    setBusy(null);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setMessage(t('notifications.savedPrefs'));
  }

  async function revokeDevice(id: string) {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(id);
    setError(null);
    const result = await client.call(notificationCommandSpec, {
      action: 'notifications.device.revoke',
      deviceId: id,
    });
    setBusy(null);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setDeviceRows((current) => current.filter((device) => device.id !== id));
  }

  return (
    <div className="preferences">
      <section className="preferences__block" aria-labelledby="quiet-hours">
        <h2 id="quiet-hours">{t('notifications.quietHours')}</h2>
        <p className="form-hint">{t('notifications.quietHoursHint')}</p>

        <div className="preferences__quiet">
          <label className="toggle">
            <input
              type="checkbox"
              checked={quietEnabled}
              onChange={(event) => setQuietEnabled(event.target.checked)}
            />
            <span>{t('notifications.quietEnabled')}</span>
          </label>

          <Field
            label={t('notifications.quietStart')}
            type="time"
            value={quietStart}
            onChange={(event) => setQuietStart(event.target.value)}
            disabled={!quietEnabled}
            hint={t('notifications.quietTimezone')}
          />
          <Field
            label={t('notifications.quietEnd')}
            type="time"
            value={quietEnd}
            onChange={(event) => setQuietEnd(event.target.value)}
            disabled={!quietEnabled}
            hint={t('notifications.quietTimezone')}
          />
        </div>

        <p className="form-hint" role="status">
          {quietEnabled
            ? held
              ? t('notifications.quietHeldNote', { time: resume.clock })
              : t('notifications.quietActiveNow', {
                  start: quietStart,
                  end: quietEnd,
                  minutes: Math.max(minutesOfDay(quietEnd) - minutesOfDay(quietStart), 0),
                })
            : t('notifications.quietOffNote')}
        </p>

        <div className="preferences__actions">
          <Button onClick={saveQuietHours} loading={busy === 'quiet'}>
            {t('notifications.saveprefs')}
          </Button>
        </div>
      </section>

      <section className="preferences__block" aria-labelledby="event-matrix">
        <h2 id="event-matrix">{t('notifications.matrixTitle')}</h2>
        <p className="form-hint">{t('notifications.preferencesSubtitle')}</p>

        <div className="table-scroll">
          <table className="data-table preferences__table">
            <caption className="visually-hidden">{t('notifications.matrixTitle')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('notifications.eventColumn')}</th>
                <th scope="col">{t('notifications.channel.in_app')}</th>
                {CHANNEL_ORDER.map((channel) => (
                  <th scope="col" key={channel}>
                    {t(CHANNEL_LABEL[channel])}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((event) => (
                <tr key={event.kind}>
                  <th scope="row">
                    <span>{t(`notifications.event.${event.kind}` as TranslationKey)}</span>
                    {event.priority === 'critical' ? (
                      <Badge tone="warning">{t('notifications.criticalBadge')}</Badge>
                    ) : null}
                  </th>
                  <td>
                    <span className="form-hint">{t('notifications.alwaysOn')}</span>
                  </td>
                  {CHANNEL_ORDER.map((channel) => (
                    <td key={channel}>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={enabled(event, channel)}
                          disabled={busy === `${event.kind}:${channel}`}
                          onChange={(click) => toggle(event.kind, channel, click.target.checked)}
                        />
                        <span className="visually-hidden">
                          {`${t(`notifications.event.${event.kind}` as TranslationKey)} — ${t(
                            CHANNEL_LABEL[channel],
                          )}`}
                        </span>
                      </label>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="preferences__block" aria-labelledby="devices">
        <h2 id="devices">{t('notifications.devices')}</h2>
        {deviceRows.length === 0 ? (
          <p className="form-hint">{t('notifications.devicesEmpty')}</p>
        ) : (
          <ul className="notification-list">
            {deviceRows.map((device) => (
              <li key={device.id} className="notification">
                <span>{t(`notifications.platform.${device.platform}` as TranslationKey)}</span>
                <time className="form-hint" dateTime={device.lastSeenAt}>
                  {device.lastSeenAt.slice(0, 10)}
                </time>
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => revokeDevice(device.id)}
                  loading={busy === device.id}
                >
                  {t('notifications.deviceRevoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {message ? (
        <p className="form-success" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
