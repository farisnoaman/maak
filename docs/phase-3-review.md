# Phase 3 review — the implementation against `IMPLEMENTATION_PLAN.md`

**Date:** 2026-10-31 · **Reviewed commit:** `002abea` (PR #1, merged from `arena/736770c1-maak`)
**Scope:** `IMPLEMENTATION_PLAN.md` lines 248–285 — Phase 3 deliverables, tasks and acceptance criteria.
**Method:** read the plan clause by clause, then the migration, the commands, `packages/core`, the web
and mobile screens; re-ran every gate; probed the running stack. Where a claim could not be reproduced
in this environment it says so instead of being ticked.

This review is separate from `docs/phase-3-report.md`: that document describes what was built, this one
asks whether the plan was met, and what is missing.

---

## 1. Verdict

Phase 3 **is implemented and merged**, and the core of it is sound: the fleet model, the verification
state machine, plan quotas and the RLS story are all real and all pinned by tests. Of the six
acceptance criteria, four are fully proven, two are proven at the API/database layer but not on a
device or in a browser.

Three deliverables were not fully met. All six findings are now closed on this branch: four in §6, the
driver licence photo in §9, and the a11y gate itself in §8. Phase 3 can be built on.

A second pass (§8) then found that the a11y guard was itself not guarding: it reported 30 routes while
parsing 6, because it never signed in. Fixed, and the vehicle detail page it could not reach is now
parsed on every run.

| | Count |
|---|---|
| Deliverables listed in the plan | 7 |
| Fully met as merged | 2 (the data model, the quota hook) |
| Fully met after this branch | 4 (wizard warning and badges close too) |
| Still partly met | 0 — driver licence capture, its staff viewer and the mobile upload were one missing feature, closed in §9 |
| Plan tasks (7) | 7 attempted · 6 fully met · 1 partly (driver licence capture) |
| Acceptance criteria (6) | 4 fully verified · 2 layer-verified only |
| Findings | 6 — 5 fixed on this branch, 1 cosmetic (naming drift) |
| Follow-up findings (second pass) | 1 — the a11y gate was not authenticated, so 24 of its 30 “routes” were never parsed; fixed (see §8) |

---

## 2. Acceptance criteria, one by one

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Verified individual registers a 2019 Hiace with full trim/mechanical/comfort data, 3 photos, insurance doc → staff approves → badge flips **verified**; all fields round-trip create → detail → edit | ⚠️ partly | All ~60 columns compared in one assertion (`supabase/tests/0005_fleet.test.sql` §3); edit re-opens verification (`cmd_update_vehicle`, `00013_fleet.sql:730`); detail renders the full spec (`VehicleDetail.tsx`). The browser pass (create → 3 photos → submit → approve → badge) was run black-box and passed, but the **edit** round-trip through the wizard was not driven in a browser — only in SQL and by types. |
| 2 | Unverified account: UI disabled **and** `NOT_VERIFIED` from the RPC | ✅ | Wizard short-circuits to `fleet-locked` (`VehicleWizard.tsx`, `if (!verified)`); gateway maps to `NOT_VERIFIED` through `policyDenial()` (unit-tested); pgTAP §2 asserts the `42501`; the live stack returned `NOT_VERIFIED` with a disabled wizard. |
| 3 | Basic owner adding a 2nd vehicle → `QUOTA_EXCEEDED { metric: vehicles, limit: 1 }` + upgrade payload | ✅ | `app.assert_quota` called from both write paths (`00013_fleet.sql:634` vehicles, `:1141` drivers); pgTAP §5; `parseQuotaDetail`/`quotaOf` unit tests; live stack returned `metric=vehicles limit=1 used=1` and the UI renders the upgrade context. |
| 4 | Driver invited → logs in on mobile → sees the assigned vehicle | ⚠️ partly | Invitation, accept and assignment are all real and asserted (pgTAP §8); the RLS half is asserted (§9: the assigned driver sees the vehicle and its photos, not the documents). The **mobile screens were typed and linted, not run on a device** — no simulator in this environment. This was disclosed in the phase report and is still true. |
| 5 | Expiring insurance shows an amber warning; expired inspection blocks trip assignment later (Phase 4 test) | ✅ | Unit tests for the 30-day window and the expired case (`vehicleBadges`); the live stack showed “expires in 15 days” in amber. The Phase 4 gate exists as `isVehicleOperational()` and is unit-tested; it is **called by nothing yet**, which is correct for Phase 3. |
| 6 | Every screen verified in AR/RTL and EN/LTR; all enum labels localized (no raw `four_wheel_drive`) | ✅ | Originally this row said “`check:a11y` covers 30 routes” — that number was wrong: the script never signed in, so every protected route answered `307` and was silently skipped (§8). It now signs in as the demo owner and staff accounts, parses all 30 routes for real, and **discovers the vehicle detail page from the list** (32 routes, 2 detail pages). Enum→label tables are asserted in `fleet.test.ts` (§6.4), and the live detail page was checked for raw tokens: the only `rear_wheel_drive` in the HTML is inside the RSC payload, while the visible label is `دفع خلفي`. |

---

## 3. Deliverables and tasks

| Plan item | Status | Notes |
|---|---|---|
| `vehicles` (~60 attributes), `vehicle_photos`, `driver_profiles`, `vehicle_driver_assignments`, `odometer_readings` (baseline) | ✅ | `00013_fleet.sql:230–425`; the baseline reading is written inside `cmd_create_vehicle` (`:723`) and asserted in pgTAP §3. |
| Vehicle wizard (7 steps, resumable) with photo upload, document-expiry checks, plate duplicate warning | ⚠️ → ✅ | Steps and draft restore are real (`VEHICLE_WIZARD_STEPS`, `localStorage` restore); photo upload and expiry checks work. The **duplicate-plate warning was computed by SQL and parsed by `@maak/core` but never shown** — the key `fleet.plateDuplicate` existed, unused. Fixed on this branch (§6.1). |
| Driver management: invite by phone, **licence capture**, verification, assign/unassign | ⚠️ | Invite by phone, verification and assignment are complete. Licence *number* and *expiry* are captured at invite and checked at approval (`:1289`). **Licence photo is not captured anywhere** — see §4. |
| Staff vehicle/driver verification queues with **document viewer** and audited decisions | ⚠️ | Both queues exist in `/staff/vehicles` (`StaffReview.tsx` — vehicle section and driver section) and every decision writes an audit row. The document viewer is real for **vehicle** documents (signed/authenticated read of the private bucket). The **driver** row shows licence number and expiry as text only, because there is no licence image to show. |
| Vehicle cards with badges (verified, insurance/inspection expiring, **maintenance placeholder**) | ⚠️ → ✅ | Verified/expiring/expired/suspended/retired/registration/permit all present. `maintenance` existed nowhere in the codebase. Added as a data-driven placeholder on this branch (§6.2). |
| Quota hook: `create_vehicle` + `invite_driver` call `app.assert_quota()` | ✅ | `:634` and `:1141`, both pinned by pgTAP (§5 for vehicles; the quota message for drivers was also confirmed live: `metric=drivers limit=1 used=1`). |
| Mobile: driver profile, **licence upload**, vehicle quick view | ⚠️ | `/driver/profile` (accept invitation, see status and licence) and `/driver/vehicle/[id]` exist. Upload is missing (§4). |
| Storage: `vehicle-photos` (public) + `vehicle-documents` (private) policies | ✅ | `:1560–1590`; the photo policy authorises by vehicle ownership via the folder name, and the pgTAP suite asserts the buckets' visibility. No bucket for driver documents (part of §4). |
| Commands: create/update/submit/decide/invite/accept/verify/assign/set-status | ✅ | All nine present; `assign_driver_to_vehicle` is implemented as `cmd_assign_driver` (naming drift only, §4.5). |
| RLS: owner/org isolation; staff read-all; verification-gated writes | ✅ (after this branch) | Read policies on every table; writes exist **only** through `SECURITY DEFINER` commands, and `0005_fleet.test.sql` §10 asserts no `cmd_*` is executable by `authenticated`. The plan's “org A cannot read org B” assertion was **missing**; added on this branch (§6.3). |
| pgTAP: unverified cannot insert vehicle; **org A cannot read org B vehicles**; Basic owner blocked at 2nd vehicle | ⚠️ → ✅ | The first and third were already asserted. The cross-organization case was not — the suite had a *stranger* (0 rows) and *staff* (all rows), which is a different question. Added on this branch (§6.3). |

---

## 4. Gaps

### 4.1 ✅ Driver licence photo was a dead column — fixed (§9)

`driver_profiles.licence_photo_path` is declared (`00013_fleet.sql:360`) and generated into
`apps/web/src/lib/supabase/database.types.ts:399`, and **nothing in the repository reads or writes it**:
no bucket, no policy, no command, no upload, no viewer.

What that costs, in the plan's own words (“Driver management: invite by phone, **licence capture**,
verification” and “Mobile: driver profile + **licence upload**”):

