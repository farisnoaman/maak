'use client';

import { useState } from 'react';
import { formatMinor, translate, type Locale, type TranslationKey } from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import type { PaymentIntentRow } from '@/lib/payments';
import { paymentMethodKey, paymentStatusKey, paymentTone } from '@/lib/payment-labels';
import { PaymentAlert, usePaymentCommand } from './usePaymentCommand';

/**
 * The confirmation queue: receipts that arrived and the money nobody has vouched for yet.
 *
 * Confirming is the operator saying "this money is in the account I can see", which is why it is one
 * click and takes a note; rejecting needs a reason the passenger will read. The page behind this renders
 * under RLS, so the finance desk sees every receipt and an operator sees only their own trips — the same
 * component, two populations.
 */
export function PaymentQueue({
  locale,
  intents,
  allowReject = true,
}: {
  readonly locale: Locale;
  readonly intents: readonly PaymentIntentRow[];
  readonly allowReject?: boolean;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, run } = usePaymentCommand(locale);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  if (intents.length === 0) {
    return <p className="form-hint">{t('operatorPayments.empty')}</p>;
  }

  return (
    <div className="payment-queue">
      <PaymentAlert message={message} />
      <ul className="payment-queue__list">
        {intents.map((intent) => (
          <li key={intent.id} className="payment-row">
            <div className="payment-row__head">
              <bdi dir="ltr" className="payment-row__code">
                {intent.code}
              </bdi>
              <Badge tone={paymentTone(intent.status)}>{t(paymentStatusKey(intent.status))}</Badge>
            </div>
            <dl className="payment-row__facts">
              <div>
                <dt>{t('pay.amountDue')}</dt>
                <dd>{formatMinor(intent.amountYer, 'YER', { locale })}</dd>
              </div>
              <div>
                <dt>{t('pay.method')}</dt>
                <dd>{t(paymentMethodKey(intent.method))}</dd>
              </div>
              <div>
                <dt>{t('pay.referenceNo')}</dt>
                <dd>{intent.referenceNo ? <bdi dir="ltr">{intent.referenceNo}</bdi> : '—'}</dd>
              </div>
              <div>
                <dt>{t('operatorPayments.payer')}</dt>
                <dd>{intent.contactName ?? intent.bookingCode ?? '—'}</dd>
              </div>
            </dl>

            {rejecting === intent.id ? (
              <div className="payment-row__reject">
                <label className="ui-field__label" htmlFor={`reject-${intent.id}`}>
                  {t('payments.rejectReason')}
                </label>
                <textarea
                  id={`reject-${intent.id}`}
                  className="ui-input"
                  rows={2}
                  maxLength={300}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <div className="form-actions">
                  <Button
                    variant="danger"
                    loading={busy}
                    disabled={reason.trim().length < 5}
                    onClick={async () => {
                      const done = await run({
                        action: 'payment.reject',
                        intentId: intent.id,
                        reason: reason.trim(),
                      });
                      if (done) {
                        setRejecting(null);
                        setReason('');
                      }
                    }}
                  >
                    {t('payments.reject')}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setRejecting(null);
                      setReason('');
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="form-actions">
                <Button
                  loading={busy}
                  onClick={() =>
                    void run({ action: 'payment.confirm', intentId: intent.id, note: null })
                  }
                >
                  {t('payments.confirm')}
                </Button>
                {allowReject ? (
                  <Button variant="ghost" onClick={() => setRejecting(intent.id)}>
                    {t('payments.reject')}
                  </Button>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
