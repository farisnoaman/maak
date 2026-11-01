'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatMinor, translate, type Locale, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { paymentMethodKey } from '@/lib/payment-labels';
import { PaymentAlert, usePaymentCommand } from './usePaymentCommand';

const METHODS = ['jaib', 'mfloos', 'yempay', 'kuraimi', 'tadhamon', 'bank_transfer'] as const;

/**
 * "Pay for this seat" — the door from a booking into `/pay/[intent]`.
 *
 * The amount is *not* sent: the command computes it from the booking and the trip's payment policy, and
 * `clientReference` is generated once per mount so a double tap opens one intent instead of two. If the
 * page is refreshed the reference is new and the command returns the existing intent for the same
 * booking anyway (`ALREADY_PAID` guards the rest).
 */
export function PaymentStart({
  locale,
  bookingId,
  amountYer,
  purpose,
}: {
  readonly locale: Locale;
  readonly bookingId: string;
  /**
   * `null` when the page does not know the amount — the command computes it and this screen never guesses.
   * Showing a number the database will disagree with is how `PRICE_CHANGED` reaches a passenger for no
   * reason.
   */
  readonly amountYer: number | null;
  readonly purpose: 'booking' | 'deposit';
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const router = useRouter();
  const { busy, message, run } = usePaymentCommand(locale);
  const [method, setMethod] = useState<string>('jaib');
  const [clientReference] = useState(() =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? `web-${crypto.randomUUID()}`
      : `web-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  return (
    <div className="payment-start">
      <h2>{t('pay.title')}</h2>
      <p className="form-hint">{t('pay.subtitle')}</p>
      {amountYer != null ? (
        <p>
          {t('pay.amountDue')}: <strong>{formatMinor(amountYer, 'YER', { locale })}</strong>
        </p>
      ) : null}
      <PaymentAlert message={message} />
      <Select
        label={t('pay.method')}
        value={method}
        options={METHODS.map((value) => ({ value, label: t(paymentMethodKey(value)) }))}
        onChange={(event) => setMethod(event.target.value)}
      />
      <Button
        loading={busy}
        onClick={async () => {
          const result = await run({
            action: 'payment.intent.create',
            bookingId,
            method: method as never,
            purpose,
            claimedAmountYer: amountYer,
            clientReference,
          });
          const intent = result?.intent as { id?: string } | undefined;
          if (intent?.id) router.push(`/${locale}/pay/${intent.id}`);
        }}
      >
        {t('pay.title')}
      </Button>
    </div>
  );
}
