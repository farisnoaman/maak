import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { PreviewBanner } from '@/components/PreviewBanner';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminNav } from '@/components/admin/AdminNav';
import { PlansEditor } from '@/components/finance/PlansEditor';
import { loadAccountContext } from '@/lib/account';
import { loadCommissionRules, loadPlans } from '@/lib/finance';

/**
 * `/admin/plans/commissions` — the rates that beat the platform default.
 *
 * It shared `/admin/plans` with the price list: one page answering "what does a plan cost?" and "what does this
 * organisation pay instead?" The prices stay on the index; the rules and their form live here.
 */
export const dynamic = 'force-dynamic';

export default async function AdminPlanCommissionsPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/plans/commissions`);
  }

  const allowed = loaded.roles.includes('platform_admin');
  if (!allowed) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/admin/plans" />
        <main id="main" className="shell section">
          <h1>{t('plans.commissions')}</h1>
          <p className="form-hint">{t('errors.FORBIDDEN')}</p>
        </main>
      </>
    );
  }

  const [plans, rules] = await Promise.all([loadPlans(), loadCommissionRules()]);

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/plans" />
      <ConsoleShell
        consoleTitle="console.admin"
        pathname="/admin/plans"
        locale={locale}
        title="plans.commissions"
        subtitle="plans.commissionsSubtitle"
        groups={adminNav(locale)}
        actions={
          <Link className="ui-btn ui-btn--ghost ui-btn--sm" href={`/${locale}/admin/plans`}>
            {t('plans.backToPlans')}
          </Link>
        }
      >
        {loaded.configured ? null : <PreviewBanner locale={locale} />}
        <PlansEditor locale={locale} plans={plans} rules={rules} mode="commissions" />
      </ConsoleShell>
    </>
  );
}
