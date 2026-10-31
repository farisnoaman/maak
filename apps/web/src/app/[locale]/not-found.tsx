import { LOCALE_LABEL, translate, DEFAULT_LOCALE, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';

/**
 * Localized 404. `not-found.tsx` cannot read route params, so it falls back to Arabic
 * (the default locale) and offers both language homes — never a dead end.
 */
export default function NotFound() {
  const t = (key: TranslationKey) => translate(DEFAULT_LOCALE, key);

  return (
    <main id="main" className="shell section">
      <h1>{t('errors.NOT_FOUND')}</h1>
      <div style={{ marginBlockStart: 'var(--space-6)', display: 'flex', gap: 'var(--space-3)' }}>
        <a href="/ar">
          <Button>{LOCALE_LABEL.ar}</Button>
        </a>
        <a href="/en">
          <Button variant="ghost">{LOCALE_LABEL.en}</Button>
        </a>
      </div>
    </main>
  );
}
