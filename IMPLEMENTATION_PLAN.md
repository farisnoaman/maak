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

## Working agreement

1. **Kick-off (me):** restate the phase scope + the exact acceptance tests I will run.
2. **Build (me):** migrations → RPCs → pgTAP → `@maak/core` → web UI → mobile UI → both locales.
3. **Demo (you):** I run the app on a live preview, seed demo data, post a walkthrough + screenshots
   (Arabic and English).
4. **Review:** you test the acceptance checklist. Changes stay inside the same phase.
5. **Gate:** merge `phase-N: <name>` → I tick the tracker below → next phase starts.

**Definition of Done for every phase**
- Green CI: typecheck, lint (module boundaries + RTL + i18n parity), unit, pgTAP, Playwright smoke (ar + en),
  `supabase db diff` empty, generated types in sync.
- Every new user-facing string exists in **both** `ar.json` and `en.json`; every screen verified in RTL **and** LTR.
- Migrations are forward-only and re-runnable; seeds idempotent.
- `specs.md` updated if reality changed; one-paragraph changelog appended here.

---

## Phase 0 — Foundations & Scaffold (web + mobile + bilingual shell)

**Goal:** a running skeleton on web + mobile with the cost-saving architecture *and* the bilingual
foundation baked in from the first commit (RTL retrofits are the expensive kind).

### Deliverables
- pnpm + Turborepo monorepo: `apps/web`, `apps/mobile`, `packages/core`, `packages/design-tokens`, `packages/config`.
- Next.js (App Router, TS strict, `next-intl`) with locale-prefixed routes `/{locale}`, `ar` default,
  `en` secondary, `hreflang`, locale-preserving switch, `dir` set on `<html>`.
- Shared design tokens → Tailwind (web) + NativeWind (mobile); Arabic (Cairo/IBM Plex Sans Arabic) +
  Latin (Inter) font loading; **logical-property-only** style conventions enforced by ESLint.
- `@maak/core`: typed Supabase client factory, RPC wrapper with typed errors (`Result`), zod base schemas,
  i18n dictionaries with generated typed keys, formatters (money/date/number, AR/EN, numerals preference).
- Supabase project skeleton: schemas `public` / `app` / `audit`, extensions (`postgis`, `pg_trgm`, `pg_crypto`),
  migration convention, `db:types` script, committed `database.types.ts`.
- Auth shell (web SSR cookies + mobile SecureStore): phone OTP + email/password, protected-route middleware,
  locale-aware redirects.
- App shells: public layout, operator layout, staff layout, admin layout (web); tab shell + auth screens (mobile).
- CI (typecheck, lint, unit, `db lint`, types drift, build), Sentry, `.env.example`, README quickstart.
- **Preview note:** this sandbox has no Docker/Supabase CLI, so the live preview runs the web shell with a
  local mock adapter; real DB work is validated on your machine/CI via `supabase start`.

### Tasks
- [ ] Init pnpm workspace, turbo pipeline, shared tsconfig/eslint/prettier/commitlint.
- [ ] `packages/config`: eslint with `boundaries`, `no-physical-direction`, `no-hardcoded-copy` rules.
- [ ] `packages/design-tokens`: colors (light/dark), spacing scale, radii, typography, elevation, motion.
- [ ] Next.js scaffold: `app/[locale]/layout.tsx` with `dir`, `next-intl` middleware, `ar.json`/`en.json`,
      typed message keys, `hreflang` alternates, locale switcher component.
- [ ] Tailwind configured from tokens; forbidden utilities documented; base UI primitives
      (Button, Input, Select, Dialog, Toast, Skeleton, EmptyState, DirectionalIcon).
- [ ] Expo scaffold: expo-router, NativeWind from the same tokens, `expo-localization`, RTL-safe primitives,
      `ar`/`en` dictionaries shared through `@maak/core`.
- [ ] Supabase init: `config.toml`, `00001_schemas_extensions.sql`, `00002_audit_log.sql`,
      helper `app.current_profile_id()`, `app.set_updated_at()`.
- [ ] Supabase clients (browser/server/mobile) + `db:types` + CI drift check.
- [ ] `@maak/core/rpc.ts`: typed call wrapper, error-code → localized message registry, retry/timeout policy.
- [ ] `@maak/core/format.ts`: money (`1,500 ر.ي` / `YER 1,500`), dates (`Asia/Aden`, AR months), phone, `bdi` helper.
- [ ] Auth flows web + mobile; middleware; locale persistence (profile → cookie → Accept-Language).
- [ ] Sentry (web + mobile), error boundaries, 404/500 localized pages.
- [ ] GitHub Actions + PR template + phase checklist; branch protection.
- [ ] Seed skeleton (`supabase/seed.sql`) with a demo admin + `platform_settings` defaults.

