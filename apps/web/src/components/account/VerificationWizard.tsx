'use client';

import { useState } from 'react';
import {
  errorKey,
  identityCommandSpec,
  translate,
  type Locale,
  type TranslationKey,
  type VerificationStatus,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { getApiClient, uploadVerificationDocument } from '@/lib/api';

type Step = 'identity' | 'documents' | 'review';

interface Draft {
  fullName: string;
  nationalIdType: 'national_id' | 'passport' | 'residence';
  nationalIdNumber: string;
  birthPlace: string;
}

const STATUS_LABEL: Record<VerificationStatus, TranslationKey> = {
  unverified: 'verification.status.unverified',
  pending: 'verification.status.pending',
  verified: 'verification.status.verified',
  rejected: 'verification.status.rejected',
};

const STATUS_TONE = {
  unverified: 'neutral',
  pending: 'warning',
  verified: 'success',
  rejected: 'danger',
} as const;

/**
 * Three steps, in the order the database validates them: details → documents → review.
 *
 * The wizard never decides anything itself: it uploads to the caller's own storage folder and then
 * sends one `verification.submit` command. Everything the user sees after that comes from the
 * server's answer, so a revoked verification cannot be hidden by a stale client state.
 */
export function VerificationWizard({
  locale,
  initialStatus,
  initialNote,
  profile,
  userId,
  configured,
}: {
  readonly locale: Locale;
  readonly initialStatus: VerificationStatus;
  readonly initialNote: string | null;
  readonly profile: {
    fullName: string | null;
    nationalIdType: string | null;
    birthPlace: string | null;
  };
  readonly userId: string;
  readonly configured: boolean;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [status, setStatus] = useState<VerificationStatus>(initialStatus);
  const [step, setStep] = useState<Step>('identity');
  const [draft, setDraft] = useState<Draft>({
    fullName: profile.fullName ?? '',
    nationalIdType: (profile.nationalIdType as Draft['nationalIdType']) ?? 'national_id',
    nationalIdNumber: '',
    birthPlace: profile.birthPlace ?? '',
  });
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const identityComplete =
    draft.fullName.trim().length >= 2 &&
    draft.nationalIdNumber.trim().length >= 4 &&
    draft.birthPlace.trim().length >= 2;

  if (status === 'verified') {
    return (
      <div className="card console-panel">
        <Badge tone="success">{t('verification.status.verified')}</Badge>
        <p style={{ marginBlockStart: 'var(--space-3)' }}>{t('verification.alreadyVerified')}</p>
      </div>
    );
  }

  if (status === 'pending') {
    return (
      <div className="card console-panel">
        <Badge tone="warning">{t('verification.status.pending')}</Badge>
        <p style={{ marginBlockStart: 'var(--space-3)' }}>{t('verification.submitted')}</p>
      </div>
    );
  }

  async function submit() {
    if (!configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }
    if (!front || !back) {
      setError(t('errors.MISSING_DOCUMENT'));
      return;
    }

    setBusy(true);
    setError(null);

    const [frontUpload, backUpload] = await Promise.all([
      uploadVerificationDocument(front, 'national_id_front'),
      uploadVerificationDocument(back, 'national_id_back'),
    ]);

    if (!frontUpload.ok || !backUpload.ok) {
      setBusy(false);
      setError(t('errors.NETWORK'));
      return;
    }

    const profileUpdate = await client.call(identityCommandSpec, {
      action: 'profile.update',
      fullName: draft.fullName.trim(),
      nationalIdType: draft.nationalIdType,
      nationalIdNumber: draft.nationalIdNumber.trim(),
      birthPlace: draft.birthPlace.trim(),
    });

    if (!profileUpdate.ok) {
      setBusy(false);
      setError(t(errorKey(profileUpdate.error.code)));
      return;
    }

    const result = await client.call(identityCommandSpec, {
      action: 'verification.submit',
      subjectType: 'individual',
      subjectId: userId,
      documents: [
        {
          kind: 'national_id_front',
          path: frontUpload.path,
          sizeBytes: front.size,
          mime: front.type,
        },
        { kind: 'national_id_back', path: backUpload.path, sizeBytes: back.size, mime: back.type },
      ],
    });

    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setStatus('pending');
    setMessage(t('verification.submitted'));
  }

  const steps: { key: Step; label: TranslationKey }[] = [
    { key: 'identity', label: 'verification.step.identity' },
    { key: 'documents', label: 'verification.step.documents' },
    { key: 'review', label: 'verification.step.submit' },
  ];

  return (
    <div className="card console-panel">
      <div className="wizard-steps" role="list">
        {steps.map((item, index) => (
          <div
            key={item.key}
            role="listitem"
            className={`wizard-step${item.key === step ? ' wizard-step--active' : ''}${
              steps.findIndex((s) => s.key === step) > index ? ' wizard-step--done' : ''
            }`}
          >
            <span className="wizard-step__index num" aria-hidden="true">
              {index + 1}
            </span>
            <span>{t(item.label)}</span>
          </div>
        ))}
      </div>

      {initialNote && status === 'rejected' ? (
        <p className="form-error" role="status">
          {t('verification.rejectedNote', { reason: initialNote })}
        </p>
      ) : null}

      {step === 'identity' ? (
        <div className="form-grid">
          <Field
            label={t('verification.fullName')}
            value={draft.fullName}
            onChange={(event) => setDraft({ ...draft, fullName: event.target.value })}
            autoComplete="name"
            required
          />
          <Select
            label={t('verification.nationalIdType')}
            value={draft.nationalIdType}
            onChange={(event) =>
              setDraft({ ...draft, nationalIdType: event.target.value as Draft['nationalIdType'] })
            }
            options={[
              { value: 'national_id', label: t('verification.idNational') },
              { value: 'passport', label: t('verification.idPassport') },
              { value: 'residence', label: t('verification.idResidence') },
            ]}
          />
          <Field
            label={t('verification.nationalIdNumber')}
            value={draft.nationalIdNumber}
            onChange={(event) => setDraft({ ...draft, nationalIdNumber: event.target.value })}
            inputMode="numeric"
            dir="ltr"
            required
          />
          <Field
            label={t('verification.birthPlace')}
            value={draft.birthPlace}
            onChange={(event) => setDraft({ ...draft, birthPlace: event.target.value })}
            required
          />
          <div className="form-actions">
            <Button onClick={() => setStep('documents')} disabled={!identityComplete}>
              {t('common.continue')}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'documents' ? (
        <div className="form-grid">
          <p className="form-hint">{t('verification.documentsHint')}</p>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="doc-front">
              {t('verification.front')}
            </label>
            <input
              id="doc-front"
              className="ui-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(event) => setFront(event.target.files?.[0] ?? null)}
            />
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="doc-back">
              {t('verification.back')}
            </label>
            <input
              id="doc-back"
              className="ui-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(event) => setBack(event.target.files?.[0] ?? null)}
            />
          </div>
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setStep('identity')}>
              {t('common.back')}
            </Button>
            <Button onClick={() => setStep('review')} disabled={!front || !back}>
              {t('common.continue')}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'review' ? (
        <div className="form-grid">
          <dl className="summary-list">
            <div>
              <dt>{t('verification.fullName')}</dt>
              <dd>{draft.fullName}</dd>
            </div>
            <div>
              <dt>{t('verification.nationalIdNumber')}</dt>
              <dd dir="ltr">{draft.nationalIdNumber}</dd>
            </div>
            <div>
              <dt>{t('verification.birthPlace')}</dt>
              <dd>{draft.birthPlace}</dd>
            </div>
            <div>
              <dt>{t('common.status')}</dt>
              <dd>
                <Badge tone={STATUS_TONE[status]}>{t(STATUS_LABEL[status])}</Badge>
              </dd>
            </div>
          </dl>
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setStep('documents')}>
              {t('common.back')}
            </Button>
            <Button onClick={submit} loading={busy}>
              {t('verification.submit')}
            </Button>
          </div>
        </div>
      ) : null}

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
