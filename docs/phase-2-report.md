# Phase 2 — Geography, places & supervisor scoping

**Date:** 2026-10-30 · **Branch:** `arena/736770c1-maak` · **Spec:** `specs.md` v1.2 · **Plan:** `IMPLEMENTATION_PLAN.md`

Phase 2 gives Maak a geography that is *relational first*: 22 governorates, districts, places, and
admin-built regions that can contain whole governorates and/or hand-picked districts. Supervisor
scope is derived from those regions, never trusted from a token.

Legend: ✅ verified in this environment · ⚠️ code complete, needs Docker/device or external data · ⛔ not done

> **Review pass (2026-10-30).** After the first cut of this phase was merged into the branch, the
> phase was reviewed again end-to-end. Fourteen defects and dead-ends were found and fixed; §6 lists
> them with the test or guard that now prevents a repeat. Numbers below are post-review.

---

## 1. What was built

### Database (4 migrations, 8 commands, 1 RPC)

| Object | Purpose |
|---|---|
| `governorates` | 22 rows, ISO 3166-2 code as the import key, optional centre point |
| `districts` | starter set with `governorate_id`, optional `pcode`, generated normalised names |
| `places` | cities, towns, stations, landmarks, airports… plus user **gathering points**; `is_public`, `verification_status`, `created_by(_org)`, aliases |
| `regions` + `region_kind` | self-referencing tree (`region` / `sub_region`), unique name per parent |
| `region_governorates`, `region_districts` | coverage: whole governorates **and** extra districts, both replaced wholesale on update |
| `geo_assignments` | supervisor ↔ region, soft-revoked (`revoked_at`) so the history survives |
| `app.normalize_arabic`, `app.normalize_aliases` | IMMUTABLE Arabic folding (أإآٱ→ا, ة→ه, ى→ي, ؤ→و, ئ→ي, no harakat/tatweel, Arabic-Indic→Western digits, lower-case Latin, single spaces) |
| `app.assert_place_geography` | trigger: a district must exist; if a governorate is also given it must match; a district-only insert **fills** the governorate |
| `app.assert_region_depth` | trigger: at most three levels, and cycles are rejected |
| `app.region_descendants`, `app.geo_scope_districts`, `app.in_geo_scope(_gov)`, `app.geo_scope_size` | scope helpers (recursive, cycle-safe), `service_role` only |
| `public.search_places` | the **only** client-executable geography function: ranked, locale-aware, private places only for their creator |
| `cmd_upsert_region` | create/update a region and replace its coverage in one transaction |
| `cmd_assign_geo_supervisor` / `cmd_revoke_geo_supervisor` | reconcile the full region list; grant `geo_supervisor` on first assignment |
| `cmd_create_place` | staff → public + verified; everyone else → private + `pending` |
| `cmd_decide_place` | staff approve/reject (rejection needs ≥10 characters), notifies the submitter |
| `cmd_import_geo` | governorates/districts import, **dry-run by default**, ≤2000 rows, idempotent |
| `cmd_set_region_active` | retire / restore a region; refuses while active sub-regions depend on it, notifies the supervisors who lose scope |
| `cmd_set_place_active` | retire / restore a place; staff may retire anything, a user only the pin they created |

Indexes: GIN trigram on `name_ar_norm`, `name_en_norm`, `aliases_norm` (aliases are flattened into a
scalar generated column — `gin_trgm_ops` does not accept `text[]`), plus btree on every scope join.

PostGIS is created **only if available** (`create extension if not exists postgis` + a notice). It is
optional by design: scope is a set of district ids, so no polygon can widen it, and coordinates are
plain `double precision` until maps arrive.

### Shared brain (`packages/core/src/domain/geo.ts`, 27 assertions)

`normalizeArabic`, `scorePlace`, `trigramSimilarity`, `rankPlaces`, `haversineKm`, `isWithinYemen`,
`formatDistanceKm`, `validateCoverage`, `expandCoverage`, `descendantRegionIds`, `supervisorScope`,
`inScope`, `boundingBox`, `reducePicker`, `isSelectionComplete`.

