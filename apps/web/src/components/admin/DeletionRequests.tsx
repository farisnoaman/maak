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
import type { DeletionRequest } from '@/lib/admin';

/**
 * The deletion queue — the last step of a request the passenger could file since `00011` and nobody could
 * execute until `00039`.
 *
 * The reason is required here because `cmd_delete_account` requires one: an irreversible action with a
 * blank explanation is a support ticket nobody can answer six months later. The button is `danger` and the
 * row disappears on success, because a list that keeps showing a deleted account is a list that invites a
 * second attempt.
 */
export function DeletionRequests({
  locale,
  requests,
  configured,
}: {
  readonly locale: Locale;
  readonly requests: readonly DeletionRequest[];
  readonly configured: boolean;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [rows, setRows] = useState<readonly DeletionRequest[]>(requests);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function execute(request: DeletionRequest) {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('admin.deletionNotConfigured'));
      return;
    }
    if (reason.trim().length === 0) {
      setError(t('admin.deletionReasonRequired'));
      return;
    }

    setBusyId(request.id);
    setError(null);
    setMessage(null);

    const result = await client.call(identityCommandSpec, {
      action: 'account.delete',
      userId: request.id,
      reason: reason.trim(),
    });

    setBusyId(null);
    if (!result.ok) {
      // The refusal text matters more than the code here: "live bookings", "owns an organization" and
      // "outstanding balance" are each something the operator has to go and fix first.
      setError(
        `${t('admin.deletionFailed')} ${result.error.detail ?? t(errorKey(result.error.code))}`,
      );
      return;
    }

    setRows((current) => current.filter((row) => row.id !== request.id));
    setOpenId(null);
    setReason('');
    setMessage(t('admin.deletionDone'));
  }

  if (rows.length === 0) {
    return <p className="form-hint">{t('admin.deletionEmpty')}</p>;
  }

  return (
    <div>
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

      <ul className="queue-list">
        {rows.map((row) => {
          const isOpen = openId === row.id;

          return (
            <li key={row.id} className="queue-card">
              <div className="panel-head">
                <div>
                  <p className="unit-title">{row.name ?? t('admin.deletionUnnamed')}</p>
                  <p className="form-hint">
                    <bdi>{row.phone ?? row.email ?? row.id}</bdi>
                    {' · '}
                    <time dateTime={row.requestedAt}>{row.requestedAt.slice(0, 10)}</time>
                  </p>
                </div>
                {isOpen ? null : (
                  <Button variant="ghost" onClick={() => setOpenId(row.id)}>
                    {t('admin.deletionReview')}
                  </Button>
                )}
              </div>

              {row.reason ? (
                <p className="form-hint">
                  {t('admin.deletionTheirReason')}
                  {': '}
                  <bdi>{row.reason}</bdi>
                </p>
              ) : null}

              {isOpen ? (
                <div className="form-grid">
                  <Field
                    label={t('admin.deletionReason')}
                    hint={t('admin.deletionHint')}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    required
                  />
                  <div className="form-actions">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setOpenId(null);
                        setReason('');
                        setError(null);
                      }}
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      variant="danger"
                      loading={busyId === row.id}
                      onClick={() => execute(row)}
                    >
                      {t('admin.deletionExecute')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
