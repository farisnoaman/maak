'use client';

import { useState } from 'react';
import {
  errorKey,
  identityCommandSpec,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { getApiClient } from '@/lib/api';

/**
 * Account deletion is a **request**, never an immediate delete.
 *
 * Financial records and the audit trail must survive, and an account that still owns a company would
 * orphan it — both rules are enforced in SQL (`cmd_request_account_deletion`). The UI explains that,
 * and offers the cancel path so a mis-tap is not a support ticket.
 */
export function DeletionPanel({
  locale,
  pending,
  configured,
}: {
  readonly locale: Locale;
  readonly pending: boolean;
  readonly configured: boolean;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [requested, setRequested] = useState(pending);
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function mutate(action: 'account.requestDeletion' | 'account.cancelDeletion') {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);

    const result = await client.call(
      identityCommandSpec,
      action === 'account.requestDeletion'
        ? { action, reason: reason.trim() || undefined }
        : { action },
    );

    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setRequested(action === 'account.requestDeletion');
    setOpen(false);
    setMessage(
      action === 'account.requestDeletion'
        ? t('account.deletionRequested')
        : t('account.deletionCancelled'),
    );
  }

  return (
    <div className="card console-panel">
      <h2 style={{ fontSize: '1.05rem' }}>{t('account.deletion')}</h2>
      <p className="form-hint">{t('account.deletionHint')}</p>

      {requested ? <p className="form-warning">{t('account.deletionPending')}</p> : null}

      {requested ? (
        <div className="form-actions">
          <Button variant="ghost" onClick={() => mutate('account.cancelDeletion')} loading={busy}>
            {t('account.cancelDeletion')}
          </Button>
        </div>
      ) : open ? (
        <div className="form-grid">
          <Field
            label={t('account.deletionReason')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => mutate('account.requestDeletion')}
              loading={busy}
            >
              {t('account.requestDeletion')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="form-actions">
          <Button variant="ghost" onClick={() => setOpen(true)}>
            {t('account.requestDeletion')}
          </Button>
        </div>
      )}

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
