'use client';

import { useState } from 'react';
import {
  formatDate,
  formatMinor,
  parseStatementText,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import type { ReconciliationView } from '@/lib/finance';
import { FinanceAlert, useFinanceCommand } from './useFinanceCommand';

const SOURCES = ['jaib', 'kuraimi', 'tadhamon', 'cash_desk', 'bank_transfer', 'other'] as const;

/**
 * The reconciliation desk: import a statement, then work the exception queue.
 *
 * The import parses in the browser (so a malformed line is reported by line number, before anything is
 * written) and matches in SQL (so the match cannot disagree with what the queue shows). What arrives
 * unmatched is a row somebody can see, not a total somebody has to recompute.
 */
export function ReconciliationDesk({
  locale,
  data,
  orgId,
  ownerUserId,
}: {
  readonly locale: Locale;
  readonly data: ReconciliationView;
  readonly orgId: string | null;
  readonly ownerUserId: string | null;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, run } = useFinanceCommand(locale);
  const [source, setSource] = useState<string>('jaib');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<number | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const exceptions = data.lines.filter(
    (line) => line.status === 'exception' || line.status === 'pending',
  );

  return (
    <div className="finance-desk">
      <FinanceAlert message={message} />
      {summary ? (
        <p className="ui-alert" role="status">
          {summary}
        </p>
      ) : null}

      <section>
        <h2>{t('recon.import')}</h2>
        <Select
          label={t('recon.source')}
          value={source}
          options={SOURCES.map((value) => ({ value, label: value }))}
          onChange={(event) => setSource(event.target.value)}
        />
        <Field
          label={t('statement.from')}
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <Field
          label={t('statement.to')}
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
        <label className="ui-field__label" htmlFor="recon-lines">
          {t('recon.lines')}
        </label>
        <textarea
          id="recon-lines"
          className="ui-input"
          rows={6}
          value={text}
          placeholder={t('recon.paste')}
          aria-describedby="recon-lines-hint"
          onChange={(event) => {
            setText(event.target.value);
            setParseError(null);
          }}
        />
        <p className="ui-field__hint" id="recon-lines-hint">
          {parseError === null ? t('recon.lineHelp') : t('recon.lineHelp') + ` (${parseError})`}
        </p>
        <Button
          loading={busy}
          disabled={from === '' || to === '' || text.trim() === ''}
          onClick={async () => {
            const parsed = parseStatementText(text);
            if (!parsed.ok) {
              setParseError(parsed.line);
              return;
            }
            const result = await run({
              action: 'finance.reconciliation.import',
              orgId,
              ownerUserId,
              source: source as never,
              from,
              to,
              lines: parsed.lines,
            });
            if (result) {
              setSummary(
                t('recon.imported', {
                  matched: Number(result.matched ?? 0),
                  exceptions: Number(result.exceptions ?? 0),
                }),
              );
              setText('');
            }
          }}
        >
          {t('recon.import')}
        </Button>
      </section>

      <section>
        <h2>
          {t('recon.exceptions')} ({exceptions.length})
        </h2>
        {exceptions.length === 0 ? (
          <p className="form-hint">{t('recon.empty')}</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table table-cards">
              <caption className="visually-hidden">{t('recon.exceptions')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('recon.date')}</th>
                  <th scope="col">{t('recon.amount')}</th>
                  <th scope="col">{t('recon.externalRef')}</th>
                  <th scope="col">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {exceptions.map((line) => (
                  <tr key={line.id}>
                    <th scope="row" data-label={t('recon.date')}>
                      {formatDate(line.occurredOn, { locale })}
                    </th>
                    <td data-label={t('recon.amount')}>
                      {formatMinor(line.amountYer, 'YER', { locale })}
                    </td>
                    <td data-label={t('recon.externalRef')}>{line.externalRef ?? '—'}</td>
                    <td data-label={t('common.actions')}>
                      <div className="finance-desk__actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void run({
                              action: 'finance.reconciliation.resolve',
                              lineId: line.id,
                              status: 'ignored',
                              intentId: null,
                              payoutId: null,
                            })
                          }
                        >
                          {t('recon.ignore')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2>{t('recon.title')}</h2>
        {data.imports.length === 0 ? (
          <p className="form-hint">{t('recon.empty')}</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table table-cards">
              <caption className="visually-hidden">{t('recon.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('recon.source')}</th>
                  <th scope="col">{t('statement.from')}</th>
                  <th scope="col">{t('statement.to')}</th>
                  <th scope="col">{t('recon.matched')}</th>
                  <th scope="col">{t('recon.exceptions')}</th>
                </tr>
              </thead>
              <tbody>
                {data.imports.map((item) => (
                  <tr key={item.id}>
                    <th scope="row" data-label={t('recon.source')}>
                      {item.source}
                    </th>
                    <td data-label={t('statement.from')}>
                      {formatDate(item.periodFrom, { locale })}
                    </td>
                    <td data-label={t('statement.to')}>{formatDate(item.periodTo, { locale })}</td>
                    <td data-label={t('recon.matched')}>{item.linesMatched}</td>
                    <td data-label={t('recon.exceptions')}>
                      <Badge
                        tone={item.linesTotal - item.linesMatched === 0 ? 'success' : 'warning'}
                      >
                        {item.linesTotal - item.linesMatched}
                      </Badge>
                    </td>
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
