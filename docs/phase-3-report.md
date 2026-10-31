# Phase 3 — Fleet: vehicles, drivers, verification

**Date:** 2026-10-31 · **Branch:** `arena/736770c1-maak` · **Spec:** `specs.md` v1.2 · **Plan:** `IMPLEMENTATION_PLAN.md`

Phase 3 makes an operator's fleet a real object: a vehicle with ~60 attributes, photos, documents and
an expiry date on each certificate; drivers invited by phone number rather than email; and two staff
queues that turn "claimed" into "verified". Plan quotas are wired from the first write, not bolted on
when billing arrives.

Legend: ✅ verified in this environment · ⚠️ code complete, needs a device/Docker · ⛔ not done

---

## 1. What was built

### Database — `supabase/migrations/00013_fleet.sql` (one migration, 11 commands)

| Object | Purpose |
|---|---|
| `plans`, `plan_limits` | the §6.14 limits, seeded: Basic 1 vehicle / 5 trips / 1 driver / 1 staff / 1 active trip / 0 featured; Pro 5 / 50 / 10 / 5 / 5 / 2; Business `NULL` (unlimited) |
| `vehicles` | ~60 columns: identity (make, model, year, trim, plate, VIN, chassis, colour), mechanical, capacity, comfort, accessibility, safety, document dates, condition, odometer, `status`, `verification_status`; generated `plate_norm`; `vehicles_one_owner` XOR constraint |
| `vehicle_photos` | ordered, at most one primary (`vehicle_photos_one_primary` partial unique index) |
| `vehicle_documents` | insurance / registration / inspection / permit / other, in the private bucket |
| `driver_profiles` | `invited_phone` (nullable `user_id` until accepted), licence, `status`, `verification_status` |
| `vehicle_driver_assignments` | history with `unassigned_at`; one **active** driver per vehicle (partial unique index) |
| `odometer_readings` | the baseline reading every later comparison needs |
| `app.safe_uuid(text)` | a malformed path segment becomes `NULL`, never a 500 inside a storage policy |
| `app.normalize_phone`, `app.normalize_plate` | digits-only phone matching; plates compared without spaces or dashes |
| `app.owner_plan`, `app.assert_quota` | one routing point for "which plan governs this owner"; usage counted **live** from tables |
| `app.owns_vehicle`, `app.is_assigned_driver` | RLS predicates, executed as the querying role |
| `app.assert_vehicle_payload` | `stable`, one definition of the cross-field rules (seats, expiry, model year, enum sanity) |
| `cmd_create_vehicle` | verified-owner gate → quota → insert → baseline odometer → duplicate-plate **warning** |
| `cmd_update_vehicle` | full-spec update; a substantive change (plate, VIN, seats, year, insurance/inspection expiry) re-opens verification and clears the previous approver |
| `cmd_submit_vehicle_verification` | replaces the document set, requires insurance **and** registration, notifies the staff queue |
| `cmd_decide_vehicle_verification` | staff only, `pending` only, no self-approval, rejection ≥10 characters, notifies the owner |
| `cmd_set_vehicle_status` | draft / active / suspended / retired, ownership-scoped |
| `cmd_set_vehicle_photos` | ≤12 photos, every path inside `<vehicleId>/`, replaces the set, guarantees a primary |
| `cmd_invite_driver` | by phone; links immediately when the phone already has an account; one row per phone per owner |
| `cmd_accept_driver_invite` | binds an invitation to the signed-in user |
| `cmd_verify_driver` | staff only, once, needs an accepted (active) driver |
| `cmd_assign_driver` / `cmd_unassign_driver` | closes the previous assignment in the same transaction; refuses an unaccepted or unverified driver |

Every `cmd_*` is `revoke`d from `public, anon, authenticated` and granted to `service_role` only. The
predicates the RLS policies themselves run (`owns_vehicle`, `is_assigned_driver`, `safe_uuid`,
`normalize_plate`) are granted **to `authenticated`** — revoking those does not harden anything, it makes
every `select` on `vehicles` fail from inside its own policy (found the hard way, see §6).

Buckets: `vehicle-photos` (public, 5 MB, jpeg/png/webp) and `vehicle-documents` (private, 10 MB, plus
PDF). Both policies authorise the write by `app.owns_vehicle(app.safe_uuid((storage.foldername(name))[1]))`.

### Shared contract — `packages/core`

- `api/fleet.ts` — `vehicleInputSchema` (~60 fields + defaults), one `fleetActionSchema` discriminated
  union over 11 actions, `fleetCommandArgs()` (action → `cmd_*` + named arguments), `fleetScope()`,
  `vehicleFieldErrors()` mirroring the SQL rules, `fleetResultSchema`.