Ranking is pinned in both places: exact 100 / prefix 80 / substring 60 / trigram ≥0.4 → ×55, with a
kind bonus added **after** the cap (city 6 beats station 1 on a tie).

### Edge gateway (`supabase/functions/geography`)

One function, one `action` discriminator, one `cmd_*` per request. The command → argument mapping
lives in `geoCommandArgs()` in `@maak/core`, so the gateway cannot drift from the tests. Policy is
checked twice (gateway matrix + SQL), and rate limits are applied per action.

### Web + mobile

| Surface | What it does |
|---|---|
| `/ar|en/admin/regions` | region tree with coverage counts, builder (name AR/EN, kind, parent, governorate + district checkboxes), supervisor assignment with a live scope count |
| `/ar|en/admin/places` | staff review queue (approve / reject with a reason), "add a place" form, and the picker |
| `<PlacePicker>` (web) | cascading governorate → district → place, AR/EN trigram search through `search_places`, custom name, `reducePicker` state machine |
| `apps/mobile/src/app/places.tsx` | the same picker on native using the **same** `reducePicker` / `rankPlaces` |

Both directions are exercised by the a11y smoke (22 routes, RTL + LTR).

---

## 2. What was proven

| Check | Result |
|---|---|
| `npm test` | **268 passed** (15 files) — 29 geo + 23 geography-API + 2 i18n assertions added |
| Coverage | 97.2% statements · 90.9% branches · 98.9% functions |
| `npm run sql:check` | 11 migrations applied · **120 pgTAP assertions** (9 + 9 + 35 + 67) · types in sync |
| `npm run check:a11y` | 22 routes, both directions |
| `npm run check:functions` | 5 edge bundles, hash-verified |
| Lint / Prettier / typecheck / guards | clean |

The new pgTAP suite (`supabase/tests/0004_geography.test.sql`, 67 assertions) pins the promises that
matter: normalisation parity with TypeScript, 22 governorates with codes, the district↔governorate
trigger, a private gathering point invisible to other users *and* to guests and search, exact-match
ranking and limit clamping, depth ≤3 and cycle rejection, coverage replacement, scope expansion
(governorate ⊕ extra districts), immediate revocation, staff-only decisions with a reason, dry-run
imports, and `42501` when a client session calls any `cmd_*`.

---

## 3. Honest gaps

- ⚠️ **Districts are a starter set (29), not the official 333.** Aden (8), Amanat Al Asimah (8),
  Hadramaut (5) and towns in Taiz, Lahij, Marib, Abyan, Shabwah and Hudaydun. `pcode` is filled only
  where certain. The complete list comes from OCHA via
  `node scripts/geo/import-districts.mjs --file ocha-districts.csv` → `geo.import` (dry run → apply →
  re-run expecting `+0 ~0 -0`). No data is invented to look complete.
- ⚠️ **Places are a starter set (29)**, not the ~200 curated places the plan mentions. Shortlisting
  real POIs is content work, not code.
- ⛔ **MapLibre map component** is not built. Coordinates are stored and validated (`isWithinYemen`)
  and the picker works without a map; the map lands with live tracking (Phase 6) where it is needed.
- ⛔ `app.trip_in_scope()` and `trip_scope_index` wait for the `trips` table (Phase 4). The scope
  helpers they will call already exist and are tested.
- ⚠️ **Place retirement has no button yet.** `cmd_set_place_active` is complete and tested, but the
  web surface only exposes it for regions; retiring a reference place currently needs the gateway
  (staff tooling lands with the Phase 7 staff console).
- ⚠️ PostGIS geometry columns and a GIST index are not exercised here (no PostGIS in the embedded
  harness); the migration guards them behind an availability check.

---

## 4. Decisions worth keeping

1. **Scope is relational.** A district set, expanded from regions, is indexable, testable, and cannot
   be widened by a bad polygon. Geometry is for maps and distance only.
