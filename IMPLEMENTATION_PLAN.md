# Maak — Implementation Plan (Phased)

Companion to [`specs.md`](./specs.md). Eleven phases, each independently shippable.
We build **one phase at a time**: I code it on this branch → you review the running preview →
we merge → next phase.

```
Phase 0  Foundations           ── scaffold, CI, design system, i18n/RTL
Phase 1  Identity & Trust      ── accounts, companies, roles, verification
Phase 2  Geography & Places    ── regions, governorates, districts, POI, scoping
Phase 3  Fleet                 ── vehicles (full spec), drivers, assignments
Phase 4  Trips & Marketplace   ── create/publish trips, public search + filters
Phase 5  Bookings              ── passenger data, ID docs, WhatsApp, accept/cancel
Phase 6  Live Execution        ── start/end + ODO, 10-min pings, progress
Phase 7  Staff Operations      ── QR, bulk verify, A4 manifest, history search
Phase 8  Vehicle Operations    ── fuel, maintenance, auto schedules, dashboards
Phase 9  Notifications & Polish── push/email/WA, preferences, saved searches
Phase 10 Hardening & Launch    ── perf, security, stores, runbooks, UAT
```

Estimated effort (one experienced full-stack dev, focused): **~15 weeks**. Phases 0–6 (~10 weeks)
already deliver a usable product (publish → book → run → track).

---

## Working agreement (how each phase runs)

1. **Kick-off (me):** restate the phase scope + the exact acceptance tests I will run.
2. **Build (me):** migrations → RPCs → pgTAP tests → core package → web UI → mobile UI (if in scope).
3. **Demo (you):** I start the app on a live preview, seed demo data, and post a walkthrough + screenshots.
4. **Review:** you test the acceptance checklist. Changes happen inside the same phase.
5. **Gate:** merge PR `phase-N: <name>` → I tick the phase in this file → next phase starts.

**Every phase ends with:** green CI (typecheck, lint, unit, pgTAP, e2e smoke), zero `db diff` drift,
updated `specs.md` if reality changed, and a one-paragraph changelog here.

---

## Phase 0 — Foundations & Scaffold

**Goal:** a running skeleton on web + mobile + local Supabase, with the cost-saving architecture baked in
from the first commit (not retrofitted later).

### Deliverables
- pnpm + Turborepo monorepo: `apps/web`, `apps/mobile`, `packages/core`, `packages/design-tokens`, `packages/config`.
- Next.js app (App Router, TS strict): layout, Arabic RTL + English, theme tokens, PWA manifest, error/empty states.
- Expo app (expo-router): tabs shell, auth screens placeholder, NativeWind with the same tokens.
- Supabase local: `config.toml`, schemas `public` / `app` / `audit`, migration convention, `gen types` script.
- `@maak/core`: typed Supabase client factory, RPC wrapper, zod base schemas, i18n (`ar`/`en`), formatters (money, dates, Arabic numerals).
- Auth shell: sign-in/sign-up screens wired to Supabase (phone OTP + email), session handling on web (SSR cookies) and mobile (SecureStore).
- CI: install → typecheck → lint (incl. module boundaries) → unit → `supabase db lint` → types-drift check → build web.
- Sentry wiring (web + mobile), `.env.example`, README quickstart.

### Tasks
- [ ] Init pnpm workspace + turbo pipeline + shared tsconfig/eslint/prettier.
- [ ] Scaffold Next.js with Tailwind, fonts (Arabic: Cairo/IBM Plex Sans Arabic), RTL provider, locale switcher.
- [ ] Scaffold Expo app with expo-router + NativeWind + shared tokens + Arabic fonts.
- [ ] Supabase init; create `app` and `audit` schemas; add extension `postgis`, `pg_trgm`, `pgcrypto`.
- [ ] Migration `0001_extensions_schemas.sql`, `0002_audit_log.sql`, helper `app.current_profile_id()`.
- [ ] Supabase clients (browser, server, mobile) + `gen types` script + committed `database.types.ts`.
- [ ] `@maak/core`: RPC helper with typed errors, `Result` type, error-code → Arabic message map.
- [ ] i18n scaffolding + a11y/RTL lint rules (no hardcoded strings rule via custom eslint).
- [ ] Auth flow (web + mobile) + middleware for protected routes + role-aware redirect stub.
- [ ] GitHub Actions CI + branch protection + PR template + phase checklist template.
- [ ] Seed script skeleton (`supabase/seed.sql`) with a demo admin user.

