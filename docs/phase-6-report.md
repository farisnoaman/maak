# Phase 6 — trip execution and live tracking

**Date:** 2026-10-31 · **Branch:** `arena/8a1e3e09-maak` (PR #2)
**Scope:** `IMPLEMENTATION_PLAN.md` Phase 6, both slices — the state machine and the odometer (§1–2), then
positions, derived progress, the driver's console and the passenger's live screen (§5–7). What is still
open is in §8.

Phase 4 could sell a seat and Phase 5 could fill the vehicle, but nothing in the product could say "this
vehicle has left". That is what this slice adds — and it is a slice rather than a phase because each of
the remaining pieces (partitioned pings, nearest-stop geometry, ETA from rolling speed) deserves its own
tests rather than a shared headline.

---

## 1. What shipped

| Object | Purpose |
| --- | --- |
| `trip_status += 'in_progress'` | The state between "on sale" and "completed". **Migration 00021 is enum values only** — Postgres refuses to *use* a value added in the same transaction, and every migration here runs in one. |
| `trip_event_kind += started / stop_reached / ended` | The trip's history, in the same table the console already renders. |
| `trips.started_at`, `trips.last_stop_seq` | Set only by commands; a check constraint refuses `in_progress`/`completed` without a start time. |
| `odometer_readings.trip_id` + unique `(trip_id, kind)` | A reading belongs to a trip, and a trip can be started — or ended — exactly once. |
| `app.is_trip_driver`, `app.assert_can_execute_trip` | "Am I *this trip's* driver" and "may I move it along", both derived from rows, never from a claim. |
| `app.last_odometer_km` | The vehicle's last known reading: registration value or newest log, whichever is higher. |
| `cmd_start_trip` | Verified-only (BR-05), no earlier than two hours before departure (`TOO_EARLY`), monotonic odometer (`ODO_REGRESSION`), one transaction for status + reading + event + audit. |
| `cmd_mark_stop_reached` | Monotonic: a replayed "reached stop 1" answers `alreadyReached: true` instead of walking the trip backwards. |
| `cmd_end_trip` | Advances the vehicle odometer, completes the trip, finalises its bookings, and **flags** an implausible distance instead of refusing a driver who took a detour. |

The three commands join the Phase 4 `trips` edge function — one action discriminator, one `cmd_*` per
request, the same policy matrix, and the same two gateways (the guard in `check-guards.mjs` §10 compares
their capability maps by name).

## 2. Decisions worth an argument

**A trip only starts when it is verified, and not at breakfast.** The two-hour window is the same line
BR-09 draws for cancellations: before it, "started" would be a statement about a vehicle that is still in
the yard, and the passenger's live screen would believe it.

**An implausible distance is recorded, not refused.** The trip ends, the reading is stored, and the event
and audit row carry `flagged: true` when the distance exceeds what 100 km/h for the elapsed time allows
(+50 km of slack). Refusing would strand a driver at the roadside over a number an auditor can read
tomorrow — and the odometer is a *discipline*, not a hostage.

**Stops are a sequence number, not a timetable.** `last_stop_seq` records what the driver announced
reaching, so an early or late arrival moves the number and nothing else. That is the state the next slice
(pings → progress → ETA) will read.

**The capability maps stay literal.** Moving them into `@maak/core` was tried in this slice and reverted:
`check-guards.mjs` reads both maps *by name* and fails when one has an action the other does not — which is
exactly the bug that made `driver.setLicence` return `FORBIDDEN` in dev for a day. The duplication is the
thing the guard checks, so removing it would remove the check.

## 3. Evidence

`supabase/tests/0009_trip_execution.test.sql` — **30 assertions**: the four refusals, the three rows a
start writes, monotonic stops, the replay answer, a stranger's stop, ending below the starting reading,
the distance and the flag, the vehicle total, the passengers finalised with the trip, and that no client
can call any of the three commands.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | 0 errors (core · web · mobile) |
| `npm run lint` / `format:check` | clean |
| `npm test` | **391** tests / 19 files |
| `npm run check:guards` | 24 core · 108 style · **22 migrations** · **57 commands** |
| `npm run sql:check` | 22 migrations · **9** pgTAP suites · **449** assertions |
| `npm run check:a11y` | 54 routes, both directions (re-run after a clean `--reset`, so the demo trip was on sale again) |
| `npm run check:functions` | 8 bundles, no drift |

Probed on the running stack, as the seeded driver, against the seeded trip:

| Step | Result |
| --- | --- |
| `trip.start` 39 h early | `409 TOO_EARLY` — "this trip departs at 2026-11-02 05:47" |
| owner `trip.submitVerification` → staff `trip.decideVerification` | `pending` → `verified` (the Phase 4 queue, end to end) |
| `trip.start` with `odoKm: 1` | `422 ODO_REGRESSION` — "reads 1 km but the vehicle was last logged at 184320 km" |
| `trip.start` 184400 | `200`, status `in_progress`, `started_at` set |
| `trip.start` again | `409 CONFLICT` — "this trip has already started" |
| `trip.stopReached` 2, then 1 | `200`, then `alreadyReached: true`; `last_stop_seq` stays 2 |
| `trip.stopReached` 9 | `404` — that stop is not on this trip |
| `trip.end` 184520 | `200`, `distanceKm: 120`, `flagged: true`, vehicle total 184520 |
| database | readings `baseline 184320 → trip_start 184400 → trip_end 184520`; events `started → stop_reached → ended` |

## 4. Part one's loose ends (all closed in part two)

- ~~Pings, progress, ETA~~ → §5.
- ~~Driver console~~ → §6.
- ~~Web "I'm here" fallback~~ → §6.
- ~~Route geometry~~ → the `trip_route_geometry` seam and a straight-line fallback; a provider is §8.
- ~~Realtime~~ → polling ships; the publication is prepared (§5).

## 5. One defect the probe found

The gateway answered `403 FORBIDDEN` for `trip.start` while the SQL was correct: the dev backend's
capability map had not been given the three new actions. `check:guards` §10 compares the edge function's
map with the dev gateway's **by name**, so the missing keys were a guard failure waiting to happen — the
guard was run *before* the edge map gained them, so it had nothing to compare yet. Both maps now carry the
three actions, and the guard run in §3 covers it.

---

# Part two — where the vehicle actually is

## 5. Pings, and the one place that does geometry

| Object | Purpose |
| --- | --- |
| `trip_location_pings` | Partitioned monthly by `recorded_at`, `default` partition as the safety net. Append-only: a phone that reconnects after an hour uploads its queue, out of order, and every point is evidence. |
| `app.ensure_trip_ping_partition()` | Creates `trip_location_pings_YYYYMM` on demand from `cmd_record_ping`, so the table never needs a cron to keep accepting writes. |
| `app.haversine_km()` | Great-circle distance. PostGIS is not guaranteed (00008 says so), and a straight line between stops is honest about being an estimate. |
| `app.trip_stop_points()` | The stops that have coordinates, in order — free-text stops still count as stops, they just cannot take part in distance arithmetic. |
| `trip_progress` | One row per trip: last position, nearest stop, km to it, km remaining, percent, speed, two ETAs. |
| `app.recompute_trip_progress()` | The **only** implementation. Nearest *upcoming* stop (so an announced stop is behind you), remaining = to that stop + the rest of the chain, ETA from a rolling 15-minute speed with the timetable as fallback. |
| `cmd_record_ping()` | Driver-only, `in_progress` only, `recorded_at` clamped to `[started_at, now()]`, then progress recomputed in the same transaction. |
| `get_trip_progress(code)` | The read. Visibility — driver, operator, platform staff, or a passenger with a booking — enforced in the function, so "not yours" is `FORBIDDEN` rather than an empty object that looks like a vehicle that has not moved. |
| `trip_route_geometry` | Where a routing provider's polyline will live; `app.trip_route_for()` prefers it and falls back to the stop chain. |
| Realtime | `alter publication supabase_realtime add table public.trip_progress` when the deployment has the publication; the dev backend has no websocket endpoint, so the screen polls. |

**Staleness is a read-time fact.** Nothing writes "the location is old". 21 minutes (`app.ping_stale_after_seconds()`)
without a ping means `stale = true`, computed when somebody looks — correct even if the server was down,
and correct in a tab that has been open for an hour because the browser re-derives it too
(`isProgressStale()` in `@maak/core`, which does not trust the payload's own flag).

## 6. The driver's console (web)

`/driver` lists the trips assigned to you; `/driver/trips/<code>` is the console: odometer → start,
"send my position" (browser geolocation, `source: 'web'`), "reached <stop>", odometer → end.

It is a *web* console on purpose. The native app is where the ten-minute background cadence belongs, and
shipping a half-built `expo-task-manager` flow would be worse than not shipping it: a driver who believes
the phone is reporting is a driver whose passengers see «الموقع غير محدّث» for an hour.

The console also exposed a real defect: 00014's read policy matched a driver only while the trip was
`published`, so the moment `cmd_start_trip` moved it to `in_progress` **the driver could no longer read
their own trip** and the console said "this trip is not assigned to you". Migration `00024` fixes the
policy, `app.can_read_trip()` and the `bookings` count — plus the `grant execute on app.is_trip_driver`
that a policy needs in order to evaluate its own predicate (without it, PostgREST answered
`permission denied for function is_trip_driver`, a 500 that looks exactly like an outage).

## 7. The passenger's live screen

`/trips/<code>/live` — progress bar, «الآن في تعز», «يتبقى 24 كم لأقرب توقف», «يتبقى 137 كم للوصول إلى
صنعاء», arrival estimates, the stop timeline with reached markers, and a badge that flips to «الموقع غير
محدّث» with the last known point and time after 21 minutes.

Three honest states instead of one clever one: signed out → sign in; signed in without a booking → "this
is for passengers booked on the trip"; allowed → the panel. The page never re-implements the
authorisation, because the RPC is the authorisation.

ETAs are coarse on purpose (`٤٥ د`, `2 h 20 min`): a minute-precision arrival computed from a haversine
estimate and a rolling average is a promise the data cannot keep.

## 8. Evidence

| Gate | Result |
| --- | --- |
| `npm run typecheck` | 0 errors |
| `npm run lint` / `format:check` | clean |
| `npm test` | **406** tests / 20 files (15 of them new: `tracking.test.ts`) |
| `npm run sql:check` | **24** migrations · **10** pgTAP suites · **488** assertions |
| `npm run check:guards` | 25 core · 113 style · 24 migrations · 58 commands |
| `npm run check:a11y` | 54 routes, both directions (re-run on a clean seed, so the live screen was discovered from the trip page) |
| `npm run check:responsive` | clean (35 media queries) |
| `npm run check:functions` | 8 bundles, no drift |

Probed end to end over the real HTTP path — sign-in, then the same calls the browser makes:

| Step | Result |
| --- | --- |
| `/en/driver` as `driver@maak.test` | 200, lists `AD-SA-2292` |
| `/en/driver/trips/AD-SA-2292` before start | 200, "Start the trip" + odometer field |
| `trip.start` (odo 184320) → `trip.recordPing` (near Taiz, 62 km/h) | 200 → 200, progress written |
| `/en/driver/trips/AD-SA-2292` after start | 200, "The trip is running", "Send my position now", "End the trip" |
| `/en/trips/AD-SA-2292/live` as the operator | 200 — "Now near Taiz", "Arriving in 5 min", "3 h 20 min", "% of the way there" |
| same page in Arabic | «الآن في تعز» · «الوصول بعد 5 د» · «الوصول بعد 3 س 20 د» · «مباشر» |
| same page as a signed-in user with no booking | 200, "Tracking is available to passengers booked on this trip only." |
| same page, signed out | 200, "Sign in to follow this trip" |
| pings aged 25 minutes | badge flips to "Location is not current", "Last seen near Taiz", "Last update …" |

## 9. Still open (and deliberately so)

- **Native background location** — `expo-task-manager`, the offline queue (with `recorded_at` preserved,
  which the command already honours), and the iOS/Android permission UX. The web console is the
  fallback, not the answer.
- **Routing provider** — OSRM/ORS at publish, cached into `trip_route_geometry`. The read path already
  prefers it; nothing calls it yet, so distances are straight-line estimates and are labelled as such.
- **Realtime channel** — the publication is added when the deployment has it; the screen still polls.
  Moving to `trip:<id>` needs the private-channel policy and a client that can hold a socket.
- **Per-passenger check-in** — needs the passenger rows that arrive with the Phase 7 manifest.
