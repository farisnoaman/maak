'use client';

import { useEffect } from 'react';
import { forgetSessionToken, rememberSessionToken } from '@/lib/session-token';

/**
 * Keeps `?st=` (the cookie-less session token) on internal navigations.
 *
 * The first version of this rewrote every `href` as soon as it mounted. That is what React means by a
 * hydration error: the attribute the server rendered was `/ar`, and by the time React compared them the
 * value was `/ar?st=…`, so it logged a mismatch and refused to patch it up. Mutating server-rendered
 * markup is not a thing a client component is allowed to do, no matter how well intentioned.
 *
 * So this only *listens*: a click on an internal link or a submit of an internal form is caught at the
 * document level and given the token on its way out. The DOM is never touched before hydration, and
 * after it only in the act of navigating.
 *
 * Only active when the URL carries a token — i.e. when sign-in already decided cookies cannot work.
 */
export function SessionTokenKeeper() {
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('st');
    // Keep a copy for this tab before anything else: `lib/api.ts` reads it on every write, and the
    // address bar is the only place the token exists until somebody navigates away from this URL.
    if (token) rememberSessionToken(token);
    if (!token) return;

    const withToken = (raw: string | null): string | null => {
      if (!raw) return null;
      const url = new URL(raw, window.location.origin);
      if (url.origin !== window.location.origin) return null;
      if (!url.pathname.startsWith('/')) return null;
      if (url.pathname.startsWith('/_next') || url.pathname.startsWith('/api/qr')) return null;
      if (url.searchParams.has('st')) return null;
      url.searchParams.set('st', token);
      return `${url.pathname}${url.search}${url.hash}`;
    };

    const onClick = (event: MouseEvent) => {
      // Let the browser handle new tabs, downloads and modified clicks as usual.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;

      const next = withToken(anchor.getAttribute('href'));
      if (!next) return;

      // A full navigation, deliberately: the session has to be resolved on the server, and a client
      // transition would leave the address bar without the token the next request needs.
      event.preventDefault();
      window.location.assign(next);
    };

    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || event.defaultPrevented) return;
      // Signing out must forget the stored copy too, or the tab stays signed in for writes after the
      // POST has cleared the cookie — the mirror image of the bug this whole mechanism exists for.
      if ((form.getAttribute('action') ?? '').includes('/api/auth/sign-out')) forgetSessionToken();
      const next = withToken(form.getAttribute('action') ?? window.location.pathname);
      if (!next) return;
      // Set at submit time, after hydration — never during render.
      form.setAttribute('action', next);
    };

    // A previous version of this component wrote `?st=` into every `href`. Tabs that survived that
    // build still carry those attributes, and React reports them as a hydration mismatch on every
    // render. Repairing them once, after hydration, ends that permanently.
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href*="st="]')) {
      const cleaned = anchor.getAttribute('href')?.replace(/[?&]st=[^&]*/, '');
      if (cleaned) anchor.setAttribute('href', cleaned.replace(/[?&]$/, ''));
    }

    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('submit', onSubmit, true);
    };
  }, []);

  return null;
}
