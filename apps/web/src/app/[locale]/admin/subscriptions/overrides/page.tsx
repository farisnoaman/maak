import { notFound, redirect } from 'next/navigation';
import { formatDate, isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { adminNav } from '@/components/admin/AdminNav';
import { EmptyState } from '@/components/ui/Feedback';
import { loadAccountContext } from '@/lib/account';
import { loadQuotaOverrides } from '@/lib/finance';

/**
 * `/admin/subscriptions/overrides` — the support grants that sit beside a plan.
 *
 * It lived at the bottom of the subscriptions list, under a table of every payer: two subjects (who is paying, and
 * which limits support has granted) with one heading each and no way to tell which one a reader came for. The list of
 * payers stays on the index; the grants — and the reason each one exists — are a page of their own.
 *
 * Read-only, like the plan list: an override is added by the support command, and this screen is the audit view of
 * what it did.
 */
export const dynamic = 'force-dynamic';

export default async function AdminQuotaOverridesPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/admin/subscriptions/overrides`);
  }

  const allowed =
    loaded.roles.includes('platform_admin') ||
    loaded.roles.includes('finance_officer') ||
    loaded.roles.includes('platform_staff');

  if (!allowed) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/admin/subscriptions" />
        <ConsoleShell
          consoleTitle="console.admin"
          pathname="/admin/subscriptions"
          locale={locale}
          title="subs.overrides"
          subtitle="subs.overridesSubtitle"
          groups={adminNav(locale)}
        >
          <p className="form-hint">{t('errors.FORBIDDEN')}</p>
        </ConsoleShell>
      </>
    );
  }

  const overrides = await loadQuotaOverrides(null);
  const platformWide = overrides.filter((override) => override.ownerOrgId === null).length;

  return (
    <>
      <SiteHeader locale={locale} pathname="/admin/subscriptions" />
      <ConsoleShell
        consoleTitle="console.admin"
        pathname="/admin/subscriptions"
        locale={locale}
        title="subs.overrides"
        subtitle="subs.overridesSubtitle"
        groups={adminNav(locale)}
        facts={[
          { label: t('subs.factGrants'), value: String(overrides.length) },
          { label: t('plans.platformWide'), value: String(platformWide) },
        ]}
      >
        {overrides.length === 0 ? (
          <EmptyState
            title={t('subs.noOverrides')}
            description={t('subs.noOverridesHint')}
            icon="check"
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table table-cards">
              <caption className="visually-hidden">{t('subs.overrides')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('subs.overrideFor')}</th>
                  <th scope="col">{t('subs.metric')}</th>
                  <th scope="col">{t('subs.limitValue')}</th>
                  <th scope="col">{t('subs.expiresAt')}</th>
                  <th scope="col">{t('subs.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {overrides.map((override) => (
                  <tr key={override.id}>
                    <th scope="row" data-label={t('subs.overrideFor')}>
                      {override.ownerOrgId ? (
                        <bdi dir="ltr" className="id-short">
                          {override.ownerOrgId.slice(0, 8)}
                        </bdi>
                      ) : (
                        t('plans.platformWide')
                      )}
                    </th>
                    <td data-label={t('subs.metric')}>
                      {t(`metric.${override.metric}` as TranslationKey)}
                    </td>
                    <td data-label={t('subs.limitValue')}>
                      {override.limitValue === null ? t('billing.unlimited') : override.limitValue}
                    </td>
                    <td data-label={t('subs.expiresAt')}>
                      {override.expiresAt === null
                        ? t('billing.unlimited')
                        : t('billing.overrideUntil', {
                            date: formatDate(override.expiresAt, { locale }),
                          })}
                    </td>
                    <td data-label={t('subs.reason')}>{override.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ConsoleShell>
    </>
  );
}