### Acceptance criteria
- `pnpm i && pnpm dev` runs web + Expo; `/ar` and `/en` both render, with correct `dir`, fonts and copy.
- Switching locale on a deep link keeps the same path and query; `<html dir>` flips; no visual reflow breakage.
- CI fails if a key is missing in `ar.json` or `en.json`, or if `margin-left`/`float:right` appear in feature code.
- Signing up with a local OTP creates an `auth.users` row; the app lands on a localized, protected-profile screen.
- `pnpm db:types` is idempotent; CI fails on schema/type drift.
- Landing page: Lighthouse a11y ≥ 95 in both directions; ≤ 200 KB initial JS.

**Estimate:** 5–6 days.

---

## Phase 1 — Identity, Accounts & Verification

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
- [ ] Migrations: profiles/orgs/members/user_roles/verification_requests + enums + indexes + `updated_at` triggers.
- [ ] RLS on every table + pgTAP matrix (anon, unverified, verified, org member, staff, finance, admin).
- [ ] RPCs: `submit_verification`, `decide_verification`, `create_organization`, `update_organization`,
      `invite_member`, `accept_invite`, `remove_member`, `grant_role`, `revoke_role`, `set_preferred_locale`.
- [ ] Storage `avatars` (public) + `verification-docs` (private) + policies + signed URL helper.
- [ ] Notifications table + in-app bell/toast (channels wired Phase 11).
- [ ] Web: onboarding wizard, company settings, team management, `/staff/verifications`, `/admin/users`, `/admin/roles`.
- [ ] Mobile: auth, profile, verification upload, company switcher.
- [ ] Locale preference persisted on profile and applied on next login (web + mobile).
- [ ] Fixtures: 1 admin, 2 staff, 1 finance officer, 3 verified individuals, 2 verified companies, 1 unverified of each.

### Acceptance criteria
- Unverified user sees "add vehicle / create trip" disabled **and** the RPC returns `NOT_VERIFIED` when called directly.
- Company owner invites a manager → invitee accepts → can switch context → permissions differ correctly.
- Staff approve a profile → verified badge appears without reload; notification row created; audit row has actor + reason.
- Revoked verification immediately blocks all gated actions.
- Every screen of this phase renders correctly in `ar` (RTL) and `en` (LTR); no hardcoded strings in diffs.
- pgTAP: an unverified user cannot read another user's verification documents.

**Estimate:** 7 days.

---

## Phase 2 — Geography, Places & Supervisor Scoping

**Goal:** the places component for all of Yemen, admin-managed, plus region/sub-region scoping.

### Deliverables
- `regions` (self-referencing), `governorates`, `districts` (+geometry), `places`, `region_governorates`,
  `region_districts`, `geo_assignments`.
- Seed: 22 governorates, ~333 districts (OCHA P-codes), ~200 curated places — idempotent.
- Admin console: geography CRUD, region builder (governorates and/or districts), CSV/GeoJSON import with
  dry-run diff, place-verification queue, supervisor assignment.
- Shared `<PlacePicker>` (web + mobile): AR/EN trigram autocomplete with Arabic normalisation, aliases,
  governorate→district cascade, popular places, "use my location", custom gathering point creation.
- MapLibre map component with point selection; localized map labels.
- `app.in_geo_scope()`, `app.trip_in_scope()`, `trip_scope_index`.

### Tasks
- [ ] PostGIS migrations + GIST + trigram indexes on `name_ar_norm` / `name_en_norm` / `aliases`.
- [ ] Import scripts under `scripts/geo/` (governorates static, districts OCHA/HDX, places curated CSV).
- [ ] RPCs: `search_places(locale, q, filters)`, `nearest_place`, `create_place`, `admin_upsert_region`,
      `assign_region_coverage`, `assign_geo_supervisor`, `bulk_import_geo` (dry-run + apply).
- [ ] Admin UI `/admin/geography` (tree + map + import wizard), `/admin/supervisors`.
- [ ] `<PlacePicker>` hooks in core + web + mobile implementations; bidi-safe labels (`<bdi>`).
- [ ] Scope helpers + pgTAP: supervisors see only scoped rows; others see none; passenger-visibility flag honoured.

