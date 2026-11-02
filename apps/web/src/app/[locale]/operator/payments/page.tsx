import { notFound, redirect } from 'next/navigation';
import { formatMinor, isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PaymentQueue } from '@/components/payments/PaymentQueue';
import { loadAccountContext } from '@/lib/account';
import { loadPaymentIntents } from '@/lib/payments';

/**
 * `/operator/payments` — the receipts that arrived for this operator's trips.
 *
 * The queue is a plain RLS read: `payment_intents_read_authorised` already says "the payer, the trip's
 * operator, or finance", so there is no ownership filter here to get wrong. The page's only job is to show
 * what is waiting and let the operator confirm it — a person who can see the bank statement, which is the
 * closest thing to a card gateway this market has.
 */
export const dynamic = 'force-dynamic';

export default async function OperatorPaymentsPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/operator/payments`);
  }

  const [queue, confirmed] = await Promise.all([
    loadPaymentIntents(['awaiting_confirmation']),
    loadPaymentIntents(['confirmed'], 10),
  ]);

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
      <SiteHeader locale={locale} pathname="/operator/payments" />
      <ConsoleShell
        consoleTitle="console.operator"
        pathname="/operator/payments"
        locale={locale}
        title="operatorPayments.title"
        subtitle="operatorPayments.subtitle"
        items={nav}
      >
        <section>
          <h2>
            {t('operatorPayments.queue')} ({queue.length})
          </h2>
          <PaymentQueue locale={locale} intents={queue} />
        </section>

        {confirmed.length > 0 ? (
          <section>
            <h2>{t('operatorPayments.confirmed')}</h2>
            <ul className="payment-queue__list">
              {confirmed.map((intent) => (
                <li key={intent.id} className="payment-row">
                  <div className="payment-row__head">
                    <bdi dir="ltr" className="payment-row__code">
                      {intent.code}
                    </bdi>
                    <span className="payment-row__meta">
                      {formatMinor(intent.amountYer, 'YER', { locale })}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </ConsoleShell>
    </>
  );
}
