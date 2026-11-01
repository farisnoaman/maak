import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PlansEditor } from '@/components/finance/PlansEditor';
import { adminMoneyNav } from '@/components/payments/financeNav';
import { loadAccountContext } from '@/lib/account';
import { loadCommissionRules, loadPlans } from '@/lib/finance';

/**
 * `/admin/plans` — prices, limits and the commission rules.
 *
 * Admin-only, because these are the two levers that decide what the platform earns. Everything editable here
 * is a row: a price change is an update, not a deploy, which is the point of putting plans in the database.
 */
export const dynamic = 'force-dynamic';

export default async function AdminPlansPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/plans`);
  }

  const allowed = loaded.roles.includes('platform_admin');
  const [plans, rules] = await Promise.all([loadPlans(), loadCommissionRules()]);

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/plans" />
      <ConsoleShell
        locale={locale}
        title="plans.title"
        subtitle="plans.subtitle"
        phase="10"
        items={adminMoneyNav(locale)}
      >
        {allowed ? (
          <PlansEditor locale={locale} plans={plans} rules={rules} />
        ) : (
          <p className="form-hint">{t('errors.FORBIDDEN')}</p>
        )}
      </ConsoleShell>
    </>
  );
}