- an invited driver cannot prove they hold the licence the operator typed in;
- a staff reviewer approving `driver.verify` sees only a number the *inviter* typed — no image, no
  check that the two agree;
- the driver cannot correct their own licence number or expiry: there is no `driver.updateLicence`
  action, and `driver_profiles` has no self-update policy (correctly — writes go through commands).

**Fixed in `00015_driver_licence.sql` + the mobile and staff screens (§9).** One private
`driver-documents` bucket with `<driver-user-id>/…` write and owner-or-company-or-staff read policies;
`cmd_set_driver_licence`, ownership-scoped, which refuses a path that was never uploaded, refuses an
expired licence, re-opens verification when the licence changes, and audits the before/after;
`driver.setLicence` in `fleetActionSchema`; the camera upload on `/driver/profile`; the image in the
staff driver row; and 27 pgTAP assertions in `0006_driver_licence.test.sql`.

This was closed before Phase 4 rather than after, because Phase 4's trip assignment starts asking “is
this driver entitled to drive this vehicle?” and the answer would otherwise rest on an unchecked
string.

### 4.2 ✅ Duplicate-plate warning was never displayed — fixed (§6.1)

The plan asks for a “plate duplicate warning”. SQL returned `warnings: [{code: 'PLATE_DUPLICATE', …}]`
and `fleetResultSchema` parsed it, but no component ever read `warnings`, so the operator was told
nothing. The phase report's decision #3 (“each is returned in `warnings` and badged, never silently
swallowed”) was therefore too strong.