### Acceptance criteria
- `pnpm i && pnpm dev` starts web (3000), mobile (Expo), and links to local Supabase (54321).
- Signing up with a phone OTP in local Supabase creates an `auth.users` row and (stub) `profiles` row.
- Arabic/English switch flips layout direction and all visible copy; no hardcoded UI strings.
- CI is green on an empty-feature PR; `pnpm db:types` is idempotent and committed types match schema.
- Lighthouse a11y ≥ 95 on the landing page.

**Estimate:** 4–5 days.

---

## Phase 1 — Identity, Accounts & Verification

**Goal:** real multi-tenant identity: individuals, companies, staff roles, and the verification workflow
that gates everything else (BR-01..03).

### Deliverables
- `profiles`, `organizations`, `organization_members`, `user_roles`, `verification_requests`, `audit_log` policies.
- Onboarding flows: individual verification submit; company creation + verification submit; team invites (phone/email).
- Account switcher (personal ↔ company) with server-evaluated permissions.
- Verification review console (platform staff): queue, filters, document viewer, approve/reject with reason, audit trail.
- Role grant UI (platform admin only) for `platform_staff` and `geo_supervisor` (scope assigned in Phase 2).
- `app.is_verified_actor()`, `app.has_role()`, `app.my_orgs()` helper functions + pgTAP role matrix.
- Shared: `useSession()`, `useActiveAccount()`, `<Can/>` UI guard (cosmetic only), `VerifiedBadge`.
- Mobile: sign-in, profile, verification submission with camera capture.

### Tasks
- [ ] Migrations: profiles, organizations, members, user_roles, verification_requests (+ enums, indexes, triggers `updated_at`).
- [ ] RLS for every table + pgTAP tests per role (anon, unverified, verified, org member, staff, admin).
- [ ] RPCs: `submit_verification`, `decide_verification`, `create_organization`, `invite_member`, `accept_invite`, `grant_role`, `revoke_role`, `set_active_account` (client-side context only).
- [ ] Storage buckets `avatars`, `verification-docs` + policies + signed URL helper.
- [ ] Notifications table stub + in-app toast/bell (channels wired in Phase 9).
- [ ] Web: onboarding wizard, company settings, team management, staff review console (`/staff/verifications`).
- [ ] Web admin: users/orgs list, grant/revoke roles, suspend account.
- [ ] Mobile: auth screens, profile, verification upload, company switcher.
- [ ] Seeded fixtures: 1 admin, 2 staff, 3 verified individuals, 2 verified companies, 1 unverified of each.

### Acceptance criteria
- Unverified user sees "add vehicle / create trip" disabled **and** calling the RPC directly returns `NOT_VERIFIED`.
- Company owner invites a manager; the invitee accepts and can switch into the company; permissions differ correctly.
- Staff approve a profile → user sees verified badge without page reload (realtime/refetch) + notification row.
- Every decision appears in `audit_log` with actor, reason, timestamp; revoked verification immediately blocks actions.
- pgTAP matrix: an unverified user cannot read another user's verification documents.

**Estimate:** 6–7 days.

---

## Phase 2 — Geography, Places & Supervisor Scoping

**Goal:** the "places component" for all of Yemen, admin-managed, plus region/sub-region supervisor scoping
(needed by trips, search, and staff operations).

### Deliverables
- Tables: `regions` (self-referencing), `governorates`, `districts` (with geometry), `places`,
  `region_governorates`, `region_districts`, `geo_assignments`.
