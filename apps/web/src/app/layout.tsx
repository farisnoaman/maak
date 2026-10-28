import type { ReactNode } from 'react';

/**
 * Root layout intentionally renders only `children`.
 * The real <html lang dir> element lives in `[locale]/layout.tsx`, because direction and
 * language are per-route, not per-app (see specs.md §6.15).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
