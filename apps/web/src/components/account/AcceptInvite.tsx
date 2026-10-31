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
import { getApiClient } from '@/lib/api';

/**
 * Accepts a company invitation.
 *
 * The token in the URL is the *raw* token; the server compares its sha256 against the stored hash and
 * refuses if the signed-in account is not the person the invite was addressed to. So forwarding this
 * link does not let anyone else join the company.
 */
export function AcceptInvite({
  locale,
  memberId,
  token,
  configured,
}: {
  readonly locale: Locale;
  readonly memberId: string;
  readonly token: string;
  readonly configured: boolean;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await client.call(identityCommandSpec, {
      action: 'member.accept',
      memberId,
      token,
    });
    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setMessage(t('org.saved'));
  }

  return (
    <div className="card console-panel">
      <p className="form-hint" dir="ltr">
        {memberId}
      </p>
      <div className="form-actions">
        <Button onClick={accept} loading={busy}>
          {t('org.invite')}
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
    </div>
  );
}
