# Phase 9 — payments: money recorded, not moved

**Date:** 2026-10-31 · **Branch:** `arena/0c95a652-maak`
**Scope:** `IMPLEMENTATION_PLAN.md` Phase 9. What shipped, what was decided differently, and what is still
open — §6 is the honest list.

Yemen does not have a card rail a small operator can join. What it has is Jaib, M-Floos, YemPay, Kuraimi and
Tadhamon wallets, a cash desk, a bank counter, and a person holding a phone with a photograph of a receipt.
So this phase does not integrate a payment gateway: it **records** money movement with enough evidence that a
human can confirm it, and it writes every confirmation to a ledger seam that Phase 10 can post from without
losing anything.

---

## 1. What shipped

### Schema (`00030_payments.sql`, ~2 070 lines, 17 commands, 13 helpers)

| Object | Purpose |
| --- | --- |
| `public.payment_accounts` | Where money is allowed to land. `kind` is `platform` / `owner` / `agent`; a platform account is live on creation (finance has nobody above them), an operator's starts `pending_verification` and receives nothing until finance vouches for it. One default per method per owner scope, enforced by a partial unique index. Archive, never delete. |
| `public.payment_intents` | One payment: method, computed amount, payer, payee account, proof path + sha256, reference number, status (`awaiting_proof → awaiting_confirmation → confirmed / rejected / expired / cancelled`), `client_reference` for idempotency, `expires_at`. |
| `public.refunds` | `requested → approved / rejected → paid`, with the decider, the payer, the transfer reference and a reason the passenger can read. |
| `public.agents`, `public.agent_transactions` | Cash agents: float, credit limit, and a statement whose every row carries `balance_after_yer` written under a row lock. |
| `public.payouts`, `public.payout_items` | An operator withdrawing what the bookings earned. `payouts_not_self_approved` is a CHECK: the requester cannot be the approver, even with a hand-written update. |
| `public.payment_outbox` | The ledger seam. Unique `(source_table, source_id, kind)`, so a retried confirmation cannot post twice. **Phase 10's ledger backfills from here**, which is why Phase 9 had to ship it rather than a TODO. |
| `trips.deposit_percent` | Default 30, read only when `payment_policy = 'deposit'`. |
| `payment-proofs` bucket | 10 MB, images or PDF, readable by `app.can_read_payment_intent(intent)` and writable only by the payer into `<intent-id>/…`. |

Enums: `payment_method`, `payment_account_kind`, `payment_account_status`, `payment_intent_status`,
`payment_intent_purpose`, `refund_status`, `agent_tx_kind`, `payout_status`, `payment_outbox_kind`; five new
`notification_kind` values.

### Helpers

| Helper | Why it exists |
| --- | --- |
| `app.booking_paid_yer(booking)` | **Net** money the platform holds: confirmed intents minus refunds already paid, floored at zero. Gross would have left a fully refunded deposit still "paid". |
| `app.booking_amount_due_yer(booking)` | The prepay policy in one place: `transfer` → the whole fare, `deposit` → `ceil(total × deposit_percent / 100)` (rounded up — a deposit that rounds down is a discount nobody agreed to), `cash` → 0. |
| `app.refresh_booking_payment_status(booking)` | The only writer of `bookings.payment_status`. `refunded` when the whole fare came back, otherwise `unpaid` / `deposit_paid` / `paid` from the net figure. |
| `app.queue_money_event(...)` | Inserts into the outbox and returns **true only when it inserted**. That boolean is the whole idempotency story. |
| `app.can_read_payment_intent(intent)` | Payer, the trip's manager, or finance — one predicate used by RLS and by the storage policy, so a receipt image cannot be read by somebody who may not read the payment. |
| `app.is_payment_payer(intent)` | The write half of the same rule. |
| `app.owner_available_yer(owner_user, owner_org)` | The payout cap: confirmed payments − paid refunds − non-rejected payouts. Service-only, because it takes an owner as an argument. |
| `public.my_available_payout_yer(org)` | The same number for a signed-in operator, with the owner derived from the session. Added so the payouts screen does not re-implement the cap in TypeScript and drift from the command. |
| `app.enforce_prepay_before_accept()` | The gate, as a trigger on `bookings` rather than a branch inside `cmd_accept_booking`. |

