/**
 * Payment reads (Phase 9).
 *
 * Every query here runs with the visitor's own cookie through RLS — no gateway, no service role. That is
 * deliberate: `payment_intents_read_authorised`, `refunds_read_authorised` and `payouts_read_authorised`
 * already encode "the payer, the trip's operator, or finance", so a page cannot leak somebody else's
 * money even if a future route forgets a check. The three screens that use these reads (the pay page, the
 * operator queue, the finance desk) differ only in who is signed in.
 *
 * Amounts leave this module as integers in rials and are formatted at the edge of the UI, always with the
 * currency — a bare number on a money screen is a number somebody will misread.
 */

import { getServerClient } from './supabase/server';

export interface PaymentIntentRow {
  readonly id: string;
  readonly code: string;
  readonly purpose: string;
  readonly method: string;
  readonly amountYer: number;
  readonly status: string;
  readonly referenceNo: string | null;
  readonly proofPath: string | null;
  readonly rejectedReason: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
  readonly bookingId: string | null;
  readonly bookingCode: string | null;
  readonly contactName: string | null;
  readonly tripCode: string | null;
  readonly payerId: string;
}

export interface PaymentAccountView {
  readonly id: string;
  readonly kind: string;
  readonly method: string;
  readonly accountNumber: string;
  readonly holderName: string;
  readonly providerLabel: string | null;
  readonly instructionsAr: string | null;
  readonly instructionsEn: string | null;
  readonly status: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
}

export interface RefundRow {
  readonly id: string;
  readonly code: string;
  readonly bookingCode: string | null;
  readonly amountYer: number;
  readonly status: string;
  readonly reason: string;
  readonly decisionNote: string | null;
  readonly paymentReference: string | null;
  readonly requestedAt: string;
}

export interface PayoutRow {
  readonly id: string;
  readonly code: string;
  readonly amountYer: number;
  readonly status: string;
  readonly method: string;
  readonly note: string | null;
  readonly requestedAt: string;
  readonly paymentReference: string | null;
  readonly approvedAt: string | null;
}

export interface AgentRow {
  readonly id: string;
  readonly userId: string;
  readonly floatBalanceYer: number;
  readonly creditLimitYer: number;
  readonly status: string;
}

interface IntentDbRow {
  id: string;
  code: string;
  purpose: string;
  method: string;
  amount_yer: number;
  status: string;
  reference_no: string | null;
  proof_path: string | null;
  rejected_reason: string | null;
  expires_at: string | null;
  created_at: string;
  confirmed_at: string | null;
  booking_id: string | null;
  payer_id: string;
  payee_account_id: string | null;
}

const INTENT_COLUMNS =
  'id, code, purpose, method, amount_yer, status, reference_no, proof_path, rejected_reason, expires_at, created_at, confirmed_at, booking_id, payer_id, payee_account_id';

/** Booking code + contact name for a set of ids, in one query instead of an embed. */
async function bookingSummaries(
  client: NonNullable<Awaited<ReturnType<typeof getServerClient>>>,
  bookingIds: readonly string[],
): Promise<Map<string, { code: string; contactName: string | null; tripId: string }>> {
  const map = new Map<string, { code: string; contactName: string | null; tripId: string }>();
  if (bookingIds.length === 0) return map;
  const { data } = await client
    .from('bookings')
    .select('id, code, contact_name, trip_id')
    .in('id', [...new Set(bookingIds)]);
  for (const row of data ?? []) {
    map.set(row.id, {
      code: row.code,
      contactName: row.contact_name,
      tripId: row.trip_id,
    });
  }
  return map;
}

async function tripCodes(
  client: NonNullable<Awaited<ReturnType<typeof getServerClient>>>,
  tripIds: readonly string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (tripIds.length === 0) return map;
  const { data } = await client
    .from('trips')
    .select('id, code')
    .in('id', [...new Set(tripIds)]);
  for (const row of data ?? []) map.set(row.id, row.code);
  return map;
}

function toIntent(
  row: IntentDbRow,
  bookings: Map<string, { code: string; contactName: string | null; tripId: string }>,
  trips: Map<string, string>,
): PaymentIntentRow {
  const booking = row.booking_id ? bookings.get(row.booking_id) : undefined;
  return {
    id: row.id,
    code: row.code,
    purpose: row.purpose,
    method: row.method,
    amountYer: row.amount_yer,
    status: row.status,
    referenceNo: row.reference_no,
    proofPath: row.proof_path,
    rejectedReason: row.rejected_reason,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    bookingId: row.booking_id,
    bookingCode: booking?.code ?? null,
    contactName: booking?.contactName ?? null,
    tripCode: booking ? (trips.get(booking.tripId) ?? null) : null,
    payerId: row.payer_id,
  };
}

