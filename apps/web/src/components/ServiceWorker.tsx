'use client';

import { useEffect } from 'react';

/**
 * Registers the offline fallback — in production only.
 *
 * A service worker in `next dev` is a debugging tax with no upside: it survives restarts, it sits between
 * the browser and a server that changes on every save, and the one thing it would cache is the thing being
 * edited. So development actively *unregisters* one left behind by an earlier production build on the same
 * origin, which is the only way a stale worker ever gets cleaned up.
 *
 * Failure is silent on purpose: an app that cannot install is still an app.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    if (process.env.NODE_ENV !== 'production') {
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((item) => item.unregister())))
        .catch(() => undefined);
      return;
    }

    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);

  return null;
}
