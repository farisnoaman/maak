'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  errorKey,
  notificationCommandSpec,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Button } from '@/components/ui/Button';
import { getApiClient } from '@/lib/api';

export interface NotificationItem {
  readonly id: string;
  readonly titleKey: string;
  /** Values for the `{name}` / `{reason}` placeholders in the notification text. */
  readonly params?: Readonly<Record<string, string | number>>;
  readonly link: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

/**
 * In-app notification list. Read state is a write, so it goes through the gateway like everything
 * else — the bell cannot be "optimistically" cleared by a client that has no permission.
 */
export function NotificationPanel({
  locale,
  items,
  configured,
}: {
  readonly locale: Locale;
  readonly items: readonly NotificationItem[];
  readonly configured: boolean;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [rows, setRows] = useState(items);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unread = rows.filter((row) => !row.readAt).length;

  // A notification is stored as a key plus its values; rendering the key alone is how "your place
  // «{name}» is waiting for review" reached the screen with the placeholder still in it.
  const label = (row: NotificationItem) => t(row.titleKey as TranslationKey, row.params ?? {});

  /**
   * Notification links come from the database, which stores them without a locale (`/admin/places`).
   * Bouncing through a redirect for every row is wasteful and loses the error state, so the prefix is
   * added here.
   */
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
    // `ids: null` means "everything I have not read yet", which is what the button promises. The
    // command lives in the notifications edge function now (Phase 11), not the identity one.
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
  }

  if (rows.length === 0) {
    return <p className="form-hint">{t('account.noNotifications')}</p>;
  }

  return (
    <div>
      <div className="panel-head">
        <p className="form-hint num" aria-live="polite">
          {unread}
        </p>
        <Button
          variant="subtle"
          size="sm"
          onClick={markAllRead}
          loading={busy}
          disabled={unread === 0}
        >
          {t('account.markAllRead')}
        </Button>
      </div>

      <ul className="notification-list">
        {rows.map((row) => (
          <li
            key={row.id}
            className={row.readAt ? 'notification' : 'notification notification--unread'}
          >
            <span aria-hidden="true">{row.readAt ? '○' : '●'}</span>
            {row.link ? (
              <Link href={localeHref(row.link)}>{label(row)}</Link>
            ) : (
              <span>{label(row)}</span>
            )}
            <time className="form-hint" dateTime={row.createdAt}>
              {new Date(row.createdAt).toISOString().slice(0, 10)}
            </time>
          </li>
        ))}
      </ul>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
