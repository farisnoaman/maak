'use client';

import { useState } from 'react';
import { formatDate, formatMinor, translate, type Locale, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import type { ExpenseRow } from '@/lib/finance';
import { FinanceAlert, useFinanceCommand } from './useFinanceCommand';

const CATEGORIES = [
  'fuel',
  'maintenance',
  'insurance',
  'registration',
  'permit',
  'salary',
  'toll',
  'parking',
  'fine',
  'other',
] as const;

/**
 * Where an operator records what they spent.
 *
 * The checkbox is the whole accounting decision, so it is spelled out in words rather than a toggle: an
 * expense paid from the operator's own pocket changes no journal (their money never entered the platform's),
 * while `settleFromBalance` is a withdrawal from the balance the platform is holding for them. Getting that
 * wrong double-counts the money, so the hint sits under the field that decides it.
 */
export function ExpensesPanel({
  locale,
  orgId,
  expenses,
  canVoid,
}: {
  readonly locale: Locale;
  readonly orgId: string | null;
  readonly expenses: readonly ExpenseRow[];
  readonly canVoid: boolean;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, done, run } = useFinanceCommand(locale);
  const [category, setCategory] = useState<string>('fuel');
  const [amount, setAmount] = useState('');
  const [incurredOn, setIncurredOn] = useState('');
  const [description, setDescription] = useState('');
  const [settle, setSettle] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="finance-desk">
      <FinanceAlert message={message} />
      {done ? (
        <p className="ui-alert" role="status">
          ✓
        </p>
      ) : null}

      <section>
        <h2>{t('expenses.add')}</h2>
        <Select
          label={t('expenses.category')}
          value={category}
          options={CATEGORIES.map((value) => ({
            value,
            label: t(`cat.${value}` as TranslationKey),
          }))}
          onChange={(event) => setCategory(event.target.value)}
        />
        <Field
          label={t('expenses.amount')}
          inputMode="numeric"
          value={amount}
          onChange={(event) => setAmount(event.target.value.replace(/[^0-9]/g, ''))}
          hint={`${amount === '' ? '0' : amount} YER`}
        />
        <Field
          label={t('expenses.date')}
          type="date"
          value={incurredOn}
          onChange={(event) => setIncurredOn(event.target.value)}
        />
        <Field
          label={t('expenses.description')}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <label className="ui-field__label" htmlFor="settle-from-balance">
          <input
            id="settle-from-balance"
            type="checkbox"
            checked={settle}
            aria-describedby="settle-hint"
            onChange={(event) => setSettle(event.target.checked)}
          />{' '}
          {t('expenses.settle')}
        </label>
        <p className="ui-field__hint" id="settle-hint">
          {t('expenses.settleHint')}
        </p>
        <Button
          loading={busy}
          disabled={Number(amount) <= 0 || incurredOn === ''}
          onClick={async () => {
            const result = await run({
              action: 'expense.record',
              orgId,
              ownerUserId: null,
              vehicleId: null,
              tripId: null,
              category: category as never,
              amountYer: Number(amount),
              incurredOn,
              description: description.trim() === '' ? null : description.trim(),
              settleFromBalance: settle,
            });
            if (result) {
              setAmount('');
              setDescription('');
            }
          }}
        >
          {t('expenses.add')}
        </Button>
      </section>

      <section>
        <h2>{t('expenses.title')}</h2>
        {expenses.length === 0 ? (
          <p className="form-hint">{t('expenses.empty')}</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table table-cards">
              <caption className="visually-hidden">{t('expenses.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('expenses.date')}</th>
                  <th scope="col">{t('expenses.category')}</th>
                  <th scope="col">{t('expenses.amount')}</th>
                  <th scope="col">{t('expenses.description')}</th>
                  {canVoid ? <th scope="col">{t('common.actions')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {expenses.map((expense) => (
                  <tr key={expense.id}>
                    <th scope="row" data-label={t('expenses.date')}>
                      {formatDate(expense.incurredOn, { locale })}
                    </th>
                    <td data-label={t('expenses.category')}>
                      {t(`cat.${expense.category}` as TranslationKey)}
                    </td>
                    <td data-label={t('expenses.amount')}>
                      {formatMinor(expense.amountYer, 'YER', { locale })}
                    </td>
                    <td data-label={t('expenses.description')}>{expense.description ?? '—'}</td>
                    {canVoid ? (
                      <td data-label={t('common.actions')}>
                        <div className="finance-desk__actions">
                          <Field
                            label={t('expenses.voidReason')}
                            value={openId === expense.id ? voidReason : ''}
                            onChange={(event) => {
                              setOpenId(expense.id);
                              setVoidReason(event.target.value);
                            }}
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busy}
                            disabled={openId !== expense.id || voidReason.trim().length < 5}
                            onClick={() =>
                              void run({
                                action: 'expense.void',
                                expenseId: expense.id,
                                reason: voidReason.trim(),
                              })
                            }
                          >
                            {t('expenses.void')}
                          </Button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
