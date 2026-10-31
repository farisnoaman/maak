# Phase 5 — implementation report

**Date:** 2026-10-31 · **Branch:** `arena/8a1e3e09-maak` (PR #2)
**Scope:** `IMPLEMENTATION_PLAN.md` Phase 5 — bookings, passenger data and requests.

As with Phase 4, this document separates what was built from what was actually executed. Every number in
§4 comes from a gate that ran in this environment; §5 is a transcript of the end-to-end probe, including
the two defects it found.

---

## 1. What shipped

### The schema (`supabase/migrations/00019_bookings.sql`)

| Object | Purpose |
| --- | --- |
| `bookings` | One passenger request: seats, fare snapshot, status, hold expiry, cancellation and refund columns |
| `passenger_documents` | The identity a seat needs (type, number, birth place/date, photo path), one per booking |
| `document_access_log` | Every look at that identity, by whom, over which path, with IP and user agent |
| `booking_events` | Append-only timeline (created / accepted / rejected / cancelled / expired / completed / no-show) |
| `booking_share_tokens` | The WhatsApp link: 32-byte token, 72 hours, one audience, view counter, revocation |
| `booking_status`, `id_document_type`, `booking_payment_status`, `booking_event_kind`, `document_access_kind` | Enums, plus five new `notification_kind` values |
| `app.trip_booked_seats` (redefined) | Seats really occupied: accepted bookings + pending ones inside their hold |
| `app.recompute_seats_available`, `app.can_read_booking`, `app.can_manage_booking`, `app.is_booking_passenger` | The predicates the policies and commands share |
| `app.compute_refund`, `app.accept_booking_internal`, `app.notify_trip_managers`, `app.new_booking_code` | Refund ladder, the accept path used by both accept and bulk-accept, notifications, codes |
| `cmd_create_booking`, `cmd_set_passenger_document`, `cmd_accept_booking`, `cmd_bulk_accept_bookings`, `cmd_reject_booking`, `cmd_cancel_booking_by_passenger`, `cmd_cancel_booking_by_operator`, `cmd_expire_booking_holds`, `cmd_mark_no_show`, `cmd_finalize_trip_bookings`, `cmd_purge_id_documents` | One command per intent, one transaction each, each audited |
| `get_trip_manifest_data`, `create_id_share_link`, `resolve_id_share_token`, `log_document_access` | The reads that are RPCs because they write (audit rows) or because they must stay service-only |
| `app.on_trip_cancelled_bookings`, `app.on_booking_closed_revoke_links` | A cancelled trip cancels its bookings; a closed booking kills its ID links — by trigger, not by remembering |

### The scheduler (`supabase/migrations/00020_booking_jobs.sql`)

`app.job_expire_holds`, `app.job_finalize_trips`, `app.job_purge_documents` are three-line wrappers over
the commands, so the rules keep one home. `pg_cron` schedules them where the extension exists (every
two minutes / ten minutes / nightly); the embedded dev cluster has no `pg_cron`, so the migration guards
the schedule and the dev backend runs the same functions from a one-minute timer instead. That is a real
difference in *when*, not in *what*.

### The contract (`packages/core`)

- `src/api/bookings.ts` — nine actions in one discriminated union, `bookingsScope()` (see §2), the
  argument builder, and `MAX_SEATS_PER_BOOKING` so the two client steppers cannot disagree with Zod.
- `src/domain/booking.ts` — status vocabulary, translation keys, `holdsSeat`, `bookingTone`,
  `isPassengerCancellable`.
- `src/domain/finance.ts` — `BOOKING_REFUND_POLICY`, the TypeScript mirror of `app.compute_refund()`.
- Dictionaries — 94 `bookings.*` keys and five `notifications.booking*` / `notifications.tripCancelled`
  keys in both locales.

### The clients

| Surface | Route | Notes |
| --- | --- | --- |
| Booking wizard (web) | `/[locale]/trips/[code]/book` | Seats, stop, contact, gender when the trip demands it, live total, hold explanation |
| My bookings (web) | `/[locale]/account/bookings` + `/[id]` | Upcoming/past split, ticket QR, identity form, cancel, refund line |
| Operator inbox (web) | `/[locale]/operator/trips/[id]/bookings` | Pending list with bulk accept, rejected-with-reason, manifest, share-link generation, booking code on every card and manifest row |
| Share preview (web) | `/[locale]/s/[token]` (+ `/s/[token]` → locale) | Watermarked, 72-hour, operator-only, signed 5-minute photo URL |
| Driver licence (web) | `/[locale]/account/licence` | Camera/file capture, `driver.setLicence`, five-minute signed read (see `docs/phase-3-review.md` §9.1) |
| Booking wizard (native) | `app/book/[code].tsx` | One screen: seats, traveller, price, submit |
| My bookings (native) | `app/bookings/index.tsx` + `[id].tsx` | Ticket code, cancel with confirmation, ID capture via camera |

### The rest of the branch

This branch also carries the Phase 4 follow-through that came out of using the app: the staff trip detail
page and search, expired-document gating on vehicles, `trip_fare_parity` between SQL and TypeScript, the
phone bottom tab bar with a `/console` router, an installable web manifest with an offline page, and the
`booking.shareLink` / `passengerIdSignedUrl` path described in §2.

---

## 2. Decisions worth an argument

**A seat is a projection, not a counter.** `trips.seats_available` is recomputed from the bookings table
(`accepted` + unexpired `pending`) inside the same transaction that locks the trip row. There is no
`seats_available = seats_available - 1` anywhere, so a refund, an expiry, a rejection and a trip
cancellation all return seats by the same code path, and a double-decrement is unrepresentable.

**The fare is recomputed, never trusted.** The wizard sends `claimedTotalMinor` because it showed that
number, and `cmd_create_booking` recomputes with `app.trip_total()` and refuses a mismatch with
`PRICE_CHANGED`. The page and the database therefore cannot drift into an overcharge, and a stale tab
gets a code it can act on.

**`isBooker` is a claim, not a grant.** The first smoke run of `booking.cancelByPassenger` returned
`FORBIDDEN`: the policy is booker-scoped, and `bookingsScope()` was claiming nothing for the passenger's
own actions. The fix claims `isBooker`; the command still re-reads `bookings.passenger_id`, so a forged
claim buys nothing. This is exactly the class of bug a gate cannot find and a transcript can.

**A refusal has to say what happened, and be visible where the thumb is.** The second booking on one
trip was refused all along — by `bookings_one_active_per_trip`, a partial unique index. What a passenger
saw was nothing: the insert retried the violation five times (that loop exists to retry *code*
collisions, not this), surfaced a bare `23505`, the gateway mapped it to `DUPLICATE_REFERENCE` — "an entry
with this name already exists", a sentence written for organization names — and the form rendered it in
`.ui-alert`, a class that had never been defined in `globals.css`, at the top of a form whose submit
button is at the bottom. On a phone the honest reading of that screen is "the button is broken". Three
fixes, one for each layer: `cmd_create_booking` now checks for a live booking first and raises
`ALREADY_BOOKED` naming it; the retry loop re-raises anything that is not a code collision; and the form
renders the failure directly above the button, styled, announced, scrolled into view, with a link to My
bookings. The booking page now asks the database first: a passenger who already holds a seat on the trip
sees that booking's code and a way into it instead of a form whose only possible answer is a refusal.
The native screen had the mirror-image hole — it printed `error.detail`, which is English
support text, instead of a translation — and now calls `errorKey()`. The demo seed also gained a
published trip, because an empty marketplace is the same bug with a different cause.

**A share link dies with the booking.** `resolve_id_share_token` refuses anything that is not `pending`
or `accepted`, and a trigger revokes the tokens when a booking closes. Without it, cancelling a seat left
the operator able to open the passenger's ID for the rest of the 72 hours — the second defect the smoke
found.

**Every private image URL lives five minutes.** `signedObjectUrl()` mints a storage signature on the
server and re-roots it on the same-origin proxy; passenger IDs and driver licences both go through it. The
bucket policy is what authorises the read; the signature is what stops the *link* from outliving the visit.
The dev backend implements the same POST-sign/GET-verify handshake, so a stale link really does 400
locally rather than passing by luck.

**Retention is a purge, not a promise.** `cmd_purge_id_documents` deletes the photos of bookings that
ended more than 90 days ago and keeps the row plus its audit trail. The nightly job calls it; the number
lives in one place.

**No QR renderer on native (yet).** The web ticket carries a scannable QR generated server-side. The
phone shows the code in large type. Drawing a QR in React Native needs a native SVG module, and adding a
native dependency to the app shell is a release decision, not a screen decision — so it is recorded here
instead of smuggled into an unrelated change.

---

## 3. What the suite promises

`supabase/tests/0008_bookings.test.sql` — **91 assertions**, in thirteen sections:

1. the server prices the booking and refuses a moved fare with `PRICE_CHANGED`;
2. the last seat is sold once — the second request gets `NO_SEATS_LEFT` and the trip never goes negative;
2b. a passenger cannot hold two bookings on one trip: `ALREADY_BOOKED`, naming the booking that exists,
   with no row written and no seat held by the refused attempt;
3. accepted / rejected by the right actor, and a rival operator or the passenger is refused;
4. the 30-minute hold, its expiry, and the sweeper being idempotent;
5. BR-09's ladder — 48 h → 100 %, 24 h → 75 %, 2 h → 50 %, inside 2 h → `CANCEL_WINDOW_CLOSED`;
6. operator cancellation refunds in full, and cancelling the trip cancels its bookings by trigger;
7. `compute_refund` matches `computeRefund()` in `@maak/core`, case for case;
8. identity: one document, three audiences, every read logged, a foreign path refused;
9. the share link — token shape, 72 hours, one audience, counted views, a new link revoking the old, an
   expired link not found, and a cancelled booking's link revoked;
10. the manifest lists accepted passengers and nothing else;
11. no-show and end-of-trip finalisation;
12. the scheduled wrappers exist, are service-only, expire a real stale hold, return the seats, and are
    no-ops on a second run.

---

## 4. Gates (all run in this environment)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` (core, web, mobile) | 0 errors |
| `npm run lint` | clean |
| `npm run format:check` | all files Prettier-clean |
| `npm run check:guards` | 24 core files · 108 style files · **20 migrations** · **54 commands** |
| `npm run check:a11y` | **54 routes**, both directions, 5 discovered detail pages |
| `npm run check:responsive` | viewport exported, 34 media queries, 7 tap targets, every wide table scrollable |
| `npm test` | **390** tests in 19 files |
| `npm run sql:check` | 20 migrations · 8 pgTAP suites · **419** assertions (91 in 0008) · no type drift · no client write grants |
| `npm run db:types:check` | types stamped for 20 migrations |
| `npm run check:functions` | 8 edge functions bundled, no drift |

---

## 5. End-to-end probe

Against the dev backend (real Postgres, real RLS, real commands) with a published trip and the demo
accounts:

| Step | Result |
| --- | --- |
| `booking.create`, 1 seat, cash | `BK-…` pending, total 5,000 YER, hold set |
| upload to `passenger-ids/<booking>/id.jpg` as the passenger | 200 |
| the same upload as the operator | **403** — the folder belongs to the booking, not the bucket |
| `booking.setDocument` | saved; a bucket-prefixed path is refused (`the photo belongs to a different booking`) |
| `booking.accept` by the operator | accepted, seats 14 → 13 |
| `booking.shareLink` | token, 72 h, `/s/<token>` |
| `/en/s/<token>` as the operator | watermarked preview + signed photo URL |
| `/en/s/<token>` as the passenger | forbidden |
| `booking.cancelByPassenger` (3 days out) | cancelled, `refund_yer` = 100 %, seats 13 → 14 |
| operator `booking.reject` with a reason | rejected, seat returned, localized notification with the reason |
| `/en/account/bookings/<id>` | ticket QR, signed URL of the form `/api/data/storage/v1/object/sign/...?token=…` |
| that signed URL | 200, 900 bytes; a bogus token → 400 |
| `document_access_log` | `owner: 1`, `share_link: 1` (four audiences, one row per look) |
| a second `booking.create` on the same trip | **409 `ALREADY_BOOKED`**, `detail: booking BK-… is already pending on this trip` |
| force a hold into the past, then `app.job_expire_holds(500)` | `{"expired": 1}`, status `expired`, seats 12 → 14, an `expired` event |
| `booking.cancelByPassenger` 39 h out | `cancelled_by_passenger`, refund **75 %** (3,750 of 5,000), seat back |
| the same share link after cancellation | resolves to "not found" — 0 mentions of the ID number in the HTML |

Four defects were found and fixed by this probe: the booker-scope denial (§2), link revocation after
cancellation (§2), the unexplained duplicate refusal and its invisible rendering (§2), and — found by
restarting from nothing — a marketplace with no trip to book, which is why the dev seed now creates one
through `cmd_create_trip` → `cmd_set_trip_stops` → `cmd_publish_trip` instead of leaving the flow
untestable without a hand-written fixture.

---

## 6. Not done, and why

- **WhatsApp delivery.** The product sends the *link* through the OS share sheet; sending templates from
  the platform is Phase 11 (channels), and building it now would mean inventing a provider contract.
- **Payments.** `payment_status` and the refund columns are placeholders that Phase 9 fills; a cash
  booking records a refund entitlement, not a transfer.
- **Device testing.** No simulator or handset in this environment: the native screens are type-checked and
  share their data layer with the web, but nobody has tapped them.
- **QR on native** — see §2.
- **`cmd_accept_driver_invite` re-invite path** (carried from Phase 3) is still untested.
