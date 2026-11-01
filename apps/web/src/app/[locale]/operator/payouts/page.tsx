import { notFound, redirect } from 'next/navigation';
import { formatMinor, isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { Badge } from '@/components/ui/Feedback';
import { PayoutRequestForm } from '@/components/payments/PayoutDesk';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import { loadAvailablePayout, loadPaymentAccounts, loadPayouts } from '@/lib/payments';
import { payoutStatusKey, paymentTone } from '@/lib/payment-labels';

/**
 * `/operator/payouts` — withdrawing what the bookings earned.
 *
 * The available figure comes from `my_available_payout_yer`, the same function the command checks, so the
 * number on screen and the number enforced cannot disagree. Who approved is never shown to the operator as
 * an invitation: the request form says plainly that somebody else decides.
 */
export const dynamic = 'force-dynamic';

export default async function OperatorPayoutsPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/payouts`);
  }

  const org = loaded.configured ? activeOrganization(loaded) : null;
  const [available, accounts, payouts] = await Promise.all([
    loadAvailablePayout(org?.id ?? null),
    loadPaymentAccounts(),
    loadPayouts(),
  ]);

  const destinations = accounts.filter(
    (account) => account.kind !== 'platform' && account.status === 'active',
  );

  const nav = [
    { key: 'console.navOverview' as TranslationKey, href: `/${locale}/operator` },
    { key: 'console.navVehicles' as TranslationKey, href: `/${locale}/operator/vehicles` },
    { key: 'console.navFleet' as TranslationKey, href: `/${locale}/operator/fleet` },
    { key: 'console.navDrivers' as TranslationKey, href: `/${locale}/operator/drivers` },
    { key: 'console.navPayments' as TranslationKey, href: `/${locale}/operator/payments` },
    { key: 'console.navPayouts' as TranslationKey, href: `/${locale}/operator/payouts` },
    { key: 'org.team' as TranslationKey, href: `/${locale}/operator/team` },
  ];

  return (
    <>
      <SiteHeader locale={locale} pathname="/operator/payouts" />
      <ConsoleShell
        locale={locale}
        title="payouts.title"
        subtitle="payouts.subtitle"
        phase="9"
        items={nav}
      >
        <section>
          <p className="payout-available">
            {t('payouts.available')}: <strong>{formatMinor(available, 'YER', { locale })}</strong>
          </p>
          <PayoutRequestForm
            locale={locale}
            availableYer={available}
            accounts={destinations}
            orgId={org?.id ?? null}
          />
        </section>

        <section>
          <h2>{t('payouts.history')}</h2>
          {payouts.length === 0 ? (
            <p className="form-hint">{t('payouts.empty')}</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table table-cards">
                <caption className="visually-hidden">{t('payouts.history')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('payments.reference')}</th>
                    <th scope="col">{t('payouts.amount')}</th>
                    <th scope="col">{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map((payout) => (
                    <tr key={payout.id}>
                      <td data-label={t('payments.reference')}>
                        <bdi dir="ltr">{payout.code}</bdi>
                      </td>
                      <td data-label={t('payouts.amount')}>
                        {formatMinor(payout.amountYer, 'YER', { locale })}
                      </td>
                      <td data-label={t('common.status')}>
                        <Badge tone={paymentTone(payout.status)}>
                          {t(payoutStatusKey(payout.status))}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </ConsoleShell>
    </>
  );
}
