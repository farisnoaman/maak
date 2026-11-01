'use client';

import { useState } from 'react';
import { formatMinor, translate, type Locale, type TranslationKey } from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import type { PaymentAccountView, PayoutRow } from '@/lib/payments';
import { payoutStatusKey, paymentTone, paymentMethodKey } from '@/lib/payment-labels';
import { PaymentAlert, usePaymentCommand } from './usePaymentCommand';

const METHODS = ['jaib', 'kuraimi', 'tadhamon', 'bank_transfer', 'cash_desk', 'other'] as const;

/**
 * The operator asking for their money.
 *
 * The amount is bounded by what the database says is available — the same `app.owner_available_yer` the
 * command checks — so the form cannot be used to request more than the bookings earned. A destination
 * account is required: a payout that does not say where it lands is a payout finance has to guess.
 */
export function PayoutRequestForm({
  locale,
  availableYer,
  accounts,
  orgId,
}: {
  readonly locale: Locale;
  readonly availableYer: number;
  readonly accounts: readonly PaymentAccountView[];
  /**
   * The organization whose money this is, or `null` for an individual operator.
   *
   * Sent because "available" is computed per owner: omitting it would ask the command for the personal
   * balance and get a truthful zero on a company that has earned money.
   */
  readonly orgId: string | null;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, done, run } = usePaymentCommand(locale);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>(accounts[0]?.method ?? 'jaib');
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id ?? '');

  if (availableYer <= 0) return <p className="form-hint">{t('payouts.empty')}</p>;
  if (done) {
    return (
      <p className="ui-alert" role="status">
        {t('payouts.request')} ✓
      </p>
    );
  }

  const value = Number(amount || '0');
  const tooMuch = value > availableYer;

  return (
    <div className="payout-form">
      <PaymentAlert message={message} />
      <p className="form-hint">
        {t('payouts.available')}: <strong>{formatMinor(availableYer, 'YER', { locale })}</strong>
      </p>
      <Field
        label={t('payouts.amount')}
        inputMode="numeric"
        value={amount}
        onChange={(event) => setAmount(event.target.value.replace(/[^0-9]/g, ''))}
        error={tooMuch ? t('payouts.available') : undefined}
        hint={t('payouts.selfApprovalNote')}
      />
      {accounts.length > 0 ? (
        <Select
          label={t('payouts.destination')}
          value={accountId}
          options={accounts.map((account) => ({
            value: account.id,
            label: `${t(paymentMethodKey(account.method))} · ${account.accountNumber}`,
          }))}
          onChange={(event) => {
            setAccountId(event.target.value);
            const chosen = accounts.find((account) => account.id === event.target.value);
            if (chosen) setMethod(chosen.method);
          }}
        />
      ) : (
        <Select
          label={t('payouts.method')}
          value={method}
          options={METHODS.map((value_) => ({
            value: value_,
            label: t(paymentMethodKey(value_)),
          }))}
          onChange={(event) => setMethod(event.target.value)}
        />
      )}
      <Button
        loading={busy}
        disabled={value <= 0 || tooMuch}
        onClick={() =>
          void run({
            action: 'payout.request',
            amountYer: value,
            method: method as never,
            orgId,
            destinationAccountId: accountId === '' ? null : accountId,
            note: null,
          })
        }
      >
        {t('payouts.request')}
      </Button>
    </div>
  );
}

export function PayoutQueue({
  locale,
  payouts,
}: {
  readonly locale: Locale;
  readonly payouts: readonly PayoutRow[];
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, run } = usePaymentCommand(locale);
  const [reference, setReference] = useState('');

  if (payouts.length === 0) return <p className="form-hint">{t('financePayouts.empty')}</p>;

  return (
    <div className="payout-queue">
      <PaymentAlert message={message} />
      <ul className="payment-queue__list">
        {payouts.map((payout) => (
          <li key={payout.id} className="payment-row">
            <div className="payment-row__head">
              <bdi dir="ltr" className="payment-row__code">
                {payout.code}
              </bdi>
              <Badge tone={paymentTone(payout.status)}>{t(payoutStatusKey(payout.status))}</Badge>
            </div>
            <dl className="payment-row__facts">
              <div>
                <dt>{t('payouts.amount')}</dt>
                <dd>{formatMinor(payout.amountYer, 'YER', { locale })}</dd>
              </div>
              <div>
                <dt>{t('payouts.method')}</dt>
                <dd>{t(paymentMethodKey(payout.method))}</dd>
              </div>
            </dl>

            {payout.status === 'requested' ? (
              <Button
                loading={busy}
                onClick={() =>
                  void run({ action: 'payout.approve', payoutId: payout.id, note: null })
                }
              >
                {t('financePayouts.approve')}
              </Button>
            ) : null}

            {payout.status === 'approved' ? (
              <div className="payment-row__decide">
                <Field
                  label={t('payments.reference')}
                  value={reference}
                  maxLength={80}
                  onChange={(event) => setReference(event.target.value)}
                />
                <Button
                  loading={busy}
                  onClick={async () => {
                    const done = await run({
                      action: 'payout.pay',
                      payoutId: payout.id,
                      reference: reference.trim() === '' ? null : reference.trim(),
                    });
                    if (done) setReference('');
                  }}
                >
                  {t('financePayouts.markPaid')}
                </Button>
              </div>
            ) : null}

            {payout.status === 'paid' && payout.paymentReference ? (
              <p className="form-hint">
                {t('payments.reference')}: <bdi dir="ltr">{payout.paymentReference}</bdi>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
