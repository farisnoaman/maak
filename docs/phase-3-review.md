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

Three deliverables were not fully met, and one acceptance criterion had **no assertion** behind it.
Three of those findings are closed on this branch (§6); one substantive gap remains and is described
in §4.1 (driver licence photo / mobile licence capture). That is the only thing I would not ship
Phase 4 on top of without deciding.

| | Count |
|---|---|
| Deliverables listed in the plan | 7 |
| Fully met as merged | 2 (the data model, the quota hook) |
| Fully met after this branch | 4 (wizard warning and badges close too) |
| Still partly met | 3 (driver licence capture, staff document viewer for drivers, mobile licence upload — all three the same missing feature) |
| Plan tasks (7) | 7 attempted · 6 fully met · 1 partly (driver licence capture) |
| Acceptance criteria (6) | 4 fully verified · 2 layer-verified only |
| Findings | 6 — 3 fixed on this branch, 2 open (licence photo, a11y detail route), 1 cosmetic |

---

## 2. Acceptance criteria, one by one

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Verified individual registers a 2019 Hiace with full trim/mechanical/comfort data, 3 photos, insurance doc → staff approves → badge flips **verified**; all fields round-trip create → detail → edit | ⚠️ partly | All ~60 columns compared in one assertion (`supabase/tests/0005_fleet.test.sql` §3); edit re-opens verification (`cmd_update_vehicle`, `00013_fleet.sql:730`); detail renders the full spec (`VehicleDetail.tsx`). The browser pass (create → 3 photos → submit → approve → badge) was run black-box and passed, but the **edit** round-trip through the wizard was not driven in a browser — only in SQL and by types. |
| 2 | Unverified account: UI disabled **and** `NOT_VERIFIED` from the RPC | ✅ | Wizard short-circuits to `fleet-locked` (`VehicleWizard.tsx`, `if (!verified)`); gateway maps to `NOT_VERIFIED` through `policyDenial()` (unit-tested); pgTAP §2 asserts the `42501`; the live stack returned `NOT_VERIFIED` with a disabled wizard. |
| 3 | Basic owner adding a 2nd vehicle → `QUOTA_EXCEEDED { metric: vehicles, limit: 1 }` + upgrade payload | ✅ | `app.assert_quota` called from both write paths (`00013_fleet.sql:634` vehicles, `:1141` drivers); pgTAP §5; `parseQuotaDetail`/`quotaOf` unit tests; live stack returned `metric=vehicles limit=1 used=1` and the UI renders the upgrade context. |
| 4 | Driver invited → logs in on mobile → sees the assigned vehicle | ⚠️ partly | Invitation, accept and assignment are all real and asserted (pgTAP §8); the RLS half is asserted (§9: the assigned driver sees the vehicle and its photos, not the documents). The **mobile screens were typed and linted, not run on a device** — no simulator in this environment. This was disclosed in the phase report and is still true. |
| 5 | Expiring insurance shows an amber warning; expired inspection blocks trip assignment later (Phase 4 test) | ✅ | Unit tests for the 30-day window and the expired case (`vehicleBadges`); the live stack showed “expires in 15 days” in amber. The Phase 4 gate exists as `isVehicleOperational()` and is unit-tested; it is **called by nothing yet**, which is correct for Phase 3. |
| 6 | Every screen verified in AR/RTL and EN/LTR; all enum labels localized (no raw `four_wheel_drive`) | ⚠️ partly | `check:a11y` covers 30 routes in both directions, including 8 fleet routes. Two holes: nothing asserted the enum→label tables at all — fixed on this branch (§6.4); and the **vehicle detail page** (`/operator/vehicles/[id]`) is still not in the a11y route list, because it needs a seeded id (§4.6). |

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

### 4.1 ⛔ Driver licence photo is a dead column (open — the one real gap)

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

**Shape of the fix (not done here, ~½–1 day):** one migration adding a private `driver-documents`
bucket with `<auth.uid()>/…` write and owner-or-staff read policies; `cmd_set_driver_licence(actor,
licence_no, licence_expiry, photo_path)` that is ownership-scoped, re-opens verification when a
verified driver changes the licence, and writes an audit row; a `driver.setLicence` action in
`fleetActionSchema`; the upload on `/driver/profile` (`expo-image-picker` is already a dependency);
the image in the staff driver row; and 4–6 pgTAP assertions including “staff can read it, another
driver cannot”.

I would close this before Phase 4 rather than after, because Phase 4's trip assignment starts asking
“is this driver entitled to drive this vehicle?” and the answer currently rests on an unchecked string.

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

### 4.6 ◻︎ Coverage gap — the vehicle detail page is not in the a11y route list

`scripts/check-a11y.mjs:49–56` lists the fleet list, wizard, drivers and staff queue, but not
`/operator/vehicles/[id]` — it needs a seeded id, so it was left out. The page renders in both
directions (it shares `ConsoleShell` and `VehicleDetail` with the checked screens), but “every screen
verified in AR/RTL and EN/LTR” is not literally true until that route is checked too.

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
| `npm run typecheck` · `lint` · `format:check` · `check:guards` | clean · clean · clean · 20 core / 72 style / 13 migrations / 35 commands |
| `npm run check:a11y` | 30 routes, both directions |
| `npm run dev:check` | dev stack healthy |
| Duplicate-plate path on the live stack | `vehicle.create` twice with one plate: first `warnings: []`, second `warnings: [{code: PLATE_DUPLICATE, make, model, vehicleId}]` — the payload the wizard now renders |

**Not verified here:** the warning banner's rendering was not driven in a browser (no browser
automation in this environment) — the data path and the type-checked branch are, the pixels are not.
The mobile gap in §4.1 is untouched.

---

## 7. Recommendation

1. **Close §4.1 (driver licence photo) before Phase 4.** It is the only item where the plan's wording
   (“licence capture”, “licence upload”) is not met at all, and where a later phase will start relying
   on data that is currently a text field nobody checked.
2. Add `/operator/vehicles/[id]` to `scripts/check-a11y.mjs` with a seeded vehicle, so acceptance
   criterion 6 is literally true (§4.6).
3. Then proceed to Phase 4. Everything Phase 4 needs from Phase 3 — a verified vehicle, an operational
   predicate, real quotas, org isolation — is in place and asserted.
