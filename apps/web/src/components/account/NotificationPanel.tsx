'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  errorKey,
  identityCommandSpec,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Button } from '@/components/ui/Button';
import { getApiClient } from '@/lib/api';

export interface NotificationItem {
  readonly id: string;
  readonly titleKey: string;
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

  async function markAllRead() {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await client.call(identityCommandSpec, { action: 'notification.read' });
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
              <Link href={row.link}>{t(row.titleKey as TranslationKey)}</Link>
            ) : (
              <span>{t(row.titleKey as TranslationKey)}</span>
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
