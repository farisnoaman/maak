# Maak — Implementation Plan (Phased)

Companion to [`specs.md`](./specs.md) (v1.1). **Thirteen phases**, each independently shippable.
We build **one phase at a time**: I code it on this branch → you review the running preview →
we merge → next phase starts.

```
Phase 0   Foundations            ── monorepo, CI, design tokens, bilingual routing (AR/EN), auth shell
Phase 1   Identity & Trust       ── individuals, companies, staff, roles, verification
Phase 2   Geography & Places     ── regions, governorates, districts, POI, supervisor scoping
Phase 3   Fleet                  ── vehicles (~60 fields), drivers, assignments, verification
Phase 4   Trips & Marketplace    ── create/publish trips, pricing, public search + cascading filters
Phase 5   Bookings               ── passenger data, ID docs, WhatsApp, accept/reject/cancel
Phase 6   Live Execution         ── start/end + ODO, 10-min pings, progress, passenger live view
Phase 7   Staff Operations       ── QR scan, bulk verification, A4 manifest, historical search
Phase 8   Vehicle Operations     ── fuel, maintenance, auto schedules, fleet dashboards
Phase 9   Payments               ── cash / e-wallet / agent / bank deposit, accounts registry, proofs
Phase 10  Finance & Subscriptions── double-entry ledger, invoices, payouts, statements, Basic/Pro/Business
Phase 11  Notifications & Polish  ── push/email/WA, preferences, saved-search alerts, i18n QA
Phase 12  Hardening & Launch      ── perf, security, stores, runbooks, UAT
```

**Estimated effort (one experienced full-stack dev, focused): ~19–20 weeks.**
Phases 0–6 (~11 weeks of that) already deliver a usable product: publish → search → book → verify →
run → track. Phase 9 (payments) can run in parallel with 8; Phase 10 depends on 3, 4 and 9.

---

## Architecture convention (applies to every phase below)

Stack: **Next.js (web)** + **Expo (mobile)** + **`@maak/core` (framework-free TypeScript)** +
**Supabase Edge Functions (the only write path)** + **Postgres** (RLS for reads, atomic `cmd_*` functions).

Where the task lists say *"Commands (edge fn + atomic `cmd_*` SQL)"*, each command means:

```
supabase/functions/<domain>-<action>/index.ts   thin handler:
    1. supabase.auth.getUser()  → actor (profile, orgs, roles, plan)
    2. zod parse (schema from @maak/core) → 400 with field errors
    3. assertPolicy('<domain>.<action>', actor, input)   pure TS, Vitest-tested
    4. compute in core: price() · refund() · commission() · journalEntries() · assertQuota()
    5. exactly ONE db.rpc('cmd_<domain>_<action>', payload)  → atomic, all-or-nothing
    6. shape response via zod response schema; audit row written inside the transaction
```

Rules that every phase must respect:
- **No client write grants.** `anon`/`authenticated` get `SELECT` (RLS-filtered) only.
- **One command = one transaction.** Never two `db.rpc()` calls in one handler (lint + review + test).
- **Business math in `packages/core`, never in SQL.** SQL only asserts invariants and writes atomically.
- **Reads bypass the gateway** (PostgREST + RLS): cheap, cacheable, no business logic allowed.
- **Validation is deliberately redundant:** zod (good UX errors) + DB constraints (last line of defense).
- **Client prices are claims, not facts:** the command recomputes the fare from trip/stop rows and rejects
  mismatches with `PRICE_CHANGED` (ADR-24).
- **Geometry in PostGIS, money in TypeScript.** No distance math in Deno; no ledger math in SQL (ADR-22).
- **Bundle before deploy:** `npm run build:functions` inlines `packages/core`; deploying unbundled fails CI
  (ADR-21). Full rationale: `docs/adr/0001-backend-architecture.md`.

## Working agreement

1. **Kick-off (me):** restate the phase scope + the exact acceptance tests I will run.
2. **Build (me):** migrations → commands (edge + atomic SQL) → Vitest → pgTAP → core → web UI → mobile UI → both locales.
3. **Demo (you):** I run the app on a live preview, seed demo data, post a walkthrough + screenshots
   (Arabic and English).
4. **Review:** you test the acceptance checklist. Changes stay inside the same phase.
5. **Gate:** merge `phase-N: <name>` → I tick the tracker below → next phase starts.

**Definition of Done for every phase**
- Green CI: typecheck, lint (module boundaries + RTL + i18n parity), **Vitest**, pgTAP, Playwright smoke
  (ar + en), `supabase db diff` empty, generated types in sync, **no `service_role` string in any client bundle**.
- Every command has a unit test (authorization + validation) and an integration test (rows + balanced journal + audit).
- Every new user-facing string exists in **both** `ar.json` and `en.json`; every screen verified in RTL **and** LTR.
- Migrations are forward-only and re-runnable; seeds idempotent.
- `specs.md` updated if reality changed; one-paragraph changelog appended here.

---

## Phase 0 — Foundations & Scaffold (web + mobile + bilingual shell) ✅

**Status: complete (audited 2026-10-28).** Evidence: [`docs/phase-0-audit.md`](./docs/phase-0-audit.md).

**Goal:** a running skeleton on web + mobile with the cost-saving architecture *and* the bilingual
foundation baked in from the first commit (RTL retrofits are the expensive kind).

### Deliverables (as built)

- **npm workspaces monorepo** (as-built note 1): `apps/web`, `apps/mobile`, `packages/core`,
  `packages/design-tokens`, `packages/config`.
