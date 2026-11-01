import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { ReconciliationDesk } from '@/components/finance/ReconciliationDesk';
import { financeNav } from '@/components/payments/financeNav';
import { loadAccountContext } from '@/lib/account';
import { loadReconciliation } from '@/lib/finance';

/**
 * `/finance/reconciliation` — importing statements and working the exceptions.
 *
 * Finance-only: the import reads a bank statement and the resolve actions write matching rows, so a
 * narrower screen would produce unmatched money with nobody responsible for it.
 */
export const dynamic = 'force-dynamic';

export default async function FinanceReconciliationPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/finance/reconciliation`);
  }

  const allowed =
    loaded.roles.includes('finance_officer') || loaded.roles.includes('platform_admin');
  const data = allowed ? await loadReconciliation() : { imports: [], lines: [] };

  return (
    <>
      <SiteHeader locale={locale} pathname="/finance/reconciliation" />
      <ConsoleShell
        locale={locale}
        title="recon.title"
        subtitle="recon.subtitle"
        phase="10"
        items={financeNav(locale)}
      >
        {allowed ? (
          <ReconciliationDesk locale={locale} data={data} orgId={null} ownerUserId={null} />
        ) : (
          <p className="form-hint">{t('errors.FORBIDDEN')}</p>
        )}
      </ConsoleShell>
    </>
  );
}