- Seed: 22 governorates, ~333 districts, ~200 curated places (airports, ports, borders, landmarks, universities, hospitals, markets) — idempotent.
- Admin console: geography CRUD, region builder (assign governorates **and/or** districts to regions/sub-regions),
  bulk CSV/GeoJSON import with dry-run diff, place verification queue.
- **Shared `<PlacePicker>`** (web + mobile): trigram autocomplete in AR/EN + aliases, governorate/district cascade,
  popular places, "use my location" (nearest place), custom gathering-point creation.
- Map component (MapLibre) with point selection.
- Geo supervisor assignment UI: user → scope (region/sub-region/governorate/district) + `can_view_passengers`.
- `app.in_geo_scope(place_id)`, `app.trip_in_scope(trip_id)` helpers + `trip_scope_index` (filled in Phase 4).

### Tasks
- [ ] PostGIS-enabled migrations + GIST indexes + trigram indexes on names/aliases.
- [ ] Import scripts (`scripts/geo/*`): governorates (static), districts (OCHA/HDX p-codes + geometry), places (curated CSV).
- [ ] RPCs: `search_places`, `nearest_place`, `create_place`, `admin_upsert_region`, `assign_region_coverage`, `assign_geo_supervisor`, `bulk_import_geo`.
- [ ] Admin UI: `/admin/geography` (tree + map + import wizard), `/admin/supervisors`.
- [ ] `<PlacePicker>` + `<RegionSelect>` in `@maak/core` hooks + web components + mobile components.
- [ ] Scope helpers + pgTAP: supervisor sees only scoped rows; non-supervisor sees none.

### Acceptance criteria
- Typing "عدن" returns Aden governorate, districts, and POIs; typing "الحوطة" disambiguates duplicates by governorate.
- Admin creates region «إقليم المرتفعات» → assigns 6 governorates + 4 extra districts from another governorate → supervisors assigned to it.
- A geo supervisor assigned to Aden sees only trips/places intersecting Aden (verified with fixtures).
- Import of a districts CSV is idempotent: running it twice changes nothing; dry-run shows `+0 ~0 -0`.

**Estimate:** 6–7 days.

---

## Phase 3 — Fleet: Vehicles & Drivers

**Goal:** the full vehicle specification, driver profiles, verification, and assignments — the assets trips need.

### Deliverables
- `vehicles` with the complete attribute set (identity, mechanical, capacity, comfort, safety/compliance,
  accessibility, appearance, media, operational) — see `specs.md` §6.3.
- `vehicle_photos`, `driver_profiles`, `vehicle_driver_assignments`, `odometer_readings` (baseline only here).
- Vehicle wizard (7 steps, resumable) with photo upload, document expiry validation, duplicate-plate warning.
- Driver management: invite driver by phone, licence capture, verification, assign/unassign to vehicles.
- Vehicle verification queue for staff (docs viewer, approve/reject/revoke, audit).
- Vehicle list/detail cards with status badges (verified, insurance expiring, maintenance due placeholder).
- Mobile: driver profile + licence upload; vehicle quick view.

### Tasks
- [ ] Migration with ~60 vehicle columns + enums (`drive_type`, `transmission`, `fuel_type`, `body_type`, `vehicle_status`) + constraints.
- [ ] RLS: owner/org isolation; staff read-all; verification gated writes.
- [ ] RPCs: `create_vehicle`, `update_vehicle`, `submit_vehicle_verification`, `decide_vehicle_verification`,
      `invite_driver`, `accept_driver_invite`, `verify_driver`, `assign_driver_to_vehicle`, `set_vehicle_status`.
- [ ] Storage `vehicle-photos` (public) + `vehicle-documents` (private) policies.
- [ ] Web: `/operator/vehicles` (list, wizard, detail), `/operator/drivers`, `/staff/vehicles`.
- [ ] Mobile: `/driver/profile`, `/driver/vehicle/[id]`.
- [ ] pgTAP: unverified actor cannot insert vehicle; org A cannot read org B vehicles.

