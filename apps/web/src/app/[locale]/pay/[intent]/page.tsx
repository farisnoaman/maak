import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { formatMinor, isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { Badge } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
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

  /**
   * Where this payment is in its life, as three steps rather than a status word.
   *
   * "Waiting for confirmation" is accurate and tells a passenger nothing about whether they still have to do
   * something — which is the only question the screen exists to answer. The steps answer it: the first is done, the
   * second is done once the receipt is attached, the third is the company's move.
   */
  const stage =
    intent.status === 'awaiting_proof'
      ? 1
      : intent.status === 'awaiting_confirmation'
        ? 2
        : intent.status === 'confirmed'
          ? 3
          : intent.status === 'rejected'
            ? 2
            : 1;
  const failed = intent.status === 'rejected' || intent.status === 'expired';
  const steps: { key: TranslationKey; state: 'done' | 'current' | 'todo' | 'error' }[] = [
    { key: 'pay.stepCreated', state: stage >= 1 ? 'done' : 'todo' },
    {
      key: 'pay.stepReceipt',
      state:
        intent.status === 'awaiting_proof'
          ? 'current'
          : intent.status === 'rejected'
            ? 'error'
            : 'done',
    },
    {
      key: 'pay.stepConfirm',
      state:
        intent.status === 'confirmed'
          ? 'done'
          : intent.status === 'awaiting_confirmation'
            ? 'current'
            : 'todo',
    },
  ];

  return (
    <>
      <SiteHeader locale={locale} pathname={`/pay/${intentId}`} />
      <main id="main" className="shell pay-view">
        {intent.bookingId ? (
          <Link className="trip-back" href={`/${locale}/account/bookings/${intent.bookingId}`}>
            <Icon name="chevron" size={16} className="back-arrow" />
            {t('pay.backToBooking')}
          </Link>
        ) : null}

        <header className="pay-head">
          <div>
            <h1>{t('pay.title')}</h1>
            {/* The "transfer it, then attach the receipt" instruction only belongs on a payment that is waiting
                for one. Under a confirmed payment it is advice about a job already done. */}
            {intent.status === 'awaiting_proof' ? (
              <p className="pay-head__sub">{t('pay.subtitle')}</p>
            ) : null}
          </div>
          <Badge tone={paymentTone(intent.status)}>{t(paymentStatusKey(intent.status))}</Badge>
        </header>

        <div className="pay-layout">
          <div className="pay-main">
            {/* The amount, at the size of the thing it is: the number a person is about to send. */}
            <section className="pay-due" aria-labelledby="pay-due-title">
              <h2 className="pay-due__label" id="pay-due-title">
                {intent.status === 'confirmed' ? t('pay.amountPaid') : t('pay.amountDue')}
              </h2>
              <p className="pay-due__amount num">
                {formatMinor(intent.amountYer, 'YER', { locale })}
              </p>
              <dl className="pay-due__facts">
                <div>
                  <dt>{t('pay.booking')}</dt>
                  <dd>
                    {intent.bookingCode ? <bdi dir="ltr">{intent.bookingCode}</bdi> : '—'}
                    {intent.tripCode ? (
                      <span className="pay-due__trip"> · {intent.tripCode}</span>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>{t('pay.method')}</dt>
                  <dd>{t(paymentMethodKey(intent.method))}</dd>
                </div>
                <div>
                  <dt>{t('pay.referenceNo')}</dt>
                  <dd>{intent.referenceNo ? <bdi dir="ltr">{intent.referenceNo}</bdi> : '—'}</dd>
                </div>
              </dl>
            </section>

            {/* Where the money goes. Large, monospaced and direction-locked: it gets read out loud and typed into
                another app by somebody who is not looking at this screen. */}
            {account ? (
              <section className="pay-account" aria-labelledby="pay-account-title">
                <h2 className="pay-account__title" id="pay-account-title">
                  {t('pay.accountNumber')}
                </h2>
                <p className="pay-account__number" dir="ltr">
                  {account.accountNumber}
                </p>
                <dl className="pay-account__meta">
                  {account.providerLabel ? (
                    <div>
                      <dt>{t('pay.toAccount')}</dt>
                      <dd>{account.providerLabel}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>{t('pay.holderName')}</dt>
                    <dd>{account.holderName}</dd>
                  </div>
                </dl>
              </section>
            ) : null}

            {!account && intent.status === 'awaiting_proof' ? (
              <p className="ui-alert ui-alert--error">{t('pay.noAccount')}</p>
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
              <p className="ui-alert ui-alert--success" role="status">
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
          </div>

          <aside className="pay-side" aria-labelledby="pay-progress-title">
            <section className="pay-progress">
              <h2 className="pay-side__title" id="pay-progress-title">
                {t('pay.progress')}
              </h2>
              <ol className="pay-steps" data-failed={failed ? 'true' : undefined}>
                {steps.map((step) => (
                  <li
                    key={step.key}
                    className="pay-steps__step"
                    data-state={step.state}
                    aria-current={step.state === 'current' ? 'step' : undefined}
                  >
                    <span className="pay-steps__dot" aria-hidden="true">
                      {step.state === 'done' ? <Icon name="check" size={12} /> : null}
                    </span>
                    <span className="pay-steps__label">{t(step.key)}</span>
                  </li>
                ))}
              </ol>
            </section>

            {instructions ? (
              <section className="pay-instructions" aria-labelledby="pay-instructions-title">
                <h2 className="pay-side__title" id="pay-instructions-title">
                  {t('pay.instructions')}
                </h2>
                <p>{instructions}</p>
              </section>
            ) : null}
          </aside>
        </div>
      </main>
    </>
  );
}
