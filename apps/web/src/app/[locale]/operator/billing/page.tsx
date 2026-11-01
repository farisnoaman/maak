import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type TranslationKey, type Locale } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { BillingPanel } from '@/components/finance/BillingPanel';
import { operatorMoneyNav } from '@/components/payments/financeNav';
import { loadAccountContext } from '@/lib/account';
import {
  loadFinanceDashboard,
  loadOwnSubscription,
  loadPlans,
  loadQuotaOverrides,
} from '@/lib/finance';

/**
 * `/operator/billing` — the plan, the period and what is left of the limits.
 *
 * The status and the plan come from `finance.dashboard`, which resolves them in SQL (`app.owner_plan`), so
 * the screen cannot claim Pro while the database has already fallen back to Basic after an expiry. The quota
 * list is the same function `app.assert_quota` refuses on, which is why "you have 1 of 1 vehicles" and the
 * refusal to add a second one always agree.
 */
export const dynamic = 'force-dynamic';

export default async function OperatorBillingPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/billing`);
  }
  const org = loaded.organizations[0] ?? null;

  const [dashboard, subscription, plans, overrides] = await Promise.all([
    loadFinanceDashboard({ orgId: org?.id ?? null, ownerUserId: loaded.user?.id ?? null }),
    loadOwnSubscription(org?.id ?? null),
    loadPlans(),
    loadQuotaOverrides(org?.id ?? null),
  ]);

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/billing" />
      <ConsoleShell
        consoleTitle="console.operator"
        pathname="/operator/billing"
        locale={locale}
        title="billing.title"
        subtitle="billing.subtitle"
        items={operatorMoneyNav(locale)}
      >
        {dashboard === null ? (
          <p className="form-hint">{t('billing.noSubscription')}</p>
        ) : (
          <BillingPanel
            locale={locale}
            orgId={org?.id ?? null}
            subscription={subscription}
            plan={dashboard.plan}
            plans={plans}
            quota={dashboard.quota}
            overrides={overrides}
          />
        )}
      </ConsoleShell>
    </>
  );
}
