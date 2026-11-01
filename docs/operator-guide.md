# Operator guide — running a transport business on Maak

**Who this is for:** the owner or manager of a company or an individual operator. Somebody who has vehicles,
drivers and a route they already run, and wants bookings and money to stop living in a WhatsApp group.

Every screen is at `/<locale>/…` where `<locale>` is `ar` or `en`. This guide uses the paths without the prefix;
the Arabic interface is the default and the English one has every label, including the parts of the app that are
the same in both.

**The one thing worth knowing before the first click:** the rules live in the database, not in the buttons. A
screen that offers you an action you are not allowed to take will not be lying — it will just fail, in Arabic,
with a reason. That is deliberate (see §11): two people, a phone and a browser, looking at the same trip an hour
apart, must get the same answer.

---

## 0. The five-minute tour

| Screen | What it is for |
| --- | --- |
| `/operator` | The console's front door: vehicles, drivers, trips, verification status, what needs attention |
| `/operator/trips` | Every trip you own, filterable by status; `/operator/trips/calendar` is the month view |
| `/operator/trips/new` | The five-step trip wizard |
| `/operator/trips/<id>/bookings` | One trip's booking requests, accept/reject, the manifest |
| `/operator/payments` | Receipts waiting for your confirmation — the queue that actually earns you money |
| `/operator/vehicles` | The fleet register: specifications, documents, expiry |
| `/operator/fleet` | Cost and upkeep: fuel, maintenance, what is late |
| `/operator/drivers` | Invitations, licences, who is assigned where |
| `/operator/payouts` | What you have earned, and requesting a transfer |
| `/operator/billing` | Your plan, quota and invoices |
| `/operator/expenses` | Costs you want on the record (fuel, repairs, fees) |
| `/operator/team` | Who else can sign in to this organization, and as what |
| `/operator/settings` | Organization profile and payment accounts |

Two kinds of tenant exist and the paths are the same for both: an **organization** (a company with a team) and an
**individual owner** (one person, their own vehicles). An individual signs in to the same `/operator` console; a
plan limit of "1 vehicle" is a plan limit, not a punishment.

---

## 1. From a phone number to a selling account

1. **Sign in** at `/auth/sign-in`. Accounts are created from the sign-in screen; there is no separate sign-up
   page, because a second door into the same account is one more thing to keep consistent.
2. **Create the organization** at `/account` → *Create organization*. An individual who will never have staff can
   stay on a personal account and register vehicles directly.
3. **Submit verification** at `/account/verification`: the account holder's ID, and for a company the commercial
   registration. This is what `NOT_VERIFIED` refers to on almost every other screen.
4. **Wait for a decision.** A staff member reviews it (`/staff/verifications` on their side). Approval is what
   lets you publish trips; a rejection carries a written reason and can be resubmitted.
5. **Invite your team** at `/operator/team` — see §9. Do this last: an unverified organization with five invited
   managers is five people who cannot do anything yet.

> **Why verification blocks publishing and not registering.** You can set everything up while a human reads your
> documents: vehicles, drivers, a draft trip, prices. What you cannot do is *show a trip to a passenger* before a
> human has looked at you. The failure mode we are avoiding is a stranger with a stock photo of a bus collecting
> transfer receipts.

---

## 2. Vehicles

`/operator/vehicles/new` walks through the register. What matters, and why:

| Field | Why it is asked |
| --- | --- |
| Plate, make, model, year, body type | The passenger is buying a seat in *this* vehicle; the trip page shows it |
| Seats | The seat count is the inventory. Every booking decrements it, and the database refuses to go negative |
| Insurance and registration expiry | A lapsed document takes the vehicle out of publication automatically. It is not a reminder you can ignore |
| Photographs | Reused on the trip page. A dark photo in a car park sells nothing |
| Documents | Stored in a private bucket. Staff see them; the public does not |

- **Verification** is a staff decision (`/staff/vehicles` on their side). An unverified vehicle cannot be
  published on a trip: `NOT_VERIFIED`.
- **Expiry** is enforced by the database on every publish and every edit, so a vehicle that passed review in
  March is not silently usable in June.
- **`/operator/vehicles/<id>/health`** is where the maintenance and fuel story lives; `/operator/fleet` rolls the
  whole fleet up. The interesting number there is not the odometer — it is *which vehicle is late for its oil
  change* and *which one is drinking more fuel than it did last month*.

> **A note on "why can't I edit the plate any more".** Once a vehicle is on a published trip, its identity is part
> of that trip's history. Changing the plate afterwards is not an edit, it is a different vehicle.

