'use client';

import { useEffect } from 'react';

/**
 * Reloads the tab when its JavaScript no longer belongs to the server that rendered it.
 *
 * Two failure modes, both normal for a preview iframe that stays open for hours:
 *
 * 1. **Stale document.** The tab displays HTML from a build that no longer exists and hydrates it with
 *    chunks from a new one.
 * 2. **Stale chunks.** The server restarted (sandbox resume, `npm run dev` again) while the tab stayed
 *    open. Its HMR socket is dead, so the old modules live on in memory, and every navigation hydrates
 *    fresh server HTML with old client code. React reports a hydration mismatch about attributes that
 *    no longer exist in the source, which is impossible to act on.
 *
 * Each side is detected directly rather than inferred: `build` arrives as a prop (so it is the *server's*
 * build), while `process.env.NEXT_PUBLIC_MAAK_BUILD` is inlined into this chunk at compile time (so it is
 * this *chunk's* build). When they disagree, one of them is stale — and a reload is the only cure.
 *
 * In production the stamp is unset on both sides, so this is inert. It reloads at most once per build,
 * so a mismatch it cannot fix ends in silence rather than a reload loop.
 */
export function StaleBuildGuard({ build }: { readonly build: string }) {
  useEffect(() => {
    const chunkBuild = process.env.NEXT_PUBLIC_MAAK_BUILD ?? 'dev';
    if (!build || build === 'dev' || chunkBuild === 'dev') return;

    const key = 'maak:reloaded-for';
    const reloadOnce = (target: string) => {
      try {
        if (window.sessionStorage.getItem(key) === target) return;
        window.sessionStorage.setItem(key, target);
        window.location.reload();
      } catch {
        // Storage disabled: do not risk a loop.
      }
    };

    // (2) This chunk predates the document that asked for it.
    if (chunkBuild !== build) {
      reloadOnce(build);
      return;
    }

    // (1) The document is older than the server answering now.
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/version', { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const current = ((await response.json()) as { build?: string }).build;
        if (!current || current === build) return;
        reloadOnce(current);
      } catch {
        // Offline or the endpoint is missing: leave the page alone.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [build]);

  return null;
}