### 4.3 ✅ Maintenance badge did not exist — fixed (§6.2)

`grep -rn maintenance packages/core/src apps/web/src apps/mobile/src` returned nothing.

### 4.4 ✅ No cross-organization isolation assertion — fixed (§6.3)

### 4.5 ◻︎ Naming drift — `assign_driver_to_vehicle`

Implemented as `cmd_assign_driver` (plus `cmd_unassign_driver`). The plan's name is a sketch; the code
is clearer and consistently mapped through `fleetCommandArgs()`. Recorded, not changed.

### 4.6 ✅ Coverage gap — the vehicle detail page was not in the a11y route list — fixed (§8.2)

`scripts/check-a11y.mjs` listed the fleet list, wizard, drivers and staff queue, but not
`/operator/vehicles/[id]`: it needs a real id, and with an empty database there was none to use. The
page now renders from the seeded demo fleet and the script discovers its id from the list page, so it
is parsed in AR and EN on every run.

---

## 5. What is genuinely solid

Worth saying, because a review that only lists defects is not a review:

1. **Quota is a service, not a check.** One routing point (`app.owner_plan`) and live counting, so a
   plan change cannot leave a stale counter behind. Both metrics were confirmed on the live stack.
2. **The verification state machine is honest.** Submitted → decided once, no self-approval, a
   substantive edit re-opens and clears the approver. pgTAP asserts the negative cases, which is
   where these things usually break.
