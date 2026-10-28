import Link from 'next/link';
import type { ReactNode } from 'react';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import { Badge } from './ui/Feedback';

export interface ConsoleNavItem {
  readonly key: TranslationKey;
  readonly href: string;
}

/**
 * *-console layout shared by operator, staff and admin.
 *
 * One component means one place to change navigation, one place to add a permission gate,
 * and no drift between consoles. Items are filtered by the caller (server-side), never hidden
 * in the client as a security measure.
 */
export function ConsoleShell({
  locale,
  title,
  subtitle,
  phase,
  items,
  children,
}: {
  readonly locale: Locale;
  readonly title: TranslationKey;
  readonly subtitle: TranslationKey;
  readonly phase: string;
  readonly items: readonly ConsoleNavItem[];
  readonly children: ReactNode;
}) {
  const t = (key: TranslationKey) => translate(locale, key);

  return (
    <main id="main" className="shell console-layout">
      <aside>
        {/* Not an <h1>: the page has exactly one, inside the panel. */}
        <p style={{ fontSize: '1.05rem', fontWeight: 800, marginBlockEnd: 'var(--space-4)' }}>
          {t(title)}
        </p>
        <nav className="console-nav" aria-label={t(title)}>
          {items.map((item) => (
            <Link key={item.href} href={item.href}>
              {t(item.key)}
            </Link>
          ))}
        </nav>
      </aside>

      <section className="card console-panel">
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <h1>{t(title)}</h1>
          <Badge tone="warning">
            {t('common.phase')} {phase}
          </Badge>
        </div>
        <p>{t(subtitle)}</p>
        <div className="console-grid">{children}</div>
      </section>
    </main>
  );
}
