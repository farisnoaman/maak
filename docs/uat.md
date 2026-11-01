# UAT — the script, the sessions, the burn-down

The report has said for a phase that **UAT is a calendar item with real people** and cannot be closed from a
sandbox. That is true of the *sessions*; it is not true of the *script*. This file is the script: what each role
does, in what order, what "pass" looks like, and the form the result is recorded in. A session that improvises is
a session whose findings cannot be reproduced.

- **Who:** three operators (one individual driver-owner, one company with 2–5 vehicles, one agency with drivers),
  two passengers recruited by the operators, one staff member and one finance officer from the platform team.
- **How long:** one 90-minute session per operator, run by one person from the platform and observed by one
  engineer who takes notes and does not help.
- **Where:** a staging build against seeded data (`npm run perf:seed -- --trips 2000` on a staging database, not
  the 50,000 used for performance). Not a developer's laptop, not a phone with test contacts in it.
- **Rule:** the observer never explains. If a step needs explanation to complete, that *is* the finding.

---

## 0. Before the first session (30 minutes, one person)

| # | Check | Pass looks like |
| --- | --- | --- |
| 0.1 | Staging web + API reachable; `/ar` and `/en` both load | No console errors, skip link focuses the `main` |
| 0.2 | Seeded data: ≥ 3 governorates with places, ≥ 2 verified operators, ≥ 30 upcoming trips | Search returns results without typing |
| 0.3 | Demo accounts reset: `admin@`, `staff@`, `owner@`, `driver@`, `finance@maak.test` / `Maak!2026` | Each signs in |
| 0.4 | Mail: `RESEND_API_KEY` set, `MAAK_MAIL_FROM` verified | A test notification arrives in a real inbox |
| 0.5 | Push: `EXPO_ACCESS_TOKEN` set, one device registered | A test push arrives on the device |
| 0.6 | Scheduler running (`npm run notify -- --fail-on-error` on cron) | `notify:check` shows 13 jobs wired |
| 0.7 | Recording: screen + audio, with consent | Files named `uat-<operator>-<date>` |

---

## 1. Passenger — the booking cycle (per passenger, 25 minutes)

The passenger is given one sentence: *"Book a seat to Sana'a tomorrow, and use the app until you are on the bus."*
Nothing else.

| # | Step | Pass condition |
| --- | --- | --- |
| 1.1 | Sign up with a phone number, in Arabic | Account created; the app is in Arabic and Arabic-Indic numerals appear where the setting says |
| 1.2 | Search from Aden to Sana'a for tomorrow | Results appear in under 2 s; the filter chips show counts that match the list |
| 1.3 | Filter by "direct only" and a price cap, then back to all | Every remaining trip matches the filter; clearing restores the full list |
| 1.4 | Save the search and enable alerts | The search appears under *saved searches* with alerts on |
| 1.5 | Open a trip, read the details, book 1 seat | Booking shows `requested`; the operator is notified |
| 1.6 | Wait for acceptance (the operator accepts in the next session) | Status becomes `accepted` with no reload needed |
| 1.7 | On a prepay trip: create the payment and upload a receipt photo | Intent shows `awaiting_confirmation`; the photo uploads from the phone camera |
| 1.8 | Receive the confirmation | Notification (in-app + push) names the booking code and amount |
| 1.9 | Open the live trip page during the trip | Map, "الآن في …", next stop, ETA, progress all present; a stale badge appears if the driver stops reporting |
| 1.10 | Receive the 24 h and 2 h reminders | Two notifications, each naming the trip and the booking |
| 1.11 | Cancel a *second* booking inside the refund band | The refund percentage shown matches the policy (100/75/50 by hours) |
| 1.12 | Turn off email for "booking accepted" | The next acceptance sends push and in-app, no email |
| 1.13 | Set quiet hours to now | A non-critical push is held; a cancellation still arrives immediately |
| 1.14 | Switch the app to English | Every string is English; no Arabic sentence with an English fragment |

**Findings to record explicitly:** the moment of confusion (if any), the step where the passenger looked for a
button that was not there, and any sentence they read aloud as wrong.

---

## 2. Operator — publish, accept, run (per operator, 45 minutes)

Given: *"Publish your trip for tomorrow, accept the bookings you get, and run it to the end."*