### Acceptance criteria
- Typing «عدن» returns governorate, districts and POIs; typing «الحوطة» disambiguates by governorate; same in English.
- Arabic search tolerates hamza/alef/teh-marbuta variants and missing diacritics.
- Admin creates «إقليم المرتفعات» with 6 governorates + 4 extra districts from another governorate; supervisors assigned.
- A supervisor scoped to Aden sees only Aden-intersecting trips (fixtures prove it); out-of-scope returns empty.
- Re-running the districts import changes nothing (`+0 ~0 -0`).
- Place picker and admin tree render correctly in RTL and LTR; map controls mirrored but map itself is not.

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
- [ ] RPCs: `create_vehicle`, `update_vehicle`, `submit_vehicle_verification`, `decide_vehicle_verification`,
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
- [ ] Migrations: trips/trip_stops + enums (`trip_status`, verification status, `booking_mode`, `discount_kind`,
      `pricing_mode`, `gender_policy`, `payment_policy`) + constraints (seats, ordering, no duplicate consecutive stops).
- [ ] `app.assert_trip_editable()`, `app.actor_can_manage_trip()`, `app.recompute_seats_available()`,
      `app.set_trip_visibility()`.
- [ ] `trips_search` refresh triggers + indexes (GIN stop ids, btree date/price, trigram names, featured boost).
- [ ] RPCs: `create_trip`, `update_trip`, `set_trip_stops`, `publish_trip`, `submit_trip_verification`,
      `decide_trip_verification`, `cancel_trip`, `search_public_trips(locale, filters, sort, cursor)`,
      `get_trip_public`, `staff_search_trips`.
- [ ] Facets (`{ items, facets, total }`) + 30 s cache + k6 benchmark script.
- [ ] Pricing engine in `@maak/core/pricing.ts` mirroring DB math + Vitest parity tests against RPC fixtures.
- [ ] Web `/operator/trips/*`, `/trips`, `/trips/[code]`, `/staff/trips`; localized forms with `Asia/Aden` timezone.
- [ ] Mobile search/filter/results/detail.
- [ ] pgTAP: unverified cannot create; edit blocked at 1h59m (frozen clock); drafts/rejected/completed hidden publicly.

### Acceptance criteria
- Verified operator creates Sana'a → Aden with 2 stops, per-stop pricing, 10% discount, publishes → visible publicly in < 1 s.
- Cascading filters behave: choosing «عدن» narrows origin options with counts; «بدون توقف» removes stop-only trips.
- Editing 1h59m before departure returns `EDIT_WINDOW_CLOSED` from the RPC, not just a disabled button.
- Completed/cancelled trips disappear from `/trips` instantly and remain in `/staff/trips`.
- Search p95 < 300 ms at 50k seeded trips (k6 report attached).
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
- [ ] Migrations + enums (`booking_status`, `id_type`, `payment_status`) + constraints (identity fields required).
- [ ] RPCs: `create_booking`, `accept_booking`, `reject_booking`, `cancel_booking_by_passenger`,
      `cancel_booking_by_operator`, `expire_booking_holds`, `get_trip_manifest_data`, `create_id_share_link`,
      `resolve_id_share_token`, `compute_refund`.
- [ ] Storage `passenger-ids` (private) + policies + 5-min signed URLs + watermark on preview.
- [ ] Cron: `expire_holds`, `auto_complete_bookings`, `purge_expired_id_documents`.
- [ ] Web `/trips/[code]/book`, `/operator/trips/[id]/bookings`, `/me/bookings`, `/s/[token]`.
- [ ] Mobile booking wizard, my bookings, ticket.
- [ ] pgTAP: parallel last-seat bookings (exactly one wins), cutoff enforcement, cross-org access denied, refund math.

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
- [ ] Migrations: pings (partitioned), progress, route geometry, odometer readings, richer trip_events.
- [ ] `app.recompute_trip_progress`: nearest upcoming stop (KNN), polyline or haversine distance, ETA from rolling speed.
- [ ] Routing provider at publish (cached; OSRM/ORS) + graceful fallback.
- [ ] RPCs: `start_trip`, `end_trip`, `record_trip_ping`, `mark_stop_reached`, `report_incident`,
      `get_trip_progress`, `get_driver_trips_today`, `check_in_passenger`.
- [ ] Realtime publication + private-channel policy + `useTripProgress()` hook in core.
- [ ] Mobile: driver flow, `expo-task-manager` background location, queue, permission UX (iOS/Android), bilingual prompts.
- [ ] Web passenger live page `/trips/[code]/live`, stale states, route map.
- [ ] pgTAP: start blocked when unverified/early; monotonic ODO; out-of-order pings; visibility limited to accepted passengers.

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
- [ ] `qr_token` generation + `GET /api/qr/trip/:token` resolver + rate limiting.
- [ ] Scanner UI (web: `barcode-detector`/zxing; mobile: `expo-camera`) with permission prompts localized.
- [ ] RPCs: `bulk_verify_trips`, `bulk_verify_trips_with_passengers`, `bulk_verify_passengers`,
      `bulk_verify_entities`, `get_trip_for_staff(token)`, `staff_search_trips`, `log_document_access`.
