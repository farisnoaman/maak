'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';

type AccessState = 'unknown' | 'granted' | 'blocked' | 'unsupported';

/**
 * Storage Access API for the embedded preview.
 *
 * A document in a third-party iframe is "cross-site" even when it talks to its own origin, and browsers
 * that block third-party storage will then store the session cookie and never send it back — sign-in
 * appears to do nothing. The standards answer is `document.requestStorageAccess()`, which asks the
 * browser for unpartitioned storage access; it must be called from a user gesture, and a sign-in click
 * is exactly that.
 *
 * This is progressive enhancement, never a requirement: with JavaScript off the plain form still posts,
 * and with no third-party restriction (`window.self === window.top`) nothing renders at all.
 */
export function StorageAccessPrompt({ locale }: { locale: Locale }) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [state, setState] = useState<AccessState>('unknown');
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);

  const embedded = typeof window !== 'undefined' && window.self !== window.top;

  useEffect(() => {
    if (!embedded) {
      setState('granted');
      return;
    }
    const hasStorageAccess = (document as Document & { hasStorageAccess?: () => Promise<boolean> })
      .hasStorageAccess;
    if (typeof hasStorageAccess !== 'function') {
      // No Storage Access API: nothing to ask for. The sign-in flow still reports the outcome.
      setState('unsupported');
      return;
    }
    hasStorageAccess
      .call(document)
      .then((granted) => setState(granted ? 'granted' : 'blocked'))
      .catch(() => setState('blocked'));
  }, [embedded]);

  const request = useCallback(async () => {
    const api = document as Document & { requestStorageAccess?: () => Promise<void> };
    if (typeof api.requestStorageAccess !== 'function') {
      setState('unsupported');
      return false;
    }
    setBusy(true);
    try {
      await api.requestStorageAccess();
      setState('granted');
      return true;
    } catch {
      setState('blocked');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  // Ask *before* the form navigates: once we are on the way out, no user gesture is available any more.
  useEffect(() => {
    const form = formRef.current ?? document.querySelector('form.auth-form');
    if (!form || state === 'granted' || state === 'unsupported') return;

    const onSubmit = (event: Event) => {
      const submitEvent = event as SubmitEvent;
      event.preventDefault();
      const formElement = submitEvent.target as HTMLFormElement;
      // Whatever the answer, the form goes through: a refusal is reported by the redirect, which is
      // more useful than a dead button.
      void request().finally(() => formElement.submit());
    };

    form.addEventListener('submit', onSubmit, true);
    return () => form.removeEventListener('submit', onSubmit, true);
  }, [request, state]);

  if (!embedded || state === 'granted' || state === 'unknown') return null;

  return (
    <div className="auth-notice" role="note">
      <p>{t('auth.storageAccessBody')}</p>
      {state === 'blocked' ? (
        <Button variant="ghost" fullWidth loading={busy} onClick={() => void request()}>
          {t('auth.storageAccessEnable')}
        </Button>
      ) : null}
      {state === 'unsupported' ? (
        <a
          className="ui-btn ui-btn--ghost ui-btn--block"
          href={window.location.href}
          target="_blank"
          rel="noreferrer"
        >
          {t('auth.openInTab')}
        </a>
      ) : null}
      <form ref={formRef} hidden />
    </div>
  );
}
