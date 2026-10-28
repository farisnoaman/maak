'use client';

import { useMemo, useState } from 'react';
import { computePrice, formatMinor, translate, type Locale } from '@maak/core';

/**
 * Runs the exact same pricing function the edge command runs.
 * This is the visible proof of ADR-01/ADR-18: one implementation, three surfaces.
 */
export function FareCalculator({ locale }: { locale: Locale }) {
  const [price, setPrice] = useState(5000);
  const [seats, setSeats] = useState(2);
  const [discountPercent, setDiscountPercent] = useState(10);

  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

  const breakdown = useMemo(() => {
    try {
      return computePrice({
        bookingMode: 'per_seat',
        pricingMode: 'flat',
        seats: Math.max(1, Math.floor(seats) || 1),
        pricePerSeatMinor: Math.max(0, Math.floor(price) || 0),
        discount:
          discountPercent > 0
            ? { kind: 'percent', value: Math.min(100, discountPercent) * 100, scope: 'all' }
            : null,
      });
    } catch {
      return null;
    }
  }, [price, seats, discountPercent]);

  const money = (minor: number) => formatMinor(minor, 'YER', { locale });

  return (
    <section className="card calc" aria-labelledby="calc-title">
      <h2 id="calc-title">{t('calc.title')}</h2>
      <p className="calc__subtitle">{t('calc.subtitle')}</p>

      <div className="calc__fields">
        <div className="field">
          <label htmlFor="price">{t('calc.pricePerSeat')}</label>
          <input
            id="price"
            type="number"
            inputMode="numeric"
            min={0}
            step={500}
            value={price}
            onChange={(event) => setPrice(Number(event.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="seats">{t('calc.seats')}</label>
          <input
            id="seats"
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            value={seats}
            onChange={(event) => setSeats(Number(event.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="discount">{t('calc.discount')}</label>
          <input
            id="discount"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            value={discountPercent}
            onChange={(event) => setDiscountPercent(Number(event.target.value))}
          />
        </div>
      </div>

      {breakdown ? (
        <div className="calc__rows" role="status" aria-live="polite">
          <div className="calc__row">
            <span>{t('calc.subtotal')}</span>
            <span className="num">{money(breakdown.subtotalMinor)}</span>
          </div>
          <div className="calc__row">
            <span>{t('calc.discountAmount')}</span>
            <span className="num">{money(breakdown.discountMinor)}</span>
          </div>
          <div className="calc__row calc__row--total">
            <span>{t('calc.total')}</span>
            <span className="num">{money(breakdown.totalMinor)}</span>
          </div>
        </div>
      ) : (
        <p className="calc__note">{translate(locale, 'errors.VALIDATION_FAILED')}</p>
      )}

      <p className="calc__note">{t('calc.note')}</p>
    </section>
  );
}
