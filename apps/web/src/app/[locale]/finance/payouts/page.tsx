import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PayoutQueue } from '@/components/payments/PayoutDesk';
import { financeNav } from '@/components/payments/financeNav';
import { loadAccountContext } from '@/lib/account';
import { loadPayouts } from '@/lib/payments';

/**
 * `/finance/payouts` — the queue where a second pair of eyes decides.
 *
 * `payouts_not_self_approved` is a CHECK constraint, not a convention, so the person who asked cannot be the
 * one who approved — not even with a hand-written update. This screen is what finance actually does:
 * approve, then mark paid with the transfer reference the bank gave them.
 */
export const dynamic = 'force-dynamic';

export default async function FinancePayoutsPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/finance/payouts`);
  }

  const payouts = await loadPayouts();
  const pending = payouts.filter(
    (payout) => payout.status === 'requested' || payout.status === 'approved',
  );

  return (
    <>
      <SiteHeader locale={locale} pathname="/finance/payouts" />
      <ConsoleShell
        locale={locale}
        title="financePayouts.title"
        subtitle="financePayouts.subtitle"
        phase="9"
        items={financeNav(locale)}
      >
        <section>
          <p className="form-hint">{t('financePayouts.subtitle')}</p>
          <PayoutQueue locale={locale} payouts={pending} />
        </section>
      </ConsoleShell>
    </>
  );
}
