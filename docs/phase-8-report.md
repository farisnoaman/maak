# Phase 8 — vehicle operations: the fuel, the oil, and what it cost

**Date:** 2026-10-31 · **Branch:** `arena/8a1e3e09-maak` (PR #2)
**Scope:** `IMPLEMENTATION_PLAN.md` Phase 8. What shipped, what was decided differently, and what is still
open — §6 is the honest list.

Phase 6 taught a vehicle to move and to count its kilometres. It did not teach anybody that the van is
1 200 km past its oil change, or that its fuel bill for the month is half of what the operator charges for
the Aden–Sana'a run. This phase is that ledger, and it rests on one idea: **there is exactly one odometer,
one due point and one expense per event, and every screen reads the same row.**

---

## 1. What shipped

### Schema (`00027_vehicle_operations.sql`, 1 948 lines, 24 functions)

| Object | Purpose |
| --- | --- |
| `public.fleet_settings` | One row per owner (personal or org): `remind_km`, `remind_days`, `block_overdue_assignment`, `fuel_anomaly_percent`. Absent = documented defaults, so a new owner is never "unconfigured". |
| `public.fuel_logs` | Odometer, litres, price per litre, generated `total_cost_yer`, full-tank flag, station name + optional place link, receipt path, soft delete. |
| `public.maintenance_schedules` | The rule: interval in km and/or days, last completion, **generated** `due_km` / `due_on`. |
| `public.maintenance_records` | The evidence: kind, date, odometer, cost, vendor, attachment. `schedule_id` links it to a rule without closing it. |
| `public.vehicle_maintenance_status` | The derived state (`ok` / `due_soon` / `overdue`), counts, next due, plus `last_notified_state` — the column the reminder job needs and a view could not carry. |
| `public.expenses` | The money, ready for Phase 10: `fuel` / `maintenance` rows written by triggers, soft-deleted with their source, and an `expense.reversePending` audit marker for the ledger. |

Enums `maintenance_kind` (16 values), `maintenance_state`, `expense_category`, `expense_source`.
Two notification kinds were added in `00026` (`vehicle_maintenance_due`, `vehicle_maintenance_overdue`) and
their copy in both dictionaries.

### Helpers and the one guard

- `app.fleet_thresholds(vehicle)` — the owner's settings, or the defaults (500 km / 14 days / no block / 25%).
- `app.assert_vehicle_access(actor, vehicle, owner_only)` — owner, org member, assigned driver or staff.
  `owner_only` is the switch the *rule* commands use; a driver may report work, only the owner may move the
  interval that decides when it is due again.
- **`app.assert_odometer_advance(vehicle, reading, allow_backward)`** — BR-16 in one place. Every write path
  (fuel, maintenance, manual reading, trip start/end from Phase 6) answers to it.
- `app.maintenance_state_for(due_km, due_on, odometer, as_of, remind_km, remind_days)` — `IMMUTABLE`, so it is
  the state machine used by the badge, the card, the rollup and the trip gate.
- `app.recompute_maintenance_status(vehicle)` — writes the derived row; called from triggers on schedules,
  records, `odometer_readings` and `vehicles.odometer_km`.
- `app.fuel_segments(vehicle, limit)` — tank-to-tank segments: partial fills accumulate litres until the next
  full tank closes the segment. This is the *only* consumption implementation in the system.

### Commands (edge function `fleet`, one `cmd_*` per request)

| Action | Function | Notes |
| --- | --- | --- |
| `fuel.log` | `cmd_log_fuel` | One transaction writes the log, the odometer reading, the vehicle's high-water mark, and (by trigger) the expense. Returns `anomaly` + `lPer100Km`. |
| `odometer.record` | `cmd_record_manual_odometer` | A lower reading is `ODO_REGRESSION` unless the **owner** gives `overrideReason`; then the reading is stored, the vehicle keeps its highest total, and the reason lands in the audit row. |
| `maintenance.schedule` | `cmd_upsert_maintenance_schedule` | A km rule with no starting point is anchored at the current odometer; a date rule at today (Aden). |
| `maintenance.log` | `cmd_log_maintenance` | Ad-hoc work (tyres, battery) — the same row, `schedule_id` optional. |
| `maintenance.done` | `cmd_mark_maintenance_done` | **Closes the rule**: `last_done_*` move, so the generated `due_*` moves. Deliberately distinct from logging a record — otherwise a tyre rotation resets the oil interval. |
| `fleet.settings` | `cmd_update_fleet_settings` | Two branches (personal row / org row), audited. |

Reads are session-bound wrappers, the same shape as `staff_summary`: **`public.vehicle_health(uuid)`** and
**`public.fleet_summary(uuid)`**, backed by `get_vehicle_health(actor, …)` (dynamic, because it may backfill a
missing status row) and `get_fleet_summary(actor, org?)` (stable). The actor-taking versions stay
service-role only; a client can never claim to be somebody else.

### The daily sweep

`app.job_maintenance_scan(500)` on `pg_cron` as `maak_maintenance_scan` at `0 6 * * *` (09:00 Aden, guarded
so a database without the extension still migrates). **Notify on a state *change*, not per day**: a van that
has been overdue for three weeks produces one notification, and `last_notified_state` is cleared when it
returns to healthy so the next lapse is news again.

### Surfaces

- `/operator/fleet` — the rollup: active / due-soon / overdue counts, this month's fuel and maintenance spend,
  one row per vehicle with its state badge, consumption, next due, and a drill-down. Thresholds are edited
  right there. CSV export at `/api/fleet/export`.
- `/operator/vehicles/[id]/health` — the card: current odometer, recent and lifetime L/100km, cost per km,
  month spend, the schedule list with badges, recent work, tank-to-tank segments, and the four write forms
  (fill, reading + optional photo, schedule, mark done).
- `/driver/fuel` (mobile) — the fill or the bare reading, from the pump. It reads the driver's own assignment
  through RLS, so it cannot be pointed at somebody else's van.
- A `Fleet & maintenance` entry in the operator shell, and the health card linked from every rollup row.
- Dev seed: three full tanks ending at **8.44 L/100km**, an oil rule due in 330 km (amber), an inspection rule
  and one past brake job — so every badge and every number on the demo has something real behind it.

---

## 2. The decisions worth defending

**A trigger, not a line in each command, for the derived state.** A schedule edited by `upsert`, a record
added by `mark_done`, or the odometer advanced by the end of a trip all change the answer. The first version
recomputed only on schedules and records — which meant a trip ending at 125 300 km left the badge green until
the next morning's sweep, and the trip gate could let the same van out again. There are now four triggers,
and a pgTAP assertion that an odometer write alone flips the state.

**The override keeps the high-water mark.** When an owner corrects a replaced odometer from 186 120 back to
119 000, the *reading* is stored as given but `vehicles.odometer_km` stays at its highest value. The van did
not un-drive 67 000 km; the record now contains both facts, plus who asked and why.

**Anomaly detection reports, it never refuses.** `cmd_log_fuel` compares the newest tank-to-tank figure with
the mean of the previous seven and returns `anomaly: true` when it exceeds baseline × (1 + percent/100). A van
that suddenly drinks 40% more is a symptom (tyre, leak, theft); refusing the receipt would hide the symptom
*and* lose the cost.

**The rollup sums the rows it shows.** `get_fleet_summary` is built from `fuel_segments` and
`vehicle_maintenance_status` — the same functions the individual card uses — rather than from its own query,
because the acceptance criterion is that the totals *reconcile* with the logs. A separate implementation is a
second number that can drift.

**Money stays in integer minor units.** `total_cost_yer` is a generated `bigint` of `(round(litres × price))::bigint`
— the cast inside the parentheses, which is a syntax rule Postgres enforces and I learned the hard way. Every
expense carries `owner_user_id` xor `owner_org_id` so Phase 10 can post without a join.

---

## 3. Acceptance criteria — evidence

| Criterion | Where it is proved |
| --- | --- |
| Two full tanks 450 km / 38 L → 8.4 L/100km | `0012` test 8 (`app.fuel_segments` → 8.44) · `packages/core/tests/fleet-ops.test.ts` (`lPer100Km(38, 450)`) · dev seed · live probe of `/operator/fleet` shows **8.44** |
| Oil every 5 000 km, last at 120 000 → due 125 000; 124 600 due soon; 125 300 overdue | `0012` tests 12–17 (generated `due_km`, both window edges, both sides of the date rule) |
| End-trip ODO advances the total | Phase 6 `cmd_end_trip` writes the high-water mark; `0012` proves the **status follows an odometer write** with no job involved |
| A lower manual reading is refused unless the owner overrides, audited | `0012` tests 18–23: refusal without reason, refusal for a driver *with* a reason, owner override succeeds, vehicle total unchanged, `audit.log.reason` holds the words |
| Fleet totals reconcile with the underlying logs | `0012` tests 48–51 compare `vehicle_health.expenses.monthTotalYer` and `fleet_summary.totals.monthFuelYer` with `sum(expenses)` computed independently |
| An overdue vehicle is blocked when the setting is on | `0012` tests 40–43: `app.assert_trip_vehicle` raises `MAINTENANCE_OVERDUE` (23505), and passes once the block is off |
| Fuel/maintenance costs appear as expenses | `0012` tests 4–6, 31: one expense per fill with the same total, the service is an expense, and deleting the source soft-deletes the money + marks the reversal |

Gates at the end of the phase: `sql:check` ✓ (27 migrations, 12 suites, **52 new pgTAP assertions**) ·
guards ✓ (27 migrations / 66 commands / 126 style files) · typecheck ✓ · `npm test` **444 / 22 files** ·
lint ✓ · format ✓ · a11y ✓ **66 routes, 9 discovered detail pages** · responsive ✓ · 8 edge bundles rebuilt ·
`db:types` in sync.

---

## 4. Where the work landed

- `supabase/migrations/00026_vehicle_notifications.sql`, `00027_vehicle_operations.sql`
- `supabase/tests/0012_vehicle_operations.test.sql` (52) + the `0007` allowlist for the two new reads
- `packages/core/src/domain/fleet-ops.ts` (display math, CSV, label maps), `packages/core/src/api/fleet.ts`
  (six schemas + argument map), `policy.ts` (seven capabilities), `dictionaries.ts` (Phase 8 copy, AR + EN)
- `apps/web/src/lib/fleet-ops.ts`, `components/fleet/{FleetRollup,HealthActions}.tsx`,
  `app/[locale]/operator/fleet`, `app/[locale]/operator/vehicles/[id]/health`, `app/api/fleet/export`
- `apps/mobile/src/app/driver/fuel.tsx`
- `scripts/dev-backend/db.mjs` (seed), `scripts/check-a11y.mjs` (two routes + health discovery),
  `supabase/functions/fleet/index.ts` and `scripts/dev-backend/gateway.mjs` (the duplicated capability map)

---

## 5. Deliberate deviations from the plan text

1. **`app.vehicle_odometer_guard()` is `app.assert_odometer_advance()`** — a function the commands call, not a
   trigger, because the one legal backwards step must be expressible and a trigger cannot tell a correction
   from a mistake.
2. **`get_vehicle_health` / `get_fleet_summary` are reads through session wrappers**, not edge-function
   actions. Same precedent as `staff_summary` and `get_trip_manifest`: the UI never holds an actor id.
3. **`maintenance_status` is a table**, not a view, because the reminder job must remember what it already
   sent.
4. **`mark_maintenance_done` returns the recomputed status.** The record's trigger fires before the schedule
   moves, so the first version reported "overdue" about work it had just recorded; it now recomputes and a
   pgTAP assertion holds that.

---

## 6. What is not done (honest list)

> Superseded in part by §7: the gaps below were the ones I named when the phase shipped, and six of them
> are now closed. What remains open is at the end of that section.

- **No PDF export.** The plan says "CSV/PDF export (plan-gated later)"; CSV ships. A PDF needs a font strategy
  for Arabic (the Phase 6 `pdfkit` attempt failed on woff-only packages) and print-to-PDF already covers the
  one document that must leave the app — the manifest.
- **Photos are owner-only.** The photo on a manual reading goes to `vehicle-documents/<vehicle>/odometer/…`,
  and that bucket's write policy is `app.owns_vehicle(...)`. A driver cannot attach one; the command would
  accept the path, so this is a policy decision, not an oversight. Loosening it means a driver-writable
  prefix and a look at who may read it.
- **No receipt photo on a fill in the mobile screen.** The column and the schema field exist; the screen does
  not offer a camera, for the same reason the Phase 7 scanner has no camera: an untested native module is
  worse than a field that works.
- **Anomalies are shown, not notified.** The fill response and the health card surface `anomaly`; nothing
  sends a notification. If it deserves a bell, it belongs in the same dedupe as the maintenance scan.
- **Per-trip fuel attribution is modelled but not surfaced.** `fuel_logs.trip_id` is validated against the
  vehicle and stored; no screen groups consumption by route yet.
- **Export gating by plan** is deferred with the rest of Phase 10's quotas — the CSV is available to any
  owner today. *Closed in §7: the printable report is Pro/Business, the CSV stays free.*

---

## 7. Phase 8.1 — the gaps this report named, closed

The report above was honest about what the phase did not do; this section is the pass that closed six of
those items and the evidence for each. It is a separate migration pair on purpose: `00028` adds one enum
value, `00029` uses it. A single file cannot add an enum value and reference it in the same transaction.

### What changed

| Gap (from §6) | What it is now | Evidence |
| --- | --- | --- |
| Per-trip fuel attribution "modelled but not surfaced" | `cmd_log_fuel` resolves a trip by **id or by the printed code** (a phone has a code, not a uuid), refuses a code that is not a trip of *this* vehicle, and `app.trip_fuel()` groups fills per trip from the trip's own odometer readings. The health card renders **Consumption by trip**. | `0013` — *a fill may name its trip by the printed code, case-insensitively* and *a code that is not a trip of this vehicle is refused* (`P0002`) · live: `{"code":"NOT_FOUND","detail":"no trip with that code on this vehicle"}` at HTTP 404 |
| No monthly trend | `app.monthly_fuel()` returns L/100km and cost per calendar month **including months with no fills**, so the chart has no hole where the van did not drive. Rendered as **Month by month**. | `0013` — *three months are returned, not just the ones with fills* and *an empty month is reported, with a zero* · live page row: `Oct 2026 · 3 fills · 119 L · 1,350 km · 8.81 L/100km · YER 59,500` |
| Kilometres per litre missing | `get_vehicle_health.recentKmPerLitre` / `lifetimeKmPerLitre`, `get_fleet_summary.recentKmPerLitre`, all derived from the *same* `app.fuel_segments` rows as L/100km — so the two views cannot disagree. | `0013` — *the newest segment reads 2.61 L/100km*, *and 38.33 km/L*, *the two figures multiply back to 100* · `packages/core/tests/fleet-ops.test.ts` (`kmPerLitre(450, 38)`) |
| "Anomalies are shown, not notified" | A fill that beats its own 7-segment baseline by the configured percentage writes a `vehicle_fuel_anomaly` notification **once per vehicle per week**, updating the status row so the row exists even when no schedule does. | `0013` — *it rings the bell once*, *the moment it rang is remembered*, *a second bad fill in the same week does not ring it again* · live: first anomaly `anomaly:true`, second fill `anomalyNotified:false` |
| "Photos are owner-only" / "no receipt photo on a mobile fill" | The storage policy now admits the **assigned driver** into `odometer/`, `receipt/` and `maintenance/` — a driver can photograph the meter they are looking at, and nothing else. Both mobile modes capture: the receipt on a fill, the meter on a bare reading. Each uploads *before* it calls the command, so a stored path always opens. | `0013` — *a driver may write into the odometer folder of a vehicle they are assigned*, *the owner may still write anywhere under their vehicle*, *the driver clause is scoped to the assignment, not to the bucket* · `apps/mobile/src/lib/api.ts::uploadVehicleOpsFile` |
| "Export gating by plan is deferred" | `plan_limits.fleet_reports` (Basic 0, Pro 1, Business unlimited) + `app.plan_allows` + `app.report_access`; `public.fleet_report_access()` is the session-bound wrapper the route calls. `get_fleet_summary` carries `reportsAllowed` per vehicle. | `0013` — *Basic does not include the printable report* … *and a stranger reads nothing about somebody else's plan* · live as a Basic account: the locked page renders, **0** table rows |
| "No PDF export" | An A4 print route at `/[locale]/operator/fleet/report` using the manifest's paper CSS and `@page` rules — the same trade-off Phase 7 made, because a print stylesheet embeds the Arabic face the browser already rendered. | live `/en/operator/fleet/report` HTTP 200 with **59,500** fuel and **18,000** maintenance, matching `/operator/fleet` digit for digit |
| CSV covers only the current month | `kind=detail` on the existing export returns a **date-ranged ledger** (`public.fleet_cost_detail`), one row per fill and per service, with the range echoed back and a backwards range swapped rather than rejected. | `0013` — *the export sums to exactly what the fills and the services add up to* (`Σ fuel_logs.total_cost_yer + Σ maintenance_records.cost_yer`), *one row per fill and per service*, *a stranger cannot export another organization's costs* · live: Oct range sums **77,500** = 59,500 + 18,000 |
| Stations were free text | A fill may name a `places` row of kind station; the form offers the directory and fills the name from it, and an unknown station is refused rather than silently stored. | `0013` — *a fill stores the station it was linked to* / *a station that is not in the directory is refused* · live: the picker lists `Al Rawda Station — Aden`, `Al Noor Station — Zinjibar`, and the seeded fills are **linked**, not just named |
| Attachments were write-only | `get_vehicle_health.recentRecords[].attachmentPath` and a read link through `/api/data/storage/v1/object/authenticated/vehicle-documents/…`; "mark done" accepts a note and a file. | `0013` — *a service records the invoice it was paid against* and *the health card returns the path so the invoice can be opened* · the mark-done form uploads first and refuses to record a service whose invoice did not land |

### Gates after 8.1

`sql:check` ✓ **29 migrations, 13 suites** (`0013` = **41 assertions**; `0005`'s plan-metric count moved
18 → 21 for the third plan column) · guards ✓ **29 migrations / 66 commands / 127 style files** ·
typecheck ✓ (core, web, mobile) · `npm test` ✓ **451 / 22 files** · coverage ✓ 95.84 % statements,
87.1 % branches (the two new `fleetCommandArgs` tests are what carry `src/api/fleet.ts` back over the line) ·
lint ✓ · format ✓ · a11y ✓ **68 routes, 9 discovered detail pages** · responsive ✓ · 8 edge bundles rebuilt ·
`db:types:check` ✓ 29 migrations.

### Still not done (unchanged opinion)

- **The anomaly bell has no per-user switch.** It is one weekly message per vehicle to the org owner and
  managers; a preferences screen is Phase 9's job and inventing one here would be half a feature.
- **`fleet_cost_detail` exports costs, not litres-and-kilometres reconciliation by trip.** The per-trip view
  is a screen, not a spreadsheet; if an accountant asks for it, it is a second `kind`.
- **The printed report has no logo per organization.** It prints the organization's name, which is what a
  driver hands over; branding is a settings concern nobody has asked for yet.

---

## 8. Phase 8.2 — the fleet dashboard, made to fit the screen it is on

The dashboard worked and read badly. Two stylesheet defects were doing most of the damage, and neither was
a matter of taste:

1. **`.fleet-grid` meant two different things.** Phase 3 defined it as the card grid
   (`display: grid; repeat(auto-fill, minmax(…280px…))`); the Phase 8 tables reused the name. The later rule
   never reset `display`, so **every fleet table — the rollup and the four tables on the health card — was
   laid out as a grid of 280px columns instead of a table**. The table styles now live on `.fleet-ledger`,
   which nothing else owns.
2. **`.console-grid` was a tile grid applied to every console page.** `repeat(auto-fill, minmax(220px, 1fr))`
   with a single child puts that child in the *first* 220px track, so `/operator/fleet` (and vehicles,
   drivers, health, trips…) rendered as a narrow strip beside a row of empty tracks. `.console-grid` is now
   one full-width column, and the three overview screens opt into the tile grid with `layout="tiles"`, which
   is the only place a wall of 220px tiles was ever wanted.

With the page finally the width of the page, the layout work was worth doing:

| At 320–719px | At 720px and up |
| --- | --- |
| Five totals as a 2-up card row (accent bar per state: red overdue, amber due soon, green clear) | The same five across one row, money cards widest |
| One sentence under the totals — *"Vehicles needing attention: 2"*, or *"Every vehicle is within its maintenance window"* | Same sentence; it is a fact, not a screen-width feature |
| Filters as chips with live counts (`All 3 · Overdue 1 · Due soon 1 · OK 1`), one tap target each | Same chips, right-aligned on the section heading |
| The fleet as a **list of cards**: plate as the title, state badge, then `label → value` rows drawn from `data-label`; the action gets the full width | A real table: aligned numeric columns, tabular figures, hover row, actions right-aligned |
| Export and report buttons side by side, full width; the date range stacks; the save button spans | Buttons inline; dates in a row; save right-aligned |

Rows are sorted by severity (overdue → due soon → OK), then by plate, so the first row is the one that needs
the workshop. That is presentation only: the totals above the list are always the whole fleet, whichever chip
is pressed.

**The guard grew a rule for the failure this invites.** Stacking a table hides its header, so every value must
carry its own label: `check:responsive` now fails a table whose `--cards`/`table-cards` class has more value
cells than `data-label`s. It was proved by deleting one label — `4 value cell(s) but only 3 carry data-label` —
and restoring it.

### Demo data, so the layout has something to lay out

The seed had one van, which made a fleet dashboard a single row: no filter, no card stack, nothing to
compare. Two more vans are seeded — a Coaster that is **1 550 km overdue** on its oil and a County that is
**healthy** — with their fills dated **last month**, deliberately. The dashboard's month figures are the
plan's acceptance numbers (**59 500** fuel, **18 000** maintenance) and they are quoted in §3 and in the PR;
adding this month's fuel would have quietly changed the evidence. Verified after a reset: the three rows read
`8-4471 overdue · 341 550 km · 11.78 L/100km`, `12345-ع due soon · 185 670 km · 8.44 L/100km`,
`5-2210 OK · 96 240 km · 7.5 L/100km`, and the totals are still 59 500 / 18 000.

### Gates after 8.2

`check:all` ✓ (guards 27 / 127 / 29 / 66 · responsive 42 media queries, the new label rule · lint · format ·
typecheck ×3 · 451 tests · coverage 95.84 % / 87.1 % · db types · edge bundle · 29 migrations, 13 suites) ·
`check:a11y` ✓ **68 routes**, including the fleet page in both directions · both locales render the new
copy (`مركبات تحتاج إلى انتباهك: 2`).

---

## 9. Phase 8.3 — the marketplace, the booking form and the account area

The same method as 8.2: find the defects that are facts about the markup and the stylesheet, fix those first,
then let the layout follow. The marketplace had three, and one of them meant a desktop visitor could not filter
at all.

1. **The filters were unreachable from 900px up.** The panel is a `<details>` whose `<summary>` is
   `display: none` on a wide screen — a sidebar has no toggle. But the panel was rendered
   `open={activeCount > 0}`, so a visitor who had not filtered anything got a *closed* disclosure with no
   summary: the content is not merely collapsed, it is not rendered, and no stylesheet can bring it back.
   `<details>` hides its own content by attribute, so the attribute is the fix. `FilterDisclosure` sets `open`
   from `matchMedia('(min-width: 900px)')` and marks the panel `data-enhanced`; the summary is hidden only
   once that attribute is there. Without JavaScript the summary stays visible and the panel is one click away
   — the failure mode is a disclosure, never a form nobody can reach. The old CSS also assumed a `<details>`
   keeps its marker under `display: flex`; it does not, so the summary now draws its own chevron.
2. **`.trip-filters__actions` styled `.btn`; the markup writes `.ui-btn`.** The "full width on a phone" rule
   therefore never applied and nothing was ever stretched — the same class-drift the fleet ledger had.
3. **`.trip-filters__count` was used three times and defined nowhere.** The facet counts ("Aden 2"), the
   active-filter count on the summary and the direct count all rendered as loose digits after a label.
4. **The filter groups zeroed their own margins** (a `<fieldset>` needs that) and the form between them had no
   gap, so the nine controls sat flush against each other. The form is now the grid that spaces them.

With those fixed, the rest was layout:

**The first version of that fix caused a hydration error, and it is worth recording why.** It rendered `open`
from React state, which makes React the authority on an attribute the *user* owns: tapping the summary flips it
with no React involvement, so a tap that landed while a slow hydration was still running left the panel open in
the DOM and `open={false}` in props — and React reported *"a tree hydrated but some attributes of the server
rendered HTML didn't match"*, `open=""` on one side and `open={false}` on the other. `open` is not a prop any
more: the element is driven through a ref after mount (`element.open = true` from 900px up), so React never
renders the attribute and there is nothing for hydration to disagree with. Opening the panel on a phone went
with it, deliberately — doing that a frame after first paint shoves the results half a screen down — and the
count beside "Filter" already says the filters are in force. `check:guards` rule 15 now fails any `<details>`
that renders `open`, proved by putting the prop back and watching the build fail with the line number.

| At 320–719px | At 720px and up |
| --- | --- |
| Filters behind one 44px row: *Filter* + a brand badge with the number in force; the panel opens into full-width fields | A 16–18rem sidebar, always open, summary gone |
| Filter and Clear are full-width buttons, stacked | One row, hugged left |
| Trip cards in one column; price above a full-width action | `auto-fill` cards from 22rem; price and action on one line |
| The book bar is a floating card pinned to the bottom of the screen | Inline buttons in the article, no shadow, no border |
| Timeline stops: numbered pin, name, then arrival and fare beneath it | Arrival and fare on the stop's own line, right-aligned |
| The booking form is a card that is the page | Same card, 40rem, more padding |
| Account sections: pill navigation that scrolls sideways | The same pills, wrapped into rows |

**The trip detail page had no rules at all.** `.trip-detail` was used as a wrapper and defined nowhere, so the
busiest page in the marketplace — heading, eleven summary rows, three stops, policies, operator, sticky book
bar — was a stack of browser default margins. It is now one column of blocks with a rhythm, capped at 48rem,
and **deliberately not a grid**: `position: sticky` on the book bar needs the article to be its containing
block, and a grid item is confined to its own row, which would silently unpin the bar.

**The stop marker was a 0.7rem dot with the stop's number inside it**, so the digit drew over the circle. It is
a 1.5rem numbered pin now. **The route arrow was a hard-coded `←`**: the English page read *"Aden ← Sana'a"*,
which says the opposite of the trip, while the JSON-LD on the same page said `Aden → Sana'a`. It is `→` now,
flipped by the `--icon-flip` token the chevrons already use, so Arabic still reads the way Arabic reads.

**The account area had no navigation.** `/account/bookings`, `/account/invitations`, `/account/licence` and
`/account/verification` were reachable only from the hub's button row — a person on their bookings had no way
back to their details but the back button. Every account page now carries the same five-link pill row, marked
`aria-current="page"`. The hub itself lost its inline styles, its doorway links became a tile grid, and
signing out — which ends the session, and is not one of the page's actions — moved below a rule with the
sentence that says so. `.account-org` was also the one element in the app painted with a literal `#fff`, which
is invisible only for as long as there is no dark theme.

**Two class names that have never existed, closed.** `driver/LicencePanel.tsx` has written `fleet-panel` and
`fleet-form-grid` since Phase 3; neither was ever in the stylesheet, which is why `/account/licence` rendered as
an unbordered stack of fields. Both now have rules. It is the same failure as `.trip-filters__count`, and the
reason the audit for "class used with no exact rule" is worth running after every screen.

### Demo data, so the marketplace is a marketplace

One published trip proves the booking flow and cannot prove the marketplace: one card has no second column to
get wrong, no sort that changes anything, no origin facet with two counts, and never a **Direct** badge (that
badge means *no stops*, and the only seeded trip had three). Two more departures are now seeded through the
same three commands as the first — a direct Aden → Taiz on the Coaster, and a women-only Sana'a → Aden via Taiz
on the County — guarded per route so a stack left running does not grow duplicates. After a reset `/en/trips`
reads **3 trips**, facet counts Everyone 2 / Women only 1 / Men only 0, **Direct 1**, and the three cards are
Aden → Sana'a (featured, 14 seats, YER 5 000), Aden → Taiz (direct, 22 seats, YER 2 500) and Sana'a → Aden
(women only, 26 seats, YER 4 500). The fleet month figures are untouched — no fills were added.

The same argument applies one screen further in. `/account/bookings` is a *list*, and with no bookings the demo
only ever showed its empty state — so the booking card this phase restyled was never rendered by anybody. One
**accepted** booking is seeded for the demo owner on the direct trip: accepted rather than pending because a
pending booking carries a 30-minute hold, and a demo that expires while somebody is looking at it is worse than
none. It is on the direct trip deliberately — no destination stop means the flow exercises the null-stop branch
that a stop-priced trip never reaches. After a reset the page reads *Upcoming* with `Aden → Taiz`, badge
**Confirmed**, the reference in a `<bdi>` and the fare beside it.

### Gates after 8.3

`check:all` ✓ (guards 27 / 129 / 29 / 66 · responsive **50 media queries**, 7 tap targets, no hidden
navigation, no unguarded grid tracks · lint · format · typecheck ×3 · 451 tests · coverage 95.84 % / 87.1 % ·
db types · edge bundle · 29 migrations, 13 suites) · `check:a11y` ✓ **71 routes** (68 + the public trip detail in
both directions and the signed-in booking form), 12 discovered detail pages. The booking form is discovered from
a marketplace card and signed in as the **driver** account, not the owner: the seed gives the owner a booking, so
the owner's visit would correctly answer `ALREADY_BOOKED` and the form this check exists for would never be
parsed.

**What was not verified: pixels.** There is no headless browser in this environment, so every layout claim in
this section was checked in the served HTML and by CSS arithmetic — DOM shape, computed widths at 320 / 360 /
720 / 900 / 1280, direction-sensitive rules, and the two class audits — and never by looking at a screenshot.
The one behaviour that is neither markup nor stylesheet, `FilterDisclosure` setting `open` from a `matchMedia`
subscription on mount, is described here rather than claimed as observed; its failure mode is a visible
summary, which is checked — the server response for a filtered page now carries no `open` attribute at all.
