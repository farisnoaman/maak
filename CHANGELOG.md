# Changelog

The dated record lives in `docs/phase-*-report.md` — one file per phase, written when the phase closed, with the
numbers and the mistakes. This file groups those phases into releases a human can read, newest first.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · versions: [SemVer](https://semver.org/).

**Status: `1.0.0` is not tagged yet.** Per `docs/phase-12-report.md` §6 it is tagged after pilot UAT
(`docs/uat.md`) and the hosted-project restore run (`docs/runbook.md` §3), not before. Everything below is merged
on `main`; the tag is the last step, not the first.

---

## [Unreleased] — after the last phase report

### Added

- **Install paths, written down** (`docs/apps.md` §"How to install it on a phone"): the web app as a PWA (works
  today, no account), Expo Go for the inner loop, `eas build --profile preview` for an APK a tester keeps, and the
  store route that waits on accounts. `apps/mobile/.env.example` lists the four variables the app reads.
- **The driver can run a trip from the phone** (`apps/mobile/src/app/driver/trips/`): start, share position, mark a
  stop, end — the same `trip.*` commands as the web console, with `expo-location`.

### Changed

- **The home page sells the trip instead of the build.** It showed a phase number, a unit-test count, three
  architecture cards and seven console cards of which five said "coming soon" — while `/trips` served real
  departures it never mentioned. Now: a search-first hero with the next three real departures beside it, trips you
  can book now, popular destinations from the search function's own facets, three booking steps, the fare
  calculator, an operator band, and the consoles as one quiet row. `docs/polish-plan.md` has the accounting and the
  queue for the screens after it.
- **Header and footer.** The primary nav went from eight links (including the vehicles console, the component
  styleguide and two legal documents) to four; everything removed is in the new shared `SiteFooter`, which now
  appears on public pages instead of only the home page. The footer's `Phase 2 · Next.js · Expo · Supabase` line is
  gone.
- **Page titles lead with the brand's own name** (`— معك` in Arabic, not `— Maak`), and the default title says what
  the product does rather than who the software is for.

### Fixed

- **A finance assertion that had been counting all subscription invoices** — `0015` test 68 failed on a clean
  checkout, and it was the test that was wrong: an upgrade three screens earlier legitimately leaves a prorated
  invoice open, so "issued subscription invoices = 1" was really asserting "nothing else has been billed yet".
- **`eas.json` configured a variable nothing reads.** All three profiles set `EXPO_PUBLIC_API_URL`; the app reads
  `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`, so every build would have installed and then said
  "not configured". Profiles now name an EAS *environment* and the variables live there.
- **`app.json` asked for `ACCESS_BACKGROUND_LOCATION` and the iOS "always" string** while nothing used them —
  removed rather than left as a permission the app does not honour.

- **The route a real road takes** (`00042`, `npm run routes:fill`). A router queue
  (`get_trips_needing_routes`), a validated write (`cmd_store_trip_route`) and a corridor cache keyed to four
  decimals, so 200 departures on one road cost one provider call. `app.trip_route_for()` now prefers the trip's
  geometry, then the corridor, then the straight line — which stays the default when there is no provider, no
  network or a malformed answer. `parseOsrmRoute` / `routeLooksPlausible` in `@maak/core` are unit-tested without a
  network, including the [lng, lat] swap that would otherwise put Yemen's trips in the Indian Ocean.
- **The payment jobs a cron was supposed to run** (`00043`, `00044`). `payments-expiry` finally schedules
  `cmd_expire_stale_payment_intents`; `payment-reminders` tells a passenger their undecided receipt is still being
  checked (and that an unpaid intent is about to expire); `agent-settlements` tells an agent at 90 % of their credit
  limit, and the finance desk, that a settlement is due. Three jobs rather than one, because they fail differently.
- **The dev backend has a service key.** `MAAK_SERVICE_ROLE_KEY` (default `maak-dev-service-key`) executes as
  `service_role`, so a script that calls a service-only function works on a laptop the way it works in production.
- **Privacy policy and terms of use**, Arabic and English, at `/ar|en/privacy` and `/ar|en/terms`, generated from
  `apps/web/src/lib/legal.ts` and checked by a test for section parity, script and date.
- **Store readiness**: `apps/mobile/eas.json` (development / preview / production profiles, submit config with the
  two account ids left as explicit placeholders) and `docs/store-listing.md` (listing copy in both languages,
  privacy answers, pre-submission checklist).
- **UAT**: `docs/uat.md` — the session script, the pass conditions per role, the severity ladder and the burn-down
  table. The sessions themselves are still a calendar item.
- **This file**, plus `docs/handover.md`.

### Changed

- **One rule for "you are close to your quota"** (`00041`). `app.quota_state()` returns `threshold` (100 at the
  limit, 80 when the next unit crosses 80 %, else null) computed once for every plan; `cmd_notify_quota_thresholds`
  reads it instead of its own `used * 100 / limit`. Basic is now warned in-flow at 80 %; the boundary is one unit
  earlier than the job used to send it. `warning` is `threshold is not null`; `soft` now means only "overage is
  charged".
- **`/admin/users` lists the platform, not the caller.** The role console read its own session, so the only row it
  could act on was the operator looking at it. It now lists the 50 most recent accounts with verification badges,
  their roles and a *Deletion requested* mark, through `profiles_select_staff` and `user_roles_select_staff` — with
  the cap stated when it bites and the *User ID* field as the way past it.
- **A filtered search stops scanning** (`00040`). The bucket aggregate answers a dimension-filtered search from
  ~30 rows: `direct: true` 41.6 → 7.7 ms, the worst dimension case 8.6 ms, homepage 6.1 ms — ~115 cold searches/s
  per core where there were 23. The price/date/text path still pays one 37 ms grouping pass, and says so.
- **The deletion queue** (`00039` + the admin screen): a request had an executor and no list.

## [0.12.0] — Phase 12, hardening and launch readiness

- Platform alarms on itself: six named checks (`stale_trips`, `dead_deliveries`, `unbalanced_journals`,
  `verification_backlog`, `payment_sla`, `error_rate`) delivered through the ordinary notification machinery, with
  a runbook page per alert.
- Search: 15,690 ms → 112 ms → 5.6 ms at 50,000 trips (`00036`, `00038`), with the ceiling documented instead of
  hidden.
- A restore drill that executes instead of describing: hot backup → second cluster → 24 checks against the source,
  in 0.47 s at 49,998 trips (`npm run drill:restore`).
- A scheduler that fails loudly, and a security review expressed as a gate.

## [0.11.0] — Phase 11, notifications, preferences and search alerts

- The full v1.1 event matrix, in-app / push / email / WhatsApp deep link, per-event per-channel preferences, quiet
  hours with critical overrides, AR/EN templates, deep links that keep filters, an optional digest, trip reminders
  at 24 h / 2 h / departure, the no-show window, and history for every role.
- CI fails on a missing translation key — proven by removing one.

## [0.10.0] — Phase 10, finance and subscriptions

- Ledger with a trial balance, journal entries, invoices, payouts, statements, reconciliation, agent floats, plans,
  subscriptions and quota, with `cmd_run_integrity_check` as the standing answer to "do the books balance".

## [0.9.0] — Phase 9, payments

- Payment intents, receipt upload and proof hashing, human confirmation, refunds with the four-band ladder, payouts,
  agent cash-in, and a write-only outbox so no money event is ever lost to a crash.

## [0.8.0] — Phases 7 and 8, trip execution and tracking

- Start / stop / end, seat holds and `boarded`-free manifest, staff operations, location pings in monthly partitions,
  `app.recompute_trip_progress`, the live passenger page and the driver console.

## [0.4.0–0.6.0] — Phases 4 to 6

- The vehicle specification and driver management, trip creation with stops and pricing, the public marketplace and
  booking state machine, and the driver's phone: licence, assigned vehicle, fuel and payments.

## [0.1.0–0.3.0] — Phases 1 to 3

- Identity and roles, verification, the geography gazetteer, the design system and the bilingual shell, and the
  write lockdown that makes every mutation a single audited command.

---

## How to read the numbers

Every claim above is reproducible: `npm run check:all`, `npm run sql:check`, `npm run perf:smoke`,
`npm run drill:restore`. The reports say what failed on the way — the drill that reported success on failure, the
benchmark answered by a cache, the enum cast that cost 12 ms — because a changelog that only lists successes is a
marketing page, and the next person needs the mistakes more.
