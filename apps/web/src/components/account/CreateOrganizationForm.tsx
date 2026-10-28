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
import { Select } from '@/components/ui/Select';
import { getApiClient } from '@/lib/api';

/**
 * Create a company account. Deliberately open to any signed-in user: the account exists as
 * *unverified* until staff review it, so creating one grants no operational power (BR-01..03).
 */
export function CreateOrganizationForm({
  locale,
  configured,
}: {
  readonly locale: Locale;
  readonly configured: boolean;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [kind, setKind] = useState<'company' | 'agency'>('company');
  const [registrationNo, setRegistrationNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);

    const result = await client.call(identityCommandSpec, {
      action: 'organization.create',
      name: name.trim(),
      nameEn: nameEn.trim() || undefined,
      kind,
      registrationNo: registrationNo.trim() || undefined,
    });

    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setMessage(t('org.saved'));
    setName('');
    setNameEn('');
    setRegistrationNo('');
  }

  if (!open) {
    return (
      <Button variant="subtle" onClick={() => setOpen(true)}>
        {t('account.createOrganization')}
      </Button>
    );
  }

  return (
    <fieldset className="invite-box">
      <legend>{t('org.createTitle')}</legend>
      <div className="form-grid">
        <Field
          label={t('org.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Field
          label={t('org.nameEn')}
          value={nameEn}
          onChange={(e) => setNameEn(e.target.value)}
          dir="ltr"
          hint={t('common.optional')}
        />
        <Select
          label={t('org.kind')}
          value={kind}
          onChange={(e) => setKind(e.target.value as 'company' | 'agency')}
          options={[
            { value: 'company', label: t('org.kind.company') },
            { value: 'agency', label: t('org.kind.agency') },
          ]}
        />
        <Field
          label={t('org.registrationNo')}
          value={registrationNo}
          onChange={(e) => setRegistrationNo(e.target.value)}
          dir="ltr"
          hint={t('common.optional')}
        />
      </div>
      <div className="form-actions">
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
        <Button onClick={create} loading={busy} disabled={name.trim().length < 2}>
          {t('org.create')}
        </Button>
      </div>
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
    </fieldset>
  );
}
