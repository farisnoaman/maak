'use client';

import { translate } from '@maak/core';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePathLocale } from '@/lib/use-path-locale';

/**
 * The route waits on one RPC, so it streams a skeleton instead of a blank panel. A client component because
 * a loading segment gets no `params`; the locale comes from the path (see `usePathLocale`). No `<h1>` here on
 * purpose: the page owns the one heading, and a fallback that also claims it gives the route two.
 */
export default function CatalogueLoading() {
  const locale = usePathLocale();

  return (
    <main id="main" className="shell section">
      <Skeleton rows={8} label={translate(locale, 'notifications.loading')} />
    </main>
  );
}
