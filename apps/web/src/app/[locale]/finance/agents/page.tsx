import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { AgentsDesk } from '@/components/payments/AgentsDesk';
import { financeNav } from '@/components/payments/financeNav';
import { loadAccountContext } from '@/lib/account';
import { loadAgents } from '@/lib/payments';

/**
 * `/finance/agents` — the floats.
 *
 * A cash agent holds the platform's money in a drawer. The credit limit is the ceiling on that drawer, and
 * the command refuses a cash-in that would cross it; this page shows the number it compares against so the
 * refusal is never a surprise.
 */
export const dynamic = 'force-dynamic';

export default async function FinanceAgentsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/finance/agents`);
  }

  const agents = await loadAgents();

  return (
    <>
      <SiteHeader locale={locale} pathname="/finance/agents" />
      <ConsoleShell
        locale={locale}
        title="financeAgents.title"
        subtitle="financeAgents.subtitle"
        phase="9"
        items={financeNav(locale)}
      >
        <section>
          <p className="form-hint">{t('financeAgents.subtitle')}</p>
          <AgentsDesk locale={locale} agents={agents} />
        </section>
      </ConsoleShell>
    </>
  );
}
