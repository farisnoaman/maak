import { formatMinor, translate, type Locale, type TranslationKey } from '@maak/core';
import type { MoneySummary } from '@/lib/finance';

/**
 * The month's numbers, as a definition list.
 *
 * A `<dl>` rather than a table of values, because that is what it is: labels and their figures. Every figure
 * carries its currency — a bare number on a money screen is a number somebody will misread — and the profit
 * line is last, because it is the one the operator came for.
 */
export function SummaryCards({
  locale,
  summary,
  platform,
}: {
  readonly locale: Locale;
  readonly summary: MoneySummary;
  readonly platform: boolean;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const money = (value: number) => formatMinor(value, 'YER', { locale });

  const rows: { key: TranslationKey; value: string; tone?: 'good' | 'bad' }[] = platform
    ? [
        { key: 'financeDash.gross', value: money(summary.grossYer) },
        { key: 'financeDash.commission', value: money(summary.commissionYer), tone: 'good' },
        { key: 'financeDash.subscription', value: money(summary.subscriptionYer), tone: 'good' },
        { key: 'financeDash.refunds', value: money(summary.refundsYer) },
        { key: 'financeDash.payouts', value: money(summary.payoutsYer) },
        { key: 'financeDash.profit', value: money(summary.profitYer), tone: 'good' },
        { key: 'financeDash.payable', value: money(summary.payableYer) },
      ]
    : [
        { key: 'financeDash.gross', value: money(summary.grossYer) },
        { key: 'financeDash.commission', value: money(summary.commissionYer) },
        { key: 'financeDash.expenses', value: money(summary.expensesYer) },
        { key: 'financeDash.profit', value: money(summary.profitYer), tone: 'good' },
        { key: 'financeDash.available', value: money(summary.availableYer), tone: 'good' },
        { key: 'financeDash.payable', value: money(summary.payableYer) },
        { key: 'financeDash.pendingPayouts', value: money(summary.pendingPayoutsYer) },
        { key: 'financeDash.unpaidInvoices', value: String(summary.unpaidInvoices) },
      ];

  return (
    <dl className="finance-summary">
      {rows.map((row) => (
        <div className="finance-summary__row" key={row.key}>
          <dt>{t(row.key)}</dt>
          <dd data-tone={row.tone ?? undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
