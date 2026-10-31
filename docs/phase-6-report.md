# Phase 6 — trip execution, part one

**Date:** 2026-10-31 · **Branch:** `arena/8a1e3e09-maak` (PR #2)
**Scope:** `IMPLEMENTATION_PLAN.md` Phase 6, first slice — the state machine and the odometer. The parts
that need a live position (pings, progress, map, realtime) are **not** in this slice and are listed in §4.

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
| `npm run check:a11y` | 51 routes (two fewer than usual: the probe left the demo trip completed) |
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

## 4. Not in this slice

- **Pings, progress, ETA, map** — `trip_location_pings` (monthly partitions), `record_trip_ping`,
  `app.recompute_trip_progress`, `/trips/[code]/live`. Needs geometry fixtures to be worth testing.
- **Realtime** — the private `trip:<id>` channel and the 30 s polling fallback.
- **Driver console UI** — the three commands exist and are exercised over HTTP; the screens (today's
  trips, start, running view, "reached stop", end) are the next slice.
- **Background location** on native (permissions, queue, iOS/Android differences) and the web "I'm here"
  fallback.
- **Routing provider** and route geometry.

## 5. One defect the probe found

The gateway answered `403 FORBIDDEN` for `trip.start` while the SQL was correct: the dev backend's
capability map had not been given the three new actions. `check:guards` §10 compares the edge function's
map with the dev gateway's **by name**, so the missing keys were a guard failure waiting to happen — the
guard was run *before* the edge map gained them, so it had nothing to compare yet. Both maps now carry the
three actions, and the guard run in §3 covers it.
