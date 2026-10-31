'use client';

import { useState } from 'react';
import { translate, type Locale, type TranslationKey } from '@maak/core';

/**
 * Share this trip.
 *
 * Two mechanisms, in order of preference: the native share sheet (a phone user expects WhatsApp there),
 * then the clipboard. Both are guarded — `navigator.share` needs a secure context and a user gesture, and
 * a browser that has neither still gets a visible, selectable URL rather than a button that does nothing.
 */
export function ShareTrip({ locale, url }: { readonly locale: Locale; readonly url: string }) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function share() {
    const absolute = new URL(url, window.location.origin).toString();
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({ url: absolute });
        setStatus('copied');
        return;
      }
      await navigator.clipboard.writeText(absolute);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  }

  return (
    <div className="trip-share">
      <button type="button" className="ui-btn ui-btn--ghost" onClick={() => void share()}>
        {t('trips.share')}
      </button>
      <p role="status" className="trip-form__hint">
        {status === 'copied' ? t('trips.shareCopied') : null}
        {status === 'failed' ? t('trips.shareFailed') : null}
      </p>
    </div>
  );
}