---

## 3. Drivers

A driver is a person with their own account and their own phone. They are not a row you create.

1. **Invite** at `/operator/drivers`, by phone number. The invitation does not expire — it is a row in your roster
   with the status *invited*, keyed on the normalised phone number, and it links to an account the moment somebody
   with that number signs up. That is why inviting the same number twice is `DUPLICATE_REFERENCE` rather than a
   second driver: it is the same person.
2. **The driver accepts** at `/account/invitations` on their own sign-in. Until they do, they stay *invited* and
   cannot be assigned to a trip (`CONFLICT: the driver has not accepted the invitation yet`).
3. **The driver adds their licence** at `/account/licence` — number, class, expiry and a photograph. The
   photograph goes into a private bucket; staff review it.
4. **Staff approve the licence.** Any later edit to the licence sends it back to review: the point of an approval
   is the document that was approved.
5. **Assign** the driver to a trip in the wizard's last step, or afterwards from the trip screen.

You cannot add a driver's licence *for* them, and that is on purpose: the licence photo is the one document where
"the operator uploaded it" is exactly the situation a passenger should be able to worry about.

---

## 4. Trips

### The wizard (`/operator/trips/new`)

| Step | What it decides |
| --- | --- |
| **Route** | Origin and destination governorate, departure time in Aden time, estimated duration |
| **Stops** | Optional intermediate stops, in order, each with its own fare from the origin |
| **Price** | Seats, pricing mode, discount, gender policy, payment policy, luggage allowance |
| **Vehicle** | Which verified vehicle and which accepted, licence-approved driver |
| **Review** | Everything, then *save as draft* or *publish* |

Five choices in the price step deserve a sentence each:

- **Booking mode** — `per_seat` sells seats; `whole_trip` sells the vehicle; `both` offers either. A `whole_trip`
  trip booked by one passenger takes the whole seat count in a single transaction.
- **Pricing mode** — `flat` is one fare to the destination; `per_stop` prices each stop separately, and the
  passenger pays for the stop they get off at. Switching to `per_stop` without setting fares on the stops is
  refused, because a stop with no fare would sell a seat for nothing.
- **Discount** — percent (stored as basis points: 10 % is `1000`, never a float) or a fixed number of riyals, and
  a scope: the whole trip, per seat, or everywhere.
- **Gender policy** — `any`, `women_only`, `men_only`. Enforced when the booking is created, not just hidden in
  the UI: a booking that contradicts the policy is `VALIDATION_FAILED` at the database.
- **Payment policy** — `cash` (pay the driver), `transfer` (send to your payment account and upload the receipt),
  `deposit` (part now). This is what the passenger is told at checkout, and it decides whether a payment intent
  is created at all.

### Publishing

Publishing asks four questions and refuses on any of them, with the reason attached:

1. Is the **account** verified? (`NOT_VERIFIED`)
2. Is the **vehicle** verified and unexpired? (`NOT_VERIFIED`)
3. Is the **driver** verified, licence-approved and invited-and-accepted? (`NOT_VERIFIED`)
4. Are the stops priced, the seats counted and the departure in the future? (`VALIDATION_FAILED`)

After publishing, the trip appears in `/trips` within a second — the search projection is refreshed by a trigger,
not a nightly job.

### After publishing

- **Editing closes two hours before departure** (`EDIT_WINDOW_CLOSED`). A passenger who bought a seat at 14:00
  must not find the departure moved to 16:00 at 14:30. Two hours is the same line the cancellation policy uses.
- **A substantive edit re-opens verification** if the trip had been reviewed. Substantive means the departure
  time, the route, the vehicle, the seat count, the pricing mode, a price or a discount — everything a passenger
  could have bought on. Notes and policies are cosmetic and do not: nobody's purchase was made against the
  wording of a note.
- **Cancelling is not deleting.** `cancel` with a reason, and every booking on that trip is refunded **in full**,
  regardless of the ladder in §7: the passenger did nothing wrong.

---

## 5. Bookings

`/operator/trips/<id>/bookings` is the queue.

- A new request is **`pending`, holding its seats for 30 minutes.** The hold is why a popular trip does not sell
  the same seat twice while you are asleep. If nobody decides, the hold expires and the seats go back.
- **Accept** one at a time or **accept several** at once. Accepting is what turns a request into a reservation
  and notifies the passenger — exactly one push and one in-app row, even if you press twice.
