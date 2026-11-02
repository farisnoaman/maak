import { Skeleton } from '@/components/ui/Feedback';
import { translate, DEFAULT_LOCALE, type TranslationKey } from '@maak/core';

/**
 * The marketplace streaming fallback: a title, a line of explanation, then results the shape of the rows that
 * replace them. `notFound()` needs the first byte of a response to decide its status, so a loading boundary at the
 * *locale* root turned every 404 into a 200 with a skeleton in it; a boundary here, on the one list that actually
 * streams, leaves the rest of the app free to answer correctly.
 */
export default function Loading() {
  const t = (key: TranslationKey) => translate(DEFAULT_LOCALE, key);
  return (
    <main id="main" className="shell section" aria-busy="true">
      <Skeleton height={34} width="46%" label={t('common.loading')} />
      <div style={{ blockSize: 'var(--space-3)' }} />
      <Skeleton height={14} width="62%" />
      <div style={{ blockSize: 'var(--space-6)' }} />
      <div className="skeleton-stack">
        <Skeleton height={88} radius="var(--radius-lg)" />
        <Skeleton height={88} radius="var(--radius-lg)" />
        <Skeleton height={88} radius="var(--radius-lg)" />
      </div>
    </main>
  );
}
