# Phase 2 — Geography, places & supervisor scoping

**Date:** 2026-10-30 · **Branch:** `arena/736770c1-maak` · **Spec:** `specs.md` v1.2 · **Plan:** `IMPLEMENTATION_PLAN.md`

Phase 2 gives Maak a geography that is *relational first*: 22 governorates, districts, places, and
admin-built regions that can contain whole governorates and/or hand-picked districts. Supervisor
scope is derived from those regions, never trusted from a token.

Legend: ✅ verified in this environment · ⚠️ code complete, needs Docker/device or external data · ⛔ not done

---

## 1. What was built

### Database (3 migrations, 6 commands, 1 RPC)

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
| `npm test` | **260 passed** (15 files) — 27 geo + 19 geography-API assertions added |
| Coverage | 97.43% statements · 90.88% branches · 98.93% functions |
| `npm run sql:check` | 10 migrations applied · **108 pgTAP assertions** (9 + 9 + 35 + 55) · types in sync |
| `npm run check:a11y` | 22 routes, both directions |
| `npm run check:functions` | 5 edge bundles, hash-verified |
| Lint / Prettier / typecheck / guards | clean |

The new pgTAP suite (`supabase/tests/0004_geography.test.sql`, 55 assertions) pins the promises that
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
