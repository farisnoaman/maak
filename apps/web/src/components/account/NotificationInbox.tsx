'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  deliveryStatusTone,
  errorKey,
  notificationCommandSpec,
  notificationText,
  splitBidi,
  translate,
  translateCount,
  type Locale,
  type NotificationChannel,
  type NotificationDeliveryStatus,
  type NotificationKind,
  type TranslationKey,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { getApiClient } from '@/lib/api';
import type { InboxItem } from '@/lib/notifications';

const CHANNEL_ORDER: readonly NotificationChannel[] = ['in_app', 'push', 'email', 'whatsapp'];

const CHANNEL_LABEL: Record<NotificationChannel, TranslationKey> = {
  in_app: 'notifications.channel.in_app',
  push: 'notifications.channel.push',
  email: 'notifications.channel.email',
  whatsapp: 'notifications.channel.whatsapp',
};

/**
 * A rendered sentence with its Latin runs isolated.
 *
 * «حجزك BK-3C9923 على الرحلة AD-TA-56DD» contains two codes; without `<bdi>` the browser is free to move the
 * hyphens and digits, and an Arabic reader sees a mangled booking reference. The split comes from `@maak/core`
 * so it is unit-tested rather than checked by eye in one direction.
 */
function MixedText({ text }: { readonly text: string }) {
  const segments = splitBidi(text);
  if (segments.every((segment) => !segment.latin)) return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) =>
        segment.latin ? (
          <bdi key={index}>{segment.text}</bdi>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

const STATUS_LABEL: Record<NotificationDeliveryStatus, TranslationKey> = {
  sent: 'notifications.status.sent',
  pending: 'notifications.status.pending',
  sending: 'notifications.status.sending',
  skipped: 'notifications.status.skipped',
  failed: 'notifications.status.failed',
  dead: 'notifications.status.dead',
};

/**
 * The inbox.
 *
 * Two things make this list different from a generic activity feed. First, it shows the **channel the message
 * actually used** — "sent", "held until 06:00", "skipped because you turned email off" — because the
 * question a person asks about a notification they did not see is "why", and a plain list cannot answer it.
 * Second, unread state is written through the gateway: the bell is not something a client clears on its own.
 */
export function NotificationInbox({
  locale,
  items,
  unread,
  configured,
}: {
  readonly locale: Locale;
  readonly items: readonly InboxItem[];
  readonly unread: number;
  readonly configured: boolean;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [rows, setRows] = useState(items);
  const [remaining, setRemaining] = useState(unread);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const localeHref = (href: string) =>
    /^\/(ar|en)(\/|$)/.test(href) ? href : `/${locale}${href.startsWith('/') ? '' : '/'}${href}`;

  async function markAllRead() {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);
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
    setRows((current) => current.map((row) => (row.readAt ? row : { ...row, readAt: now })));
    setRemaining(0);
  }

  if (rows.length === 0) {
    return <p className="form-hint">{t('account.noNotifications')}</p>;
  }

  return (
    <div className="notification-centre">
      <div className="panel-head">
        {/* The count sentence is Arabic, and Arabic has six forms of it. `translateCount` picks the one the
            number asks for; the live region announces the change to a screen reader. */}
        <p className="form-hint num" aria-live="polite" role="status">
          {translateCount(locale, 'notifications.unread', remaining)}
        </p>
        <Button
          variant="subtle"
          size="sm"
          onClick={markAllRead}
          loading={busy}
          disabled={remaining === 0}
        >
          {t('account.markAllRead')}
        </Button>
      </div>

      <ul className="notification-list">
        {rows.map((row) => {
          const text = notificationText(locale, {
            kind: row.kind as NotificationKind,
            titleKey: row.titleKey,
            params: row.params,
          });
          const channels = CHANNEL_ORDER.filter((channel) => row.channels[channel] != null);

          return (
            <li
              key={row.id}
              className={row.readAt ? 'notification' : 'notification notification--unread'}
            >
              <div className="notification__main">
                <span aria-hidden="true">{row.readAt ? '○' : '●'}</span>
                {row.link ? (
                  <Link href={localeHref(row.link)}>
                    <MixedText text={text} />
                  </Link>
                ) : (
                  <span>
                    <MixedText text={text} />
                  </span>
                )}
              </div>

              <div className="notification__meta">
                <span className="form-hint">
                  {t(`notifications.event.${row.kind}` as TranslationKey)}
                </span>
                <time className="form-hint" dateTime={row.createdAt}>
                  {row.createdAt.slice(0, 10)}
                </time>
                <ul
                  className="notification__channels"
                  aria-label={t('notifications.channelsLabel')}
                >
                  {channels.map((channel) => {
                    const status = row.channels[channel] as NotificationDeliveryStatus;
                    return (
                      <li key={channel}>
                        <Badge tone={deliveryStatusTone(status)}>
                          {`${t(CHANNEL_LABEL[channel])} · ${t(STATUS_LABEL[status])}`}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </li>
          );
        })}
      </ul>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
