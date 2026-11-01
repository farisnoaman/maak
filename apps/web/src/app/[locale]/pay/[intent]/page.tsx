import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { formatMinor, isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { Badge } from '@/components/ui/Feedback';
import { PayProofForm } from '@/components/payments/PayProofForm';
import { loadAccountContext } from '@/lib/account';
import { loadPaymentIntent } from '@/lib/payments';
import { paymentMethodKey, paymentStatusKey, paymentTone } from '@/lib/payment-labels';

/**
 * `/pay/[intent]` — one payment, one screen.
 *
 * Deliberately not part of the account console: a passenger on a phone, in a shop, needs the account
 * number, the amount and an upload button, in that order. Everything else is a status line.
 *
 * The screen never computes the amount. It prints what the intent carries, because the intent is what the
 * database will confirm against — a page that recomputes can disagree with the money that actually moved.
 */
export const dynamic = 'force-dynamic';

export default async function PayPage({
  params,
}: {
  params: Promise<{ locale: string; intent: string }>;
}) {
  const { locale: raw, intent: intentId } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/pay/${intentId}`);
  }

  const loadedIntent = await loadPaymentIntent(intentId);
  if (!loadedIntent) notFound();
  const { intent, account } = loadedIntent;

  const isPayer = loaded.user?.id === intent.payerId;
  const instructions =
    locale === 'ar'
      ? (account?.instructionsAr ?? account?.instructionsEn)
      : (account?.instructionsEn ?? account?.instructionsAr);

  return (
    <>
      <SiteHeader locale={locale} pathname={`/pay/${intentId}`} />
      <main id="main" className="shell pay-view">
        <section className="card">
          <div className="payment-row__head">
            <h1>{t('pay.title')}</h1>
            <Badge tone={paymentTone(intent.status)}>{t(paymentStatusKey(intent.status))}</Badge>
          </div>

          <dl className="trip-summary">
            <div className="trip-summary__row">
              <dt>{t('pay.booking')}</dt>
              <dd>
                {intent.bookingCode ? <bdi dir="ltr">{intent.bookingCode}</bdi> : '—'}
                {intent.tripCode ? ` · ${intent.tripCode}` : ''}
              </dd>
            </div>
            <div className="trip-summary__row trip-summary__row--total">
              <dt>{t('pay.amountDue')}</dt>
              <dd>{formatMinor(intent.amountYer, 'YER', { locale })}</dd>
            </div>
            <div className="trip-summary__row">
              <dt>{t('pay.method')}</dt>
              <dd>{t(paymentMethodKey(intent.method))}</dd>
            </div>
            {account ? (
              <div className="trip-summary__row">
                <dt>{t('pay.toAccount')}</dt>
                <dd>
                  <bdi dir="ltr">{account.accountNumber}</bdi>
                  {account.providerLabel ? ` · ${account.providerLabel}` : ''}
                  {` · ${account.holderName}`}
                </dd>
              </div>
            ) : null}
            {intent.referenceNo ? (
              <div className="trip-summary__row">
                <dt>{t('pay.referenceNo')}</dt>
                <dd>
                  <bdi dir="ltr">{intent.referenceNo}</bdi>
                </dd>
              </div>
            ) : null}
          </dl>

          {!account && intent.status === 'awaiting_proof' ? (
            <p className="ui-alert ui-alert--error">{t('pay.noAccount')}</p>
          ) : null}

          {instructions ? (
            <>
              <h2>{t('pay.instructions')}</h2>
              <p>{instructions}</p>
            </>
          ) : null}

          {intent.status === 'awaiting_proof' && isPayer ? (
            <PayProofForm
              locale={locale}
              intentId={intent.id}
              referenceNo={intent.referenceNo}
              amountYer={intent.amountYer}
            />
          ) : null}

          {intent.status === 'awaiting_confirmation' ? (
            <p className="ui-alert" role="status">
              {t('pay.submitted')}
            </p>
          ) : null}

          {intent.status === 'confirmed' ? (
            <p className="ui-alert" role="status">
              {t('pay.confirmedNote')}
            </p>
          ) : null}

          {intent.status === 'rejected' ? (
            <p className="ui-alert ui-alert--error" role="alert">
              {t('pay.rejectedReason', { reason: intent.rejectedReason ?? '—' })}
            </p>
          ) : null}

          {intent.status === 'expired' ? (
            <p className="ui-alert" role="status">
              {t('pay.expiredNote')}
            </p>
          ) : null}

          {intent.bookingId ? (
            <p>
              <Link href={`/${locale}/account/bookings/${intent.bookingId}`}>
                {t('pay.backToBooking')}
              </Link>
            </p>
          ) : null}
        </section>
      </main>
    </>
  );
}
