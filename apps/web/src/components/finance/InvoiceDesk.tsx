'use client';

import { useState } from 'react';
import { formatDate, formatMinor, translate, type Locale, type TranslationKey } from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import type { InvoiceRow } from '@/lib/finance';
import { FinanceAlert, useFinanceCommand } from './useFinanceCommand';

const KIND_KEY: Record<string, TranslationKey> = {
  booking: 'invoices.kindBooking',
  subscription: 'invoices.kindSubscription',
};

const STATUS_KEY: Record<string, TranslationKey> = {
  draft: 'invoices.statusDraft',
  issued: 'invoices.statusIssued',
  paid: 'invoices.statusPaid',
  void: 'invoices.statusVoid',
  overdue: 'invoices.statusOverdue',
};

function tone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'paid') return 'success';
  if (status === 'overdue') return 'danger';
  if (status === 'void') return 'neutral';
  return 'warning';
}

/**
 * The invoice desk.
 *
 * Two actions, and both are narrow on purpose: `pay` records money that arrived by bank transfer or Jaib,
 * and `void` only works while nothing has been posted — a paid invoice is corrected by a reversing journal,
 * not by deleting the bill. The button that is not allowed is not rendered, so the refusal is a rule the
 * screen shows rather than an error it produces.
 */
export function InvoiceDesk({
  locale,
  invoices,
  canSettle,
}: {
  readonly locale: Locale;
  readonly invoices: readonly InvoiceRow[];
  readonly canSettle: boolean;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, done, run } = useFinanceCommand(locale);
  const [reference, setReference] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  if (invoices.length === 0) return <p className="form-hint">{t('invoices.empty')}</p>;

  return (
    <div className="finance-desk">
      <FinanceAlert message={message} />
      {done ? (
        <p className="ui-alert" role="status">
          ✓
        </p>
      ) : null}
      <div className="table-scroll">
        <table className="data-table table-cards">
          <caption className="visually-hidden">{t('invoices.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('invoices.code')}</th>
              <th scope="col">{t('invoices.kind')}</th>
              <th scope="col">{t('invoices.total')}</th>
              <th scope="col">{t('invoices.commission')}</th>
              <th scope="col">{t('invoices.issued')}</th>
              <th scope="col">{t('invoices.due')}</th>
              <th scope="col">{t('common.status')}</th>
              {canSettle ? <th scope="col">{t('common.actions')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <tr key={invoice.id}>
                <th scope="row" data-label={t('invoices.code')}>
                  {invoice.code}
                </th>
                <td data-label={t('invoices.kind')}>
                  {t(KIND_KEY[invoice.kind] ?? 'invoices.kindBooking')}
                </td>
                <td data-label={t('invoices.total')}>
                  {formatMinor(invoice.totalYer, 'YER', { locale })}
                </td>
                <td data-label={t('invoices.commission')}>
                  {formatMinor(invoice.commissionYer, 'YER', { locale })}
                </td>
                <td data-label={t('invoices.issued')}>
                  {formatDate(invoice.issuedAt, { locale })}
                </td>
                <td data-label={t('invoices.due')}>
                  {invoice.dueOn ? formatDate(invoice.dueOn, { locale }) : '—'}
                </td>
                <td data-label={t('common.status')}>
                  <Badge tone={tone(invoice.status)}>
                    {t(STATUS_KEY[invoice.status] ?? 'invoices.statusIssued')}
                  </Badge>
                </td>
                {canSettle ? (
                  <td data-label={t('common.actions')}>
                    {invoice.status === 'issued' || invoice.status === 'overdue' ? (
                      <div className="finance-desk__actions">
                        <Button
                          size="sm"
                          loading={busy}
                          onClick={() => {
                            setOpenId(invoice.id);
                            void run({
                              action: 'invoice.pay',
                              invoiceId: invoice.id,
                              reference: reference === '' ? null : reference,
                            });
                          }}
                        >
                          {t('invoices.pay')}
                        </Button>
                        <Field
                          label={t('invoices.voidReason')}
                          value={openId === invoice.id ? voidReason : ''}
                          onChange={(event) => {
                            setOpenId(invoice.id);
                            setVoidReason(event.target.value);
                          }}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={voidReason.trim().length < 5}
                          onClick={() =>
                            void run({
                              action: 'invoice.void',
                              invoiceId: invoice.id,
                              reason: voidReason.trim(),
                            })
                          }
                        >
                          {t('invoices.void')}
                        </Button>
                      </div>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canSettle ? (
        <Field
          label={t('invoices.reference')}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          hint={t('invoices.pay')}
        />
      ) : null}
    </div>
  );
}
