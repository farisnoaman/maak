'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  errorKey,
  paymentsCommandSpec,
  translate,
  type Locale,
  type PaymentsAction,
  type TranslationKey,
} from '@maak/core';
import { getApiClient } from '@/lib/api';

export interface PaymentFailure {
  readonly code: string;
  readonly fields?: Record<string, string>;
}

/**
 * The one place a payment command is sent from the browser.
 *
 * Three surfaces (the pay page, the operator queue, the finance desk) share it so that the busy state, the
 * error translation and the `router.refresh()` after success cannot drift apart. `fields` keeps
 * `VALIDATION_FAILED` message per input instead of one generic sentence, because the fixes differ.
 */
export function usePaymentCommand(locale: Locale) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PaymentFailure | null>(null);
  const [done, setDone] = useState(false);

  async function run(input: PaymentsAction): Promise<Record<string, unknown> | null> {
    const client = getApiClient();
    if (!client) {
      setFailure({ code: 'INTERNAL' });
      return null;
    }
    setBusy(true);
    setFailure(null);
    setDone(false);
    const result = await client.call(paymentsCommandSpec, input);
    setBusy(false);
    if (!result.ok) {
      setFailure(result.error as PaymentFailure);
      return null;
    }
    setDone(true);
    router.refresh();
    return result.data as Record<string, unknown>;
  }

  const message = failure
    ? translate(locale, errorKey(failure.code as never) as TranslationKey)
    : null;

  return { busy, message, failure, done, run, reset: () => setDone(false) };
}

/** A small shared error line so every money screen reports failures the same way. */
export function PaymentAlert({ message }: { readonly message: string | null }) {
  if (!message) return null;
  return (
    <p className="ui-alert ui-alert--error" role="alert">
      {message}
    </p>
  );
}
