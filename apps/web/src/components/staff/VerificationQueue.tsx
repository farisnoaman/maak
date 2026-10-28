'use client';

import { useState } from 'react';
import {
  canDecideVerification,
  errorKey,
  identityCommandSpec,
  translate,
  type Locale,
  type Role,
  type TranslationKey,
  type VerificationQueueItem,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { getApiClient } from '@/lib/api';

/**
 * The verification queue.
 *
 * `canDecideVerification()` is the same predicate the SQL command enforces, so a staff member who
 * submitted a request sees the row but not the buttons — and would be refused anyway.
 */
const DOCUMENT_LABEL: Record<string, TranslationKey> = {
  national_id_front: 'verification.front',
  national_id_back: 'verification.back',
  commercial_registration: 'verification.commercialRegistration',
};

function docLabel(kind: string, t: (key: TranslationKey) => string): string {
  const key = DOCUMENT_LABEL[kind];
  return key ? t(key) : kind;
}

export function VerificationQueue({
  locale,
  items,
  actorId,
  actorRoles,
  configured,
}: {
  readonly locale: Locale;
  readonly items: readonly VerificationQueueItem[];
  readonly actorId: string | null;
  readonly actorRoles: readonly Role[];
  readonly configured: boolean;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [rows, setRows] = useState(items);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, outcome: 'approve' | 'reject') {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    if (outcome === 'reject' && reason.trim().length < 10) {
      setError(t('verification.rejectReason'));
      return;
    }
    setBusyId(id);
    setError(null);
    setMessage(null);

    const result = await client.call(identityCommandSpec, {
      action: 'verification.decide',
      requestId: id,
      outcome,
      reason: reason.trim() || undefined,
    });

    setBusyId(null);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setRows((current) =>
      current.map((row) =>
        row.id === id
          ? {
              ...row,
              status: outcome === 'approve' ? ('approved' as const) : ('rejected' as const),
            }
          : row,
      ),
    );
    setOpenId(null);
    setReason('');
    setMessage(outcome === 'approve' ? t('staff.approved') : t('staff.rejected'));
  }

  if (rows.length === 0) {
    return <p className="form-hint">{t('staff.empty')}</p>;
  }

  return (
    <div>
      <ul className="queue-list">
        {rows.map((row) => {
          const decidable =
            row.status === 'pending' &&
            canDecideVerification(
              { userId: actorId, roles: actorRoles },
              { requestedBy: row.requestedBy, status: row.status },
            );
          const isOpen = openId === row.id;

          return (
            <li key={row.id} className="queue-card">
              <div className="panel-head">
                <div>
                  <p style={{ fontWeight: 700 }}>{row.subjectName ?? row.subjectId}</p>
                  <p className="form-hint">
                    {row.subjectType === 'individual'
                      ? t('staff.type.individual')
                      : t('staff.type.organization')}
                    {' · '}
                    <time dateTime={row.createdAt}>{row.createdAt.slice(0, 10)}</time>
                  </p>
                </div>
                <Badge
                  tone={
                    row.status === 'pending'
                      ? 'warning'
                      : row.status === 'approved'
                        ? 'success'
                        : row.status === 'rejected'
                          ? 'danger'
                          : 'neutral'
                  }
                >
                  {t(
                    `staff.status.${row.status}` as
                      | 'staff.status.pending'
                      | 'staff.status.approved'
                      | 'staff.status.rejected'
                      | 'staff.status.withdrawn',
                  )}
                </Badge>
              </div>

              {row.documents.length > 0 ? (
                <ul className="doc-list">
                  {row.documents.map((document) => (
                    <li key={document.id}>
                      {document.url ? (
                        <a href={document.url} target="_blank" rel="noreferrer noopener">
                          {docLabel(document.kind, t)} · {t('staff.openDocument')}
                        </a>
                      ) : (
                        <span className="form-hint">
                          {docLabel(document.kind, t)} · {t('common.status')}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}

              {row.status === 'pending' && !decidable ? (
                <p className="form-hint">{t('staff.ownRequest')}</p>
              ) : null}

              {decidable ? (
                isOpen ? (
                  <div className="form-grid">
                    <Field
                      label={t('staff.decideReason')}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                    <div className="form-actions">
                      <Button variant="ghost" onClick={() => setOpenId(null)}>
                        {t('common.cancel')}
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => decide(row.id, 'reject')}
                        loading={busyId === row.id}
                      >
                        {t('staff.reject')}
                      </Button>
                      <Button onClick={() => decide(row.id, 'approve')} loading={busyId === row.id}>
                        {t('staff.approve')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="form-actions">
                    <Button variant="subtle" size="sm" onClick={() => setOpenId(row.id)}>
                      {t('staff.approve')} / {t('staff.reject')}
                    </Button>
                  </div>
                )
              ) : null}
            </li>
          );
        })}
      </ul>

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
