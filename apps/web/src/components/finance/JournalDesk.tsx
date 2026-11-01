'use client';

import { useState } from 'react';
import { formatMinor, translate, type Locale, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { FinanceAlert, useFinanceCommand } from './useFinanceCommand';

interface DraftLine {
  readonly key: string;
  readonly account: string;
  readonly direction: 'debit' | 'credit';
  readonly amount: string;
}

const ACCOUNTS = [
  'platform_cash',
  'platform_bank',
  'agent_receivable',
  'operator_receivable',
  'operator_payable',
  'commission_revenue',
  'subscription_revenue',
  'refund_expense',
  'payout_clearing',
  'suspense',
] as const;

let lineSeq = 0;
function newLine(): DraftLine {
  lineSeq += 1;
  return { key: `line-${lineSeq}`, account: 'platform_cash', direction: 'debit', amount: '' };
}

/**
 * The manual journal editor.
 *
 * The balance is computed here **and** enforced by the database. Computing it here is not a duplicate
 * validation rule: it is the difference between "your numbers do not add up" appearing as you type and
 * appearing as a 422 after a submit, and posting a journal is not something to learn by trial.
 *
 * The account list is the chart in the migration. A free-text account field would let a typo through to a
 * refusal message about an unknown account, which is a worse way to find out.
 */
export function JournalDesk({
  locale,
  canPost,
}: {
  readonly locale: Locale;
  readonly canPost: boolean;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, run } = useFinanceCommand(locale);
  const [description, setDescription] = useState('');
  const [postingDate, setPostingDate] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([newLine(), newLine()]);

  if (!canPost) return null;

  const debit = lines
    .filter((line) => line.direction === 'debit')
    .reduce((sum, line) => sum + Number(line.amount || '0'), 0);
  const credit = lines
    .filter((line) => line.direction === 'credit')
    .reduce((sum, line) => sum + Number(line.amount || '0'), 0);
  const balanced = debit > 0 && debit === credit;

  function update(key: string, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  return (
    <div className="finance-form">
      <FinanceAlert message={message} />
      <Field
        label={t('ledger.description')}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        required
      />
      <Field
        label={t('ledger.postingDate')}
        type="date"
        value={postingDate}
        onChange={(event) => setPostingDate(event.target.value)}
      />
      <div className="table-scroll">
        <table className="data-table">
          <caption className="visually-hidden">{t('ledger.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('ledger.account')}</th>
              <th scope="col">{t('ledger.side')}</th>
              <th scope="col">{t('ledger.amount')}</th>
              <th scope="col">
                <span className="visually-hidden">{t('common.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.key}>
                <th scope="row" data-label={t('ledger.account')}>
                  <Select
                    label={t('ledger.account')}
                    value={line.account}
                    options={ACCOUNTS.map((account) => ({ value: account, label: account }))}
                    onChange={(event) => update(line.key, { account: event.target.value })}
                  />
                </th>
                <td data-label={t('ledger.side')}>
                  <Select
                    label={t('ledger.side')}
                    value={line.direction}
                    options={[
                      { value: 'debit', label: t('ledger.debit') },
                      { value: 'credit', label: t('ledger.credit') },
                    ]}
                    onChange={(event) =>
                      update(line.key, { direction: event.target.value as 'debit' | 'credit' })
                    }
                  />
                </td>
                <td data-label={t('ledger.amount')}>
                  <Field
                    label={t('ledger.amount')}
                    inputMode="numeric"
                    value={line.amount}
                    onChange={(event) =>
                      update(line.key, { amount: event.target.value.replace(/[^0-9]/g, '') })
                    }
                  />
                </td>
                <td data-label={t('common.actions')}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={lines.length <= 2}
                    onClick={() =>
                      setLines((current) => current.filter((item) => item.key !== line.key))
                    }
                  >
                    −
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="form-hint" role="status">
        {balanced
          ? t('ledger.balanced')
          : t('ledger.unbalanced', {
              debit: formatMinor(debit, 'YER', { locale }),
              credit: formatMinor(credit, 'YER', { locale }),
            })}
      </p>

      <Button
        size="sm"
        variant="subtle"
        onClick={() => setLines((current) => [...current, newLine()])}
      >
        {t('ledger.addLine')}
      </Button>

      <Field
        label={t('ledger.clientReference')}
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        hint={t('ledger.clientReference')}
      />
      <Field
        label={t('ledger.reason')}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />

      <Button
        loading={busy}
        disabled={!balanced || description.trim().length < 3}
        onClick={() =>
          void run({
            action: 'finance.journal.post',
            sourceKind: 'adjustment',
            orgId: null,
            ownerUserId: null,
            description: description.trim(),
            postingDate: postingDate === '' ? null : postingDate,
            clientReference: reference.trim() === '' ? null : reference.trim(),
            reason: reason.trim() === '' ? null : reason.trim(),
            lines: lines
              .map((line) => ({
                account: line.account,
                direction: line.direction,
                amount: Number(line.amount || '0'),
              }))
              .filter((line) => line.amount > 0),
          })
        }
      >
        {t('ledger.post')}
      </Button>
    </div>
  );
}