- `api/quota.ts` — `parseQuotaDetail` / `quotaOf()` turn `QUOTA_EXCEEDED: metric=… limit=… used=…`
  into `{ metric, limit, used }`, keeping `NULL` (unlimited) distinct from `0` (none allowed).
- `domain/vehicle.ts` — `vehicleBadges()` (verification first, expired before expiring, 30-day amber
  window), `isVehicleOperational()` (what Phase 4 will gate a trip on), enum→label tables for body /
  drive / transmission / fuel / status / verification, and `VEHICLE_WIZARD_STEPS`.
- `domain/policy.ts` — `policyDenial()` returns `UNAUTHENTICATED | NOT_VERIFIED | FORBIDDEN`, so an
  unverified account is told what is actually wrong instead of "you lack permission".
- i18n: ~150 `fleet.*` keys plus driver notifications, in **both** Arabic and English.

### Edge gateway — `supabase/functions/fleet/index.ts`

One action discriminator, one `cmd_*` per request (one transaction), policy checked in the gateway *and*
in SQL, per-action rate limits (60/h for creates and updates, 240/h for the rest).

### Web (`apps/web`)

| Route | What it does |
|---|---|
| `/[locale]/operator/vehicles` | the fleet as cards: primary photo or a labelled placeholder, verification badge, driver, and a personal⇄organization context switcher |
| `/[locale]/operator/vehicles/new` | the **seven-step resumable wizard** (identity → mechanical → capacity → comfort → safety → documents → review) with per-step validation, photo upload and document upload |
| `/[locale]/operator/vehicles/[id]` | the full specification (all ~60 fields, localised), photo grid, documents, driver assign/unassign, edit, retire |
| `/[locale]/operator/drivers` | invite by phone, driver list with licence and verification badge, assign a vehicle to a verified driver |
| `/[locale]/staff/vehicles` | the two review queues with the documents inline, approve / reject-with-reason |

The wizard writes its draft to `localStorage` on every step change and restores it on mount, so a
reload or a locked phone does not cost nineteen filled fields. Nothing on any of these screens reloads
the page on its own.

### Mobile (`apps/mobile`)

`/driver/profile` — invitation → accept → verification badge → assigned vehicle (with a link);
`/driver/vehicle/[id]` — the quick view: plate, spec rows, badges, and whether the vehicle is
operational. Read-only by design: a driver confirms what they are about to drive, they do not edit the
fleet.

---

## 2. What was proven

| Check | Result |
|---|---|
| `npm test` | **301 passed** (16 files) — 29 new fleet assertions |
| `npm run sql:check` | 13 migrations applied · **192 pgTAP assertions** (9 + 9 + 35 + 75 + 64) · types in sync · no client write grants |
| `npm run check:a11y` | **30 routes**, both directions |
| `npm run check:guards` | 20 core files · 72 style files · 13 migrations · 35 commands |
| `npm run dev:check` | smoke checks, including sign-in, RLS reads and the gateway session gate |
| Lint / Prettier / typecheck / `build:functions` | clean (6 bundles) |

`supabase/tests/0005_fleet.test.sql` (64 assertions) pins the phase's promises:

1. plan limits are seeded and Basic really is **one** vehicle; a `0` limit is not "unlimited".
2. an unverified account is refused, and the gateway says `NOT_VERIFIED` (not `FORBIDDEN`).
3. all ~60 attributes round-trip: one assertion compares the whole `concat_ws(...)` of the row.
4. expired insurance, passenger seats > total seats and a future model year are refused; plates compare
   equal with or without spaces and dashes.
5. verification is a state machine — submitted → decided once, never self-approved, and re-opened by a
   substantive edit but not by a colour change.
6. the second vehicle on Basic raises `QUOTA_EXCEEDED: metric=vehicles limit=1 used=1`.
7. phone invitations survive a person who has not signed up yet; the same phone twice is refused.
8. one driver per vehicle: reassigning closes the previous row and keeps it in history.
9. RLS: the assigned driver sees the vehicle and its photos but **not** the documents; a verified
   stranger sees nothing; staff see what they review.
10. no `cmd_*` is executable by `authenticated`, while the RLS predicates are — and the quota internals
    and payload validator are not.

