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

export interface EditableOrganization {
  readonly id: string;
  readonly name: string;
  readonly nameEn: string | null;
  readonly registrationNo: string | null;
  readonly taxNo: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly kind: 'company' | 'agency';
  readonly verificationStatus: VerificationStatus;
  readonly role: 'owner' | 'manager' | 'accountant' | 'dispatcher';
}

const STATUS_TONE = {
  unverified: 'neutral',
  pending: 'warning',
  verified: 'success',
  rejected: 'danger',
} as const;

/**
 * Company settings + company verification submission.
 *
 * Two rules are visible in the UI because they are enforced in SQL:
 *   · only an owner or manager can edit (the button is hidden AND the command refuses)
 *   · editing the legal name or registration number resets a verified company to unverified, so the
 *     warning is shown before the save, not after.
 */
export function OrganizationPanel({
  locale,
  organization,
  configured,
}: {
  readonly locale: Locale;
  readonly organization: EditableOrganization;
  readonly configured: boolean;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const canEdit = organization.role === 'owner' || organization.role === 'manager';

  const [form, setForm] = useState({
    name: organization.name,
    nameEn: organization.nameEn ?? '',
    registrationNo: organization.registrationNo ?? '',
    taxNo: organization.taxNo ?? '',
    phone: organization.phone ?? '',
    email: organization.email ?? '',
    kind: organization.kind,
  });
  const [status, setStatus] = useState<VerificationStatus>(organization.verificationStatus);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<'save' | 'verify' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const legalChanged =
    form.name.trim() !== organization.name.trim() ||
    form.registrationNo.trim() !== (organization.registrationNo ?? '').trim();

  async function save() {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy('save');
    setError(null);
    setMessage(null);

    const result = await client.call(identityCommandSpec, {
      action: 'organization.update',
      orgId: organization.id,
      name: form.name.trim(),
      nameEn: form.nameEn.trim() || undefined,
      registrationNo: form.registrationNo.trim() || undefined,
      taxNo: form.taxNo.trim() || undefined,
      phone: form.phone.trim() || undefined,
      email: form.email.trim() || undefined,
    });

    setBusy(null);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    const body = result.data.organization as
      { verificationStatus?: VerificationStatus } | undefined;
    if (body?.verificationStatus) setStatus(body.verificationStatus);
    setMessage(t('org.saved'));
  }

  async function submitVerification() {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    if (!file) {
      setError(t('errors.MISSING_DOCUMENT'));
      return;
    }
    setBusy('verify');
    setError(null);

    const upload = await uploadVerificationDocument(file, 'commercial_registration');
    if (!upload.ok) {
      setBusy(null);
      setError(t('errors.NETWORK'));
      return;
    }

    const result = await client.call(identityCommandSpec, {
      action: 'verification.submit',
      subjectType: 'organization',
      subjectId: organization.id,
      documents: [
        {
          kind: 'commercial_registration',
          path: upload.path,
          sizeBytes: file.size,
          mime: file.type,
        },
      ],
    });

    setBusy(null);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setStatus('pending');
    setMessage(t('verification.submitted'));
  }

  return (
    <div className="card console-panel">
      <div className="panel-head">
        <h2 style={{ fontSize: '1.05rem' }}>{t('org.settings')}</h2>
        <Badge tone={STATUS_TONE[status]}>
          {t(`verification.status.${status}` as TranslationKey)}
        </Badge>
      </div>

      <div className="form-grid">
        <Field
          label={t('org.name')}
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          disabled={!canEdit}
          required
        />
        <Field
          label={t('org.nameEn')}
          value={form.nameEn}
          onChange={(event) => setForm({ ...form, nameEn: event.target.value })}
          disabled={!canEdit}
          dir="ltr"
        />
        <Field
          label={t('org.registrationNo')}
          value={form.registrationNo}
          onChange={(event) => setForm({ ...form, registrationNo: event.target.value })}
          disabled={!canEdit}
          dir="ltr"
        />
        <Field
          label={t('org.taxNo')}
          value={form.taxNo}
          onChange={(event) => setForm({ ...form, taxNo: event.target.value })}
          disabled={!canEdit}
          dir="ltr"
          hint={t('common.optional')}
        />
        <Field
          label={t('org.phone')}
          value={form.phone}
          onChange={(event) => setForm({ ...form, phone: event.target.value })}
          disabled={!canEdit}
          dir="ltr"
          inputMode="tel"
        />
        <Field
          label={t('org.email')}
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
          disabled={!canEdit}
          dir="ltr"
          type="email"
        />
        <Select
          label={t('org.kind')}
          value={form.kind}
          onChange={(event) =>
            setForm({ ...form, kind: event.target.value as 'company' | 'agency' })
          }
          disabled={!canEdit}
          options={[
            { value: 'company', label: t('org.kind.company') },
            { value: 'agency', label: t('org.kind.agency') },
          ]}
        />
      </div>

      {legalChanged && status === 'verified' ? (
        <p className="form-warning" role="status">
          {t('notifications.organizationInvalidated')}
        </p>
      ) : null}

      <div className="form-actions">
        <Button onClick={save} loading={busy === 'save'} disabled={!canEdit}>
          {t('org.save')}
        </Button>
      </div>

      {status === 'unverified' || status === 'rejected' ? (
        <div className="verify-box">
          <h3 style={{ fontSize: '0.95rem' }}>{t('org.verification')}</h3>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="org-doc">
              {t('verification.commercialRegistration')}
            </label>
            <input
              id="org-doc"
              className="ui-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              disabled={!canEdit}
            />
          </div>
          <Button
            variant="subtle"
            onClick={submitVerification}
            loading={busy === 'verify'}
            disabled={!canEdit || !file}
          >
            {t('verification.submit')}
          </Button>
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
