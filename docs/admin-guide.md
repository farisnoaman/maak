# Admin guide — the platform side

**Who this is for:** the people who run Maak itself — platform staff who verify accounts and watch trips, the
finance team who confirm payments and move money, the admin who owns geography and plans, and the geo supervisors
who maintain places. It is also the answer to "what can this role actually do?", which is a question the database
answers and this document explains.

Paths are `/<locale>/…`; `ar` is the default. Everything here is enforced in PostgreSQL, not in the pages: a
button in the console is a convenience, a refusal from a `cmd_*` function is the rule.

---

## 0. The four platform roles

| Role | Given to | Can |
| --- | --- | --- |
| `platform_admin` | you, and as few people as possible | Everything staff can, plus roles, plans, geography, subscriptions and the notification catalogue |
| `platform_staff` | support and operations | Verify accounts, organizations, vehicles and drivers; search trips; cancel or end a trip; scan tickets; read the manifest |
| `finance_officer` | the money team | Confirm payments, decide refunds, approve and mark payouts paid, reconciliation, invoices, statements, the ledger, agent cash-in |
| `geo_supervisor` | whoever maintains the map | Governorates, districts and places inside their assigned region — and nothing else |

Two facts worth internalising:

- **Roles are grants, not flags.** Each is a row in `user_roles` with `granted_by`, `granted_at` and a
  `revoked_at`; revoking is an update, never a delete. "Who gave this person refund rights, and when" has an
  answer three months later.
- **Separation of duties is real, not polite.** Nobody decides their own verification request, however senior
  (`FORBIDDEN: own request`), and nobody approves their own payout (`PAYOUT_SELF_APPROVAL`). Both refusals are
  in the database because both are the classic way an internal control quietly stops existing.

Granting a role: `/admin/users` → *grant*. Revoking: the same screen. The last platform admin cannot revoke
themselves (`SELF_LOCKOUT`) — an admin console with no admin is a support ticket nobody can answer.

---

## 1. Staff console — verification

`/staff/verifications` is the queue, and it is the most time-sensitive screen in the product: an operator cannot
publish anything until a human has looked at them.

Four kinds of subject arrive here:

| Subject | What you are looking at | Where it came from |
| --- | --- | --- |
| Individual | ID document and the name on it | `/account/verification` |
| Organization | Commercial registration, and the owner's identity | the same screen, for a company |
| Vehicle | Registration and insurance documents, expiry dates | the operator's vehicle register |
| Driver licence | Licence number, class, expiry and photograph | `/account/licence` |

How to decide:

- **Approve** when the document is legible, unexpired, and the name matches the account. Nothing more — this is a
  document check, not a credit check.
- **Reject** with a reason of **at least 10 characters**, written for the person who will read it. "Rejected" with
  no reason generates a support conversation that could have been avoided. The reason is shown to them, and their
  next submission starts from it.
- The queue is a *decision* queue, not a filing cabinet: a request can be `pending`, `approved`, `rejected` or
  `withdrawn`, and deciding one twice is `CONFLICT: already decided`.
- **Any later edit re-opens the review.** A new licence photo, a changed registration — the approval was for the
  document that existed when you clicked.

> **What a verification is not.** It does not vouch for the operator's driving, their prices or their schedule. It
> says: a human at Maak looked at this paperwork and it was in order on this date. `docs/runbook.md` is where the
> "and then they behaved badly" case is handled, which is a cancellation, a refund and a conversation.

---

## 2. Staff console — trips and the road

### `/staff/trips` — search and intervene

Staff see every trip with its owner, verification state and status, searchable by code, operator and date.

The two interventions, and why they are commands rather than edits:

- **Cancel a trip** (`cmd_cancel_trip`, with a reason). Every booking on it is cancelled and refunded **in full**,
  and every passenger is notified. You are not editing a status; you are ending a promise.
- **End a trip** (`cmd_end_trip`, with the odometer reading). For the trip a driver started and never finished —
  the `stale_trips` alert (§5) is how you find out. Ending it closes the bookings and feeds the operator's
  statement. Run it twice and the second call is refused (`TRIP_NOT_STARTABLE: this trip is completed`), which is
  the right shape: it cannot end a trip twice, and it does not pretend to have done something it did not.

**Do not** `update public.trips set status = …` in SQL. It works, and it leaves the trip's history contradicting
itself — no `completed_at`, no audit row, no seat recompute. The runbook says the same thing in stronger language.

- **Verification decisions** on trips happen here too: approve a submitted trip, or reject it with a note. A trip
  that is rejected cannot be published until it is resubmitted.

### `/staff/trips/<id>/manifest` — the roadside list

Names, seats, phones, and passenger identity where one was supplied. This is the screen a driver shows at a
checkpoint; print it or open it on a phone. Identity data is private — a private bucket, readable only through
the command — and the retention job deletes it 90 days after the booking reaches a final state
(`cmd_purge_id_documents`), which is the point after which a dispute is a court case and not a database query.

### `/staff/scan` — check a trip at the roadside

