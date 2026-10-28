import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { getSession } from '@/lib/supabase/server';
import { Badge, EmptyState } from '@/components/ui/Feedback';

/**
 * A protected route. The proxy already redirects signed-out visitors, and this page re-checks
 * server-side: defence in depth, because a proxy bypass must never expose a private screen.
 */
export default async function AccountPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const session = await getSession();
  if (!session.user) redirect(`/${locale}/auth/sign-in?next=/${locale}/account`);

  return (
    <main id="main" className="shell section">
      <h1>{t('nav.account')}</h1>
      <div className="card console-panel" style={{ marginBlockStart: 'var(--space-6)' }}>
        <Badge tone="success">{t('home.verified')}</Badge>
        <p className="num" dir="ltr" style={{ marginBlockStart: 'var(--space-3)' }}>
          {session.user.email ?? session.user.phone}
        </p>
        <p style={{ fontSize: '0.78rem', color: 'var(--ink-500)' }}>{session.user.id}</p>
      </div>

      <div style={{ marginBlockStart: 'var(--space-8)' }}>
        <EmptyState title={t('common.comingSoon')} description={t('common.phase') + ' 1'} />
      </div>
    </main>
  );
}
