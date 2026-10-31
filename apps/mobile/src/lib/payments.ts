import { paymentsCommandSpec } from '@maak/core';
import { getApiClient } from './api';
import { getMobileClient } from './supabase';
import { sha256HexOfUri } from './sha256';

/**
 * Payments on native.
 *
 * Same split as web: reads are RLS-filtered PostgREST queries (a payer sees their own intents, an operator
 * the ones on their trips, finance everything), and the one write goes through the `payments` command. The
 * receipt is hashed **before** the upload with `./sha256`, because `proof_hash` is unique in the database and
 * a second booking must not be able to reuse the same photograph.
 *
 * There are no generated types on native, so the shape below is trimmed to what the screen renders.
 */

export interface MobilePaymentIntent {
  readonly id: string;
  readonly code: string;
  readonly method: string;
  readonly amountYer: number;
  readonly status: string;
  readonly referenceNo: string | null;
  readonly rejectedReason: string | null;
  readonly accountNumber: string | null;
  readonly holderName: string | null;
  readonly instructionsAr: string | null;
  readonly instructionsEn: string | null;
}

type Row = Record<string, unknown>;
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number =>
  typeof value === 'number' ? value : Number(value ?? 0) || 0;

export async function loadPaymentIntent(id: string): Promise<MobilePaymentIntent | null> {
  const supabase = getMobileClient();
  if (!supabase) return null;

  const { data } = await supabase
    .from('payment_intents')
    .select('id, code, method, amount_yer, status, reference_no, rejected_reason, payee_account_id')
    .eq('id', id)
    .maybeSingle();
  if (!data) return null;
  const row = data as Row;

  let account: Row | null = null;
  const accountId = str(row.payee_account_id);
  if (accountId) {
    const { data: accountRow } = await supabase
      .from('payment_accounts')
      .select('account_number, holder_name, instructions_ar, instructions_en')
      .eq('id', accountId)
      .maybeSingle();
    account = (accountRow ?? null) as Row | null;
  }

  return {
    id: String(row.id),
    code: String(row.code),
    method: String(row.method),
    amountYer: num(row.amount_yer),
    status: String(row.status),
    referenceNo: str(row.reference_no),
    rejectedReason: str(row.rejected_reason),
    accountNumber: str(account?.account_number),
    holderName: str(account?.holder_name),
    instructionsAr: str(account?.instructions_ar),
    instructionsEn: str(account?.instructions_en),
  };
}

/**
 * Uploads a receipt into `<intent-id>/…` in the private bucket.
 *
 * The folder is the intent, not the user: the storage policy asks `app.is_payment_payer(<intent>)`, so the
 * same rule that lets a passenger pay protects them from somebody else's receipt landing on their payment.
 */
export async function uploadPaymentProof(
  uri: string,
  intentId: string,
): Promise<{ ok: true; path: string; hash: string } | { ok: false; error: string }> {
  const supabase = getMobileClient();
  if (!supabase) return { ok: false, error: 'not-configured' };

  const extension = uri.split('.').pop()?.toLowerCase() ?? 'jpg';
  const path = `${intentId}/${Date.now()}.${extension}`;

  try {
    const hash = await sha256HexOfUri(uri);
    const response = await fetch(uri);
    const buffer = await response.arrayBuffer();
    const { error } = await supabase.storage.from('payment-proofs').upload(path, buffer, {
      contentType:
        extension === 'png' ? 'image/png' : extension === 'pdf' ? 'application/pdf' : 'image/jpeg',
      upsert: false,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, path, hash };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'upload failed' };
  }
}

export async function submitPaymentProof(input: {
  readonly intentId: string;
  readonly proofPath: string;
  readonly proofHash: string;
  readonly referenceNo: string | null;
  readonly claimedAmountYer: number;
}) {
  const client = getApiClient();
  if (!client) return { ok: false as const, error: { code: 'INTERNAL' } };
  return client.call(paymentsCommandSpec, {
    action: 'payment.proof.submit',
    intentId: input.intentId,
    proofPath: input.proofPath,
    proofHash: input.proofHash,
    referenceNo: input.referenceNo,
    claimedAmountYer: input.claimedAmountYer,
  });
}

/** Opens an intent for a booking. The amount is the command's to compute; the claim is only compared. */
export async function startPayment(input: {
  readonly bookingId: string;
  readonly method: string;
  readonly purpose: 'booking' | 'deposit';
  readonly clientReference: string;
}) {
  const client = getApiClient();
  if (!client) return { ok: false as const, error: { code: 'INTERNAL' } };
  return client.call(paymentsCommandSpec, {
    action: 'payment.intent.create',
    bookingId: input.bookingId,
    method: input.method as never,
    purpose: input.purpose,
    clientReference: input.clientReference,
  });
}