| # | Step | Pass condition |
| --- | --- | --- |
| 2.1 | Sign in, land on the operator console | Today's trips and today's bookings visible without navigating |
| 2.2 | Add a vehicle with photos and an insurance document | Saves; badge shows "pending verification" |
| 2.3 | Invite a driver by phone | Driver appears as invited; the invite can be resent |
| 2.4 | Create a trip with 3 stops, a price and a booking policy | Draft saved and resumable after closing the browser |
| 2.5 | Publish the trip | Appears in the public search within 30 s; a maps route is drawn on the live page |
| 2.6 | Accept the passenger's booking | Passenger notified; seats decrement |
| 2.7 | Open the manifest | Every passenger on the trip with seat count and contact |
| 2.8 | Start the trip; mark a stop reached | Passenger live page moves; ETA updates |
| 2.9 | Scan a ticket (staff or driver) | Accepted once; a second scan is refused with a clear reason |
| 2.10 | End the trip | Status `completed`; passenger gets the arrival message |
| 2.11 | Look at revenue for the trip | Amount matches the accepted bookings minus platform fee |
| 2.12 | Try to add a second vehicle on Basic | `QUOTA_EXCEEDED` with the limit and an upgrade path, not a dead end |
| 2.13 | Check the quota notice at 80 % | The wizard warns at 80 % of a limit (since `00041`, on every plan) |
| 2.14 | Ask for a payout | Request created; the finance officer approves it in §4 |

---

## 3. Staff — verification and support (20 minutes)

| # | Step | Pass condition |
| --- | --- | --- |
| 3.1 | `/staff/verifications` | Pending requests with age; nothing older than 48 h without an alert |
| 3.2 | Approve the operator's vehicle from §2.2 | Badge flips to verified; the operator is notified |
| 3.3 | Reject a request with a reason | The requester sees the reason, in their language |
| 3.4 | Try to decide your own request | Refused (`FORBIDDEN: own request`) |
| 3.5 | Search trips as staff | Finds a trip by code and by phone |
| 3.6 | `/admin/users` | Lists accounts with roles and verification badges; the deletion queue is visible |

---

## 4. Finance — money that must reconcile (30 minutes)

| # | Step | Pass condition |
| --- | --- | --- |
| 4.1 | Confirm the receipt from §1.7 | Booking becomes `confirmed`; ledger entries appear on both sides |
| 4.2 | Confirm the same receipt again | Nothing happens the second time (idempotent) |
| 4.3 | Try to reuse the same image on another intent | `PROOF_ALREADY_USED` |
| 4.4 | Reject a receipt with a reason | Passenger notified with the reason |
| 4.5 | Approve a refund | Ledger balances; the passenger sees `refunded` |
| 4.6 | Approve and pay the payout from §2.14 | Payout `paid`; the operator's balance moves |
| 4.7 | Run the integrity check | `status: ok`; no alert row |
| 4.8 | Open the dashboard | Totals match the ledger within one refresh; response under 500 ms |

---

## 5. Session record (one per operator)

Copy this into the tracking issue and fill it in during the session, not after.

```
Operator:            <name / kind>          Date:
Participants:        <roles>                Observer:
Build:               <commit / build id>    Environment: staging

Step   Result (pass / fail / blocked)   Time    Note (what they tried, what they said)
2.1    ...
...

Top three friction points (verbatim quotes):
1.
2.
3.

Blocking defects (severity P1 — the session could not continue):
Found:
Owner:
```

Severity, so the burn-down means something:

- **P1** — the session could not continue, or money moved wrongly. Fix before the next session.
- **P2** — the task completed, but only after the observer explained. Fix before launch.
- **P3** — friction, wording, a moment of hesitation. Fix if the fix is smaller than the complaint.
- **P4** — a wish. Record it; do not build it before launch.

## 6. Burn-down and sign-off

| Session | Date | P1 open | P2 open | P3 open | Signed off |
| --- | --- | --- | --- | --- | --- |
| Operator A (individual) | | | | | |
| Operator B (company) | | | | | |
| Operator C (agency) | | | | | |
| Passenger + finance pass | | | | | |

**Launch gate:** every session signed off, **zero open P1 and P2**, P3s either fixed or recorded with a decision,
and `v1.0.0` tagged after that (see `CHANGELOG.md`). A session with an open P1 is not signed off; a launch with one
is a launch that already knows its first incident.

## 7. What this script does not cover

- Load at production volume — `docs/perf/README.md` and the k6 suites, run separately against a box with the stated
  load.
- Restore on the hosted project — `docs/runbook.md` §3, run once against a real project before launch.
- Store review — `docs/store-listing.md`, after the two legal URLs resolve publicly.