End-to-end through the running stack (cookie session → `/api/data` proxy → gateway → SQL):
create a 2019 Hiace with the full specification → three photos → submit with both documents → the staff
queue lists it → approve → the card shows **verified** and the insurance badge turns amber ("expires in
15 days") because the fixture expires inside the window; a second vehicle on Basic returns
`QUOTA_EXCEEDED` with the upgrade context; an unverified account gets `NOT_VERIFIED` from the gateway
**and** a disabled wizard on the page.

---

## 3. Honest gaps

- ⚠️ **Photos are uploaded from the browser and stored, but not resized.** A 4 MB phone photo is sent
  as-is; image processing belongs with the CDN/edge work, not in `cmd_*`.
- ⚠️ **The mobile driver screens are typed and linted, not run on a device** (no simulator here).
- ⚠️ **Only two document kinds are mandatory** (insurance, registration). Inspection and permit are
  stored and badged when present; whether they must be mandatory per governorate is a policy question.
- ⛔ **A driver cannot accept an invitation in the web app** — only on mobile (`/driver/profile`).
  The web console shows the pending state and the reason assignment is refused.
- ⛔ **`odometer_readings` has only the baseline.** Trip readings arrive with Phase 4; the table, the
  `kind` enum and the regression rule (`ODO_REGRESSION`) already exist.
- ⚠️ **`notification_kind` is a closed enum**: driver events reuse `member_invited` / `member_joined` /
  `verification_approved` / `verification_rejected`, because `alter type … add value` cannot run in the
  same transaction as the migration that would use it. A dedicated kind is a one-line follow-up
  migration.
- ⛔ **No plan-change UI.** `plan_limits` is read by the screens and the quota message explains the
  limit, but upgrading is Phase 11.

---

## 4. Decisions worth keeping

1. **Quota is a service, not a check.** `app.owner_plan(owner_user, owner_org)` is the single routing
   point and `app.assert_quota` reads usage live from the tables — there is no counter to drift and no
   place for a second opinion to exist.
2. **`NULL` means unlimited, `0` means none.** Encoding "unlimited" as a large number was rejected: it
   makes a paid tier look like a big Basic and hides a missing plan row.
3. **Warnings are warnings.** A duplicate plate, an unverified driver, expired insurance: each is
   returned in `warnings` and badged, never silently swallowed. Phase 4 decides what blocks a trip;
   `isVehicleOperational()` already answers it in one place.
4. **jsonb is serialised in one place.** Node's `pg` turns a JS array into a Postgres array literal, so
   passing `p_documents` as an array produced `22P02 invalid input syntax for type json`. `fleetCommandArgs()`
   now stringifies every jsonb argument, so the dev gateway and the Deno function cannot disagree.
5. **Revocation of a fleet privilege is ownership-scoped, not verification-scoped.** An owner whose
   account verification lapses can still retire a vehicle and correct its mileage — otherwise their
   worst day produces a fleet they cannot manage.
6. **`--reset` exists on `npm run dev`.** Editing an already-applied migration was invisible: the ledger
   records file *names*, so a changed file is neither re-run nor noticed. The flag drops and replays.

---

## 5. How to try it

```bash
npm run dev -- --reset      # database + API + web, migrations replayed
# sign in as owner@maak.test / Maak!2026 and open /ar/operator/vehicles
```

- `owner@maak.test` — verified, Basic, belongs to the demo organization (uses the organization context).
- `admin@maak.test` / `staff@maak.test` — the review queues at `/ar/staff/vehicles`.
- `new@maak.test` — unverified: the wizard is disabled and the gateway answers `NOT_VERIFIED`.

---

## 6. Defects found and fixed while building this phase

| # | Defect | Now prevented by |
|---|---|---|
| 1 | `NEXT: is_assigned_driver` was revoked from `authenticated`, so every `select` on `vehicles` failed with `42501` inside its own RLS policy | §10 of `0005_fleet.test.sql` asserts the predicates are executable by `authenticated` while the internals are not |
| 2 | Submitting documents failed with `22P02` because a JS array reached a `jsonb` parameter | `fleetCommandArgs()` serialises jsonb; a unit test asserts `p_documents` is a string |
| 3 | An unverified account got `FORBIDDEN` from the gateway but `NOT_VERIFIED` from SQL — two different messages for one rule | `policyDenial()` in core, used by both gateways; fleet unit test + pgTAP |
| 4 | A future-dated plate/insurance edit re-opened verification but kept `verified_by`/`verified_at`, so the audit named the wrong approver | `cmd_update_vehicle` clears both; pgTAP asserts they are `NULL` |
| 5 | Staff were notified when a vehicle was **created**, before there was anything to review | the notification moved to `cmd_submit_vehicle_verification` |
| 6 | An empty `<input type="date">` submitted `''`, which failed the date regex and turned a cleared optional field red | `isoDate` accepts `''` → `null`; unit test |
| 7 | The dev storage handler ignored the `public/` and `authenticated/` URL prefixes, so a real Supabase photo URL 404'd locally | `handleStorage` strips the access prefix and allows public reads without a session |
| 8 | The fleet list silently showed only the organization's vehicles, with no way back to a personal one | a context switcher on both fleet screens |