- **`packages/core`** — framework-free TypeScript, 117 Vitest assertions:
  `domain/{money,ledger,pricing,finance,policy}.ts`, `api/{client,errors,gateway}.ts`
  (the gateway's origin/body/write-guard rules are pure and tested), `i18n/{locale,dictionaries}.ts`
  with compile-time key safety, `format.ts` (money/date/number, AR/EN, numerals, `<bdi>`).
- **Next.js 16** (App Router, TS strict) with locale-prefixed routes `/{locale}`, `ar` default,
  `hreflang`, locale-preserving switch, `dir` on `<html>`, and a `proxy.ts` that both negotiates the
  locale and refreshes the Supabase session.
- **Design tokens → CSS custom properties** (as-built note 3) shared with mobile via the same scales;
  Arabic (Cairo/IBM Plex Sans Arabic) + Latin (Inter); **logical-property-only** styles enforced by
  ESLint **and** the guard script.
- **UI primitives**: `Button`, `Field`, `Select`, `Dialog`, `Toast`, `Skeleton`, `EmptyState`,
  `Badge`, `DirectionalIcon`, plus a `/[locale]/styleguide` page reviewed in both directions.
- **Edge gateway** (`supabase/functions/_shared/`): `handler.ts` (POST-only, CORS allow-list,
  256 KB cap, zod, `required | optional | public` auth), `auth.ts`, `actor.ts` (roles re-read per
  request), `db.ts` (single-write guard), `ratelimit.ts` (Postgres sliding window), `audit.ts`
  (denied requests), `errors.ts`, `cors.ts`. Reference commands: `health` + `me`.
- **Database** (CLI-native `supabase/migrations`): 5 migrations — schemas/extensions, append-only
  audit log, client-write lockdown with default privileges, identity core + RLS, rate limits.
- **Auth shell**: SSR cookie client, browser client, mobile SecureStore client with chunked storage,
  sign-in (email/password + phone OTP) on web and mobile, protected-route redirect with `?next=`,
  account page re-checking the session server-side.
- **App shells**: public site, operator/staff/admin console shells, mobile sign-in screen.
- **Function bundling** (`npm run build:functions`): esbuild inlines `packages/core` + `_shared`;
  `--check` compares hashes so a stale bundle cannot ship (ADR-21).
- **ESLint + Prettier** with four custom architecture rules (`core-is-framework-free`,
  `no-physical-direction`, `no-hardcoded-copy`, `single-write-per-handler`).
- **Error handling**: localized `error.tsx`, `not-found.tsx`, `loading.tsx`, `global-error.tsx`,
  and `lib/monitoring.ts` (PII-redacting reporter; Sentry is a drop-in transport).
- **Types**: `lib/supabase/database.types.ts` stamped with a hash of the migrations;
  `npm run db:types:check` fails on drift.
- **CI** (`docs/ci/ci.yml`): guards → lint → format → typecheck → coverage → types drift →
  bundle → build, plus pgTAP (Docker), security scan and an accessibility job. PR template +
  phase checklist in `docs/ci/pull_request_template.md`.

### As-built notes (deliberate deviations)

1. **npm workspaces, not pnpm + Turborepo.** npm ships with Node; the pipeline is 12 named scripts and
   runs in ~30 s. Turborepo can be added later without changing any package — the cost today is
   another tool to keep current.
2. **Own typed i18n instead of `next-intl`.** Zero runtime dependency, compile-time key safety,
   parity enforced in tests. Swapping to `next-intl` later is mechanical because every string already
   lives in `packages/core`.
3. **CSS custom properties instead of Tailwind/NativeWind.** RTL correctness is visible and auditable;
   no build plugin to fight. Tailwind (or NativeWind) can consume the same tokens later.
4. **`app.uid()` instead of `app.current_profile_id()`** — same purpose, shorter name, one helper.

### Acceptance criteria — verified

| Criterion | Result |
|---|---|
| Unit tests pass offline, no database, < 2 s | ✅ 117 tests, ~1.0 s |
| `/ar` and `/en` render with correct `dir`, fonts, copy | ✅ `<html lang="ar" dir="rtl">` / `lang="en" dir="ltr"` |
| Locale switch keeps path + query | ✅ client switch rewrites the first segment only |
| Bad JWT on `health` → 401; `me` → actor payload | ✅ `auth: 'optional'` rejects a presented-but-invalid token (unit-tested rules) |
| Second `db.rpc()` fails a unit test **and** the lint rule | ✅ `gateway.test.ts` + `maak/single-write-per-handler` |
| `anon`/`authenticated` cannot INSERT/UPDATE/DELETE | ✅ pgTAP `0001_write_lockdown.test.sql` + `app.audit_client_write_grants()` |
| CI fails on missing i18n key / physical CSS / `service_role` in bundle / framework import in core / stale bundle / types drift | ✅ six checks, each verified by injecting a violation |
| `packages/core/src/domain/**` ≥ 90% lines; `policy.ts` ≥ 95% | ✅ domain 100% lines; `policy.ts` 100% lines / 97.2% statements |
| Lighthouse a11y ≥ 95 both directions | ⚠️ Lighthouse needs Chrome; replaced by `npm run check:a11y` (lang/dir, single `h1`, landmarks, labels, skip link, no empty controls) on 8 routes — **manual Lighthouse still recommended** |
| ≤ 200 KB initial JS | ⚠️ measured after the production build; see audit doc |

**Estimate:** 7 days (actual: 1 working session, mostly because the guards caught issues early).

---

## Phase 1 — Identity, Accounts & Verification ✅

**Status: complete (audited 2026-10-28).** Evidence: [`docs/phase-1-report.md`](./docs/phase-1-report.md).

**Goal:** real multi-tenant identity — individuals, companies, staff, roles — and the verification workflow
that gates everything else (BR-01..03).

### Deliverables
- Tables: `profiles`, `organizations`, `organization_members`, `user_roles`, `verification_requests`, `audit_log` policies.
- Onboarding: individual verification submit; company creation + verification submit; team invites (phone/email).
- Account switcher (personal ↔ company) with server-evaluated permissions.
- Verification console (platform staff): queue, filters, document viewer, approve/reject with reason, audit trail.
- Role grants (admin only): `platform_staff`, `finance_officer`, `geo_supervisor` (scope in Phase 2).
- Helpers: `app.is_verified_actor()`, `app.has_role()`, `app.my_orgs()`, `app.owner_effective_plan()` **stub**
  returning Basic defaults (activated properly in Phase 10 — no retrofit later).
- Shared `useSession()`, `useActiveAccount()`, `<Can/>`, `<VerifiedBadge>`, localized permission messages.
- Mobile: sign-in, profile, verification submission with camera capture.

### Tasks
- [x] Migrations: profiles/orgs/members/user_roles/verification_requests + enums + indexes + `updated_at` triggers.
- [x] RLS on every table + pgTAP matrix (anon, unverified, verified, org member, staff, finance, admin) — 23 assertions in `supabase/tests/0003_*` (needs Docker to run).
- [x] Commands (edge fn + atomic `cmd_*` SQL): `submit_verification`, `decide_verification`, `create_organization`, `update_organization`,
      `invite_member`, `accept_invite`, `remove_member`, `grant_role`, `revoke_role`, `set_preferred_locale` (+ `update_profile`, `mark_notifications_read`).
- [x] Storage `avatars` (public) + `verification-docs` (private) + policies + signed URL helper (`verification-queue`).
- [x] Notifications table + in-app list with mark-all-read (channels wired Phase 11).
- [x] Web: verification wizard, company settings, team management, `/staff/verifications`, `/admin/users` (roles inline).
- [x] Mobile: profile, verification upload with camera capture, company list.
- [x] Locale preference persisted on profile (`cmd_set_preferred_locale`) and used by the gateway on every request.
- [~] Fixtures: the preview dataset covers the personas for UI review; real seeds need `auth.users` rows, so they live in pgTAP, not `seed.sql`.

### Acceptance criteria
- Unverified user sees "add vehicle / create trip" disabled **and** the RPC returns `NOT_VERIFIED` when called directly.
- Company owner invites a manager → invitee accepts → can switch context → permissions differ correctly.
- Staff approve a profile → verified badge appears without reload; notification row created; audit row has actor + reason.
- Revoked verification immediately blocks all gated actions.
- Every screen of this phase renders correctly in `ar` (RTL) and `en` (LTR); no hardcoded strings in diffs.
- pgTAP: an unverified user cannot read another user's verification documents.

**Evidence:** [`docs/phase-1-report.md`](./docs/phase-1-report.md) — 214 unit tests, 53 pgTAP
assertions executed against a real PostgreSQL (`npm run sql:check`), 18 a11y routes, 4 edge bundles.

**Estimate:** 7 days.

---

## Phase 2 — Geography, Places & Supervisor Scoping

**Goal:** the places component for all of Yemen, admin-managed, plus region/sub-region scoping.

### Deliverables
- ✅ `regions` (self-referencing, depth ≤3, cycle-safe), `governorates`, `districts`, `places`,
  `region_governorates`, `region_districts`, `geo_assignments`.
- ⚠️ Seed: all **22 governorates** + a *starter* set of 29 districts and 29 places (idempotent). The
  full 333-district OCHA list is imported with `scripts/geo/import-districts.mjs`; it is not shipped.
- ✅ Admin console: region builder (governorates and/or districts), coverage replacement, supervisor
  assignment, place-verification queue, CSV import with a dry-run diff.
- ✅ Shared `<PlacePicker>` (web + mobile): AR/EN trigram autocomplete with Arabic normalisation,
  aliases, governorate→district cascade, custom gathering point creation.
- ⛔ MapLibre map component (point selection by search works; the map arrives with Phase 6 tracking).
- ✅ `app.in_geo_scope()`, `app.geo_scope_districts()`, `app.region_descendants()`. `app.trip_in_scope()`
  and `trip_scope_index` wait for the `trips` table (Phase 4).

### Tasks
- [x] PostGIS (guarded, optional) + trigram indexes on `name_ar_norm` / `name_en_norm` / `aliases_norm`
      (aliases are flattened into a generated column: `gin_trgm_ops` rejects `text[]`).
- [x] Import helper `scripts/geo/import-districts.mjs` (OCHA CSV → validated `geo.import` payload,
      dry-run by default). Governorates are static in the seed; curated places are still starter data.
- [x] Commands (edge fn + atomic `cmd_*` SQL): `search_places` (RPC), `cmd_upsert_region`,
      `cmd_assign_geo_supervisor`, `cmd_revoke_geo_supervisor`, `cmd_create_place`, `cmd_decide_place`,
      `cmd_import_geo` (dry-run + apply), `cmd_set_region_active`, `cmd_set_place_active`.
      Coverage replacement is part of `cmd_upsert_region`.
- [x] Admin UI `/admin/regions` (tree + builder + supervisors + retire/restore) and `/admin/places`
      (review queue, add-place form, picker). `nearest_place` is deferred to the map work in Phase 6.
- [x] `<PlacePicker>` (web) + native `/places` screen sharing `reducePicker` / `rankPlaces` /
      `search_places`; labels stay in the RTL flow, numbers and coordinates are `<bdi>`-safe.
- [x] Scope helpers + pgTAP (55 assertions): scope expansion, immediate revocation, private places,
      depth/cycle rejection, dry-run imports, and `42501` for client-called commands.

### Acceptance criteria
- Typing «عدن» returns governorate, districts and POIs; typing «الحوطة» disambiguates by governorate; same in English.
- Arabic search tolerates hamza/alef/teh-marbuta variants and missing diacritics.
- Admin creates «إقليم المرتفعات» with 6 governorates + 4 extra districts from another governorate; supervisors assigned.
- A supervisor scoped to Aden sees only Aden-intersecting trips (fixtures prove it); out-of-scope returns empty.
- Re-running the districts import changes nothing (`+0 ~0 -0`).
- Place picker and admin tree render correctly in RTL and LTR; map controls mirrored but map itself is not.

**Evidence:** [`docs/phase-2-report.md`](./docs/phase-2-report.md) — **268 unit tests**, **120 pgTAP
assertions** executed against a real PostgreSQL (`npm run sql:check`), 22 a11y routes, 5 edge bundles.
A post-merge review pass (§6 of the report) fixed 14 defects, including a region builder that could
not build the acceptance-criterion region and reference data that could never be retired.

**Estimate:** 7 days.

---

## Phase 3 — Fleet: Vehicles & Drivers

**Goal:** the full vehicle specification, driver profiles, verification and assignments.

### Deliverables
- `vehicles` (~60 attributes: identity, mechanical, capacity, comfort, safety/compliance, accessibility,
  appearance, media, operational), `vehicle_photos`, `driver_profiles`, `vehicle_driver_assignments`,
  `odometer_readings` (baseline).
- Vehicle wizard (7 steps, resumable) with photo upload, document-expiry checks, plate duplicate warning.
- Driver management: invite by phone, licence capture, verification, assign/unassign to vehicles.
- Staff vehicle/driver verification queues with document viewer and audited decisions.
- Vehicle cards with badges (verified, insurance/inspection expiring, maintenance placeholder).
- **Quota hook wiring:** `create_vehicle` and `invite_driver` call `app.assert_quota()` (Basic defaults active
  from day one; Pro/Business values switched on in Phase 10).
- Mobile: driver profile + licence upload, vehicle quick view.

### Tasks
- [ ] Migration (~60 columns) + enums (`drive_type`, `transmission`, `fuel_type`, `body_type`, `vehicle_status`)
      + constraints (year range, seats > 0, VIN length when present).
- [ ] RLS: owner/org isolation; staff read-all; verification-gated writes.
- [x] Commands (edge fn + atomic `cmd_*` SQL): `create_vehicle`, `update_vehicle`, `submit_vehicle_verification`, `decide_vehicle_verification`,
      `invite_driver`, `accept_driver_invite`, `verify_driver`, `assign_driver_to_vehicle`, `set_vehicle_status`.
- [ ] Storage `vehicle-photos` (public) + `vehicle-documents` (private) policies.
- [ ] Web `/operator/vehicles` (list, wizard, detail), `/operator/drivers`, `/staff/vehicles`.
- [ ] Mobile `/driver/profile`, `/driver/vehicle/[id]`.
- [ ] pgTAP: unverified cannot insert vehicle; org A cannot read org B vehicles; Basic owner blocked at 2nd vehicle.

### Acceptance criteria
- Verified individual registers a 2019 Toyota Hiace with full trim/mechanical/comfort data, 3 photos, insurance
  doc → staff approves → badge flips verified. All fields round-trip create→detail→edit.
- Unverified account: UI disabled **and** `NOT_VERIFIED` from the RPC.
- Basic-plan owner adding a 2nd vehicle gets `QUOTA_EXCEEDED { metric: vehicles, limit: 1 }` with an upgrade payload.
- Driver invited → logs in on mobile → sees the assigned vehicle.
- Expiring insurance fixture shows an amber warning; expired inspection blocks trip assignment later (Phase 4 test).
- Every screen verified in AR/RTL and EN/LTR; all enum labels localized (no raw `four_wheel_drive` leaking).

**Estimate:** 6 days.

---

## Phase 4 — Trips, Pricing & Public Marketplace

**Goal:** verified operators publish trips; anyone finds them with cascading, localized filters. The core product.

### Deliverables
- `trips`, `trip_stops`, `trip_events`, `trip_verifications`, `trips_search` (denormalised) + visibility (BR-07/08).
- Creation wizard: route → schedule → stops → capacity/pricing (flat or per-stop) → discount → vehicle/driver →
  policies (incl. payment policy placeholders) → review/publish.
- Rules: verification submit, 2-hour edit lock (BR-06), audited edits, re-verification policy, cancel trip.
- Operator console: trip list by status, detail (edit/publish/cancel), calendar view.
- **Public marketplace** `/trips`: cascading facets with counts, sorting, keyset pagination, map/list toggle,
  featured (plan-boosted) slots labelled as such, localized SEO metadata + JSON-LD, share links.
- Trip detail: route timeline with stop prices, discount breakdown, operator card, seats left, policies, book CTA.
- Filter state fully serialised in the URL (shareable, locale-preserving).
- Staff trip search incl. historical/cancelled (basic; bulk tools in Phase 7).
- User trip history shell (bookings filled in Phase 5).
- **Quota hooks:** `create_trip` (trips/month) and `publish_trip` (active trips) call `assert_quota()`.
- Mobile: search + filter sheet + trip detail.

### Tasks
- [x] Migrations: trips/trip_stops + enums (`trip_status`, verification status, `booking_mode`, `discount_kind`,
      `pricing_mode`, `gender_policy`, `payment_policy`) + constraints (seats, ordering, no duplicate consecutive stops).
- [x] `app.assert_trip_editable()`, `app.actor_can_manage_trip()`, `app.recompute_seats_available()`,
      `app.set_trip_visibility()`.
- [x] `trips_search` refresh triggers + indexes (GIN stop ids, btree date/price, trigram names, featured boost).
- [x] Commands (edge fn + atomic `cmd_*` SQL): `create_trip`, `update_trip`, `set_trip_stops`, `publish_trip`, `submit_trip_verification`,
      `decide_trip_verification`, `cancel_trip`, `search_public_trips(locale, filters, sort, cursor)`,
      `get_trip_public`, `staff_search_trips`.
- [x] Facets (`{ items, facets, total }`) + 30 s cache; **measured at last** — `npm run perf:seed` clones a
      published trip 50,000 times in 8 s and `npm run perf:smoke` reports p95 5.6 ms cold / 2.7 ms cached, after
      `00036` rewrote the function (it was 15.7 s) and `00038` removed the O(public trips) page and the per-request
      facet scan. k6 suites written in `docs/perf/`, not yet run against a production-sized environment — there is
      none.
- [x] Pricing engine in `@maak/core/pricing.ts` mirroring DB math + Vitest parity tests against RPC fixtures.
- [x] Web `/operator/trips/*`, `/trips`, `/trips/[code]`, `/staff/trips`; localized forms with `Asia/Aden` timezone.
- [x] Mobile search/filter/results/detail — implemented and typechecked, **not run on a device**.
- [x] pgTAP: unverified cannot create; edit blocked at 1h59m (frozen clock); drafts/rejected/completed hidden publicly.

### Acceptance criteria
- Verified operator creates Sana'a → Aden with 2 stops, per-stop pricing, 10% discount, publishes → visible publicly in < 1 s.
- Cascading filters behave: choosing «عدن» narrows origin options with counts; «بدون توقف» removes stop-only trips.
- Editing 1h59m before departure returns `EDIT_WINDOW_CLOSED` from the RPC, not just a disabled button.
- Completed/cancelled trips disappear from `/trips` instantly and remain in `/staff/trips`.
- Search p95 < 300 ms at 50k seeded trips. **Met at 50,000 trips: 5.6 ms p95 (`docs/perf/smoke-50k.json`)**;
  the remainder — an unselective *filter* still costs one 42 ms pass for its cascading counts, ~23 cold
  searches/second/core — is written up in `docs/perf/README.md` rather than left implicit.
- Shared URL reproduces exact filter state, in both locales (including Arabic query strings).
- Detail page LCP < 2.5 s on throttled mobile, both directions; JSON-LD validates.
- Basic-plan owner blocked at the 6th trip in a month; Pro sees a warning at 80% before blocking at 100% (soft limit).

**Estimate:** 10 days.

---

## Phase 5 — Bookings, Passenger Data & Requests

**Goal:** turn interest into confirmed seats with the identity/trust model passengers need.

### Deliverables
- `bookings`, `passenger_documents`, `document_access_log`; transactional seat holds (BR-10), expiry cron (BR-11).
- Booking flow: stop selection, seats, live price breakdown, passenger identity form (name, ID type/number,
  place of birth, mobile, note), ID photo (camera/file), optional WhatsApp private share.
- Signed WhatsApp share links (`/s/:token`, 72 h, watermarked viewer, audited views).
- Operator inbox per trip: accept/reject with reason, bulk accept; accepted passenger list with payment placeholders.
- Cancellations: passenger (≥ 2 h, BR-09), operator (anytime + reason), auto `no_show`/`completed`.
- My bookings (upcoming/past) with status, cancel, ticket QR, re-book.
- `app.compute_refund()` implemented now (used by Phase 9/10 money flows).
- Notifications: request/accepted/rejected/cancelled (in-app now, channels in Phase 11).
- Mobile: booking wizard, my bookings, ticket; receipt upload placeholder for Phase 9.

### Tasks
- [x] Migrations + enums (`booking_status`, `id_type`, `payment_status`) + constraints (identity fields required)
      — `00019_bookings.sql`; five enums, one document per booking, hold-while-pending and code-shape checks.
- [x] Commands (edge fn + atomic `cmd_*` SQL): `create_booking`, `accept_booking`, `reject_booking`, `cancel_booking_by_passenger`,
      `cancel_booking_by_operator`, `expire_booking_holds`, `get_trip_manifest_data`, `create_id_share_link`,
      `resolve_id_share_token`, `compute_refund`.
- [x] Storage `passenger-ids` (private) + policies + 5-min signed URLs (`lib/storage.ts`) + watermarked preview
      (`/[locale]/s/[token]`, operator-only, audited reads).
- [x] Cron: `expire_holds`, `auto_complete_bookings` (`job_finalize_trips`), `purge_expired_id_documents` —
      `00020_booking_jobs.sql`, `pg_cron` where present, a dev timer where not.
- [x] Web `/trips/[code]/book`, `/operator/trips/[id]/bookings`, `/account/bookings` (+ `/[id]`), `/s/[token]`
      — `/account` rather than `/me`, because the account area already existed.
- [x] Mobile booking wizard, my bookings, ticket — implemented and typechecked, **not run on a device**.
- [x] pgTAP: last seat sold once, cutoff enforcement, cross-org access denied, refund math — 91 assertions in
      `0008_bookings.test.sql` (the last-seat case is sequential: pgTAP has one session per file).

### Acceptance criteria
- Two simultaneous last-seat bookings: exactly one succeeds, the other gets `NO_SEATS_LEFT`.
- Cancel 2h05m before departure: OK. 1h55m: `CANCEL_WINDOW_CLOSED`.
- Pending holds expire and the seat returns automatically.
- ID image visible only to booking owner, trip owner org, and authorised staff; every access logged; URL expires in 5 min.
- WhatsApp share link shows a watermarked preview to the trip owner only, for 72 h.
- Rejection releases the seat, notifies the passenger, and shows the reason in their locale.
- All passenger forms usable one-handed on mobile; validation messages localized and announced to screen readers.

**Estimate:** 8 days.

---

## Phase 6 — Trip Execution, ODO & Live Tracking

**Goal:** the trip actually runs: verified-only start, odometer discipline, 10-minute location, meaningful progress.

> **Mostly done.** Part one: start / stop-reached / end, odometer discipline, status machine. Part two:
> pings (partitioned), derived progress with ETA, the driver's web console and the passenger's live
> screen with polling and staleness. See `docs/phase-6-report.md`. What remains is listed at the end of
> that report: the native background-location cadence, a routing provider, the realtime channel and
> per-passenger check-in.

### Deliverables
- Driver console (mobile): today's trips, start (blocked unless verified, BR-05), ODO + photo, running screen,
  "reached stop", end with ODO, per-passenger check-in, cash-collection prompt (wired in Phase 9).
- `trip_location_pings` (monthly partitions), `record_trip_ping`, `app.recompute_trip_progress`, `trip_progress`,
  `trip_route_geometry`.
- Background location every 10 min with offline queue; web fallback "I'm here" + geolocation while open.
- Passenger live screen: map, «الآن في …», next stop + km + ETA, destination km + ETA, progress %, live/stale badge,
  seats remaining — fully localized (Arabic numerals option respected).
- Realtime private channel `trip:<id>` + 30 s polling fallback; staleness rules + ops alert.
- ODO integration: vehicle total updates, distance sanity check, anomaly flag.
- Cron: auto `in_progress` at departure, auto-complete rules, stale-trip alerts.

### Tasks
- [x] Migrations: odometer readings, `trip_events`, `trip_status.in_progress` (`00021`, `00022`); pings
      (monthly partitions), `trip_progress`, `trip_route_geometry` and the driver's read policy (`00023`, `00024`).
- [x] `app.recompute_trip_progress`: nearest upcoming stop, haversine chain, ETA from rolling speed with a
      timetable fallback — `supabase/migrations/00023_trip_tracking.sql`.
- [ ] Routing provider at publish (cached; OSRM/ORS) + graceful fallback — the straight-line fallback and the
      `trip_route_geometry` seam exist; no provider is called yet.
- [x] Commands (edge fn + atomic `cmd_*` SQL): `start_trip`, `end_trip`, `mark_stop_reached`, `record_ping`,
      and the visibility-checked read `get_trip_progress`. (`check_in_passenger` and a dedicated
      `get_driver_trips_today` are folded into the read policy + `/driver` for now. **`check_in_passenger` did
      not land in Phase 7 either** — the manifest is the sheet the conductor reads; marking a seat boarded
      waits for the booking-state slice that gives `accepted` a `boarded` successor.)
- [x] Realtime: the private `trip:<id>` publication is added when the deployment has it (00023), and the live
      screen polls every 30 s — the transport that exists in *both* environments is the one that ships.
- [~] Mobile: the web driver console covers start / position / stop / end. `expo-task-manager` background
      location, the offline queue and the iOS/Android permission UX are not built.
- [x] Web passenger live page `/trips/[code]/live`, stale states, route strip.
- [x] pgTAP: 30 assertions in `0009_trip_execution.test.sql` (start, ODO, stops, end) and 39 in
      `0010_trip_tracking.test.sql` (pings, out-of-order timestamps, progress, staleness, visibility, grants).

### Acceptance criteria
- Start 3 h early → `TOO_EARLY`; unverified trip → `TRIP_NOT_VERIFIED`; wrong driver → `FORBIDDEN` unless audited override.
- Lower ODO than last reading rejected with a clear localized message.
- Pings update the map and the text within 2 s: «الآن في X · يتبقى 24 كم لأقرب توقف · يتبقى 137 كم للوصول إلى عدن».
- Non-booked user calling `get_trip_progress` gets `FORBIDDEN`; booked passenger receives live updates.
- 21 minutes without a ping → «الموقع غير محدّث» + last known point and time (and English equivalent).
- End trip writes ODO, advances the vehicle total, and flags a 25% distance anomaly in fixtures.
- Driver flow works offline: queue flushes on reconnect with correct `recorded_at`.

**Estimate:** 9 days.

---

## Phase 7 — Staff Operations: QR, Bulk Verification, A4 Manifest

**Goal:** the authority/supervisor toolset: scan, verify in bulk, print — in either language.

### Deliverables
- Trip QR: token on verification, printable QR, in-app scanner (web + mobile), permission-trimmed trip view, scan audit.
- Bulk verification: trips; trips + their passengers; passengers within one trip; entities (profiles/orgs/vehicles/drivers).
  Geo-scoped, per-row results, reason required, audited, notified.
- A4 manifest PDF (server-rendered, Arabic/Latin font embedding, QR, vehicle block, driver block, passenger table,
  compact 2-column, locale toggle, payment status column).
- Staff trip search with full filters incl. history + CSV export.
- Supervisor dashboard: pending verifications in scope, live trips in scope, stale trips, recent scans.

### Tasks
- [x] `qr_token` generation + resolver + rate limiting. — `00025`: token on `verified`/`published`/`in_progress`/`completed`
      by trigger, backfilled; resolved by `get_trip_for_staff(actor, token, ip)` behind the session-bound
      `staff_scan(text)`, rate-limited in the function and logged either way. No `GET /api/qr/...` route: the scan is
      an authenticated staff read, not a public URL.
- [x] Scanner UI (web: `BarcodeDetector`; mobile: token entry — `expo-camera` deferred, see `docs/phase-7-report.md` §6)
      with permission prompts localized (§`ops.scanCameraUnsupported`, `ops.scanCameraOff`).
- [x] Commands (edge fn + atomic `cmd_*` SQL): `cmd_bulk_verify_trips`, `cmd_rotate_trip_qr`, `get_trip_for_staff`,
      `get_trip_manifest`, `staff_scope_summary`, `staff_search_trips` (now ops-scoped with history filters).
      **Not built:** `bulk_verify_trips_with_passengers`, `bulk_verify_passengers`, `bulk_verify_entities`,
      `log_document_access` (already shipped in 00019) — see the report §6.
- [x] A4 manifest + layout tests at 4/14/30 passengers. — Print-optimised HTML with `@page size: A4` and
      `manifestColumns()`; **no server-side PDF binary** (pdfkit + Noto Naskh WOFF was prototyped and rejected:
      woff/woff2 only, second layout engine). Layout is asserted by `packages/core/tests/manifest.test.ts`.
- [x] Staff web `/staff/scan`, `/staff/dashboard`, `/staff/trips/[id]/manifest`, history filters + CSV export on
      `/staff/trips`. (The dashboard lives inside the staff console instead of a separate `/supervisor/*` area.)
- [x] Mobile scanner screen + manifest link (`apps/mobile/src/app/staff/scan.tsx`, token entry).
- [x] pgTAP: out-of-scope verification blocked; manifest refused for a passenger (403/`42501`); scan audit written
      on both allowed and refused attempts. (`can_view_passengers` was not needed: the manifest read *is* the gate.)
- [x] Manifest format tests replace PDF snapshots: CSV (BOM/quoting/CRLF/Aden offsets) and column splitting at
      14/30 passengers, both locales — `packages/core/tests/manifest.test.ts` (16 tests).

### Acceptance criteria
- Aden-scoped supervisor scanning an Aden trip sees it; an out-of-scope supervisor sees «خارج نطاقك» / “Outside your scope”.
- Bulk verify 10 trips + passengers → `9 verified, 1 failed (out of scope)` with per-row reasons.
- 14-passenger manifest fits one A4 page; Arabic renders correctly (no tofu) and English renders LTR cleanly.
- Passenger cannot download the manifest (`403`); generation is audited and visible in the audit explorer.
- Historical search finds last month's completed trip by date range + governorate; CSV matches the filtered rows.

**Evidence:** 36 pgTAP assertions (`0011_staff_operations.test.sql`) and 16 unit tests
(`packages/core/tests/manifest.test.ts`); probed end to end on the running stack — the Aden/Sanaa patch split,
`9 verified, 1 failed (OUT_OF_SCOPE)`, a 14-passenger sheet on one column, `403` for a passenger and `404` for a
missing trip, and a history export that matches the table row for row. What was decided differently (no PDF
binary, trips-only bulk, no native camera) is argued in `docs/phase-7-report.md` §2 and §6.

**Estimate:** 8 days.

---

## Phase 8 — Vehicle Operations: ODO, Fuel & Maintenance

**Goal:** fleets stay roadworthy and their costs feed the finance module automatically.

### Deliverables
- `fuel_logs`, `maintenance_records`, `maintenance_schedules` (generated due columns), `maintenance_status`,
  reminder cron — plus automatic `expenses` rows (category `fuel` / `maintenance`) for Phase 10.
- Auto ODO: trip start/end, manual readings with photo, monotonic guard (BR-16), anomaly detection.
- Fuel analytics: L/100km, km/L, cost/km, per-trip and monthly trends, station linking.
- Maintenance: km/date schedules, due-soon/overdue badges, "mark done", cost history, attachments.
- Dashboards: vehicle health card, fleet rollup, upcoming maintenance, CSV/PDF export (plan-gated later).
- Settings: reminder thresholds, block-assignment-when-overdue flag.
- Mobile: fuel/ODO quick log from the running trip screen.

### Tasks
- [x] Migrations + generated columns + `app.assert_odometer_advance()` (the BR-16 guard, in front of every write
      path) + `app.recompute_maintenance_status()`.
- [x] Cron: daily maintenance scan → reminders, deduped per state change.
- [x] Commands (edge fn + atomic `cmd_*` SQL): `log_fuel`, `log_maintenance`, `upsert_maintenance_schedule`,
      `mark_maintenance_done`, `record_manual_odometer`, `get_vehicle_health`, `get_fleet_summary`.
- [x] Expense sync triggers (fuel/maintenance → `expenses`, soft-delete → `expense.reversePending` audit stub for Phase 10).
- [x] Web `/operator/vehicles/[id]/health`, `/operator/fleet`, CSV export.
- [x] Mobile fuel/ODO quick action (`/driver/fuel`).
- [x] Tests: consumption math, due-date math, timezone-safe date handling (Vitest + pgTAP — 52 pgTAP assertions)
- [x] 8.3 — the marketplace, the booking form and the account area: the filter panel was a closed `<details>`
      whose summary is hidden from 900px up, so a desktop visitor had no filters at all (`FilterDisclosure`
      sets the `open` attribute and marks the panel `data-enhanced`, so a browser without JavaScript still gets
      a visible toggle); `.trip-filters__count` and the `fleet-panel`/`fleet-form-grid` pair were used and
      never defined; `.trip-detail` had no rules; the stop marker drew its number over a 0.7rem dot; the route
      arrow pointed backwards in English; the account area gained the pill navigation its four sub-screens never
      had. Two extra departures and one accepted booking seeded, so the grid, the facets, the "direct" badge and the
      booking card have something to lay out.
- [x] 8.2 — the dashboard itself: `.fleet-grid` meant two things (a card grid and a table) and `.console-grid`
      was a tile grid on every content page, so the fleet screen rendered its tables as columns of cards
      inside a 220px strip. Renamed the table class, made the console grid one column, and rebuilt the page
      around a stat row with state tones, filter chips and a fleet table that becomes labelled cards below
      720px.
- [x] 8.1 — the gaps the first pass left: per-trip and monthly fuel analytics, km/L alongside L/100km, station
      linking, receipt/odometer photos for the assigned driver, fuel-anomaly notifications, attachment read
      links, the plan-gated A4 report, and a date-ranged cost ledger for the CSV (`0013`, 41 assertions)

### Acceptance criteria
- Two full-tank logs 450 km / 38 L apart → dashboard shows 8.4 L/100km.
- Schedule "oil every 5,000 km" with last at 120,000 → due 125,000; 124,600 shows “due soon”; 125,300 “overdue”.
- End-trip ODO advances the vehicle total automatically; a lower manual reading is rejected unless the owner
  overrides with a reason (audited).
- Fleet dashboard totals reconcile with underlying logs.
- An overdue vehicle is blocked from new trip assignment when the setting is on.
- Fuel/maintenance costs appear as expenses ready for the finance module.

**Estimate:** 6 days.

### As built (deliberate deviations)

- **`app.vehicle_odometer_guard()` is `app.assert_odometer_advance()`.** Named for what it does, and a
  function the commands *call* rather than a trigger: the one legal backwards step (an owner correcting a
  replaced odometer) has to be expressible, and a trigger cannot tell a correction from a mistake. The
  high-water mark on `vehicles.odometer_km` is what keeps both honest.
- **`get_vehicle_health` / `get_fleet_summary` are reads, not edge-function actions.** They follow the same
  rule as `get_trip_manifest` and `staff_summary`: the session-bound wrappers (`vehicle_health`,
  `fleet_summary`) are what the UI calls, so the client never holds an actor id it could lie about. The
  commands themselves take `p_actor` and stay service-role.
- **`maintenance_status` is a table, not a view.** The reminder job needs to remember *what it already told
  somebody*; a view cannot. It is recomputed by triggers on schedules, records, readings and the vehicle's
  odometer, so no screen ever shows a state the trip gate would disagree with.
- **Anomaly detection reports, it never refuses.** A fill 30% above the average returns `anomaly: true`; the
  receipt is still recorded. Refusing it would hide the symptom and lose the cost. Since 8.1 it also rings a
  bell — **once per vehicle per week**, because a symptom that nobody hears is not a report.
- **The PDF export is a print route, not a binary.** `/[locale]/operator/fleet/report` prints on A4 through
  the manifest's paper CSS, so the Arabic face is the one the browser already rendered. A real PDF needs a
  font pipeline that failed in Phase 6; print-to-PDF is the same artefact with none of that risk.
- **The printable report is plan-gated at the database, not in the UI.** `plan_limits.fleet_reports` +
  `app.plan_allows` decide; hiding the link is a courtesy, and the route asks the same function before it
  renders a row. The CSV stays free for every plan — it is data export, not a deliverable document.

**Changelog:** Phase 8 adds six tables, four enums, six commands, two reads, a nightly reminder job and the
expenses outbox Phase 10 will post from. Phase 8.1 (`00028`–`00029`) adds one metric to `plan_limits`, the
`vehicle_fuel_anomaly` notification kind, per-trip and monthly fuel reads, driver-writable photo folders, the
A4 report and `fleet_cost_detail` — 41 further pgTAP assertions. Fleet odometers now advance from fuel, maintenance, manual readings
and trip ends through one guard; schedules carry generated due points; `/operator/fleet` renders a rollup
whose totals are the same rows each vehicle card shows. 52 pgTAP assertions and 22 Vitest cases cover the
acceptance numbers (8.44 L/100km, 120 000 → 125 000), the monotonic guard and its one audited override, the
reminder dedupe, and the trip gate's `MAINTENANCE_OVERDUE` refusal.

---

## Phase 9 — Payments (cash / e-wallet / agent / bank deposit)

**Goal:** record and confirm money movement in a way that fits Yemen, without a card gateway, and reconcile it.

### Deliverables
- `payment_accounts` (platform + verified users + agents), `payment_intents`, `refunds`, `agents`,
  `agent_transactions`, `payouts`, `payout_items`, `payment-proofs` bucket.
- **Platform payment accounts**: finance officer/admin CRUD with provider list (Jaib, Cash/ONE, M-Floos, YemPay,
  Al-Kuraimi Bank, Tadhamon, cash desk), instructions in AR/EN, default per method, archive-not-edit history.
- **User payment accounts**: verified individuals/companies/agents add their own; `pending_verification` until
  finance confirms ownership (document upload); only `active` accounts receive money.
- Payment intent lifecycle with idempotency, proof upload (camera/file), reference number, confirm/reject with
  reason, expiry, anti-fraud checks (proof hash, reference dedupe, tolerance, velocity).
- Booking integration: `prepay_required` blocks confirmation until paid; deposit percent support; cash-on-boarding
  collection by driver/operator; partial payment → `booking_balance`.
- Refund execution (request → approve → paid/rejected) using `app.compute_refund()` from Phase 5.
- Agent flows: cash-in with float balance, credit limit, settlement submission, receipts.
- Finance queue UI: unmatched deposits, proofs to review, SLA timers, bulk confirm.
- Passenger payment UI: method chooser, account number with one-tap copy, WhatsApp share of receipt, status tracking.
- Mobile: pay for booking, upload receipt, payment status, cash-collect (driver).

### Tasks
- [x] Migrations + enums (`payment_method`, `payment_status`, `purpose`, `account_status`, `agent_tx_kind`) + constraints.
- [x] RLS: payer sees own intents, owner org sees trip-related, finance sees all, agents see own float.
- [ ] Commands (edge fn + atomic `cmd_*` SQL): `create_payment_intent`, `submit_payment_proof`, `confirm_payment`, `reject_payment`,
      `cancel_payment_intent`, `expire_stale_payments`, `request_refund`, `decide_refund`, `pay_refund`,
      `create_payment_account`, `verify_payment_account`, `archive_payment_account`,
      `agent_cash_in`, `request_payout`, `approve_payout`, `mark_payout_paid`.
- [x] Ledger **posting stubs** for confirm/refund (entries created; full ledger from Phase 10 lands here or there —
      decided: ledger tables ship in Phase 10, Phase 9 writes to an outbox table so no money event is ever lost).
- [x] Storage `payment-proofs` + policies + 180-day retention job + proof hashing.
- [ ] Cron: stale intent expiry, unmatched-deposit reminders, agent settlement reminders.
- [x] Web `/pay/[intent]`, `/operator/payments`, `/finance/payments`, `/finance/accounts`, `/finance/agents`, `/operator/payouts`.
- [x] Mobile pay/upload/status + driver cash-collect sheet.
- [x] pgTAP: double-confirm prevented (idempotency), proof reuse blocked, out-of-scope account edits denied,
      prepay-required booking cannot confirm unpaid, wrong amount handled.

### Acceptance criteria
- Passenger on a `prepay_required` trip pays via e-wallet: uploads receipt + reference → operator confirms →
  booking becomes `confirmed` and a ledger outbox event exists. Confirming twice does nothing the second time.
- Reusing the same receipt image on another intent is rejected (`PROOF_ALREADY_USED`).
- Booking with 30% deposit shows `deposit_paid` and a remaining balance; paying the balance flips it to `paid`.
- Cash trip: driver taps “collected” for 4 passengers → 4 intents, one batched confirmation, correct totals.
- Agent cash-in updates float and appears in the agent's statement; exceeding the credit limit is blocked.
- Finance officer adds a platform wallet number → it appears to passengers within the same session (localized instructions).
- A verified individual adds a bank account → status pending → finance verifies → it becomes usable for payouts.
- Refund approved before the cutoff posts correctly; after the cutoff the passenger sees the policy reason.
- All payment screens verified in AR/RTL and EN/LTR; amounts always paired with currency; no truncation on narrow devices.

**Estimate:** 8 days.

---

## Phase 10 — Finance & Subscriptions (ledger, invoices, plans, quotas)

**Goal:** one financial truth and a working monetisation engine.

**Status: complete (2026-11-01).** Evidence: [`docs/phase-10-report.md`](./docs/phase-10-report.md).
31 migrations · 105 commands · 10 edge functions · 15 pgTAP suites (774 assertions) · 522 unit tests ·
101 a11y routes.

### Deliverables
- Double-entry ledger: `ledger_accounts` (platform + per-owner chart), `journal_entries`, `ledger_entries` with
  balance-constraint triggers, immutability (no UPDATE/DELETE), reversing entries, `suspense` handling.
- Backfill from the Phase 9 outbox; every payment/refund/payout/invoice/commission posts exactly once.
- Invoices (booking + subscription) with frozen `snapshot`, numbering, PDF in both locales.
- Commission engine (`commission_rules`, global + per-owner, effective-dated, caps/floors) applied on confirmation.
- Payouts: request → approve → mark paid (segregation of duties enforced), statement generation.
- Statements (monthly) PDF/CSV; revenue/expense/profit reports; per-trip, per-vehicle, per-month analytics.
- Expenses: manual entry with receipt, plus the automatic fuel/maintenance rows from Phase 8.
- Reconciliation workspace: statement CSV import, auto-match, exception queue, audited manual adjustments.
- Daily integrity job: balance checks, suspense, owner-balance reconciliation, missing-journal detection + alerts.
- **Plans & subscriptions**: `plans`, `plan_limits`, `subscriptions`, `usage_counters`, `subscription_events`,
  `quota_violations`, `quota_overrides`; Basic/Pro/Business seeded and admin-editable.
- Quota enforcement activated across every creation path (vehicle, trip, staff, driver, active trips,
  featured listings, finance exports) with structured `QUOTA_EXCEEDED` / `QUOTA_WARNING` payloads.
- Subscription billing: trial, invoice-driven renewal, `past_due` → `grace` → `expired` fallback to Basic,
  upgrade/downgrade (proration recorded as journal entries), cancel at period end.
- UI: operator finance dashboard, statements/invoices, expense capture, payout requests; admin plans editor,
  commission editor, subscription overview, quota override with expiry.

### Tasks
- [x] Migrations: ledger tables + `assert_balanced_journal()` deferred constraint trigger + revoke UPDATE/DELETE.
- [x] `post_journal(entries[], source)` helper + one posting function per money event (payment, refund, payout,
      invoice, commission, subscription, adjustment) — the only writers.
- [x] Plans/limits/subscriptions migrations + seeds (Basic/Pro/Business from §6.14) + `app.owner_effective_plan()`
      replacing the Phase 1 stub with real resolution (Basic fallback, trial, grace, expiry, overrides).
- [x] `app.assert_quota()` wired into every guarded RPC + `usage_counters` upsert + `quota_violations` logging.
- [x] Commands (edge fn + atomic `cmd_*` SQL): `start_subscription`, `change_plan`, `cancel_subscription`, `renew_subscription` (idempotent on invoice),
      `expire_subscriptions`, `request_payout`, `approve_payout`, `mark_payout_paid`, `issue_invoice`, `void_invoice`,
      `post_manual_journal`, `import_reconciliation`, `get_finance_dashboard`, `get_statement`, `export_finance`.
- [x] Cron: subscription expiry/grace, usage period rollover, statement generation, integrity job.
- [x] PDF: invoice + statement templates (AR/EN, RTL/LTR) with the same font pipeline as the manifest.
- [x] Web `/finance/*` (dashboard, invoices, statements, payouts, reconciliation), `/operator/billing`,
      `/admin/plans`, `/admin/commissions`, `/admin/subscriptions`.
- [x] pgTAP: journal always balances; double posting impossible; commission math; refund math; payout limits;
      quota boundaries per metric; downgrade keeps existing resources; trial→expiry fallback; period rollover.
- [x] Vitest: finance formatters, proration, commission rounding, statement math parity with SQL.

### Acceptance criteria
- Confirming a 10,000 YER booking with 5% commission posts exactly two journal pairs (receivable/operator payable +
  commission revenue) and the entries sum to zero. Attempting to insert an unbalanced entry fails.
- Deleting a posted entry is rejected at the DB level; a correction requires a reversing entry with a reason.
- Daily integrity job is green on fixtures; tampering with one amount turns it red (test proves the alarm works).
- Operator sees revenue − commission − expenses = profit for the month; statement PDF matches the dashboard to the riyal.
- Payout: owner requests 50,000 → finance approves (different user required) → mark paid → statement and ledger update;
  a payout exceeding balance is rejected.
- Subscription: trial Pro → invoice → pay → `active` with new `period_end`; unpaid → `past_due` → `grace` → `expired`
  → limits fall back to Basic without deleting anything.
- Quotas: Basic blocks the 2nd vehicle, 6th trip, 2nd staff, 2nd driver with structured payloads; Pro warns at 80%
  then hard-blocks if `soft_limit = false`; admin override raises the limit until it expires.
- Downgrade Business → Basic: existing 12 vehicles remain, creating a 13th is blocked, nothing is deleted.
- Plans admin editor changes a limit → enforcement reflects it immediately, no deploy.

**Estimate:** 10 days.

---

## Phase 11 — Notifications, Preferences & Search Alerts

**Goal:** the platform tells the right person the right thing, once, on the right channel, in their language.

**Status: complete (2026-11-01).** Evidence: [`docs/phase-11-report.md`](./docs/phase-11-report.md).
32 migrations · 128 commands · 11 edge functions · 16 pgTAP suites (868 assertions) · 623 unit tests ·
107 a11y routes · 35 notification events · 9 scheduled jobs.

### Deliverables
- Full event matrix (specs §6.10) — including payment, refund, payout, invoice, subscription, quota events.
- Channels: in-app, push (Expo), email (Resend), WhatsApp deep links; localized templates with typed variables.
- `notification_preferences` (event × channel), quiet hours (Asia/Aden), critical overrides.
- Saved searches with alerts: save filters, cron matching, digest notifications, deep links preserving filters.
- Reminder jobs: trip in 2 h, departure, no-show window, verification SLA, maintenance, subscription expiring,
  quota threshold.
- Notification centre (web + mobile) with unread counts and deep links.
- i18n QA pass: 100% key parity, plural/gender rules, Arabic numerals, `<bdi>` for mixed strings.
- Accessibility & polish: empty/loading/error/offline states, skeletons, keyboard nav, focus management,
  RTL screen-reader order checks.

### Tasks
- [x] `notifications`, `notification_preferences`, `saved_searches`, `saved_search_matches` + RLS.
      Eight tables in `00032_notifications.sql`: the catalogue (`notification_events`), settings, preferences,
      device tokens, deliveries, delivery attempts, saved searches, saved-search matches.
- [x] `app.enqueue_notification()` (outbox) + edge function `dispatch` (push/email) with retries + dead-letter table.
      Deliveries are rows, not a queue: `pending → sending → sent | skipped | failed → dead`, five attempts with
      1/5/15/60-minute backoff, and a ten-minute stuck sweep so a crashed worker cannot hold a row.
- [x] Cron: `match_saved_searches`, `digest_saved_searches`, `send_trip_reminders` (tomorrow / two hours /
      departure), `notify_no_shows`, `notify_pending_verifications`, `notify_quota_thresholds`,
      `notify_subscription_expiring` (7/3/1 days), `run_maintenance_scan` and `retry` — nine jobs, all callable
      through `notifications.job.run`, each idempotent by dedupe key and each reporting only what it created.
      Scheduled by `docs/ci/notify.yml` (five-minute workflow, `--fail-on-error`, activated with `npm run
      ci:install`), because a job nobody runs is a rumour.
- [x] Template registry (per event, AR/EN, zod-validated variables) + preview screen for admins.
      Registry: `notification_kind` enum + `notification_events` + `notifications.*` keys + `notificationText()`
      in core (typed variables, AR/EN parity asserted). Preview: `/admin/notifications` renders all 34 events
      through that same function, one `lang`/`dir`-annotated AR and EN cell per row, behind
      `notification.catalogue` (staff only).
- [x] Web/mobile notification centre + preference screens (RTL-safe toggles).
- [x] Tests: dispatch idempotency (no duplicate push on retry), quiet hours, opt-out respected, deep links resolve.

### Acceptance criteria
- Accepting a booking produces exactly one push + one in-app notification, even if the dispatch job retries.
- A saved search «عدن → صنعاء، الجمعة، ≤ 5,000 ر.ي» alerts once per new matching trip, not per refresh.
- Disabling email for "booking accepted" stops emails but keeps push.
- Quiet hours suppress non-critical push at 23:00 and deliver at 06:00; a cancellation still delivers immediately.
- Notification text is complete and natural in both Arabic and English (no machine-translation artefacts, no missing variables).
- CI fails on a missing translation key — verify by intentionally removing one.

**Estimate:** 6 days.

---

## Phase 12 — Hardening, Security & Launch

**Goal:** safe to put real passengers and real money in it.

### Deliverables
- Performance: load test at 100k trips / 200 live trips / 5k pings/hour / 500 concurrent bookings; query-plan review;
  index tuning; p95 targets met on search, writes and finance dashboards.
- Security review: RLS matrix re-audit, definer-function review, storage policies, rate limits, OTP abuse,
  ledger grant verification, dependency audit, penetration checklist.
- Reliability: backups + restore drill, PITR verified, cron failure alerts, Sentry alerting, on-call runbook.
- Mobile release: EAS builds, store assets (AR/EN screenshots), permission copy, privacy labels, TestFlight/Internal,
  OTA pipeline, RTL screenshot verification on device.
- Data: production geography seed, platform payment accounts, plan seeds, admin accounts, settings defaults.
- Docs: `docs/runbook.md`, `docs/admin-guide.md`, `docs/operator-guide.md` and `docs/passenger-guide.md` (Arabic),
  generated RPC/API reference. **Written: the runbook and all three guides.** The generated RPC reference is still
  open — the console below is the closest thing to it today.
- UAT with 3 pilots (1 company, 2 individuals) and burn-down of findings.

### Tasks
- [~] Performance harness: `npm run perf:seed` (50,000 trips in 8 s), `npm run perf:smoke` (gated, runs in the
      sandbox), `npm run perf:db` (concurrency at the database), k6 suites in `docs/perf/` for search, the booking
      race, ping ingest and the finance dashboard. Measured results in `docs/perf/`. **Not run:** k6 (no k6 in the
      sandbox) and payment-confirmation volume (needs a payment provider fixture).
- [x] `EXPLAIN ANALYZE` review where it mattered: search was 15,690 ms at 50k, 112 ms after `00036` (one plpgsql
      call per row per facet; a non-inlineable sort key) and 5.6 ms after `00038` (the facet scan and the sort
      removed). Autovacuum tuning for the pings table remains.
- [x] Account deletion executed rather than merely requested: `cmd_delete_account` (`00039`) anonymises the person
      and keeps the books, with six refusals, `platform_admin` only and no self-service; 30 pgTAP assertions in
      `0018` and `docs/admin-guide.md` §6a for the operator's half (Storage objects, `authScrubbed`).
- [ ] Security checklist execution + fixes; `supabase db lint`, `plpgsql_check`, `npm audit` clean.
- [ ] Backup restore into a scratch project with documented timings.
- [ ] Alerts: error rate, stale live trips, failed notifications, imbalanced journals, verification backlog,
      payment confirmation SLA breach.
- [ ] EAS build/submit config, store listings, privacy policy + terms (AR/EN).
- [ ] UAT script + sessions + issue burn-down.
- [ ] Tag `v1.0.0`, changelog, handover session.

### Acceptance criteria
- Search p95 < 300 ms, write RPC p95 < 250 ms, finance dashboard p95 < 500 ms under stated load.
  **At 50,000 trips on a 2-core sandbox:** search 5.6 ms cold / 2.7 ms cached, write 4.2 ms, dashboard 83.5 ms —
  all inside their targets one request at a time; 8 concurrent cold searches reach p95 195 ms. The one linear
  cost left is an unselective filter's cascading counts (42 ms), documented in `docs/perf/README.md`.
- Zero critical/high findings; every table's RLS covered by a passing test; ledger grants verified by test.
- Restore drill completes within documented RTO (< 1 h) with integrity checks passing.
- iOS + Android builds install and complete the driver journey on real devices, in Arabic (RTL) and English.
- Three pilot operators complete a full cycle unaided: subscribe → publish → book → pay → verify → run → manifest → statement.
- Daily financial integrity job green for 7 consecutive days of UAT activity.

**Estimate:** 8 days.

---

## Backlog (post-v1, deliberately deferred)

Card/PSP acquiring with webhooks, escrow with automated payouts, multi-currency, VAT/tax filing,
recurring trips + route templates, seat-map selection, ratings & reviews, chat, WhatsApp Business API,
call-center console, payroll, fuel-card integrations, advanced BI, referrals/coupons,
third language, offline-first full PWA, driver mobile money wallet.

---

## Dependency map

```
0 ── 1 ── 2 ── 3 ── 4 ── 5 ── 6 ── 7
                    │      │     
                    │      └── 11      (needs booking + tracking + money events)
                    ├── 9 ── 10        (payments → ledger + subscriptions)
                    └── 8              (vehicle ops; can run parallel to 6/7)
everything ── 12
```
Phase 8 can run in parallel with 6–7. Phase 9 can start once Phase 5 lands (it needs bookings to pay for).
Phase 10 must follow 9. Phase 11 needs 5, 6, 9, 10. Phase 12 is last.

---

## Progress tracker

| Phase | Name | Status | PR | Notes |
|---|---|---|---|---|
| 0 | Foundations & bilingual shell | ✅ Complete (audited) | — | 117 tests · lint+guards green · `/ar` + `/en` live · 2 edge functions · 5 migrations · auth shell · pgTAP written (needs Docker) |
| 1 | Identity & Trust | ✅ Complete | — | 214 tests · orgs + membership + roles · 16 commands · verification queue with signed docs · **53 pgTAP assertions executed** (`npm run sql:check`) |
| 2 | Geography & Places | ✅ Complete | PR #2 | governorates/districts/regions · places + moderation · supervisor scoping |
| 3 | Fleet | ✅ Complete | PR #2 | vehicles, photos, documents, drivers, assignments · quota hooks live |
| 4 | Trips & Marketplace | ✅ Complete | PR #2 | publish → search → book · pricing + discounts |
| 5 | Bookings | ✅ Complete | PR #2 | requests, seats, passengers, refund math ready for 9/10 |
| 6 | Live Execution | ✅ Complete | PR #2 | start/end, ODO, pings, staleness, public tracking |
| 7 | Staff Operations | ✅ Complete | PR #2 | QR scan + scope, bulk verify, A4 manifest, history export |
| 8 | Vehicle Operations | ✅ Complete | PR #2 | fuel/maintenance/ODO · due states · reminders · rollup · expenses outbox for 10 |
| 9 | Payments | ✅ Complete | this PR | no card gateway · intents + proofs + human confirmation · prepay trigger · refunds/payouts/agents · outbox → 10 · **58 pgTAP assertions** · 457 unit tests · 83 a11y routes |
| 10 | Finance & Subscriptions | ⬜ | | activates quotas + plan billing |
| 11 | Notifications & Polish | ⬜ | | |
| 12 | Hardening & Launch | ⬜ | | |

---

## What I need from you to start Phase 0

1. **Go-ahead** — nothing else blocks scaffolding.
2. Answers to the seven open questions in `specs.md` §19 are needed before **Phase 10**, not before Phase 0.
   The two that shape early UI: Is Basic truly free (0 YER)? Is commission on the seat fare for all confirmed bookings?
3. Confirm the seeded plan values in §6.14 (1/5/∞ vehicles, 5/50/∞ trips, 1/5/∞ staff, 1/10/∞ drivers) or send yours.
