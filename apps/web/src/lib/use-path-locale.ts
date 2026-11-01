'use client';

import { usePathname } from 'next/navigation';
import { isLocale, type Locale } from '@maak/core';

/**
 * The locale from `/[locale]/…`, for the few client components that have no `params`.
 *
 * `loading.tsx` is one: a segment's loading UI is rendered *around* the page and Next does not hand it the
 * route's `params`, so `await params` there is a runtime `TypeError` — which is exactly how the first version
 * of the Phase 11 skeletons failed, on every route that had one. Reading the first path segment back is the
 * only locale the loader can see, and it is always right because the proxy rewrites locale-less paths.
 */
export function usePathLocale(): Locale {
  const pathname = usePathname() ?? '';
  const segment = pathname.split('/')[1] ?? '';
  return isLocale(segment) ? segment : 'ar';
}
