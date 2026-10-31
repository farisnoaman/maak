'use client';

import { useRef, useState } from 'react';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { uploadPaymentProof } from '@/lib/api';
import { PaymentAlert, usePaymentCommand } from './usePaymentCommand';

/** sha256 of the file's bytes, hex — the same digest the database stores and refuses to see twice. */
async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The passenger's half of a payment: attach the receipt, quote the transfer reference, send it.
 *
 * The hash is computed **here**, before the upload, and sent with the command: one image cannot pay for
 * two bookings, and the proof is checked by the database rather than by whoever is looking at the queue.
 * The file goes straight to storage under `<intent-id>/…`, which is the only folder the payer may write.
 */
export function PayProofForm({
  locale,
  intentId,
  referenceNo,
  amountYer,
}: {
  readonly locale: Locale;
  readonly intentId: string;
  readonly referenceNo: string | null;
  readonly amountYer: number;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, run } = usePaymentCommand(locale);
  const fileRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState(referenceNo ?? '');
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function submit() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setFileError(t('pay.receiptHint'));
      return;
    }
    setFileError(null);
    setUploading(true);
    const upload = await uploadPaymentProof(file, intentId);
    if (!upload.ok) {
      setUploading(false);
      setFileError(t('pay.uploadFailed'));
      return;
    }
    let proofHash: string;
    try {
      proofHash = await sha256Hex(file);
    } catch {
      setUploading(false);
      setFileError(t('pay.uploadFailed'));
      return;
    }
    setUploading(false);
    await run({
      action: 'payment.proof.submit',
      intentId,
      proofPath: upload.path,
      proofHash,
      referenceNo: reference.trim() === '' ? null : reference.trim(),
      // What the screen showed when the file was chosen; the command compares it and refuses a change.
      claimedAmountYer: amountYer,
    });
  }

  return (
    <div className="payment-proof">
      <PaymentAlert message={message} />
      {fileError ? (
        <p className="ui-alert ui-alert--error" role="alert">
          {fileError}
        </p>
      ) : null}

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`proof-${intentId}`}>
          {t('pay.receipt')}
        </label>
        <input
          ref={fileRef}
          id={`proof-${intentId}`}
          className="ui-input"
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          aria-describedby={`proof-hint-${intentId}`}
        />
        <p className="ui-field__hint" id={`proof-hint-${intentId}`}>
          {t('pay.receiptHint')}
        </p>
      </div>

      <Field
        label={t('pay.referenceNo')}
        value={reference}
        maxLength={80}
        onChange={(event) => setReference(event.target.value)}
        hint={t('pay.hashNote')}
      />

      <Button loading={busy || uploading} onClick={() => void submit()}>
        {t('pay.submit')}
      </Button>
    </div>
  );
}