2. **Coverage is replaced, never merged.** A partial update is how a region ends up covering half a
   district, so `cmd_upsert_region` deletes and re-inserts the coverage rows in the same transaction.
3. **Validation on both sides, one definition.** `validateCoverage()` decides what the form allows; the
   SQL rejects what the form should never have sent. The same is true of Arabic normalisation, which
   is compared against pinned expectations in both suites.
4. **Revocation is a soft delete.** Assignments keep `revoked_at`/`revoked_by`, scope is computed on
   read, and nothing is cached — so revocation is immediate *and* auditable.
5. **Users may add pins, not reference data.** A verified account creates a private, pending
   `gathering_point`; staff promote it. That keeps the shared reference trustworthy without blocking
   the trip that needed the pin today.

---

## 5. How to continue the import

```bash
npm run geo:import -- --file ocha-districts.csv --out districts.json   # validate + build payload
# POST districts.json to /functions/v1/geography as a platform admin (dryRun: true)
# inspect added / updated / skipped, then set "dryRun": false and POST again
```

Then re-run `npm run sql:check` (it re-seeds from migrations) and open `/admin/regions` to build the
first real regions.

---

## 6. Review pass — what was wrong and what changed

Each item is a defect or a dead-end found by re-reading the phase after it "passed", plus the
mechanism that now stops it from coming back.

| # | Problem | Fix | Prevented by |
|---|---|---|---|
| 1 | Three notification keys written by SQL (`notifications.geoAssigned`, `.placeApproved`, `.placeRejected`) did not exist in either dictionary, so the bell rendered raw keys | added all three + `placePending` in `ar` and `en` | new guard #7 scans every `notifications.*` literal in migrations against `dictionaries.ts`; two unit assertions pin the list |
| 2 | A `cmd_*` name typo would have been a runtime 500 | — | new guard #8 resolves every `cmd_*` string in `packages/core/src/api` and `supabase/functions` against the migrations |
| 3 | **The region builder could not create the acceptance-criterion region** (6 governorates + 4 districts from *another* governorate): districts were only offered under selected governorates | coverage is now two independent lists; the district panel browses any governorate and marks already-covered ones | core test `builds a region from 6 governorates plus 4 districts from elsewhere` |
| 4 | The picker showed *nothing* until you typed, because an empty query scored 0 — a user could never pick a place in preview mode | browse mode in `rankPlaces()` **and** `search_places` (empty query → filtered, ordered by kind then name) | unit test + pgTAP `an empty query browses a governorate instead of returning nothing` |
| 5 | Place kinds rendered as raw enum text (`gathering_point`) | `PLACE_KIND_KEY` in core + 13 localised labels per locale | i18n test asserts every kind key exists in both dictionaries |
| 6 | A verified account could create a `city`/`airport` — reference data drifting away from staff control | `cmd_create_place` rejects non-user-creatable kinds for non-staff | pgTAP `a verified account cannot invent a reference city` |
| 7 | Submitting a pin notified nobody | `cmd_create_place` notifies the submitter that it is queued | pgTAP assertion on `notifications.placePending` |
| 8 | `DISTRICT_OUTSIDE_GOVERNORATE` was named as if a district had to belong to a *selected* governorate — which contradicts the feature (it really meant "the district's governorate is unknown") | renamed `DISTRICT_GOVERNORATE_UNKNOWN`, with the rule spelled out in the doc comment | the 6+4 test above |
| 9 | **Regions and places could never be retired**, while `regions` is unique on (parent, name) — a typo permanently occupied a name and a wrong place stayed in every picker | `cmd_set_region_active` / `cmd_set_place_active` (soft, audited, idempotent; region refuses while active children exist) | pgTAP section 8b (7 assertions) |
| 10 | Retiring a region would have hidden it from the loader, making reactivation impossible — the same dead-end one screen later | loader returns retired regions too (`isActive`), UI lists them separately with a reactivate action | `/admin/regions` renders both sections; typecheck enforces the flag |
| 11 | Supervisor scope was computed over **inactive** regions in the loader, disagreeing with `app.geo_scope_districts` | loader filters to active regions before `supervisorScope()` | same code path as the pgTAP scope assertions |
| 12 | Supervisor assignment looked blank for an existing supervisor, so re-saving silently revoked the regions not re-checked | selecting a user loads their current regions; revoke clears the checkboxes | reconcile semantics already covered by pgTAP `re-assigning reconciles` |
| 13 | `staff_place_queue()` was a service-role-only RPC that nothing called (the loader reads the queue through RLS) — surface without a purpose, and staff RLS visibility was untested | removed the RPC; the queue is read via `places_read_staff`, which is now asserted for staff *and* non-staff | pgTAP `staff see the pending user submission through RLS` / `a non-staff account sees no pending place` |
| 14 | Five Phase 2 i18n keys were never referenced | deleted from both dictionaries | parity test + `keyParity()` |