### Commands (edge function `payments`, one `cmd_*` per request)

| Action | Function | Notes |
| --- | --- | --- |
| `payment.account.create` | `cmd_create_payment_account` | Platform accounts require finance; the previous default of that method is demoted **before** the insert, because the unique index is the point. |
| `payment.account.verify` | `cmd_verify_payment_account` | Finance only; a refusal needs a reason. |
| `payment.account.archive` | `cmd_archive_payment_account` | Owner or finance; archived accounts stop being offered. |
| `payment.intent.create` | `cmd_create_payment_intent` | `clientReference` makes a double tap one intent; the amount is computed from the booking and compared against `claimedAmountYer`. |
| `payment.proof.submit` | `cmd_submit_payment_proof` | Inserts the proof, moves to `awaiting_confirmation`, notifies the trip's managers. |
| `payment.confirm` | `cmd_confirm_payment` | Idempotent: a second call returns `changed: false`, inserts nothing in the outbox, notifies nobody. |
| `payment.reject` | `cmd_reject_payment` | A reason is required and reaches the passenger. |
| `payment.intent.cancel` | `cmd_cancel_payment_intent` | Payer or operator. |
| `refund.request` | `cmd_request_refund` | Payer, booker, trip manager or finance; capped at what is actually held; one open request per booking. |
| `refund.decide` | `cmd_decide_refund` | Finance only — the operator cannot decide their own trip's refund. |
| `refund.pay` | `cmd_pay_refund` | Finance, with the transfer reference; writes `bookings.refund_yer` and a `refund_paid` outbox row. |
| `agent.cashIn` | `cmd_agent_cash_in` | Agent or finance, capped by the credit limit. |
| `payout.request` | `cmd_request_payout` | Operator, capped by `app.owner_available_yer`. |
| `payout.approve` | `cmd_approve_payout` | Finance; refuses the requester with `PAYOUT_SELF_APPROVAL` (the CHECK is the backstop). |
| `payout.pay` | `cmd_mark_payout_paid` | Finance, with the reference; idempotent. |
| *(cron)* | `cmd_expire_stale_payment_intents(n)` | Housekeeping; never touches a confirmed intent. |

Error codes the UI can explain: `PAYMENT_REQUIRED`, `PROOF_ALREADY_USED`, `REFERENCE_ALREADY_USED`,
`PAYMENT_METHOD_UNAVAILABLE`, `PAYMENT_ACCOUNT_NOT_ACTIVE`, `ALREADY_PAID`, `PRICE_CHANGED`,
`PAYOUT_SELF_APPROVAL`, `CREDIT_LIMIT_EXCEEDED`, `DUPLICATE`.

### Clients

- **Contract:** `packages/core/src/api/payments.ts` — 15 zod actions, `paymentsScope`, `paymentsCommandArgs`,
  `paymentResultSchema`. The same file feeds the edge function, the dev gateway and both apps, so an argument
  name cannot drift.
