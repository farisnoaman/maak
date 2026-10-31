'use client';

import { useState } from 'react';
import { formatMinor, translate, type Locale, type TranslationKey } from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import type { RefundRow } from '@/lib/payments';
import { paymentTone, refundStatusKey } from '@/lib/payment-labels';
import { PaymentAlert, usePaymentCommand } from './usePaymentCommand';

/**
 * Refunds, from both sides.
 *
 * `RefundRequestForm` is the passenger asking; `RefundQueue` is the finance desk deciding and then paying.
 * They live together because the rule they share — three hands, never one — is easier to see when the two
 * halves are on the same page of code.
 */
export function RefundRequestForm({
  locale,
  bookingId,
  maxAmountYer,
}: {
  readonly locale: Locale;
  readonly bookingId: string;
  readonly maxAmountYer: number;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, done, run } = usePaymentCommand(locale);
  const [amount, setAmount] = useState(String(maxAmountYer));
  const [reason, setReason] = useState('');

  if (done) {
    return (
      <p className="ui-alert" role="status">
        {t('refunds.request')} ✓
      </p>
    );
  }

  return (
    <div className="refund-form">
      <PaymentAlert message={message} />
      <p className="form-hint">{t('refunds.requestHint')}</p>
      <Field
        label={t('refunds.amount')}
        inputMode="numeric"
        value={amount}
        onChange={(event) => setAmount(event.target.value.replace(/[^0-9]/g, ''))}
        hint={formatMinor(maxAmountYer, 'YER', { locale })}
      />
      <div className="ui-field">
        <label className="ui-field__label" htmlFor="refund-reason">
          {t('payments.reason')}
        </label>
        <textarea
          id="refund-reason"
          className="ui-input"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <p className="ui-field__hint">{t('refunds.reasonHint')}</p>
      </div>
      <Button
        loading={busy}
        disabled={reason.trim().length < 5 || Number(amount) <= 0}
        onClick={() =>
          void run({
            action: 'refund.request',
            bookingId,
            amountYer: Number(amount),
            reason: reason.trim(),
          })
        }
      >
        {t('refunds.request')}
      </Button>
    </div>
  );
}

export function RefundQueue({
  locale,
  refunds,
}: {
  readonly locale: Locale;
  readonly refunds: readonly RefundRow[];
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, run } = usePaymentCommand(locale);
  const [reason, setReason] = useState('');
  const [paying, setPaying] = useState<string | null>(null);
  const [reference, setReference] = useState('');

  if (refunds.length === 0) return <p className="form-hint">{t('refunds.none')}</p>;

  return (
    <div className="refund-queue">
      <PaymentAlert message={message} />
      <ul className="payment-queue__list">
        {refunds.map((refund) => (
          <li key={refund.id} className="payment-row">
            <div className="payment-row__head">
              <bdi dir="ltr" className="payment-row__code">
                {refund.code}
              </bdi>
              <Badge tone={paymentTone(refund.status)}>{t(refundStatusKey(refund.status))}</Badge>
            </div>
            <dl className="payment-row__facts">
              <div>
                <dt>{t('refunds.amount')}</dt>
                <dd>{formatMinor(refund.amountYer, 'YER', { locale })}</dd>
              </div>
              <div>
                <dt>{t('pay.booking')}</dt>
                <dd>{refund.bookingCode ? <bdi dir="ltr">{refund.bookingCode}</bdi> : '—'}</dd>
              </div>
              <div>
                <dt>{t('payments.reason')}</dt>
                <dd>{refund.reason}</dd>
              </div>
            </dl>

            {refund.status === 'requested' ? (
              <div className="payment-row__decide">
                <Field
                  label={t('payments.note')}
                  value={reason}
                  maxLength={300}
                  onChange={(event) => setReason(event.target.value)}
                />
                <div className="form-actions">
                  <Button
                    loading={busy}
                    onClick={async () => {
                      const done = await run({
                        action: 'refund.decide',
                        refundId: refund.id,
                        approve: true,
                        note: reason.trim() === '' ? null : reason.trim(),
                      });
                      if (done) setReason('');
                    }}
                  >
                    {t('payments.approve')}
                  </Button>
                  <Button
                    variant="danger"
                    loading={busy}
                    disabled={reason.trim().length < 5}
                    onClick={async () => {
                      const done = await run({
                        action: 'refund.decide',
                        refundId: refund.id,
                        approve: false,
                        note: reason.trim(),
                      });
                      if (done) setReason('');
                    }}
                  >
                    {t('payments.reject')}
                  </Button>
                </div>
              </div>
            ) : null}

            {refund.status === 'approved' ? (
              paying === refund.id ? (
                <div className="payment-row__decide">
                  <Field
                    label={t('payments.reference')}
                    value={reference}
                    maxLength={80}
                    onChange={(event) => setReference(event.target.value)}
                    hint={t('refunds.referenceHint')}
                  />
                  <div className="form-actions">
                    <Button
                      loading={busy}
                      onClick={async () => {
                        const done = await run({
                          action: 'refund.pay',
                          refundId: refund.id,
                          reference: reference.trim() === '' ? null : reference.trim(),
                        });
                        if (done) {
                          setPaying(null);
                          setReference('');
                        }
                      }}
                    >
                      {t('refunds.markPaid')}
                    </Button>
                    <Button variant="ghost" onClick={() => setPaying(null)}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="subtle" onClick={() => setPaying(refund.id)}>
                  {t('refunds.markPaid')}
                </Button>
              )
            ) : null}

            {refund.status === 'paid' && refund.paymentReference ? (
              <p className="form-hint">
                {t('payments.reference')}: <bdi dir="ltr">{refund.paymentReference}</bdi>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
