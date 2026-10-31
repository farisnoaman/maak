# Phase 4 — implementation report

**Date:** 2026-10-31 · **Branch:** `arena/8a1e3e09-maak` (PR #2)
**Scope:** `IMPLEMENTATION_PLAN.md` Phase 4 — trips, pricing and the public marketplace.

This document describes what was built and what was *executed*, in that order of distrust: a claim
here is worth what a gate or a probe shows, and where a claim could not be reproduced in this
environment the report says so rather than ticking the box.

---

## 1. What shipped

### The substrate (migration `00014_trips.sql`)

| Object | Purpose |
| --- | --- |
| `trips`, `trip_stops`, `trip_events`, `trip_verifications` | The trip, its ordered stops, its append-only history, its verification requests |
| `trips_search` (denormalised) | The read model the marketplace queries: visibility, price from, stop ids, search text, featured rank |
| `trip_status`, `trip_booking_mode`, `trip_pricing_mode`, `trip_discount_kind`, `trip_discount_scope`, `trip_gender_policy`, `trip_payment_policy` | Enums, so an invalid state is unrepresentable rather than merely rejected |
| `app.assert_trip_payload`, `app.assert_trip_editable`, `app.actor_can_manage_trip`, `app.assert_trip_vehicle`, `app.assert_trip_driver`, `app.replace_trip_stops`, `app.recompute_seats_available`, `app.refresh_trip_search` | The rules, in one place, called by the commands |
| `app.trip_unit_fare`, `app.trip_discount`, `app.trip_total`, `app.trip_price_from` | The pricing engine — the authority the TypeScript mirrors |
| `cmd_create_trip`, `cmd_update_trip`, `cmd_set_trip_stops`, `cmd_publish_trip`, `cmd_submit_trip_verification`, `cmd_decide_trip_verification`, `cmd_cancel_trip` | One command per user intent, each one transaction, each one audited |
| `search_public_trips`, `get_trip_public`, `staff_search_trips` | Three reads: cascading facets + keyset pagination, one public trip, the staff search |

Every command is a single `security definer` function with `search_path = ''`, re-deriving the actor
from `app.uid()` and re-asserting ownership, verification and quota from the rows themselves.

### The contract (`packages/core`)

- `src/api/trips.ts` — Zod schemas for the seven actions (`tripsActionSchema`), the filter schema, the
  argument builders (`tripsCommandArgs`, `publicTripsArgs`, `publicTripArgs`, `staffTripsArgs`) and
  `tripFieldErrors()`, the cross-field rules that mirror `app.assert_trip_payload()`.
- `src/domain/trip.ts` — status/verification/badge labels, `isTripEditable()` (the 2-hour lock),
  `tripBadges()`, `departureLabel()` in `Asia/Aden`, `adenLocalToIso`/`isoToAdenLocal`, the filter codec
  (`readTripFilters`/`tripFilterQuery`/`activeFilterCount`) and `tripPriceFrom()` (the mirror of
  `app.trip_price_from()`).
- `src/domain/pricing.ts` — unchanged. It was already the fare engine; Phase 4 asserts against it rather
  than growing a second one.

### The edges

- `supabase/functions/trips/index.ts` — the Deno gateway, one branch per action, mapping a `cmd_*`
  error code to the contract code.
- `scripts/dev-backend/gateway.mjs` — the same behaviour without Deno, so the smoke test exercises the
  real path. It reads the deployment's `TRIPS_CAPABILITY` map; `check-guards.mjs` fails if the Deno
  function does not declare every action that map grants.

### The screens

Web (`apps/web`): `/operator/trips` (list by status, context switcher), `/operator/trips/new` (five-step
wizard), `/operator/trips/[id]` (detail, edit-in-place, publish / submit / cancel), `/operator/trips/calendar`
(month grid in Aden time), `/trips` (marketplace with cascading facets, sort, cursor paging),
`/trips/[code]` (public detail + JSON-LD + share), `/staff/trips` (review queue + staff search),
`/staff/trips/[id]` (one trip as staff see it, with the verification decision), `/account/trips`
(passenger shell).

Mobile (`apps/mobile`): `/trips` (search, filter sheet, infinite scroll) and `/trips/[code]`.

Both clients call the *same* RPCs with the *same* argument builders, so a filter cannot mean one thing on
the web and another in the app.

Phone first, not phone-tolerant: below 720px the bottom tab bar carries the four destinations a thumb
needs (home, marketplace, my trips, console), the home page opens with a three-field GET search whose
result is a shareable URL rather than a modal, and `/console` forwards a staff member to `/staff` and an
operator to `/operator` so the tab bar never guesses a role it cannot know.

The web app is also installable: `app/manifest.ts` (standalone, `/ar/trips` as `start_url`), icons rendered
by `app/icons/[size]` so no PNG can go stale against the tokens, and `public/sw.js` — which caches nothing
by design and only answers a failed navigation with a bilingual offline page. `check:guards` §14 fails the
build if any of the four installability facts disappears, or if the worker starts caching.

---

## 2. Defects the tests found (and fixed)

The pgTAP suite (`supabase/tests/0007_trips.test.sql`, 80 assertions) and the dev smoke test were
written before the UI, and they found four things that would have shipped:

1. **Trip creation would have failed in production.** `app.new_trip_code()` called
   `gen_random_bytes()` with `search_path = ''`; pgcrypto lives in `extensions` on Supabase, so the call
   does not resolve. Replaced with an md5 of `random()` + `clock_timestamp()`, which are in `pg_catalog`
   and therefore resolvable with an empty path.
2. **Every insert would have violated the code check.** The generator produced `SA-AD-12AB` while the
   table's constraint demanded four characters in each of the first three groups. The generator now
   matches the constraint it is checked against.
3. **The marketplace would have errored on every cache miss.** `search_public_trips` was declared
   `STABLE` while writing its result into `search_cache`; a stable function may not `INSERT`. It is now
   `VOLATILE`, with the reason in a comment.
4. **Anonymous search would have been a permission error, not a result.** The public RLS policy called
   `app.actor_can_manage_trip()`, which `anon` cannot execute, so Postgres raised `42501` while
   evaluating the policy for the very role the marketplace exists for. The policy now tests ownership
   directly.

A fifth, smaller one: the dev REST stand-in wrapped scalar RPC results in `[{ "fn": … }]` while real
PostgREST returns the value itself. Fixed, because a client that has to unwrap in dev and not in
production is the kind of divergence that only shows up on deploy.

A sixth was found later, by using the screen rather than by reading it: `staff_search_trips` had been
created inside the block that revokes the trip *commands* from `anon` and `authenticated`, so it was
reachable only by `service_role` — and reads in this app never use the service role. `/staff/trips?q=…`
answered `42501 permission denied for function staff_search_trips` and the page rendered "forbidden" to
the staff member it exists for. Migration `00016` re-grants it to `authenticated` (the function already
authorises itself through `app.is_platform_staff`), and `0007` now asserts the grant — plus an invariant
that every function this project defines in `public` is executable by a signed-in user — so the next
read that ships revoked fails the suite instead of a console.

---

## 3. Evidence

| Gate | Result |
| --- | --- |
| `npm run sql:check` | 17 migrations applied; 7 pgTAP suites green; **97** trip assertions; no type drift; no client write grants |
| `npm test` | 18 files, **367** tests (33 of them the Phase 4 domain/contract tests) |
| `npm run check:guards` | 22 core files · 92 style files · 17 migrations · 43 commands |
| `npm run check:a11y` | **52** routes, both directions, **7** discovered detail pages |
| `npm run check:responsive` | viewport exported, no unguarded grid tracks, every wide table scrollable |
| `npm run dev:check -- --api` | 16/16, including the marketplace without a session and a trip-code lookup |
| `npm run check:functions`, `db:types:check` | bundles current; types match 15 migrations |

Probed on the running stack (owner, staff and anonymous sessions):

- create → publish → appears in `/trips` and at `/trips/[code]` in both locales;
- submit for review → appears in `/staff/trips` with approve/reject;
- the operator detail renders the fare breakdown from `app.trip_total()`, the stops and the event log;
- `/trips/[code]` emits `<title>`, `rel=canonical` per locale, `hreflang` for `ar`/`en`/`x-default` and a
  `schema.org/BusTrip` payload whose price equals the rendered fare.

---

## 4. What is deliberately not done

- **Map/list toggle.** There is no map provider key in this environment and no tile server on the
  network allowlist, so a "map" would be a grey rectangle that lies about being tested. The list view
  carries the same information (governorate, stops, price, departure); the toggle is a UI shell that
  needs a provider decision first.
- **k6 search benchmark (p95 < 300 ms at 50k trips).** `k6` is not installed and the sandbox cannot seed
  50 000 trips and load-test them meaningfully. The 30-second cache and the keyset cursor are in place;
  the number is unverified, and this report does not claim it.
- **Mobile on a device.** The two mobile screens typecheck and share the web's RPC calls and formatting,
  but there is no simulator here. They have not been run.
- **Booking.** Phase 5. `/account/trips` is the shell, and the trip detail says "booking opens soon"
  rather than showing a button that does nothing.
