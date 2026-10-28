import { translate, type Locale } from '@maak/core';

/**
 * Shown on every screen that is rendering fixtures because no database is configured.
 *
 * It is deliberately loud and `role="status"`: nobody should mistake demo rows for real data, and a
 * screenshot of a preview can never be passed off as production.
 */
export function PreviewBanner({ locale }: { readonly locale: Locale }) {
  return (
    <p className="preview-banner" role="status">
      <span aria-hidden="true">◐</span> {translate(locale, 'preview.banner')}
    </p>
  );
}