3. **Warnings do not become errors.** A duplicate plate, an unverified driver, expired insurance:
   each is a value, not an exception, and Phase 4 can decide what blocks a trip in one place
   (`isVehicleOperational`).
4. **Write lockdown is tested from the client's side**, not just asserted in prose: no `cmd_*` is
   executable by `authenticated`, while the predicates the RLS policies run *are* — the failure mode
   found during the build (§6 of the phase report) is now pinned by an assertion.

---

## 6. What this branch changes

| # | Change | Files |
|---|---|---|
| 6.1 | The wizard now **stays on the page** when `vehicle.create` reports `PLATE_DUPLICATE` and shows “You already have a vehicle with this plate: {make} {model}” with a link to the new vehicle, instead of navigating past the warning. Uses the `fleet.plateDuplicate` key that already existed, plus one new key. | `apps/web/src/components/fleet/VehicleWizard.tsx`, `apps/web/src/app/globals.css` (`.fleet-warning`), `packages/core/src/i18n/dictionaries.ts` |
| 6.2 | `vehicleBadges()` gained the **maintenance placeholder**: `nextMaintenanceDue` produces `maintenanceOverdue` (red) or `maintenanceDue` (amber inside the same 30-day window) after the document badges. Nothing writes that date yet — the placeholder stays silent rather than inventing a badge on every vehicle. | `packages/core/src/domain/vehicle.ts`, `packages/core/tests/fleet.test.ts`, dictionaries |
| 6.3 | **Cross-organization isolation** asserted: two verified companies, one vehicle each, and the questions that matter — org A sees 0 of org B's vehicles/photos/documents, org A sees exactly its own one row out of two, org B sees its own, staff still see both, and an owner of org A cannot create a vehicle inside org B. | `supabase/tests/0005_fleet.test.sql` §11 (`plan(72)`) |
| 6.4 | **Enum labels are now asserted**, closing acceptance criterion 6's “no raw `four_wheel_drive`”: every value of the body/drive/transmission/fuel/status/verification/driver-status enums must map to a label that exists in AR and EN and is not the raw token. | `packages/core/tests/fleet.test.ts` |

### Evidence after the changes

| Gate | Result |
|---|---|
| `npm run sql:check` | 5 suites — 9 / 9 / 35 / 75 / **72** assertions (200 total); types in sync; write-lockdown spot-check clean |
| `npm test` | **303 tests / 16 files** (was 301) |
| `npm run typecheck` · `lint` · `format:check` · `check:guards` | clean · clean · clean · 20 core / 72 style / **14** migrations / **42** commands (Phase 4's migration is in the tree) |
| `npm run check:a11y` | **32** routes, both directions, including 2 discovered vehicle detail pages (§8) |
| `npm run dev:check` | dev stack healthy |
| Duplicate-plate path on the live stack | `vehicle.create` twice with one plate: first `warnings: []`, second `warnings: [{code: PLATE_DUPLICATE, make, model, vehicleId}]` — the payload the wizard now renders |

**Not verified here:** the warning banner's rendering was not driven in a browser (no browser
automation in this environment) — the data path and the type-checked branch are, the pixels are not.
The mobile gap in §4.1 is untouched.

---

## 7. Recommendation

1. ~~Close §4.1 (driver licence photo) before Phase 4.~~ Done in §9.
2. ~~Add `/operator/vehicles/[id]` to `scripts/check-a11y.mjs` with a seeded vehicle.~~ Done in §8.2,
   along with the larger problem that hid it: the gate was not authenticated at all.
