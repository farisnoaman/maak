import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminNav } from '@/components/admin/AdminNav';
import { PlansEditor } from '@/components/finance/PlansEditor';
import { loadAccountContext } from '@/lib/account';
import { loadCommissionRules, loadPlans } from '@/lib/finance';

/**
 * `/admin/plans` — the price list.
 *
 * Admin-only, because this is one of the two levers that decide what the platform earns. Everything editable here
 * is a row: a price change is an update, not a deploy, which is the point of putting plans in the database.
 * The other lever — negotiated commission rates — is its own page at `/admin/plans/commissions`.
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
        consoleTitle="console.admin"
        pathname="/admin/plans"
        locale={locale}
        title="plans.title"
        subtitle="plans.subtitle"
        groups={adminNav(locale)}
        facts={[
          { label: t('plans.priceList'), value: String(plans.length) },
          {
            label: t('plans.commissions'),
            value: String(rules.length),
            href: `/${locale}/admin/plans/commissions`,
          },
        ]}
        actions={
          <Link
            className="ui-btn ui-btn--ghost ui-btn--sm"
            href={`/${locale}/admin/plans/commissions`}
          >
            {t('plans.commissions')}
          </Link>
        }
      >
        {allowed ? (
          <PlansEditor locale={locale} plans={plans} rules={rules} mode="plans" />
        ) : (
          <p className="form-hint">{t('errors.FORBIDDEN')}</p>
        )}
      </ConsoleShell>
    </>
  );
}