- [ ] PDF route `GET /api/trips/:id/manifest.pdf?locale=ar|en` + Arabic font subset; layout tests at 4/14/30 passengers.
- [ ] Staff web `/staff/scans`, `/staff/trips/[id]` (manifest + bulk passengers), `/staff/dashboard`, `/supervisor/*`.
- [ ] Mobile scanner screen + manifest link.
- [ ] pgTAP: out-of-scope verification blocked; passenger detail respects `can_view_passengers`; PDF forbidden for passengers.
- [ ] PDF snapshot tests (text extraction, page count) in both locales.

### Acceptance criteria
- Aden-scoped supervisor scanning an Aden trip sees it; an out-of-scope supervisor sees «خارج نطاقك» / “Outside your scope”.
- Bulk verify 10 trips + passengers → `9 verified, 1 failed (out of scope)` with per-row reasons.
- 14-passenger manifest fits one A4 page; Arabic renders correctly (no tofu) and English renders LTR cleanly.
- Passenger cannot download the manifest (`403`); generation is audited and visible in the audit explorer.
- Historical search finds last month's completed trip by date range + governorate; CSV matches the filtered rows.

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
- [ ] Migrations + generated columns + `app.vehicle_odometer_guard()` + `app.recompute_maintenance_status()`.
- [ ] Cron: daily maintenance scan → reminders; overdue escalation.
- [ ] RPCs: `log_fuel`, `log_maintenance`, `upsert_maintenance_schedule`, `mark_maintenance_done`,
      `record_manual_odometer`, `get_vehicle_health`, `get_fleet_summary`.
- [ ] Expense sync triggers (fuel/maintenance → `expenses`, soft-delete → reversing entry stub for Phase 10).
- [ ] Web `/operator/vehicles/[id]/health`, `/operator/fleet`, exports.
- [ ] Mobile fuel/ODO quick actions.
- [ ] Tests: consumption math, due-date math, timezone-safe date handling (Vitest + pgTAP).

### Acceptance criteria
- Two full-tank logs 450 km / 38 L apart → dashboard shows 8.4 L/100km.
- Schedule "oil every 5,000 km" with last at 120,000 → due 125,000; 124,600 shows “due soon”; 125,300 “overdue”.
- End-trip ODO advances the vehicle total automatically; a lower manual reading is rejected unless the owner
  overrides with a reason (audited).
- Fleet dashboard totals reconcile with underlying logs.
- An overdue vehicle is blocked from new trip assignment when the setting is on.
- Fuel/maintenance costs appear as expenses ready for the finance module.

**Estimate:** 6 days.

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
- [ ] Migrations + enums (`payment_method`, `payment_status`, `purpose`, `account_status`, `agent_tx_kind`) + constraints.
- [ ] RLS: payer sees own intents, owner org sees trip-related, finance sees all, agents see own float.
- [ ] RPCs: `create_payment_intent`, `submit_payment_proof`, `confirm_payment`, `reject_payment`,
      `cancel_payment_intent`, `expire_stale_payments`, `request_refund`, `decide_refund`, `pay_refund`,
      `create_payment_account`, `verify_payment_account`, `archive_payment_account`,
      `agent_cash_in`, `request_payout`, `approve_payout`, `mark_payout_paid`.
- [ ] Ledger **posting stubs** for confirm/refund (entries created; full ledger from Phase 10 lands here or there —
      decided: ledger tables ship in Phase 10, Phase 9 writes to an outbox table so no money event is ever lost).
- [ ] Storage `payment-proofs` + policies + 180-day retention job + proof hashing.
- [ ] Cron: stale intent expiry, unmatched-deposit reminders, agent settlement reminders.
- [ ] Web `/pay/[intent]`, `/operator/payments`, `/finance/payments`, `/finance/accounts`, `/finance/agents`, `/operator/payouts`.
- [ ] Mobile pay/upload/status + driver cash-collect sheet.
- [ ] pgTAP: double-confirm prevented (idempotency), proof reuse blocked, out-of-scope account edits denied,
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
- [ ] Migrations: ledger tables + `assert_balanced_journal()` deferred constraint trigger + revoke UPDATE/DELETE.
- [ ] `post_journal(entries[], source)` helper + one posting function per money event (payment, refund, payout,
      invoice, commission, subscription, adjustment) — the only writers.