3. Then proceed to Phase 4. Everything Phase 4 needs from Phase 3 — a verified vehicle, an operational
   predicate, real quotas, org isolation — is in place and asserted.

---

## 8. Second pass — the guard that was not guarding

Re-running the review's own evidence turned up a worse finding than the ones it recorded, and closing
it is what made criterion 6 honest.

### 8.1 ⛔→✅ `check:a11y.mjs` reported 30 routes and parsed 6

`checkRoute()` fetched without a session. A protected route answered `307` to sign-in, and the script
did this:

```js
if (response.status === 307 || response.status === 308 || response.status === 302) return;
```

That `return` is correct behaviour *for an anonymous visitor* and a silent pass *for a guard*. The run
printed `✓ a11y smoke passed on 30 routes`, while only the six public routes — `/ar`, `/en`, both
`/styleguide`s and both sign-in pages — were ever parsed. Every console screen, including all eight
Phase 3 routes and their RTL layout, was counted as verified without being looked at.

Now the script signs in through the real form endpoint (`POST /api/auth/sign-in`, the same one a person
uses), keeps one session per role (`owner@maak.test` for operator screens, `admin@maak.test` for the
staff and admin queues), and:

- passes the cookie to every authenticated request;
- **fails** a protected route that still redirects *with* a session (a broken gate is now an error);
- reports `skipped (no session)` instead of a green tick when sign-in is unavailable — the summary line
  drops from 30 to 6 on purpose, which is the honest number;
- discovers `/operator/vehicles/[id]` from the vehicle list, in both locales and both org contexts.

Verified both ways: wrong password → `⚠ could not sign in as owner/staff` and `passed on 6 routes, 24
skipped`; correct password → `passed on 32 routes, 2 discovered detail pages`.

### 8.2 ✅ The console is no longer empty

The reason the detail page could not be discovered is that the dev database contained no vehicles at
all — every operator screen was an empty state, and a demonstration of Phase 3 had nothing to show.
`scripts/dev-backend/db.mjs` now seeds one **verified 2019 Toyota Hiace** owned by the demo company
(insurance deliberately 20 days out, so the amber badge has something to colour), its odometer baseline,
a verified driver, and the assignment between them. Fixed ids, `on conflict do nothing`: re-running the
seed is a no-op and anything edited in the UI survives a restart.

That change is what lets §4.6 close: the detail page now renders 60 attributes and is parsed in AR
(`dir="rtl"`) and EN on every gate run, with `check:a11y` reporting 32 routes.

### 8.3 Phase 4 state at the time of this pass

`supabase/migrations/00014_trips.sql` (2 300 lines: enums, trips, quotas, stops, events, verification
trail, search projection + refresh triggers, rules, commands, read APIs, RLS and grants) applies cleanly
— `npm run sql:check` builds a database from all 14 migrations, and `database.types.ts` was refreshed
for the six new tables. It has **no pgTAP suite yet** and no TypeScript/web surface; Phase 4 is
schema-complete and untested below that line, which this document does not claim otherwise.

---

## 9. Driver licence capture — the gap, closed

`00015_driver_licence.sql` (plus the phone and staff screens) is the whole of §4.1. What it establishes:

| Rule | Where | Asserted by |
|---|---|---|
| One private bucket, one folder per driver account | `driver-documents`, `app.can_read_driver_documents()` | pgTAP §1, §5 (bucket private, predicate reachable) |
| The driver writes only into their own folder | `driver_documents_write_self` policy | pgTAP (policy definition) and the dev mock, which enforces this one rule |
| One writer: `cmd_set_driver_licence`, not executable by a client | `00015` §2–3 | pgTAP §1 (`has_function_privilege`) |
| A recorded path must point at an object that exists | `cmd_set_driver_licence` | pgTAP §3; live stack returned 422 `VALIDATION_FAILED: licence photo is not uploaded` |
| An expired licence cannot be uploaded as evidence of a valid one | same | pgTAP §3 |
| Changing the licence re-opens verification and clears the approver | same | pgTAP §2 (status `pending`, `verified_by` null), §4 (a no-op save is not an event) |
| Staff are notified, the change is audited | `app.notify` + `app.write_audit` | pgTAP §2 |
| The company owner may correct it; a stranger may not | `app.manages_driver()` | pgTAP §3 |