### Acceptance criteria
- A verified individual registers a 2019 Toyota Hiace (trim, 4WD? etc.), uploads 3 photos + insurance doc, submits → staff approves → badge turns verified.
- Unverified account cannot add a vehicle (UI disabled + RPC `NOT_VERIFIED`).
- Driver invite → driver logs in on mobile → sees assigned vehicle.
- Expiring insurance (fixture) shows an amber warning on the vehicle card.
- All vehicle fields round-trip through create → detail → edit without loss.

**Estimate:** 6 days.

---

## Phase 4 — Trips, Pricing & Public Marketplace

**Goal:** verified operators publish trips; anyone finds them with cascading filters. This is the product's core.

### Deliverables
- `trips`, `trip_stops`, `trip_events`, `trip_verifications`, `trips_search` (denormalised) + visibility rules (BR-07/08).
- Trip creation wizard: route → schedule → stops → capacity/pricing (flat or per-stop) → discount → vehicle/driver → policies → review.
- Rules: verification submission, 2-hour edit lock (BR-06), audited edits, re-verification policy, cancel trip.
- Operator console: trip list with statuses, trip detail (edit, publish, cancel), calendar view.
- **Public marketplace**: `/trips` with cascading facets, sorting, keyset pagination, map/list toggle, SEO metadata + JSON-LD, share links.
- Trip detail page: route timeline, stop prices, discount breakdown, operator card, seats left, book CTA, policies.
- Saved-search-ready filter serialisation in the URL (shareable links).
- Staff trip search over all trips incl. historical (basic; bulk tools in Phase 7).
- Trip history page for users (own trips/bookings, Phase 5 fills bookings).
- Mobile: browse + filters + trip detail.

### Tasks
- [ ] Migrations: trips, trip_stops, enums (`trip_status`, `trip_verification_status`, `booking_mode`, `discount_kind`, `pricing_mode`, `gender_policy`), constraints:
      seats > 0, price ≥ 0, stops ordered, no duplicate consecutive stops, `departure_at > now()` on publish.
- [ ] `app.assert_trip_editable()`, `app.actor_can_manage_trip()`, `app.recompute_seats_available()`, `app.set_trip_visibility()`.
- [ ] `trips_search` refresh triggers + indexes (GIN stop ids, btree date/price, trigram place names).
- [ ] RPCs: `create_trip`, `update_trip`, `set_trip_stops`, `publish_trip`, `submit_trip_verification`,
      `decide_trip_verification`, `cancel_trip`, `search_public_trips`, `get_trip_public`, `staff_search_trips`.
- [ ] Facet computation (`facets jsonb`) + 30 s cache table + k6 benchmark script.
- [ ] Web: `/operator/trips/*`, `/trips` (search), `/trips/[code]` (detail), `/staff/trips`.
- [ ] Mobile: search screen with filter sheet, results list, trip detail.
- [ ] Pricing engine in `@maak/core/pricing.ts` (mirrors DB math) + Vitest parity tests against RPC fixtures.
- [ ] pgTAP: unverified cannot create; edit blocked inside 2 h (frozen clock); public query hides draft/rejected/completed.

### Acceptance criteria
- Verified operator creates a Sana'a → Aden trip with 2 stops, per-stop pricing, 10% discount, publishes (auto-verify on for verified actors in staging) → appears publicly within 1 s.
- Filters cascade: choosing "عدن" as destination narrows origin options with counts; "بدون توقف" removes stop-only options.
- Attempting an edit 1 h 59 m before departure returns `EDIT_WINDOW_CLOSED` from the RPC (not just a disabled button).
- Completed/cancelled trips disappear from `/trips` immediately and remain visible in `/staff/trips`.
- Search p95 < 300 ms with 50k seeded trips (k6 result attached to the PR).
- Shared URL reproduces the exact filter state.
- Trip detail is LCP < 2.5 s on throttled mobile and passes SEO structured-data validation.

**Estimate:** 9–10 days.

---

## Phase 5 — Bookings, Passenger Data & Requests

**Goal:** turn interest into confirmed seats, with the identity/trust model passengers need.

