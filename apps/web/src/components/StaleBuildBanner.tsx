'use client';

import { useEffect, useState } from 'react';
import { translate, type Locale } from '@maak/core';

type StaleReason = 'chunk' | 'server';

/**
 * Tells you when the page you are looking at was served by an older build — **without reloading it**.
 *
 * The first version of this reloaded automatically, and it was wrong in the worst possible way: the
 * preview stays open for hours, a rebuild makes the running chunk disagree with the document, and the
 * page then reloaded itself every couple of seconds. Anything typed into a form was destroyed before it
 * could be submitted — the sign-in POST never reached the server at all.
 *
 * So this only ever *reports*: one fetch, one banner, one button. Reloading is the user's decision and
 * therefore happens on a click, never on a timer. The stale-asset problem that motivated this is solved
 * at the source instead — `next.config.mjs` gives every dev run its own asset URL space, so a fresh
 * document cannot reference an older build's chunks.
 *
 * In production neither stamp is set, so nothing renders.
 */
export function StaleBuildBanner({ build, locale }: { build: string; locale: Locale }) {
  const [stale, setStale] = useState<StaleReason | null>(null);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

  useEffect(() => {
    if (!build || build === 'dev') return;

    // A chunk compiled by a different run than the document that loaded it.
    const chunkBuild = process.env.NEXT_PUBLIC_MAAK_BUILD ?? 'dev';
    if (chunkBuild !== 'dev' && chunkBuild !== build) {
      setStale('chunk');
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/version', { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const current = ((await response.json()) as { build?: string }).build;
        if (current && current !== build) setStale('server');
      } catch {
        // Offline or the endpoint is missing: say nothing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [build]);

  if (!stale) return null;

  return (
    <div className="shell" role="status">
      <p className="form-hint stale-banner">
        {t('common.staleBuild')}{' '}
        <button
          type="button"
          className="ui-btn ui-btn--subtle ui-btn--sm"
          onClick={() => window.location.reload()}
        >
          {t('common.reload')}
        </button>
      </p>
    </div>
  );
}