Screens: `/driver/profile` (mobile) photographs the licence with `expo-image-picker`, uploads it to the
private bucket, then records the path through the command — in that order, because the command refuses
a path that was never uploaded. `/staff/vehicles` shows the image next to the driver it belongs to, via
the same authenticated proxy the vehicle documents use.

**Two defects found while wiring it, both fixed:**

1. `scripts/dev-backend/gateway.mjs` keeps its own capability map, separate from the edge function's.
   Without `driver.setLicence` there, every call was `403 FORBIDDEN` in development while the SQL was
   correct. The two maps are now in step (this is a drift risk worth remembering for Phase 4's `trips`).
2. **Uploads never worked in the dev backend.** The router reads the request body once, and
   `handleStorage` tried to read the same stream again — every upload died with “request is not async
   iterable”, and the mock never recorded a `storage.objects` row. Both are fixed: the buffer is passed
   through, rows are written and deleted with the files. This also unblocks the verification-document
   upload that Phase 1 shipped.

Both are now pinned so they cannot come back quietly: `npm run check:guards` compares the edge
function's capability map with the dev gateway's by name (removing one key reproduces the 403 and fails
the gate), and `npm run dev:check -- --api` uploads, downloads, refuses a foreign folder and deletes an
object against the running backend.

**Verified end to end on the live stack** (as `new@maak.test`, bound to the seeded driver): upload `200`
→ `driver.setLicence` `200 { verificationStatus: "pending", reverificationRequired: true }` → the staff
queue renders the licence link → the link downloads `200` for staff and for the company owner, and the
command refuses a path that does not exist. **Not verified:** the phone screen itself (no simulator in
this environment) — the upload and command it performs were, through the same HTTP endpoints the app
uses.

### 9.1 Follow-up: the web screen, one more clock, and a demo account

Three things were still wrong *after* §9, and they were only visible by trying to use it:

1. **The only place to photograph a licence was the phone.** A driver using a laptop — or anyone
   reviewing this build in a browser — could not upload one. The web screen now exists at
   `/[locale]/account/licence`: the same order (upload into `<userId>/…`, then `driver.setLicence`), the
   same `capture="environment"` input that opens the rear camera on a phone and a file picker on a
   laptop, the same re-verification on replacement. `/account` links to it.
2. **The image URL was a session cookie, not a signature.** Licence photos were served through
   `/api/data/storage/v1/object/authenticated/...`, which works but never expires while the session
   lives. They now use the same five-minute signed read as passenger IDs (`lib/storage.ts`), for the
   driver, the operator console and the staff queue alike. The dev backend implements the sign/verify
   handshake, so a stale link really does 400 locally instead of passing by luck.
3. **Nobody could reach the screen.** The seeded driver profile had `user_id = null`, so the page
   answered "no driver profile" for every demo account and the flow could not be tried at all. The seed
   now creates `driver@maak.test` (+967733000101) and binds the existing profile to it.

Re-verified on the live stack with the seeded driver: the panel renders the stored licence number and
"no photo yet" → upload through the web proxy `200` → `driver.setLicence` `200`
`{ verificationStatus: "pending", reverificationRequired: true }` → the driver page, the operator
console and the staff queue each render a signed URL → that URL returns the image (`200`, correct byte
count), and a forged token returns `400`. The a11y gate now signs in as the driver for the two licence
routes, so an empty state can no longer pass for a verified screen.