Paste or scan a **trip's** 24-character token (`staff_scan`), and the trip comes back with what a checkpoint or a
dispatcher needs: the vehicle, the driver, the state of the manifest and the bookings. The camera is an
accelerator, not the only way — `BarcodeDetector` does not exist in Firefox or Safari, so the page says so and
offers the text box, which is also what a tablet with a cracked screen needs. The token is not a password to
everything: `staff_scan` resolves it as the caller, so a trip outside your scope comes back exactly as it would
to anybody else.

### `/staff/dashboard` — the day

Live trips, pending decisions, and the recent scans for your scope (your region, or the platform if you have none
assigned). It is the screen to leave open.

---

## 3. Finance console

`/finance/*` — the money side, for `finance_officer` and `platform_admin` (staff can read some of it, and cannot
decide).

| Screen | What it is for | The rule that matters |
| --- | --- | --- |
| `/finance/payments` | Receipts awaiting confirmation, **and the refund queue** | Confirm only when the money is in the account. The proof hash and reference are already checked for duplicates. The refunds live on this screen on purpose — a refund is a decision about a payment, and splitting them across two screens made people decide twice |
| `/finance/payouts` | Operator transfer requests | Approve, then mark paid once the transfer is actually made. Two steps, because "approved" and "sent" are different facts |
| `/finance/accounts` | Platform and agent payment accounts | An account must be `active` to be offered to a passenger; archive, never delete |
| `/finance/reconciliation` | Import a bank or wallet statement and match lines | Matched lines become evidence; unmatched ones are the work |
| `/finance/invoices` | Invoices issued to operators | Issued, cancelled and reissued — never edited |
| `/finance/statements` | Operator statements of account | Closing balance must equal the ledger. If it does not, that is an incident, not a rounding |
| `/finance/ledger` | Every journal and every line | Append-only. A correction is a reversing entry with a reason |
| `/finance/agents` | Agent cash-in and settlement | Cash an agent takes in is settled against the ledger, and the agent is notified when it clears |

**Confirming a payment is the single most consequential click in the product.** It creates the ledger journal,
marks the booking paid, notifies the passenger and starts the clock on the payout. Which is why:

- the receipt arrives with a hash and a reference that can only be used once (`PROOF_ALREADY_USED`,
  `DUPLICATE_REFERENCE`);
- a confirmed payment cannot be confirmed again (`PAYMENT_ALREADY_CONFIRMED`) — a double click is a no-op, not a
  second journal;
- a rejection needs a reason of at least five characters, shown to the passenger;
- the queue is ordered oldest first, because a receipt waiting six hours raises the `payment_sla` alert.

The **dashboard** (`/finance/dashboard`) is read straight from the ledger: gross, commission, subscriptions,
refunds, expenses, payouts and what is payable to operators. There is no materialised "totals" table to drift.

---

## 4. Admin console

| Screen | What you decide |
| --- | --- |
| `/admin/users` | Who has which platform role (§0). The only place a role is granted |
| `/admin/regions` | Regions for geo supervisors — a region can hold whole governorates and hand-picked districts from others |
| `/admin/places` | The gazetteer: places, their governorate, their Arabic and English names |
| `/admin/plans` | Plan prices and limits. Changing a limit changes what every operator can do, immediately |
| `/admin/subscriptions` | Who is on what plan, in trial, past due or in grace |
| `/admin/notifications` | The template preview: every event, its default channels, its priority, and the sentence it produces in **Arabic and English side by side** — rendered by the same function the sender uses, so a template that is missing a variable looks wrong here before it looks wrong on somebody's phone |

Two of these deserve a warning label.

**Plans.** `plan_limits` is what `app.quota_state()` reads on every publish and every vehicle, so an edit is live
at once — no deploy, no cache. Lowering a limit does not retroactively delete anything: an operator over the new
limit simply cannot add more until they are under it again, and the next `quota` job warns them.

**The notification catalogue.** `default_channels` is the *offer*, not a promise: `in_app` always happens, and a
person's own preferences decide the rest. Marking an event `critical` is what lets it through quiet hours
(23:00–06:00), so it belongs on events where a ten-hour delay causes real harm — a cancellation, a refund
decision, a payout. Not on a weekly summary. The preview is read through the staff-only `dispatch` action, so a
non-staff session gets a readable refusal instead of a page it should not be on.

---

## 5. The alerts that will wake you

Six checks run with the notification worker and enqueue one `ops_alert` per failing check per day, to the role
that owns it, with a link to the screen that answers the question. `docs/runbook.md` has the procedure for each;
this is the map:

| Check | Means | Owner |
| --- | --- | --- |
| `stale_trips` | A trip still `in_progress` 18 h after departure | staff |
| `dead_deliveries` | Notifications that exhausted every attempt in 7 days | staff |
| `unbalanced_journals` | The ledger does not balance | finance |
| `verification_backlog` | Requests older than 48 h | staff |
| `payment_sla` | A receipt waiting more than 6 h | finance |
| `error_rate` | 20 or more refused commands in an hour | staff |

