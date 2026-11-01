'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  errorKey,
  financeCommandSpec,
  translate,
  type FinanceAction,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { getApiClient } from '@/lib/api';

export interface FinanceFailure {
  readonly code: string;
  readonly fields?: Record<string, string>;
}

/**
 * The one place a finance command is sent from the browser.
 *
 * Every screen — the journal editor, the billing page, the plans editor, the reconciliation desk — shares
 * it, so the busy state, the translated failure and the refresh after success cannot drift. The failure is
 * translated from the *code*, not from the server's English detail: `UNBALANCED_JOURNAL` has a sentence
 * that says what to fix, and shipping English to an Arabic screen is not a fallback.
 */
export function useFinanceCommand(locale: Locale) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FinanceFailure | null>(null);
  const [done, setDone] = useState(false);

  async function run(input: FinanceAction): Promise<Record<string, unknown> | null> {
    const client = getApiClient();
    if (!client) {
      setFailure({ code: 'INTERNAL' });
      return null;
    }
    setBusy(true);
    setFailure(null);
    setDone(false);
    const result = await client.call(financeCommandSpec, input);
    setBusy(false);
    if (!result.ok) {
      setFailure(result.error as FinanceFailure);
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

/** One error line, so every money screen reports a refusal the same way. */
export function FinanceAlert({ message }: { readonly message: string | null }) {
  if (!message) return null;
  return (
    <p className="ui-alert ui-alert--error" role="alert">
      {message}
    </p>
  );
}