- **Web:** `/pay/[intent]` (the passenger's screen: amount, account, instructions, receipt, status),
  `/operator/payments` (confirmation queue), `/operator/payouts` (available + history + request),
  `/finance/payments` (queue + refunds + confirmed ledger), `/finance/accounts`, `/finance/agents`,
  `/finance/payouts`. Entry points added to the operator console tiles and the booking detail page (pay, and
  ask for a refund).
- **Mobile:** `/pay/[intent]` with camera/library capture, on-device SHA-256 (`apps/mobile/src/lib/sha256.ts`,
  no native dependency) and upload into the intent's folder; the booking screen's disabled "upload receipt"
  placeholder is now the real thing, with the rail chooser.
- **Seed:** `seedDemoPayments` creates the platform Jaib wallet and one receipt awaiting confirmation, through
  the commands — so a reset re-proves the amount computation and the one-receipt rule.

---

## 2. Decisions that differ from the plan, and why

1. **No PSP, and no attempt at one.** The plan said "cash / e-wallet / agent / bank deposit"; the schema makes
   that literal. Nothing in Phase 9 talks to Jaib or Kuraimi — the passenger transfers, photographs the
   receipt, and a human confirms. That is what the market actually does, and it is the only design that works
   when the platform has no merchant account.
2. **The ledger seam is an outbox, and the ledger is Phase 10.** Recorded in the plan already; the important
   consequence is that `payment_outbox` rows are *events*, never edits — `payment_reversed` exists so a
   correction is a new row.
3. **The prepay gate is a trigger, not a branch.** `cmd_accept_booking` (Phase 5) has no idea payments exist.
   Putting the rule on the `bookings` row means the seat cannot be held by any path — command, psql, or a future
   screen — without the money behind it, and `cash` trips pass because their due amount is zero.
4. **`app.booking_paid_yer` returns a net figure.** Discovered by a failing assertion: after refunding a
   deposit the booking still read `deposit_paid`. Netting refunds inside the one helper fixed the status, the
   prepay gate and the "pay the rest" amount at once, instead of three call sites each subtracting.
5. **`my_available_payout_yer` is the one money function a signed-in user may call.** The alternative — a page
   that sums intents, refunds and payouts itself — is a second definition of the payout cap, and the screen
   would eventually promise an amount the command refuses.
6. **Policy rules for `payment.confirm`, `payout.request` and `finance.viewOwn` are no longer resource-scoped.**
   A scoped rule cannot say "somebody else's trip, but only for finance", and an individual operator has no
   organization to be scoped to. The commands still re-derive ownership (`actor_can_manage_trip(...) or
   is_finance(...)`), which is the authority; the matrix only takes the first look.
7. **Notifications use one key per outcome**, not one key plus an English enum in the middle of an Arabic
   sentence: `notifications.refundApproved` / `refundRejected` / `refundPaid`, `payoutApproved` / `payoutPaid`.

---

## 3. Bugs found by writing the tests first

These are the honest ones — each was a real defect in the migration, not a test that needed adjusting.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `duplicate key … payment_accounts_one_default` when opening a second default | The demotion ran *after* the insert, so for a moment two defaults existed | Demote before the insert; the unique index is the invariant, so the code has to satisfy it rather than the other way round |
| `column "status" is of type refund_status but expression is of type text` | `case when p_approve then 'approved' else 'rejected' end` is `text` | Explicit cast to `public.refund_status` — plpgsql does not infer an enum from a `CASE` |
| Cash-in returned the previous float (`600` instead of `900`) | `to_jsonb(v_agent)` was the **pre-update** snapshot | Assign `v_agent.float_balance_yer := v_balance` after the update |
| A fully refunded deposit still reported `deposit_paid` | `booking_paid_yer` summed confirmed intents and ignored refunds | Net paid refunds, floor at zero |
| A second refund request answered "at most 0 can be refunded" | The amount check ran before the duplicate check | Check for an open request first, raise `DUPLICATE` (23505) |

---

## 4. Verification

| Gate | Result |
| --- | --- |
| `npm run sql:check` | 30 migrations applied · **14 pgTAP suites, 675 assertions** (58 new) · `database.types.ts` in sync · write lockdown intact |
| `npm test` | 457 tests, 22 files (6 new in `packages/core/tests/payments.test.ts`) |
| `npm run test:coverage` | thresholds met (`api/payments.ts` ≈ 90% statements) |
| `npm run check:guards` | 28 core files · 144 style files · 30 migrations · 82 commands · notification keys present · edge/gateway capability maps identical (bookings and payments now both checked, they were not before) |
| `npm run check:responsive` | 51 media queries, no hidden navigation, no unguarded tracks, stacked card tables labelled |
| `npm run check:a11y` | **83 routes** in both directions, including the 12 new payment screens |
| `npm run lint` · `npm run format:check` · `npm run typecheck` | clean (web, core and mobile) |
| `npm run check:functions` | 9 bundled functions, including `payments` |

End-to-end against the running dev backend (not just the SQL):

1. Finance opens a platform Jaib wallet → it is `active`, default, and the passenger page shows
   `777111222` with the Arabic instructions.
2. An operator opens a Kuraimi account → `pending_verification`; the same call with `kind: platform` is
   `403 FORBIDDEN`.
3. A booking is created for a published trip, an intent is opened (`PI-FF458D`, 5 000 YER) and `/ar/pay/<id>`
   renders the amount, the rail, the account number and the receipt form.
4. `payment.confirm` returns `status: confirmed` and writes exactly one outbox row and one notification; a
   second call returns `changed: false`.
5. `my_available_payout_yer(org)` returns 2 500; a payout of 2 400 is accepted; an operator attempting
   `payout.approve` gets `403`, finance gets `approved`.
6. Mobile: SHA-256 verified against the published vectors (`abc` → `ba7816bf…`, empty → `e3b0c442…`,
   "quick brown fox" → `d7a8fbb3…`) before it was wired into the receipt upload.

---

## 5. What the pgTAP suite actually promises (58 assertions)

The suite is written in the order a passenger meets the money: accounts → amount → proof → confirmation →
gate → refunds → payouts → agents → expiry → RLS.

Beyond the obvious, it pins the things that are easy to regress:

- the amount is **computed** (`deposit` on a 10 000 fare is 3 000) and a wrong claim is `PRICE_CHANGED`;
- the same `clientReference` returns the same intent (`created: false`) and there is still exactly one row;
- one receipt image cannot pay twice, and one bank reference belongs to one payment;
- confirming twice yields one outbox row and one notification — not two of each;
- a transfer trip **cannot** be accepted before the fare is confirmed (the trigger fires), while the cash trip
  is accepted with no payment at all;
- an operator cannot decide a refund on their own trip; finance approves, then a second finance officer pays;
- a payout approved by its own requester is refused by the schema, not only by the command;
- the same refund request twice is a duplicate; a refund larger than the money held is refused;
- an agent cannot exceed their credit limit, and a stranger cannot move their float;
- a confirmed intent is never expired by housekeeping;
- a passenger reads exactly their own payments and no operator account numbers; finance reads the queue and
  the outbox; a stranger reads nothing.

---

## 6. Still open

These are known and deliberate, not forgotten:

1. **Driver cash-collect batch.** The plan's "driver taps collected for 4 passengers → 4 intents, one batched
   confirmation" is not built. The schema supports it (`cash_desk` rail, one intent per booking) and the
   commands exist, but the batched operator screen is Phase 11 polish.
2. **Scheduling.** `cmd_expire_stale_payment_intents`, unmatched-deposit reminders and agent settlement
   reminders have no cron entry yet: this repo has no scheduler process, and Phase 12 is where the job runner
   lands. Until then the expiry command is callable and tested, nothing calls it on a timer.
3. **Retention.** The `payment-proofs` bucket has no 180-day deletion job (same reason as above).
4. **Refund policy vs. `app.compute_refund`.** The Phase 5 function (cutoffs, tiers) is not consulted by
   `cmd_request_refund`: the amount is whatever finance decides is fair, bounded by what is held. Wiring the
   policy in is a product decision — it changes what a passenger is *owed* — and belongs with Phase 10's
   finance rules rather than smuggled into an approval queue.
5. **WhatsApp share of the receipt and one-tap copy of the account number.** The pay page shows the number; the
   copy button and the share sheet are Phase 11 polish.
6. **Bulk confirm in the finance queue.** One receipt at a time today; the command is idempotent, so a batch
   action is a UI change, not a schema one.
7. **The outbox has no consumer.** It is written, indexed and read by finance; Phase 10's ledger is what turns
   those rows into double-entry postings.
8. **No tolerance window for a short transfer.** An amount that does not match `PRICE_CHANGED`s rather than
   offering "pay the difference". That is deliberate for now — a tolerance is a fraud surface — but it is the
   first thing to revisit when real receipts arrive with fees deducted.

---

## 7. Answer to "which phase first"

Phase 9, because the dependency map allows only this order: **9 → 10 → 11 → 12**. Phase 10's ledger backfills
from the outbox this phase writes, Phase 11 emits the payment and refund notifications on top of both, and
Phase 12 is launch hardening across everything. Starting Phase 10 first would have meant inventing a ledger
with no events to post, and Phase 11 without money events has nothing new to say.