### Deliverables
- `bookings`, `passenger_documents`, `document_access_log`; seat reservation with `FOR UPDATE` (BR-10), holds + expiry cron (BR-11).
- Booking flow: stop selection, seats, price breakdown, passenger identity form (name, ID type/number, place of birth, mobile, note), ID photo upload (camera/file), optional WhatsApp private share.
- Signed WhatsApp share links (`/s/:token`, 72 h, watermarked viewer, view audited).
- Operator inbox: pending requests per trip, accept/reject with reason, bulk accept later; accepted passenger list.
- Cancellations: passenger (≥2 h, BR-09), operator (anytime, reason), auto `no_show`/`completed`.
- My bookings (upcoming/past), booking detail with status, cancel, share ticket, re-book.
- Notifications: request/accepted/rejected/cancelled (in-app now, channels in Phase 9).
- Mobile: booking flow, my bookings, ticket QR.

### Tasks
- [ ] Migrations + enums (`booking_status`, `id_type`) + constraints (seats ≥ 1, identity fields NOT NULL for pending).
- [ ] RPCs: `create_booking`, `accept_booking`, `reject_booking`, `cancel_booking_by_passenger`,
      `cancel_booking_by_operator`, `expire_booking_holds` (cron), `get_trip_manifest_data`, `create_id_share_link`, `resolve_id_share_token`.
- [ ] Storage `passenger-ids` (private) + policies + signed URL (5 min) + watermark on preview.
- [ ] Cron: `expire_holds`, `auto_complete_bookings`, `purge_expired_id_documents`.
- [ ] Web: `/trips/[code]/book`, `/operator/trips/[id]/bookings`, `/me/bookings`, `/s/[token]` viewer.
- [ ] Mobile: booking wizard, my bookings, ticket.
- [ ] pgTAP: overbooking rejected under concurrency (parallel transactions), cutoff enforcement, cross-org booking access denied.

### Acceptance criteria
- Two simultaneous bookings for the last seat → exactly one succeeds; the other gets `NO_SEATS_LEFT`.
- Passenger cancels 2 h 5 m before departure: OK. 1 h 55 m: `CANCEL_WINDOW_CLOSED`.
- Pending booking holds the seat, expires after the hold window, seat returns automatically.
- ID image is accessible only to the booking owner, trip owner org, and authorized staff; every access logged; URL expires in 5 min.
- WhatsApp share link opens a watermarked ID preview visible only to the trip owner (verified with two accounts) and expires in 72 h.
- Operator rejects a booking → seat released, passenger notified, reason shown.

**Estimate:** 7–8 days.

---

## Phase 6 — Trip Execution, ODO & Live Tracking

**Goal:** the trip actually runs: verified-only start, odometer discipline, 10-minute location, meaningful progress.

### Deliverables
- Driver console (mobile): today's trips, start (blocked unless verified, BR-05), ODO + photo, running screen, "reached stop", end with ODO.
- `trip_location_pings` (monthly partitioned), `record_trip_ping`, `app.recompute_trip_progress`, `trip_progress`, `trip_route_geometry`.
- Background location (10 min) with offline queue; web fallback "I'm here" + geolocation while open.
- Passenger live screen: map, "now at <place>", next stop + km + ETA, destination km + ETA, progress %, live/stale badge, seats remaining.
- Realtime (private channel `trip:<id>`) + 30 s polling fallback; staleness rules + ops alert.
- Start/end integration with odometer: vehicle `current_odometer_km` update, distance check, anomaly flag.
- Trip status automation (cron): auto `in_progress` at departure if not started, auto-complete rules, stale-trip alerts.
- Passenger list for driver (check-in by tap, offline tolerant).

