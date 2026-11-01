'use client';

import { translate, type Locale, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';
import { FinanceAlert, useFinanceCommand } from './useFinanceCommand';

/**
 * The export button.
 *
 * It asks the server for the CSV and hands the file to the browser, rather than building the rows here: the
 * export is logged (it counts against the plan's `finance_exports`) and the log must be written by the same
 * transaction that produced the file. If the plan's limit is reached, the refusal arrives translated, which
 * is why the failure is shown instead of swallowed.
 */
export function StatementExport({
  locale,
  from,
  to,
  canExport,
  orgId,
  ownerUserId,
}: {
  readonly locale: Locale;
  readonly from: string;
  readonly to: string;
  readonly canExport: boolean;
  readonly orgId: string | null;
  readonly ownerUserId: string | null;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const { busy, message, run } = useFinanceCommand(locale);

  return (
    <div className="finance-form">
      <FinanceAlert message={message} />
      <Button
        variant="subtle"
        loading={busy}
        disabled={!canExport}
        onClick={async () => {
          const result = await run({
            action: 'finance.export',
            kind: 'statement',
            orgId,
            ownerUserId,
            from,
            to,
          });
          const rows = Array.isArray(result?.rows)
            ? (result.rows as Record<string, unknown>[])
            : [];
          const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
          const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
          const csv = [
            columns.map(escape).join(','),
            ...rows.map((row) => columns.map((column) => escape(row[column])).join(',')),
          ].join('\n');
          const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `statement-${from}-${to}.csv`;
          link.click();
          URL.revokeObjectURL(url);
        }}
      >
        {t('statement.export')}
      </Button>
    </div>
  );
}