- [ ] Plans/limits/subscriptions migrations + seeds (Basic/Pro/Business from §6.14) + `app.owner_effective_plan()`
      replacing the Phase 1 stub with real resolution (Basic fallback, trial, grace, expiry, overrides).
- [ ] `app.assert_quota()` wired into every guarded RPC + `usage_counters` upsert + `quota_violations` logging.
- [ ] RPCs: `start_subscription`, `change_plan`, `cancel_subscription`, `renew_subscription` (idempotent on invoice),
      `expire_subscriptions`, `request_payout`, `approve_payout`, `mark_payout_paid`, `issue_invoice`, `void_invoice`,
      `post_manual_journal`, `import_reconciliation`, `get_finance_dashboard`, `get_statement`, `export_finance`.
- [ ] Cron: subscription expiry/grace, usage period rollover, statement generation, integrity job.
- [ ] PDF: invoice + statement templates (AR/EN, RTL/LTR) with the same font pipeline as the manifest.
- [ ] Web `/finance/*` (dashboard, invoices, statements, payouts, reconciliation), `/operator/billing`,
      `/admin/plans`, `/admin/commissions`, `/admin/subscriptions`.
- [ ] pgTAP: journal always balances; double posting impossible; commission math; refund math; payout limits;
      quota boundaries per metric; downgrade keeps existing resources; trial→expiry fallback; period rollover.
- [ ] Vitest: finance formatters, proration, commission rounding, statement math parity with SQL.

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
- [ ] `notifications`, `notification_preferences`, `saved_searches`, `saved_search_matches` + RLS.
- [ ] `app.enqueue_notification()` (outbox) + edge function `dispatch` (push/email) with retries + dead-letter table.
- [ ] Cron: `match_saved_searches`, `send_trip_reminders`, `notify_pending_verifications`,
      `notify_quota_thresholds`, `retry_failed_notifications`.
- [ ] Template registry (per event, AR/EN, zod-validated variables) + preview screen for admins.
- [ ] Web/mobile notification centre + preference screens (RTL-safe toggles).
- [ ] Tests: dispatch idempotency (no duplicate push on retry), quiet hours, opt-out respected, deep links resolve.

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
  generated RPC/API reference.
- UAT with 3 pilots (1 company, 2 individuals) and burn-down of findings.

### Tasks
- [ ] k6 suites (search, booking race, ping ingest, payment confirmation volume) + results in `docs/perf/`.
- [ ] `EXPLAIN ANALYZE` review of the top 10 queries; missing indexes; autovacuum tuning for pings table.
- [ ] Security checklist execution + fixes; `supabase db lint`, `plpgsql_check`, `npm audit` clean.
- [ ] Backup restore into a scratch project with documented timings.
- [ ] Alerts: error rate, stale live trips, failed notifications, imbalanced journals, verification backlog,
      payment confirmation SLA breach.
- [ ] EAS build/submit config, store listings, privacy policy + terms (AR/EN).
- [ ] UAT script + sessions + issue burn-down.
- [ ] Tag `v1.0.0`, changelog, handover session.

### Acceptance criteria
- Search p95 < 300 ms, write RPC p95 < 250 ms, finance dashboard p95 < 500 ms under stated load.
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
| 0 | Foundations & bilingual shell | ⬜ Not started | — | next up |
| 1 | Identity & Trust | ⬜ | | |
| 2 | Geography & Places | ⬜ | | |
| 3 | Fleet | ⬜ | | quota hooks wired (Basic defaults) |
| 4 | Trips & Marketplace | ⬜ | | quota hooks wired |
| 5 | Bookings | ⬜ | | refund math ready for 9/10 |
| 6 | Live Execution | ⬜ | | |
| 7 | Staff Operations | ⬜ | | |
| 8 | Vehicle Operations | ⬜ | | feeds expenses into 10 |
| 9 | Payments | ⬜ | | ledger outbox → 10 |
| 10 | Finance & Subscriptions | ⬜ | | activates quotas + plan billing |
| 11 | Notifications & Polish | ⬜ | | |
| 12 | Hardening & Launch | ⬜ | | |

---

## What I need from you to start Phase 0

1. **Go-ahead** — nothing else blocks scaffolding.
2. Answers to the seven open questions in `specs.md` §19 are needed before **Phase 10**, not before Phase 0.
   The two that shape early UI: Is Basic truly free (0 YER)? Is commission on the seat fare for all confirmed bookings?
3. Confirm the seeded plan values in §6.14 (1/5/∞ vehicles, 5/50/∞ trips, 1/5/∞ staff, 1/10/∞ drivers) or send yours.