Not changed, deliberately: the starter district/place data (§3) — inventing 300 district names to
look complete would be worse than importing the real list, which now has a tested path.

---

## 7. Second review pass — three defects and one broken dev loop

Found by re-reading the commands against their own contract, then confirmed against a live database
before changing anything. Each row names the check that now fails if it comes back.

| # | Problem | Evidence | Fix | Prevented by |
|---|---|---|---|---|
| 15 | **`cmd_decide_place` decided a place that was already decided.** Approving twice audited twice and notified twice; approving a *rejected* place resurrected it with no record of why. `cmd_decide_verification` had refused this since Phase 1 | read: no status guard, unlike `cmd_decide_verification` | refuses anything not `pending`, `CONFLICT` 409 | pgTAP `a place that has already been decided cannot be decided again` + `the refused second decision left no second audit row` |
| 16 | **A duplicate name reached the user as `INTERNAL`** with `duplicate key value violates unique constraint "regions_name_unique"` in it — the gateway did not even recognise the code | live request: `{"code":"INTERNAL","detail":"duplicate key value…"}` | `cmd_upsert_region` / `cmd_create_place` name the clash (`DUPLICATE_REFERENCE`, 409) and return the existing id in `detail`; the mappers map a bare `23505` too | pgTAP duplicate-name assertions; unit tests for `errorCodeFromMessage` and `errorKey('DUPLICATE_REFERENCE')` |
| 17 | **Organization verification was ignored where an org owns something.** `cmd_create_place` checked membership and never `org_is_verified`, so an unverified — even rejected — company could own reference data the picker treats as legitimate | live call with the seeded company flipped to `pending`: **accepted** | `app.org_can_own(org, actor)` (membership **and** org verification) and a `NOT_VERIFIED` gate in `cmd_create_place` | pgTAP `a verified member cannot create a place for an unverified organization` / `once the organization is verified, the same call succeeds` |
| 18 | **Adding a migration broke `npm run dev` on an existing cluster.** The schema marker was one fingerprint over the whole file list, so a new file re-ran every earlier migration and died on `relation "log" already exists` — the dev stack would not start exactly when a schema change needed testing | reproduced by adding `00012` and restarting | per-file ledger (`dev.meta.applied_files`), with a backfill from the old comma-joined marker | the stack now starts on a new migration; `dev.meta` is dev-only |

Not changed, deliberately: `cmd_decide_place` still refuses a *rejected* place outright. A rejected
submission that becomes acceptable is a new submission; allowing approve-after-reject would make "why
did this come back?" unanswerable from the audit trail.

### One definition of an error

The two gateways each kept their own code→status table (`STATUS_BY_CODE` in the dev harness,
`known` in the edge function) and they disagreed: `DUPLICATE_REFERENCE` existed in one and not the
other, so the same failure was a documented 409 in production and a 500 in dev. Both now read
`HTTP_STATUS_BY_CODE` and `errorCodeFromMessage()` from `@maak/core`, and the parser is anchored at the
start of the message so a detail that merely mentions a code cannot be reclassified.
