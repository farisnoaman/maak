import { Skeleton } from '@/components/ui/Feedback';
import { translate, DEFAULT_LOCALE, type TranslationKey } from '@maak/core';

/** Streaming fallback: stable layout, no content jump, announced to screen readers. */
export default function Loading() {
  const t = (key: TranslationKey) => translate(DEFAULT_LOCALE, key);
  return (
    <main id="main" className="shell section" aria-busy="true">
      <Skeleton height={34} width="52%" label={t('common.loading')} />
      <div style={{ blockSize: 'var(--space-4)' }} />
      <Skeleton height={16} width="78%" />
      <div style={{ blockSize: 'var(--space-8)' }} />
      <div className="consoles">
        <Skeleton height={120} radius="18px" />
        <Skeleton height={120} radius="18px" />
        <Skeleton height={120} radius="18px" />
      </div>
    </main>
  );
}
