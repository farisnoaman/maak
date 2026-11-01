import { notFound, redirect } from 'next/navigation';
import { formatMinor, isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { InvoiceDesk } from '@/components/finance/InvoiceDesk';
import { financeNav } from '@/components/payments/financeNav';
import { loadAccountContext } from '@/lib/account';
import { loadInvoices } from '@/lib/finance';

/**
 * `/finance/invoices` — every bill the platform has issued.
 *
 * Finance sees all of them and can settle or void; an operator sees only their own and can settle theirs.
 * The read policy decides which, so the page never filters by hand and cannot leak somebody else's invoices.
 */
export const dynamic = 'force-dynamic';

export default async function FinanceInvoicesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/finance/invoices`);
  }

  const isFinance = loaded.roles.includes('finance_officer');
  const org = loaded.organizations[0] ?? null;
  const invoices = await loadInvoices({ orgId: isFinance ? null : (org?.id ?? null) });

  const open = invoices.filter((invoice) => invoice.status !== 'paid' && invoice.status !== 'void');
  const outstanding = open.reduce((sum, invoice) => sum + invoice.totalYer, 0);

  return (
    <>
      <SiteHeader locale={locale} pathname="/finance/invoices" />
      <ConsoleShell
        locale={locale}
        title="invoices.title"
        subtitle="invoices.subtitle"
        phase="10"
        items={financeNav(locale)}
      >
        <section>
          <h2>{t('invoices.title')}</h2>
          <p className="form-hint">
            {t('statement.balance')}: {formatMinor(outstanding, 'YER', { locale })}
          </p>
          <InvoiceDesk locale={locale} invoices={invoices} canSettle={isFinance || org !== null} />
        </section>
      </ConsoleShell>
    </>
  );
}