- **Reject** needs a reason. The passenger sees it.
- **No-shows**: a booking that is still `accepted` on a trip that has already left. The platform tells you how
  many there are (`no-shows` runs with the notification worker). Marking one is `booking.markNoShow`: audited, it
  refunds nothing, and — deliberately — it does not put the seat back on sale. Selling a seat twice because the
  first passenger did not appear is a decision about a person, and it is not one a button should make.
- **The manifest** (`/staff/trips/<id>/manifest` for staff; the operator sees the same data on the bookings
  screen) is the list you print or show at the roadside: names, phones, seats, identity where the passenger
  supplied it.

> **On passenger identity.** Passengers may attach an ID (type, number, birth place and date, photo). It is
> optional, stored in a private bucket, and purged 90 days after the trip. It exists for the manifest and for a
> police check at a checkpoint, and for nothing else.

---

## 6. Taking the money

For `transfer` and `deposit` trips, the passenger does not "pay online" — there is no card gateway in v1, because
the market moves money through Jaib, Cash One, Mfloos, YemPay and bank transfers. What happens instead:

1. The passenger picks the method and the destination account (yours, set up in `/operator/settings`), sees the
   amount, and transfers it themselves.
2. They **upload the receipt** with the transfer reference at `/pay/<intent>`.
3. The receipt lands in **`/operator/payments`** as *awaiting confirmation*.
4. **You confirm** — and only then does the booking count as paid, the ledger get its journal, and the passenger
   get their ticket message.

Rules that matter:

- **One receipt pays once.** The file's hash is checked: uploading the same image for two bookings is
  `PROOF_ALREADY_USED`, and the same transfer reference twice is `DUPLICATE_REFERENCE`. This is the fraud case,
  not an edge case.
- **A payment intent lasts 24 hours.** After that the code is `expired`, the receipt upload is refused, and the
  passenger creates a new intent from the booking page. Nothing is deleted; the expired intent stays with its
  history.
- **Rejecting needs a reason** of at least five characters, and the passenger sees it. Rejection is not a delete:
  the intent stays, with its history.
- **Confirm within the payment SLA.** A receipt waiting six hours raises a `payment_sla` alert to the finance
  team, which is embarrassing in an avoidable way. The queue is sorted oldest first for that reason.
- **A confirmed payment cannot be confirmed again** (`PAYMENT_ALREADY_CONFIRMED`). If you double-click, the second
  click is a no-op, not a second journal.

Cash trips skip all of this: the passenger pays you in the vehicle, and the booking is simply `accepted`.

---

## 7. Money out: payouts, statements, invoices

### What you have earned

`/operator/payouts` shows **available** — money from confirmed payments, minus refunds and minus transfers
already made. It is computed from the ledger, not from a running total in a table, so it cannot drift.

**Request a transfer** with the amount and the receiving account. Finance approves and pays it; the status walks
`requested → approved → paid`, and each step is audited. A request above what is available is refused, and the
number in the refusal is the true one.

### Statements and invoices

- `/finance/statements` (readable by you, produced by finance) is the statement of account: every confirmed
  payment, commission, refund, payout and adjustment in a period, with a closing balance that equals the ledger.
- Invoices are issued for your subscription and for commission; `/account` and `/operator/billing` link to them.
- **Invoices are never deleted or edited.** A wrong invoice is cancelled and reissued, which is what an auditor
  expects to see.

### Expenses

`/operator/expenses` records fuel, repairs, fees and anything else with a number. It exists so that
`/operator/fleet` can answer "what did this van cost me this month" without a spreadsheet.

---

## 8. Your plan and its limits

| | Basic | Pro | Business |
| --- | --- | --- | --- |
| Price | free | 7,500 YER/month | 25,000 YER/month |
| Vehicles | 1 | 5 | unlimited |
| Trips per month | 5 | 50 | unlimited |
| Active trips at once | 1 | 5 | unlimited |
| Staff | 1 | 5 | unlimited |
| Drivers | 1 | 10 | unlimited |
| Featured listings | 0 | 2 | 10 |

- Pro and Business start with a **14-day trial**.
- **Every plan stops at 100 %.** The sixth trip on Basic, the 51st on Pro and the 6th vehicle on Pro are all
  `QUOTA_EXCEEDED` with `{ metric, limit, used }` in the payload.
- **Every plan warns at 80 %, in the flow and by notification**: the response to the trip you just created
  carries `QUOTA_SOFT_WARNING` with the metric, the limit and the usage, and the `quota` job sends the same
  boundary to the owner and every manager, once per metric per threshold per month. Basic used to be the
  exception — the code name and the plan's `soft_limit` flag suggested a warning on a hard wall was noise — but
  80 % of five trips is the moment before you cannot create another one, which is the most useful moment there
  is. `threshold` (80 or 100) is decided once, in `app.quota_state()`, and both paths read it.
