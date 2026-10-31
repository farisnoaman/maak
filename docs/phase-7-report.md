# Phase 7 — staff operations: the scan, the batch, and the sheet

**Date:** 2026-10-31 · **Branch:** `arena/8a1e3e09-maak` (PR #2)
**Scope:** `IMPLEMENTATION_PLAN.md` Phase 7. What shipped, what was decided differently, and what is still
open — §6 is the honest list.

Phases 4–6 built a marketplace that can sell a seat, take the money, and move the vehicle. None of it gave
the authority a tool: a supervisor could verify trips one at a time from a web table, and a driver at a
checkpoint had no way to ask "is this trip real, and who is on it?" without telephoning the operator. This
phase is that toolkit — and it is built around one rule: **scope and permission are decided in the
database, and the UI only displays the answer.**

---

## 1. What shipped

### The token and the scan

| Object | Purpose |
| --- | --- |
| `trips.qr_token` | 24 hex characters, `^[0-9a-f]{24}$`, unique partial index. Not a URL: it is what a scanner reads and what `staff_scan` understands. |
| `app.ensure_trip_qr_token`, `app.trip_qr_token_trigger` | Issued when a trip becomes `verified`/`published`/`in_progress`/`completed`, plus a backfill — a trip that is on sale but has no token is a trip nobody can check. |
| `public.trip_scan_log` | Every attempt, allowed or refused, with actor, IP and reason. Append-only by policy: staff may read their own log, nobody may write it through the API. |
| `app.is_ops_staff` | Platform staff **or** an active `geo_supervisor`. The Phase 4 gate was "platform staff", which would have kept supervisors out of the tool built for them. |
| `app.staff_scope_governorates` | The governorates a supervisor actually covers: `region_governorates` **plus** districts collapsed up, via `region_descendants`. |
| `app.staff_in_trip_scope` | Either end of the route inside the patch. No assignment at all = no patch = the whole country (platform staff). |
| `get_trip_for_staff(actor, token, ip)` | The scan. Returns a **trimmed** trip — route, times, seats, operator, vehicle, driver *name*, last ping. No passenger names, no phone numbers, no booking codes. |
| `staff_scan(text)`, `staff_summary()`, `staff_manifest(uuid)` | Session-bound wrappers with no actor parameter: the only identity they can use is the JWT's. |

**Refusals are answers, not exceptions.** `get_trip_for_staff` returns `{allowed:false, reason}` for
`NOT_FOUND`, `OUT_OF_SCOPE` and `RATE_LIMITED` instead of raising. This is not politeness: an exception
rolls back the audit row that was just written, so a raised refusal would have been the one attempt the log
never saw. The reason travels with the route only (`code`, `origin`, `destination`), so an out-of-scope
supervisor learns *why* they are refused without learning who is on the bus.

### Bulk verification

`cmd_bulk_verify_trips(actor, tripIds[], outcome, reason, requestId, ip)` → `{results[], verified, failed}`,
max 50 per call. Each row is decided by the existing `cmd_decide_trip_verification`, so events, owner
notification and audit are byte-identical to a single decision; the scope check happens first and produces a
**row-level** failure (`OUT_OF_SCOPE`) rather than aborting the batch.

The shape is the feature. A supervisor who selects ten and gets nine needs the tenth named with its reason
on screen, not a toast that says "done". The panel keeps the per-row results after the call and refreshes
the queue behind them.

### The manifest

`get_trip_manifest(actor, tripId, requestId, ip)` → the trip block (including vehicle seats, driver phone
and **QR token**), the stops, and every confirmed passenger with seat count, phone, payment state and total.
It is a *second, separately audited* permission question — `trip.manifest` in the audit trail — because
reading the manifest is the moment personal data leaves the building.

The page at `/{locale}/staff/trips/{id}/manifest` is the A4 sheet: 210 mm wide, `@page size: A4`, the trip
header and QR, vehicle/operator/driver blocks, the stop chain, and the passenger table with a payment column.
`manifestColumns()` splits the table into page-sized columns (28 rows each) so a 30-passenger manifest is two
columns on one sheet rather than seven-point text on one. Print CSS hides the console shell and the toolbar;
`/api/staff/trips/{id}/manifest?locale=ar|en` is the same read as a CSV.

### Search, history, export

`staff_search_trips` was re-created (same signature, so `00016`'s grant still matches) with three changes: the
gate is `is_ops_staff`, the rows are filtered by the supervisor's patch, and the filters gained
`verificationStatus[]`, `from`/`to` (Aden calendar days, inclusive) and `governorateId` (either end of the
route). `/api/staff/trips/export` runs the same function with the same query string, so the file and the
table cannot disagree.

### Dashboard

`staff_scope_summary` → pending trips in scope, live trips, stale trips (no ping in 21 minutes), the
supervisor's last ten scans with their verdicts, and the scope itself. The page adds the bulk panel over the
pending queue and the recent-scans list.

### Mobile

`apps/mobile/src/app/staff/scan.tsx`: token entry → `staff_scan` → the trimmed trip or the refusal, with the
manifest link when `EXPO_PUBLIC_WEB_URL` is set. See §6 for what is *not* here.

## 2. Decisions worth an argument

**A geo supervisor with no seeded districts was invisible.** The first cut inferred scope from
`app.geo_scope_districts`, which joins `districts.is_active`. Only Aden's districts are imported in
`00009_geography_seed.sql`, so a Sanaa supervisor had a region assignment and **zero** districts — and every
trip was out of scope, silently. Scope is now derived from `region_governorates` first and districts second.
The bug is worth recording because it fails *closed*: the tool said "outside your scope" and looked correct.

**A scan sees the trip, not the passenger list.** The person at the checkpoint is answering "is this vehicle
the trip it claims to be" — they need the route, the time, the operator, the driver and the seat count. The
manifest is a separate door with its own audit row. Trimming here is not a limitation to fix later; it is the
permission model.

**The manifest is print-optimised HTML, not a PDF binary.** `pdfkit` with `@fontsource/noto-naskh-arabic`
was installed and measured in this sandbox: it renders Arabic correctly (4,376-byte output). It was not
shipped, for three reasons. The font package ships **woff/woff2 only** — no TTF/OTF — so a native PDF needs a
font converted from a format PDFKit does not read. It would be a second layout implementation in millimetres
that has to be kept in step with the screen forever. And the failure it prevents is not real: the browser's
own "Save as PDF" embeds the reader's Arabic font, so there is no tofu, and the `@page` rule gives real A4.
The cost is that the "PDF" requires one click in a dialog; the benefit is one layout and no font pipeline.
A server-rendered `.pdf` route stays open as a Phase 10 export if a printer-less workflow (email, WhatsApp)
turns out to matter more than it does today.

**Dates are calendar days in Aden, not instants.** `from`/`to` became `date`s converted with
`at time zone 'Asia/Aden'`, and `to` is exclusive of the *end* of its day. "The 14th to the 14th" is one day
to a human and zero days to a naive comparison. The CSV export writes `+03:00` offsets for the same reason:
a bare UTC timestamp is a departure time that is three hours wrong in a spreadsheet.

**Excel is a format with a BOM.** Arabic CSV without `\ufeff` opens as `Ù…Ø³Ø§ÙØ±`. Quoting every cell
(not only the ones that need it) keeps `+967…` a phone number instead of a formula.

## 3. Evidence

`supabase/tests/0011_staff_operations.test.sql` — **36 assertions**: the token's shape and rotation, the
refusal codes (`NOT_FOUND`, `OUT_OF_SCOPE`) and that both are audited, the trimmed scan payload, a
`9 verified, 1 failed (OUT_OF_SCOPE)` batch with per-row reasons, the manifest's second permission question
(passenger → `42501`), search scoped to the patch (4 rows, the Hodeidah trip absent), the platform admin's
5, the verification-state filter, a one-day date range matching exactly one trip, a governorate filter
finding `OPS-HU-0005`, and that no client can call any writer.

`packages/core/tests/manifest.test.ts` — **16 tests**: BOM and CRLF, Arabic vs Latin headers, quote doubling,
the leading `+`, row order at 30 passengers, `null` notes, the filename sanitiser, `manifestColumns` at
14 (one page) and 30 (28 + 2), `adenIso` converting `07:38Z` → `10:38+03:00`, and the history export's
column count and offset.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | 0 errors (core · web · mobile) |
| `npm run lint` / `format:check` | clean |
| `npm test` | **422** tests / 21 files |
| `npm run check:guards` | 26 core · 121 style · **25 migrations** · **60 commands** |
| `npm run sql:check` | 25 migrations · **11** pgTAP suites · **524** assertions |
| `npm run check:a11y` | **62** routes, both directions (dashboard, scan, history filters, discovered manifest) |
| `npm run check:responsive` | pass — the two new grids guard their tracks, the manifest table scrolls in its own box |
| `npm run check:functions` / `db:types:check` | 8 bundles, no drift · types re-stamped |

Probed on the running stack (`staff@maak.test`, the seeded `AD-SA-826B`):

| Step | Result |
| --- | --- |
| `staff_scan('997efdd4aa534f5170653246')` | `allowed: true`, route عدن → صنعاء, 14 seats, operator named, **no passenger names** |
| `staff_scan('ffff…')` | `allowed: false, reason: NOT_FOUND`, and a `trip_scan_log` row |
| manifest page, 14 seeded passengers | `200`; 14 rows in one column, one sheet; `manifest__columns--split` absent as designed |
| manifest CSV (`locale=ar`) | `\ufeff` + Arabic headers + 14 quoted rows |
| manifest CSV as `new@maak.test` (a passenger) | **403 FORBIDDEN** — and `trip.manifest` audit row |
| manifest CSV for a random UUID as staff | `404` — "no such trip" is a different answer from "not yours" |
| `/ar/staff/trips?from=2026-10-01&to=2026-12-31` | one row, matching `/api/staff/trips/export?…` row for row |
| `/ar/staff/scan`, `staff_scan` as a passenger | `FORBIDDEN`, logged |

## 4. How the scope answer is proven, not asserted

Three layers, deliberately:

1. `app.staff_in_trip_scope` — a predicate, callable by the policy layer, used by the batch and the search.
2. `get_trip_for_staff` / `get_trip_manifest` — the *answer*, with the reason.
3. The UI shows «خارج نطاقك» / "Outside your scope" and offers nothing to click.

The pgTAP suite exercises all three with a Sanaa supervisor and a Hodeidah trip, and the web probe does it
with a real session. A future change that widens scope must break a test rather than a promise.

## 5. Two defects the build found

**`retryable` was not a thing.** `consume_rate_limit` returns `{used, elapsed_seconds, limit,
window_seconds}` and no `allowed` field; the first implementation compared against a boolean that did not
exist and refused nothing. Fixed by comparing `used > limit` — and the scan now logs `RATE_LIMITED` like any
other refusal.

**A stale dev server hid a real bug for an hour.** The manifest CSV answered `404` for a passenger after the
`403` path was written. The route was right; the Next.js process had been running since before the fix and
was serving a compiled module, so the "old" behaviour looked current. Two lessons, both kept: `Next dev` in
this sandbox does not reliably invalidate `lib/` modules — restart it before trusting a probe — and a refusal
should carry its reason in the response body (`{error: 'FORBIDDEN'}`) so a wrong status is diagnosable from
`curl` alone.

## 6. What is not here

- **The other bulk commands.** The plan lists `bulk_verify_trips_with_passengers`, `bulk_verify_passengers`
  and `bulk_verify_entities`. Only trips shipped. Booking decisions already exist for operators
  (`booking.accept` / `booking.reject`) and entity decisions exist per-item in the Phase 3 queues; batching
  them is mechanical thanks to the per-row result shape, but each needs its own scope rule (a supervisor
  decides *trips*, not *people*), and shipping a batch of the wrong ones is worse than not shipping it.
- **Native camera.** The mobile screen takes the token, because `expo-camera` is not in this build and a
  native module that has never run on a device is not something to add blind. The token is printed under
  every QR on the manifest for exactly this reason. Web camera scanning ships (`BarcodeDetector`, with the
  text field always present as the primary path).
- **`expo-camera`-style permission prompts, `can_view_passengers`, `/supervisor/*`, `/staff/scans`.**
  The manifest read *is* the passenger-visibility gate, so a separate `can_view_passengers` predicate would
  be a second answer to the same question. The dashboard lives at `/staff/dashboard` and the scan at
  `/staff/scan`, inside the existing console rather than beside it.
- **PDF snapshot tests (page count / text extraction).** There is no PDF to snapshot, and no `pdftotext` in
  this sandbox. The layout is covered where it can be: `manifestColumns` unit tests at 4/14/30 rows, RTL/LTR
  rendering checked in both locales by the a11y pass, and the sheet's print CSS asserted by
  `check:responsive` (no unguarded grid, every wide table scrollable).
- **QR rotation has a command but no button.** `cmd_rotate_trip_qr` exists and is tested; the UI for it is a
  finance/admin action and belongs with the abuse-handling screens of Phase 10.

**Next:** Phase 8 — vehicle operations (ODO, fuel, maintenance), which is what makes the manifest's
"vehicle" block a health record rather than a plate number.
