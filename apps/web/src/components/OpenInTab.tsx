'use client';

import { useEffect, useState } from 'react';
import { translate, type Locale, type TranslationKey } from '@maak/core';

/**
 * A permanent escape hatch from the embedded preview.
 *
 * Inside a third-party iframe a browser may refuse to keep the session cookie at all (Safari and
 * Firefox do by default). A top-level tab has no third-party restrictions, so this link — the same
 * page, opened first-party — turns "sign-in does nothing" into a working app. It renders only when
 * embedded, so it never appears on a normal deployment.
 */
export function OpenInTab({ locale, path }: { locale: Locale; path: string }) {
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    if (window.self === window.top) return;
    setHref(`${window.location.origin}${path}`);
  }, [path]);

  if (!href) return null;

  return (
    <a className="nav-link" href={href} target="_blank" rel="noreferrer">
      {translate(locale, 'auth.openInTab' as TranslationKey)}
    </a>
  );
}