### Tasks
- [ ] Migrations: pings (partitioned), progress, route geometry, odometer readings, trip_events enrichment.
- [ ] `app.recompute_trip_progress`: nearest upcoming stop (KNN), polyline or haversine distance, ETA from rolling speed.
- [ ] Routing provider integration at publish (cache; OSRM/ORS) + graceful fallback.
- [ ] RPCs: `start_trip`, `end_trip`, `record_trip_ping`, `mark_stop_reached`, `report_incident`, `get_trip_progress`, `get_driver_trips_today`.
- [ ] Realtime publication + private channel policy + client subscription hook in `@maak/core`.
- [ ] Mobile: driver flow screens + `expo-task-manager` background location + queue + permissions UX (iOS/Android).
- [ ] Web: passenger live page (`/trips/[code]/live`), stale states, map with route + stops.
- [ ] pgTAP: start blocked when unverified; monotonic ODO; out-of-order/backwards ping handling; visibility limited to accepted passengers.

### Acceptance criteria
- Driver taps start 3 h before departure → `TOO_EARLY`; on an unverified trip → `TRIP_NOT_VERIFIED`.
- Start requires an ODO value ≥ last reading; lower value is rejected with a clear Arabic message.
- Pings every 10 min move the map and update the text: «الآن في X · يتبقى 24 كم لأقرب توقف · يتبقى 137 كم للوصول».
- A non-booked user calling `get_trip_progress` gets `FORBIDDEN`; a booked passenger gets live updates < 2 s.
- No ping for 21 min shows «الموقع غير محدّث» with last known point and time.
- End trip writes ODO, updates vehicle total, flags a 25% distance anomaly in fixtures.

**Estimate:** 8–9 days.

---

## Phase 7 — Staff Operations: QR, Bulk Verification, A4 Manifest

**Goal:** the authority/supervisor toolset: scan, verify in bulk, print.

### Deliverables
- Trip QR: token generation, printable QR on operator trip page, in-app scanner (web + mobile), permission-trimmed trip view, scan audit.
- Bulk verification:
  - trips (verify/reject),
  - trips + their passengers,
  - passengers within one trip,
  - entities (profiles/orgs/vehicles/drivers) for ops.
  - All scoped by geo assignment, per-row results, confirm dialog with reason, audit + notifications.
- A4 manifest PDF (server-rendered, Arabic font, QR, vehicle block, driver block, passengers table, compact 2-col).
- Staff trip search with full filters (incl. historical/cancelled), CSV export.
- Supervisor dashboard: pending verifications in scope, live trips in scope, stale trips, recent scans.

### Tasks
- [ ] `qr_token` generation on verify + `GET /api/qr/trip/:token` resolver + rate limiting.
- [ ] Scanner UI (web: `barcode-detector`/zxing; mobile: `expo-camera`).
- [ ] RPCs: `bulk_verify_trips`, `bulk_verify_trips_with_passengers`, `bulk_verify_passengers`, `bulk_verify_entities`,
      `get_trip_for_staff(token)`, `staff_search_trips`, `log_document_access`.
- [ ] PDF route `GET /api/trips/:id/manifest.pdf` with `@react-pdf/renderer` + Arabic font subset; 1-page layout tested with 4/14/30 passengers.
- [ ] Staff web: `/staff/scans`, `/staff/trips/[id]` (manifest + bulk passengers), `/staff/dashboard`, `/supervisor/*`.
- [ ] Mobile: scanner screen + manifest link.
- [ ] pgTAP: supervisor cannot verify out-of-scope trip; passenger detail visibility respects `can_view_passengers`; PDF permission denied for passengers.
- [ ] Snapshot test for PDF layout (text extraction + page count).

### Acceptance criteria
- Scanning a trip QR as an Aden supervisor shows the trip; an out-of-scope supervisor sees "خارج نطاقك".
- Bulk verify 10 trips + passengers → summary shows `9 verified, 1 failed (out of scope)` with reasons.
- 14-passenger manifest fits one A4 page; PDF renders Arabic correctly (no tofu) and contains vehicle + driver + passenger rows.
- Passenger cannot download the manifest (`403`); generating it is audited and listed in the audit explorer.
- Historical search finds a completed trip from last month by date range + governorate; CSV export matches the filtered rows.

**Estimate:** 7–8 days.

---

## Phase 8 — Vehicle Operations: ODO, Fuel & Maintenance

