import { formatMinor, translate, type Locale, type TranslationKey } from '@maak/core';
import type { MoneySummary } from '@/lib/finance';

/**
 * The three figures a finance officer opens the page for, at the size they deserve.
 *
 * The whole summary used to be one flat list of seven or eight equal rows: *collected*, *commission*, *subscription*,
 * *refunds*, *payouts*, *profit*, *owed* — all at 0.85rem, all the same weight, so the one number the page exists for
 * sat fourth from the bottom in the middle of the rows it is made of. Now: profit at display size, the two figures it
 * is checked against beside it, and the rest of the breakdown underneath as the definition list it always was.
 *
 * Profit carries a tone by **sign**, not by decoration: a month that lost money is red, and saying so is the point of
 * a money page.
 */
export function MoneyHeadline({
  locale,
  summary,
  platform,
}: {
  readonly locale: Locale;
  readonly summary: MoneySummary;
  readonly platform: boolean;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const money = (value: number) => formatMinor(value, 'YER', { locale });

  const figures: {
    key: TranslationKey;
    value: string;
    tone?: 'good' | 'bad';
    primary?: boolean;
  }[] = [
    {
      key: 'financeDash.profit',
      value: money(summary.profitYer),
      tone: summary.profitYer < 0 ? 'bad' : 'good',
      primary: true,
    },
    { key: 'financeDash.gross', value: money(summary.grossYer) },
    platform
      ? { key: 'financeDash.payable', value: money(summary.payableYer) }
      : {
          key: 'financeDash.available',
          value: money(summary.availableYer),
          tone: summary.availableYer < 0 ? 'bad' : undefined,
        },
  ];

  return (
    <dl className="money-headline">
      {figures.map((figure) => (
        <div
          className={`money-headline__cell${figure.primary ? ' money-headline__cell--primary' : ''}`}
          key={figure.key}
        >
          <dt className="money-headline__label">{t(figure.key)}</dt>
          <dd className="money-headline__value num" data-tone={figure.tone}>
            {figure.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