- The warnings are per metric, so five vehicles and thirty trips are two conversations, not one.
- Upgrading is immediate; the period is not pro-rated in v1, and `/operator/billing` says so.
- **Featured slots are automatic.** Publishing a trip spends one if your plan has a free slot, and boosts it for
  seven days. A plan with none (Basic) publishes normally, without the boost — the trip is not penalised, it is
  simply not promoted.

> If you are near the limit and unsure, `/operator/billing` shows the same numbers the database will use. That
> is not a coincidence — it reads the same function.

---

## 9. Your team

`/operator/team` invites by email or phone; the invitation expires in **72 hours**.

| Role | Can do |
| --- | --- |
| `owner` | Everything, including the plan, payouts and deleting the organization |
| `manager` | Vehicles, drivers, trips, bookings, team invitations (managers and below) |
| `accountant` | Payments, expenses, statements, payouts — the money side without the marketplace |
| `dispatcher` | Trips and bookings — the day-of-operations role |

- **Ownership is transferred, never invited.** An invitation cannot name `owner` at all — handing the company
  over is a separate, explicit action (`transfer ownership`), and the person receiving it must be verified. An
  owner cannot leave an organization either: the answer is `CONFLICT: transfer ownership before leaving`, because
  an organization with no owner is an organization nobody can fix.
- A member is **suspended**, never deleted: their name stays attached to the trips they ran, because the history
  is the point. `removed` is a status, not a `delete`.

---

## 10. Notifications you will receive

Push, email and in-app are **separately** controllable, per event, at `/account/notifications/preferences`.

- **Quiet hours** (23:00–06:00 by default) suppress non-critical push. They do **not** suppress a booking
  rejection, a cancellation, a refund decision or a role revocation — a critical event that waits until morning
  is a critical event that failed.
- The events you will actually see: booking requested / accepted / rejected / cancelled, payment submitted /
  confirmed / rejected, trip reminders (24 h, 2 h, departure), no-show counts, subscription expiring at 7 / 3 / 1
  days, quota at 80 % / 100 %, and plan changes.
- **Saved searches** are the passenger side of notifications; you do not get them.

---

## 11. When the app says no

Every refusal has a code, an Arabic and English sentence, and usually a next step. The ones you will meet:

| Code | What it means | What to do |
| --- | --- | --- |
| `NOT_VERIFIED` | Your account, vehicle or driver is not verified | Finish verification; it is not a bug |
| `QUOTA_EXCEEDED` | Plan limit reached (the payload has `metric`, `limit`, `used`) | Upgrade, or wait for the period |
| `EDIT_WINDOW_CLOSED` | Less than two hours to departure | Cancel and republish, or run it as it is |
| `CONFLICT` | Someone changed the row since your screen loaded | Reload; the newer state wins |
| `DUPLICATE_REFERENCE` / `PROOF_ALREADY_USED` | That receipt is already paying something | Check `/operator/payments` before retrying |
| `PRICE_CHANGED` | The fare moved between the page and the click | Rebook at the shown price |
| `RATE_LIMITED` | Too many attempts | Wait a minute |
| `FORBIDDEN` | Your role does not include this | Ask the owner; see §9 |

### Why the app will not let you do certain things

- **Delete a trip, a booking or a payment.** Nothing is hard-deleted. A trip is cancelled, a booking is
  cancelled, a payment is refunded. A dispute in month three is settled with the history, and a history with
  holes in it settles nothing.
- **Edit a posted ledger entry.** The ledger is append-only; a correction is a reversing entry with a written
  reason (`IMMUTABLE`).
- **Change a confirmed payment.** Refund it.
- **Upload a receipt for somebody else's booking.** The passenger's own upload is the proof.

---

## 12. The first week, in order

1. Verify the account (§1). Everything else waits on a human.
2. Add one vehicle with its documents (§2) and send it for review.
3. Invite one driver (§3); ask them to accept and photograph their licence.
4. When both are approved, create one trip as a **draft** (§4) and read it back on `/trips` before publishing.
5. Publish. Book one seat yourself with a second account and walk the whole path: request, accept, pay, receipt,
   confirm, ticket, reminder.
6. Do the same for a cancellation and a refund. You will need it eventually, and the first time should not be
   with a real passenger waiting.

If something goes wrong while you are setting up, `docs/runbook.md` is the emergency side; this guide is the
day-to-day one.
