'use client';

import { useState } from 'react';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import {
  paymentMethodKey,
  accountKindKey,
  accountStatusKey,
  paymentTone,
} from '@/lib/payment-labels';
import type { PaymentAccountView } from '@/lib/payments';
import { PaymentAlert, usePaymentCommand } from './usePaymentCommand';

const METHODS = [
  'jaib',
  'cash_one',
  'mfloos',
  'yempay',
  'kuraimi',
  'tadhamon',
  'cash_desk',
  'bank_transfer',
  'other',
] as const;

/**
 * Where the money lands.
 *
 * Two lists, one component: the platform's rails (which passengers are told to send to) and the operator
 * accounts that finance has to verify before they can receive anything. Verification is deliberately a
 * separate button with a required reason when refusing — an unverified account number is how a payout
 * reaches a stranger's wallet.
 */
export function AccountsManager({
  locale,
  accounts,
  canCreate,
}: {
  readonly locale: Locale;
  readonly accounts: readonly PaymentAccountView[];
  readonly canCreate: boolean;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, run } = usePaymentCommand(locale);
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<'platform' | 'owner'>('platform');
  const [method, setMethod] = useState<string>('jaib');
  const [number, setNumber] = useState('');
  const [holder, setHolder] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [note, setNote] = useState('');

  const methodOptions = METHODS.map((value) => ({
    value,
    label: t(paymentMethodKey(value)),
  }));

  const platform = accounts.filter((account) => account.kind === 'platform');
  const owner = accounts.filter((account) => account.kind !== 'platform');

  return (
    <div className="accounts-manager">
      <PaymentAlert message={message} />

      <h2>{t('financeAccounts.platform')}</h2>
      {platform.length === 0 ? (
        <p className="form-hint">{t('financeAccounts.empty')}</p>
      ) : (
        <ul className="account-list">
          {platform.map((account) => (
            <li key={account.id} className="account-row">
              <div className="payment-row__head">
                <strong>{t(paymentMethodKey(account.method))}</strong>
                <Badge tone={paymentTone(account.status)}>
                  {t(accountStatusKey(account.status))}
                </Badge>
              </div>
              <dl className="payment-row__facts">
                <div>
                  <dt>{t('financeAccounts.accountNumber')}</dt>
                  <dd>
                    <bdi dir="ltr">{account.accountNumber}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{t('financeAccounts.holderName')}</dt>
                  <dd>{account.holderName}</dd>
                </div>
              </dl>
              {account.isDefault ? (
                <p className="form-hint">{t('financeAccounts.default')}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canCreate ? (
        creating ? (
          <div className="account-form">
            <Select
              label={t('payments.accountKind.platform')}
              value={kind}
              options={[
                { value: 'platform', label: t(accountKindKey('platform')) },
                { value: 'owner', label: t(accountKindKey('owner')) },
              ]}
              onChange={(event) => setKind(event.target.value as 'platform' | 'owner')}
            />
            <Select
              label={t('pay.method')}
              value={method}
              options={methodOptions}
              onChange={(event) => setMethod(event.target.value)}
            />
            <Field
              label={t('financeAccounts.accountNumber')}
              value={number}
              inputMode="numeric"
              onChange={(event) => setNumber(event.target.value)}
            />
            <Field
              label={t('financeAccounts.holderName')}
              value={holder}
              onChange={(event) => setHolder(event.target.value)}
            />
            <Field
              label={t('payments.note')}
              value={note}
              maxLength={300}
              onChange={(event) => setNote(event.target.value)}
            />
            <label className="ui-check">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(event) => setIsDefault(event.target.checked)}
              />
              {t('financeAccounts.setDefault')}
            </label>
            <div className="form-actions">
              <Button
                loading={busy}
                disabled={number.trim().length < 3 || holder.trim().length < 3}
                onClick={async () => {
                  const done = await run({
                    action: 'payment.account.create',
                    kind,
                    method: method as never,
                    orgId: null,
                    accountNumber: number.trim(),
                    holderName: holder.trim(),
                    isDefault,
                    instructionsAr: note.trim() === '' ? null : note.trim(),
                    instructionsEn: note.trim() === '' ? null : note.trim(),
                  });
                  if (done) {
                    setCreating(false);
                    setNumber('');
                    setHolder('');
                    setNote('');
                    setIsDefault(false);
                  }
                }}
              >
                {t('payments.submit')}
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => setCreating(true)}>{t('financeAccounts.new')}</Button>
        )
      ) : null}

      <h2>{t('financeAccounts.ownerAccounts')}</h2>
      {owner.length === 0 ? (
        <p className="form-hint">{t('financeAccounts.empty')}</p>
      ) : (
        <ul className="account-list">
          {owner.map((account) => (
            <li key={account.id} className="account-row">
              <div className="payment-row__head">
                <strong>{t(paymentMethodKey(account.method))}</strong>
                <Badge tone={paymentTone(account.status)}>
                  {t(accountStatusKey(account.status))}
                </Badge>
              </div>
              <dl className="payment-row__facts">
                <div>
                  <dt>{t('financeAccounts.accountNumber')}</dt>
                  <dd>
                    <bdi dir="ltr">{account.accountNumber}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{t('financeAccounts.holderName')}</dt>
                  <dd>{account.holderName}</dd>
                </div>
              </dl>
              {account.status === 'pending_verification' ? (
                <div className="form-actions">
                  <Button
                    loading={busy}
                    onClick={() =>
                      void run({
                        action: 'payment.account.verify',
                        accountId: account.id,
                        approve: true,
                        note: null,
                      })
                    }
                  >
                    {t('financeAccounts.verify')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