/** One intent, for `/pay/[intent]`. Returns null when RLS says the visitor may not see it. */
export async function loadPaymentIntent(
  intentId: string,
): Promise<{ intent: PaymentIntentRow; account: PaymentAccountView | null } | null> {
  const client = await getServerClient();
  if (!client) return null;

  const { data } = await client
    .from('payment_intents')
    .select(`${INTENT_COLUMNS}`)
    .eq('id', intentId)
    .maybeSingle();
  if (!data) return null;

  const row = data as IntentDbRow;
  const bookings = await bookingSummaries(client, row.booking_id ? [row.booking_id] : []);
  const booking = row.booking_id ? bookings.get(row.booking_id) : undefined;
  const trips = await tripCodes(client, booking ? [booking.tripId] : []);

  let account: PaymentAccountView | null = null;
  if (row.payee_account_id) {
    const { data: accountRow } = await client
      .from('payment_accounts')
      .select(
        'id, kind, method, account_number, holder_name, provider_label, instructions_ar, instructions_en, status, is_default, created_at',
      )
      .eq('id', row.payee_account_id)
      .maybeSingle();
    if (accountRow) {
      account = {
        id: accountRow.id,
        kind: accountRow.kind,
        method: accountRow.method,
        accountNumber: accountRow.account_number,
        holderName: accountRow.holder_name,
        providerLabel: accountRow.provider_label,
        instructionsAr: accountRow.instructions_ar,
        instructionsEn: accountRow.instructions_en,
        status: accountRow.status,
        isDefault: accountRow.is_default,
        createdAt: accountRow.created_at,
      };
    }
  }

  return { intent: toIntent(row, bookings, trips), account };
}

/**
 * The queue for the operator and the finance desk.
 *
 * `statuses` is passed in rather than branched on: the operator sees what is waiting on *their* trips and
 * finance sees everything, but who may read which row is decided by RLS, not by this argument.
 */
export async function loadPaymentIntents(
  statuses: readonly string[],
  limit = 50,
): Promise<PaymentIntentRow[]> {
  const client = await getServerClient();
  if (!client) return [];

  const { data } = await client
    .from('payment_intents')
    .select(`${INTENT_COLUMNS}`)
    .in('status', [...statuses])
    .order('created_at', { ascending: false })
    .limit(limit);

  const rows = (data ?? []) as IntentDbRow[];
  const bookings = await bookingSummaries(
    client,
    rows.map((row) => row.booking_id).filter((id): id is string => id !== null),
  );
  const trips = await tripCodes(
    client,
    [...bookings.values()].map((booking) => booking.tripId),
  );
  return rows.map((row) => toIntent(row, bookings, trips));
}

export async function loadRefunds(limit = 50): Promise<RefundRow[]> {
  const client = await getServerClient();
  if (!client) return [];

  const { data } = await client
    .from('refunds')
    .select(
      'id, code, booking_id, amount_yer, status, reason, decision_note, payment_reference, requested_at',
    )
    .order('requested_at', { ascending: false })
    .limit(limit);

  const rows = data ?? [];
  const bookings = await bookingSummaries(
    client,
    rows.map((row) => row.booking_id),
  );
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    bookingCode: bookings.get(row.booking_id)?.code ?? null,
    amountYer: row.amount_yer,
    status: row.status,
    reason: row.reason,
    decisionNote: row.decision_note,
    paymentReference: row.payment_reference,
    requestedAt: row.requested_at,
  }));
}

export async function loadPaymentAccounts(): Promise<PaymentAccountView[]> {
  const client = await getServerClient();
  if (!client) return [];

  const { data } = await client
    .from('payment_accounts')
    .select(
      'id, kind, method, account_number, holder_name, provider_label, instructions_ar, instructions_en, status, is_default, created_at',
    )
    .order('created_at', { ascending: false });

  return (data ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    method: row.method,
    accountNumber: row.account_number,
    holderName: row.holder_name,
    providerLabel: row.provider_label,
    instructionsAr: row.instructions_ar,
    instructionsEn: row.instructions_en,
    status: row.status,
    isDefault: row.is_default,
    createdAt: row.created_at,
  }));
}

export async function loadPayouts(limit = 50): Promise<PayoutRow[]> {
  const client = await getServerClient();
  if (!client) return [];

  const { data } = await client
    .from('payouts')
    .select(
      'id, code, amount_yer, status, method, note, requested_at, payment_reference, approved_at',
    )
    .order('requested_at', { ascending: false })
    .limit(limit);

  return (data ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    amountYer: row.amount_yer,
    status: row.status,
    method: row.method,
    note: row.note,
    requestedAt: row.requested_at,
    paymentReference: row.payment_reference,
    approvedAt: row.approved_at,
  }));
}

/**
 * The payout cap, straight from the database.
 *
 * Deliberately a call and not an addition: `app.owner_available_yer` is also what the command checks
 * before it accepts a request, so the number shown and the number enforced are the same code.
 */
export async function loadAvailablePayout(orgId: string | null): Promise<number> {
  const client = await getServerClient();
  if (!client) return 0;
  const { data, error } = await client.rpc('my_available_payout_yer', { p_org_id: orgId });
  if (error) return 0;
  return typeof data === 'number' ? data : 0;
}

export async function loadAgents(): Promise<AgentRow[]> {
  const client = await getServerClient();
  if (!client) return [];

  const { data } = await client
    .from('agents')
    .select('id, user_id, float_balance_yer, credit_limit_yer, status')
    .order('created_at', { ascending: true });

  return (data ?? []).map((row) => ({
    id: row.id,
    userId: row.user_id,
    floatBalanceYer: row.float_balance_yer,
    creditLimitYer: row.credit_limit_yer,
    status: row.status,
  }));
}

/** A passenger's own payments, newest first, for the booking page. */
export async function loadBookingPayments(bookingId: string): Promise<PaymentIntentRow[]> {
  const client = await getServerClient();
  if (!client) return [];

  const { data } = await client
    .from('payment_intents')
    .select(`${INTENT_COLUMNS}`)
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: false });

  const rows = (data ?? []) as IntentDbRow[];
  const bookings = await bookingSummaries(client, [bookingId]);
  const trips = await tripCodes(
    client,
    [...bookings.values()].map((booking) => booking.tripId),
  );
  return rows.map((row) => toIntent(row, bookings, trips));
}
