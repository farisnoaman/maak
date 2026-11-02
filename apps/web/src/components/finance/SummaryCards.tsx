import { formatMinor, translate, type Locale, type TranslationKey } from '@maak/core';
import type { MoneySummary } from '@/lib/finance';

/**
 * The rest of the month's numbers, as a definition list.
 *
 * A `<dl>` rather than a table of values, because that is what it is: labels and their figures. Every figure
 * carries its currency — a bare number on a money screen is a number somebody will misread.
 *
 * The three figures the page leads with (profit, collected, owed/available) are rendered by `MoneyHeadline` at
 * display size; repeating them here would print the same money twice and flatten the hierarchy that the headline
 * exists to create, so those keys are skipped.
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

  const lead: TranslationKey[] = ['financeDash.profit', 'financeDash.gross', 'financeDash.payable'];
  const secondary = rows.filter((row) => !lead.includes(row.key));

  if (secondary.length === 0) return null;

  return (
    <dl className="finance-summary">
      {secondary.map((row) => (
        <div className="finance-summary__row" key={row.key}>
          <dt>{t(row.key)}</dt>
          <dd data-tone={row.tone ?? undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