**Goal:** fleets stay roadworthy: automatic odometer, fuel consumption, maintenance schedules and alerts.

### Deliverables
- `fuel_logs`, `maintenance_records`, `maintenance_schedules` (generated due columns), `maintenance_status`, reminder cron.
- Auto ODO: trip start/end, manual readings with photo, monotonic guard (BR-16), anomaly detection.
- Fuel: quick log (litres, price, station, full tank), consumption analytics (L/100km, cost/km, per-trip, monthly).
- Maintenance: schedules by km/date, due-soon/overdue badges, "mark done" flow, cost history, attachments.
- Dashboards: vehicle health card, fleet rollup, upcoming maintenance, export CSV/PDF.
- Settings: reminder thresholds, block-assignment-when-overdue flag.
- Mobile: driver quick log (fuel/ODO) from the running trip screen.

### Tasks
- [ ] Migrations + generated columns + `app.vehicle_odometer_guard()` + `app.recompute_maintenance_status()`.
- [ ] Cron: daily maintenance scan → reminders (in-app/push), overdue escalation.
- [ ] RPCs: `log_fuel`, `log_maintenance`, `upsert_maintenance_schedule`, `mark_maintenance_done`, `record_manual_odometer`, `get_vehicle_health`, `get_fleet_summary`.
- [ ] Web: `/operator/vehicles/[id]/health`, `/operator/fleet` dashboard, exports.
- [ ] Mobile: fuel/ODO quick actions.
- [ ] Units/tests: consumption math, due-date math, timezone-safe date handling (Vitest + pgTAP).

### Acceptance criteria
- Two full-tank logs 450 km / 38 L apart → dashboard shows 8.4 L/100km.
- Schedule "oil every 5,000 km" with last at 120,000 → due at 125,000; at 124,600 shows "due soon"; at 125,300 "overdue".
- End-trip ODO automatically advances vehicle total; a manual lower reading is rejected unless owner overrides with a reason (audited).
- Fleet dashboard totals reconcile with underlying logs (tested).
- Overdue vehicle is blocked from new trip assignment when the setting is on.

**Estimate:** 6 days.

---

## Phase 9 — Notifications, Preferences & Search Alerts

**Goal:** the platform tells the right person the right thing, once, on the right channel.

### Deliverables
- Full event matrix (specs §6.10) wired to in-app + push (Expo) + email (Resend); WhatsApp deep-link templates.
- `notification_preferences` UI (per event × channel) + quiet hours (Asia/Aden) + critical overrides.
- Saved searches with alerts: any user saves filters; cron matches new trips; digest notification.
- Reminder jobs: trip in 2 h, departure now, no-show window, verification SLA, maintenance.
- Notification centre (web + mobile) with unread counts, deep links to the right screen.
- i18n audit: 100% Arabic + English coverage, plural/gender rules, Arabic date/number formatting.
- Accessibility & polish pass: empty/loading/error states, offline notices, skeletons, keyboard nav.

### Tasks
- [ ] `notifications`, `notification_preferences`, `saved_searches`, `saved_search_matches` + RLS.
- [ ] `app.enqueue_notification()` (outbox pattern) + edge function `dispatch` (push/email) with retries + dead-letter table.
- [ ] Cron: `match_saved_searches`, `send_trip_reminders`, `notify_pending_verifications`, `retry_failed_notifications`.
- [ ] Web/mobile notification centre + preference screens.
- [ ] Template system (per event, AR/EN, variables validated by zod).
- [ ] Tests: dispatch dedupe (idempotency key), quiet-hours behaviour, preference opt-out respected.

### Acceptance criteria
- Accepting a booking produces exactly one push + one in-app notification (no duplicates on retry).
- A saved search "عدن → صنعاء, Friday, ≤ 5000 YER" notifies once per new matching trip, not per refresh.
- Disabling email for "booking accepted" stops emails but keeps push.
- Quiet hours suppress non-critical push at 23:00 and deliver at 06:00; cancellation still delivers immediately.
- All user-facing strings exist in `ar.json` and `en.json` (CI check fails on missing keys).

