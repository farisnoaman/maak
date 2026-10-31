'use client';

import { useEffect } from 'react';

/**
 * Keeps `?st=` (the cookie-less session token) attached to internal links.
 *
 * Only active when the URL carries a token, which happens only when the sign-in flow decided it had to
 * use the fallback — i.e. an embedded preview where cookies cannot be stored. Every same-origin link is
 * rewritten as it appears (and as the router adds more), so navigating never silently signs you out.
 *
 * This is the one place that knows about the token; pages and components stay oblivious.
 */
export function SessionTokenKeeper() {
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('st');
    if (!token) return;

    const attach = (root: ParentNode) => {
      for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')) {
        const url = new URL(anchor.href, window.location.origin);
        if (url.origin !== window.location.origin) continue;
        if (url.searchParams.has('st')) continue;
        url.searchParams.set('st', token);
        anchor.href = `${url.pathname}${url.search}${url.hash}`;
      }
      for (const form of root.querySelectorAll<HTMLFormElement>('form[action^="/"]')) {
        const hidden = form.querySelector<HTMLInputElement>('input[name="st"]');
        if (hidden) continue;
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'st';
        input.value = token;
        form.append(input);
      }
    };

    attach(document);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) attach(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