There is also a **finance integrity** alert (`finance_alert`, critical) from `cmd_run_integrity_check`: ten checks
including journal balance, trial balance, outbox drained and invoices consistent. It is deduped per day per
recipient, so a ledger that stays broken rings once a night with the current count — not once per run.

The alerts are delivered through the same pipeline as everything else: `notification_deliveries` rows the worker
claims and records, with the attempt trail kept. An alert that only exists as a row in a table nobody opens is not
an alert.

---

## 6. What you cannot do, and why the answer is "correct"

| You want to… | What happens | Because |
| --- | --- | --- |
| Delete a trip, booking or journal | There is no such command | A dispute in month three is settled by the history; a history with holes settles nothing |
| Delete a user account | `cmd_delete_account` (platform_admin, never your own account): the person is erased, the books are kept — see §6a | Financial rows are `ON DELETE RESTRICT`; the ledger has to keep adding up |
| Edit a posted ledger entry | `IMMUTABLE` | Money that can be edited is money that can be hidden. Corrections are reversing entries |
| Approve your own verification or payout | `FORBIDDEN: own request`, `PAYOUT_SELF_APPROVAL` | The control that fails silently is the one that matters |
| Revoke your own last admin role | `SELF_LOCKOUT` | Somebody has to be able to answer the phone |
| Read a passenger's ID from the database | Not through any client role | The bucket is private and the command is the only reader. Staff see it on the manifest, which is audited |
| Change a confirmed payment | Refund it instead | The ledger records what happened, not what we wish had |

Every one of those refusals is a `cmd_*` function with a code and a sentence, tested in the pgTAP suites. If you
find one that does not hold, that is a bug with a name, not an opinion.

### 6a. Answering an account-deletion request

A user asks from `/account` (`cmd_request_account_deletion`, which sets `profiles.deletion_requested_at` and a
reason) and can cancel while it is pending. Completing it is `cmd_delete_account` — the `account.delete` action
on the `identity` function — and it is a **platform_admin** command, not staff work, because it is the one thing
in this system that cannot be undone.

It is an **anonymisation, not a `DELETE`**. Bookings, trips, invoices, payouts and refunds reference the profile
with `ON DELETE RESTRICT`, because those rows are the books; so the profile row survives as an unnamed shell that
the money still points at, and everything that identifies a human is removed:

| Erased | Kept |
| --- | --- |
| name, phone, email, national id and type, birth place and date, avatar | the `profiles` row itself, and the id every financial row references |
| verification status and notes, and the ID photographs in Storage | completed and cancelled bookings, with their amounts and statuses |
| driver licence number and photo; bank account number and holder name | invoices, payouts, refunds, journal entries, subscriptions |
| push tokens, notifications and their bodies, saved searches and their matches | the audit trail — including the `account.deleted` row |
| roles (revoked), geo assignments, share tokens | the trip(s) the person travelled on, and their history |

It refuses, with the reason in the message, while the answer would be a lie: live bookings, live trips (draft
included), a vehicle registered to the account, an organization they own, or a non-zero available balance. Each
of those is something you can fix *for* the user rather than around them.

Three things to do around it:

1. **Delete the Storage objects** it hands back in `documentsToErase` (verification and passenger ID photographs).
   The rows are gone; the files are not the command's to delete.
2. **Read `authScrubbed` in the result and in the audit row.** When it is `true` the login was removed and — on
   Supabase — the user was banned. When it is `false` (a project whose `auth.users` this role cannot write), the
   anonymisation still stands and you must complete the ban in the dashboard. The command says which it was
   rather than assuming.
3. **Never run it on your own account.** It refuses (`FORBIDDEN: a deletion needs a second pair of eyes`), and
   that is the same rule as `SELF_LOCKOUT`: somebody has to be able to answer the phone.

The whole thing is asserted in `0018_account_deletion.test.sql` — 30 assertions, including the two refusals that
matter most: a live booking and a published trip.

> **This was a gap found while writing this guide.** Until `00039` the request was a *record*, not a process: the
> column's comment promised a staff action and no such action existed. Writing the admin guide is what surfaced
> it; `docs/phase-12-report.md` §1.9 and §6 item 7 record it.

---

## 7. The first day, in order

1. Sign in, and confirm you see the console for your role. If a console is missing, you are missing the grant —
   `/admin/users` is the fix, and it takes a second person.
2. Open `/staff/verifications` and decide one request end to end, including a rejection with a reason. Read your
   own reason as if you were the operator.
3. Open `/finance/dashboard` and read the numbers against the ledger on `/finance/ledger`. They must be the same
   numbers; if they are not, stop and write it down.
4. Run `npm run notify` once on a dev stack (or wait for the scheduled pass) and read the JSON: `ops-alerts.counts`
   is the state of the platform whether or not anything was sent.
5. Read `docs/runbook.md` before you need it. It is written for 02:00, and 02:00 is not when you want to be
   reading it for the first time.