**Estimate:** 5–6 days.

---

## Phase 10 — Hardening, Security & Launch

**Goal:** safe to put real passengers and real money-equivalent trust in it.

### Deliverables
- Performance: load test at 100k trips / 200 live trips / 5k pings/h; query plans reviewed; indexes tuned; p95 targets met.
- Security review: RLS matrix re-audit, definer-function review, storage policy review, rate limits, OTP abuse, dependency audit.
- Reliability: backups + restore drill, point-in-time recovery verified, cron failure alerts, Sentry alerts, on-call runbook.
- Mobile release: EAS build, store assets, permission copy, privacy nutrition labels, TestFlight/Internal testing, OTA pipeline.
- Data: production geography seed, admin accounts, settings defaults, support/contact info.
- Docs: `docs/runbook.md`, `docs/admin-guide.md`, `docs/operator-guide.md` (AR), API/RPC reference generated from migrations.
- UAT with 3 real pilots (1 company, 2 individuals) and a fix list burned down.

### Tasks
- [ ] k6 suites (search, booking race, ping ingest) + results in `docs/perf/`.
- [ ] `EXPLAIN ANALYZE` review for the top 10 queries; add missing indexes; vacuum/autovacuum settings.
- [ ] Security checklist execution + fixes; `supabase db lint`, `plpgsql_check`, npm audit clean.
- [ ] Backup restore into a scratch project (documented timings).
- [ ] Alerting: error rate, stale live trips, failed notifications, verification backlog > 24h.
- [ ] EAS build + submit config, store screenshots (AR/EN), privacy policy page, terms.
- [ ] UAT script + sessions + issue burn-down.
- [ ] Tag `v1.0.0`, changelog, handover session.

### Acceptance criteria
- p95 search < 300 ms, p95 write RPC < 250 ms under the stated load.
- Zero critical/high findings in the security checklist; every table's RLS covered by a passing test.
- Restore drill completes within the documented RTO (< 1 h) with data integrity verified.
- iOS + Android builds install and complete the driver journey end-to-end on real devices.
- Three pilot operators complete a full cycle (publish → book → verify → run → manifest) unaided.

**Estimate:** 7–8 days.

---

## Backlog (post-v1, deliberately deferred)

Payments/escrow/commission, recurring trip series + templates, seat-map selection, ratings & reviews,
chat, WhatsApp Business API, call-center agent console, multi-country geography, driver payroll,
fuel-card integrations, advanced BI export, referrals/coupons engine, offline-first full PWA.

---

## Dependency map

```
0 ── 1 ── 2 ── 3 ── 4 ── 5 ── 6 ── 7
                    │        │
                    └── 9 ───┘     (9 needs 5+6 events)
3 ── 8                              (8 needs trips for ODO)
everything ── 10
```
Phase 8 can run in parallel with 5–7 if you want to compress the timeline.
Phase 9 needs booking + tracking events; Phase 10 must be last.

---

## Progress tracker

| Phase | Name | Status | PR | Notes |
|---|---|---|---|---|
| 0 | Foundations | ⬜ Not started | — | awaiting go-ahead |
| 1 | Identity & Trust | ⬜ | | |
| 2 | Geography & Places | ⬜ | | |
| 3 | Fleet | ⬜ | | |
| 4 | Trips & Marketplace | ⬜ | | |
| 5 | Bookings | ⬜ | | |
| 6 | Live Execution | ⬜ | | |
| 7 | Staff Operations | ⬜ | | |
| 8 | Vehicle Operations | ⬜ | | |
| 9 | Notifications & Polish | ⬜ | | |
| 10 | Hardening & Launch | ⬜ | | |

---

## What I need from you to start Phase 0

1. **Go-ahead** (nothing else blocks scaffolding).
2. Verify/adjust these five defaults: YER currency, Arabic-first, 2-hour windows, no online payments in v1,
   OSM/MapLibre maps instead of Google Maps.
3. Answer the six open questions in `specs.md` §19 when convenient — none block Phase 0–2.
