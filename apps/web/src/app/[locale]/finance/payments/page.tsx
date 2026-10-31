import { notFound, redirect } from 'next/navigation';
import { formatMinor, isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { Badge } from '@/components/ui/Feedback';
import { PaymentQueue } from '@/components/payments/PaymentQueue';
import { RefundQueue } from '@/components/payments/RefundDesk';
import { loadAccountContext } from '@/lib/account';
import { loadPaymentIntents, loadRefunds } from '@/lib/payments';
import { financeNav } from '@/components/payments/financeNav';
import { paymentMethodKey, paymentStatusKey, paymentTone } from '@/lib/payment-labels';

/**
 * `/finance/payments` — the ledger.
 *
 * Finance sees every intent because `app.is_finance()` is inside the read policy; there is no second
 * permission check here to drift out of step with the SQL. The page also carries the refund queue, because
 * a refund is a decision about a payment and splitting them across two screens made people decide twice.
 */
export const dynamic = 'force-dynamic';

export default async function FinancePaymentsPage({
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
    redirect(`/${locale}/auth/sign-in?next=/${locale}/finance/payments`);
  }

  const [queue, confirmed, refunds] = await Promise.all([
    loadPaymentIntents(['awaiting_confirmation']),
    loadPaymentIntents(['confirmed'], 50),
    loadRefunds(),
  ]);

  return (
    <>
      <SiteHeader locale={locale} pathname="/finance/payments" />
      <ConsoleShell
        locale={locale}
        title="financePayments.title"
        subtitle="financePayments.subtitle"
        phase="9"
        items={financeNav(locale)}
      >
        <section>
          <h2>
            {t('financePayments.queue')} ({queue.length})
          </h2>
          <PaymentQueue locale={locale} intents={queue} />
        </section>

        <section>
          <h2>{t('financePayments.refunds')}</h2>
          <RefundQueue locale={locale} refunds={refunds} />
        </section>

        <section>
          <h2>{t('financePayments.confirmed')}</h2>
          {confirmed.length === 0 ? (
            <p className="form-hint">{t('financePayments.empty')}</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table table-cards">
                <caption className="visually-hidden">{t('financePayments.confirmed')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('pay.referenceNo')}</th>
                    <th scope="col">{t('pay.amountDue')}</th>
                    <th scope="col">{t('pay.method')}</th>
                    <th scope="col">{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {confirmed.map((intent) => (
                    <tr key={intent.id}>
                      <td data-label={t('pay.referenceNo')}>
                        <bdi dir="ltr">{intent.code}</bdi>
                      </td>
                      <td data-label={t('pay.amountDue')}>
                        {formatMinor(intent.amountYer, 'YER', { locale })}
                      </td>
                      <td data-label={t('pay.method')}>{t(paymentMethodKey(intent.method))}</td>
                      <td data-label={t('common.status')}>
                        <Badge tone={paymentTone(intent.status)}>
                          {t(paymentStatusKey(intent.status))}
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
