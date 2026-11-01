# Phase 12 — hardening, security and launch readiness

**Date:** started 2026-11-01 · **Branch:** `arena/e6f329f0-maak`
**Scope:** `IMPLEMENTATION_PLAN.md` Phase 12. This file is written as the phase runs: §1 is what is in place and
verified today, §2 what is in flight, §6 what is honestly still open. It is not a launch sign-off — the pilot UAT
and the store releases are the parts a repository cannot do.

The phase's premise: everything up to here was built to work. This one is about the failure modes — the job that
stops, the table without row-level security, the alert nobody reads, the restore that was never tested.

---

## 1. Done and verified

### 1.1 The platform now alarms on itself

`00034_ops_alerts.sql` adds `cmd_run_ops_alerts(uuid, timestamptz)` and a tenth notification job. It runs with
the worker, and checks six conditions that the launch plan names:

| Check | Condition | Who is told | Where the link goes |
| --- | --- | --- | --- |
| `stale_trips` | a trip `in_progress` 18 h after departure | platform staff | `/staff/trips` |
| `dead_deliveries` | a notification that exhausted five attempts in the last 7 days | platform staff | `/staff/dashboard` |
| `unbalanced_journals` | the ledger does not balance | finance + admin | `/finance/dashboard` |
| `verification_backlog` | pending verification requests older than 48 h | platform staff | `/staff/verifications` |
| `payment_sla` | a receipt uploaded and undecided for 6 h | finance + admin | `/finance/payments` |
| `error_rate` | 20+ denied/failed commands in the last hour (`audit.log`) | platform staff | `/staff/dashboard` |

Design decisions worth recording:

- **Alerts are notifications, not a dashboard.** They go through `app.enqueue_notification`, which means a dedupe
  key (`ops-alert:<check>:<YYYY-MM-DD>`), a delivery row per channel, and a receipt support can read a month
  later. A dashboard nobody watches is not an alert.
- **One kind, six sentences.** `ops_alert` is the kind; the title key is chosen per check, so the message says
  what was counted and where to look instead of "something is wrong".
- **The count is always returned**, even when zero. A scheduler log line reading
  `{"counts":{…},"sent":0}` proves the sweep ran; a missing line proves it did not. The audit table gets a row per
  run for the same reason.
- **Bug found while wiring it:** the job runner sends `p_now: null`, and an explicit `null` overrides a SQL
  parameter default — every comparison became `NULL`, every count zero, and the sweep would have reported a
  healthy platform for ever. Fixed with `coalesce(p_now, now())`, and `0017_ops_alerts.test.sql` now asserts that
  a null clock means *now* rather than *nothing happened*. This is the single most important test in the suite:
  an alerting job that silently reports health is worse than no alerting job.

**Evidence, end to end on the dev stack.** 25 refused commands were written to `audit.log`, then one worker pass:

```json
"ops-alerts": {"sent": 2, "alerts": ["error_rate"],
               "counts": {"error_rate": 25, "payment_sla": 0, "stale_trips": 0,
                          "dead_deliveries": 0, "unbalanced_journals": 0, "verification_backlog": 0}}
```

and the staff inbox:

```
ops_alert  notifications.opsErrorRate  {"check": "error_rate", "count": 25}  /staff/dashboard
           channels: {in_app: sent, push: pending, email: pending}
```

Two rows for one condition: platform staff and the admin both need it, and one dedupe key per recipient is how
"told once" stays true per person.

### 1.2 The security review is a gate, not a document

`npm run sql:check` now ends with `▶ security posture`, which applies all 37 migrations to a real PostgreSQL and
then asks the catalogue four questions:

- does every table in `public` have row-level security enabled?
- is there any table granting `SELECT` to a client role with no policy (a screen that would read nothing)?
- does every `security definer` function pin `search_path`?
- is any `cmd_*` executable by `anon`, `authenticated` or `public`?

**It found a real hole on its first run:** every partition of `public.trip_location_pings` had RLS switched off,
because `create table … partition of` copies neither policies nor grants. Nothing was reachable — the child also
inherits no `authenticated` grant, so the ACL refused first — but one line of defence was holding where two were
designed. `00035_partition_rls.sql` repairs the existing partitions and makes
`app.ensure_trip_ping_partition()` apply `enable` + `force row level security`, the parent's policy and an
explicit `revoke` on every call, so next month's partition cannot reopen it.

The full review — the RLS matrix, the definer-function patterns, dependency state, what is still open — is
[`docs/security-review.md`](./security-review.md).

### 1.3 There is a scheduler, and it fails loudly

`docs/ci/notify.yml`: a five-minute workflow that runs the worker with `--fail-on-error`, which exits non-zero when
a pass had a failed delivery or a job that threw. That exit code is the cron's only alert channel, and
`docs/runbook.md` §2 explains what to do when it goes red. `npm run ci:install` now installs `ci.yml` **and**
`notify.yml` in one command.

The schedule block ships commented out: a cron on a public repository bills minutes from the moment it is pushed,
and the cadence is the owner's decision. Activating it is one uncomment, two secrets
(`MAAK_API_URL`, `MAAK_WORKER_TOKEN`) and a commit.

### 1.4 The runbook exists

[`docs/runbook.md`](./runbook.md): the five-minute triage, what each of the six alerts means and how to clear it,
the scheduler and its cadence, the backup/restore drill with the integrity check that has to pass before the app
is pointed at a restored database, a symptom → first-command table, and who to call. Written to be read at 02:00
by somebody who did not build the platform.

### 1.5 Search was fifty times too slow, and nobody could have known

The plan's Phase 9 line read: *"Facets + 30 s cache done; **k6 benchmark not written or run** (no k6, no 50k-trip
seed)."* That is a gap with a shape — the acceptance criterion was attached to a test that did not exist, so it
could only ever be assumed. Building the seed made it measurable in eight seconds:

**p95 15,690 ms at 50,000 trips.** Against a 300 ms target. On the three-trip demo database the same function
takes 4 ms, which is why two phases passed without anybody noticing.

The cause was structural rather than a missing index: `search_public_trips` called `app.trip_matches()` once per
row *per facet* — five passes over `trips_search`, each rebuilding four text arrays out of the filter JSON for
every row — and its sort key was a function taking a whole composite row, which PostgreSQL cannot inline, so
50,000 rows meant 50,000 function calls costing 226 ms on their own.

`00036_search_performance.sql` evaluates each dimension once per row into a materialised projection and answers
the page, the total and all five facet groupings from it; the sort key gained a scalar overload that inlines.
**112 ms p95 cold, 3 ms on a cache hit.** 0007 gains six assertions that the fast path and `app.trip_matches()`
return the same totals and facets, because the rewrite is allowed to be faster and nothing else.

What was still true after it, and written down rather than implied: cold search was O(public trips) at
~100–145 ms, so the capacity was ~7 cold searches/second/core and four concurrent cold searches on this
two-core sandbox reached p95 316 ms. The 30 s cache was doing real work, and `docs/perf/README.md` listed the
three changes that would remove the limit. Two of them are now in: §1.8.

### 1.6 The one alarm that never left the building

The ops sweep above pages people. The *finance* alarm did not. `cmd_run_integrity_check` (Phase 10) reported a
ledger that does not balance by inserting straight into `public.notifications`:

```sql
insert into public.notifications (user_id, kind, title_key, params, link) select …
```

That row never reaches `notification_deliveries`, so the worker never claims it: no push, no email, no retry, no
dedupe — and one more in-app row for every scheduled run of a check that may stay red for a week. The alert that
says "the books do not balance" was the single alert the delivery pipeline never saw, in a bell somebody has to
remember to open. `00032` already had the right door (`app.enqueue_notification`) and the event catalogue already
knew the kind (`finance_alert`, critical, `{in_app, push, email}`); the call site simply predated both.

`00037_finance_alert.sql` restates the function — same ten checks, same audit row — and replaces the insert with
a per-recipient `app.enqueue_notification` call, deduped `finance-integrity:<YYYY-MM-DD>` in the notification
timezone. The count inside the message is what changes between runs; the number of messages does not.

Proved end to end on the dev stack, not just in pgTAP: one riyal of tampering (immutability trigger off, `+1`,
back on), `finance.job.run` as an admin, and the inbox shows `finance_alert` → `{in_app: sent, push: pending,
email: pending}`, dedupe key `finance-integrity:2026-11-01`, link `/finance/dashboard`; the worker then drained it
to `{in_app: sent, push: skipped, email: skipped}` (no provider configured, which is the documented dev
behaviour). The ops sweep independently reported `unbalanced_journals: 1` at the same moment, so the two paths
now agree about the same broken ledger instead of only one of them noticing.

0015 gains five assertions, including the one that names the old bug: *no `finance_alert` notification exists
without a delivery behind it*. Put the old insert back and four of them fail.

### 1.7 Three guides, and what they found

A guide is a test. Writing down what a person does step by step is the cheapest audit there is, because prose
that cannot be written is a flow that does not exist. Three documents:

- **`docs/operator-guide.md`** — the business side: verification, vehicles, drivers, the five-step trip wizard,
  bookings and seat holds, confirming receipts, payouts, plans and quota, the team roles.
- **`docs/admin-guide.md`** — the platform side: the four roles and their separation of duties, the verification
  queue, the staff and finance consoles, plans and geography, and a table of what the platform refuses to do.
- **`docs/passenger-guide.md`** — in Arabic, for the person buying a seat: search, book, pay, cancel, the refund
  ladder, tracking, and notifications.

Each claim in them was checked against the migration that implements it, not against memory. That caught four
things this round:

1. **The refund ladder is not one ladder.** A passenger who cancels gets 100 / 75 / 50 / 0 % by hours remaining;
   a passenger whose *operator* cancels gets 100 % regardless. Writing it as one table would have been wrong.
2. **Quota is a wall for every plan.** The 00013 version of `app.assert_quota` exempted soft-limit plans; `00014`
   replaced it, so Basic, Pro and Business all refuse at 100 % — what Pro and Business add is the 80 % warning.
   An older reading of the code would have documented Pro as *unlimited*, which it is not.
3. **Identity documents are purged 90 days after the booking closes**, not after the trip, and the share link is
   a 72-hour, single-live-token document share — not a general "share my booking" link.
4. **Quota warnings come from two places and disagree about `Basic`.** `app.quota_state()` only sets `warning`
   when the plan is *soft* (Pro, Business), so the create-trip response warns at 80 % for those two and never for
   Basic; the `quota` notification job does not read that flag and fires at 80 % and 100 % for every plan with a
   limit, Basic included. Neither is wrong in isolation — the job's message is informational, the in-flow warning
   is an instruction — but they should be one decision in one place. Documented rather than changed, because
   changing it this late means deciding which behaviour the product wants, and that is not a documentation task.
5. **Account deletion is a request with no executor.** `cmd_request_account_deletion` sets
   `deletion_requested_at` and `/account` shows it, but the column's comment promises a staff action in Phase 7
   and no such command exists. That is now open item 8 in §6: a support queue that can receive a request it has
   no tool to answer is worse than not offering the button.

The guides also cross-reference each other and the runbook rather than repeating it: emergencies live in
`docs/runbook.md`, the day-to-day in the operator and admin guides, and the passenger view in Arabic only,
because that is the language of the person it is written for.

### 1.8 The search ceiling, removed

§1.5 made search forty times faster and then wrote down that it was still O(public trips). Being honest about a
ceiling is not the same as accepting it, and the measurement said exactly where it was. At 50,000 trips one
cold search cost 155 ms of which: **79.5 ms** was five facet aggregations, **54.8 ms** the total, **50.5 ms**
ranking every public trip so the first twelve could be sorted out of it, and **66.8 ms** the page sort and its
joins — four costs, all proportional to the catalogue, none of them a bug.

`00038_search_counts.sql` removes two of them and leaves the other two understood:

- **The counts are counted once.** Six facets in one pass, from one definition: group the public trips into
  `(origin, destination, gender, booking, direct)` buckets — about thirty at this volume, 8,700 if every
  governorate flew to every other — and every cascading count is then a sum over buckets. That is 35 ms instead
  of 79, and the four dimension filters are applied to thirty rows instead of fifty thousand. A filtered search
  calls it directly; the *unfiltered* answer, which is the homepage and most of the traffic, is stored in
  `search_counts` and rebuilt by whichever request notices it is over thirty seconds old
  (`app.ensure_search_counts()`, one refresher at a time behind an advisory lock).
- **The page is no longer sorted.** `trips_search` gained three generated rank columns, one per sort, each
  indexed with `trip_id` and partial on `is_public`. `ORDER BY rank, trip_id LIMIT 12` is now an index scan that
  stops after twelve rows — 0.03 ms — and the keyset cursor is an index condition rather than a filter, so a
  deep page costs what it has to skip and nothing more.
- **The total stays exact.** It is an index-only `count(*)` (7 ms), because it is the number the user reads and
  paginates against. The facet chips are allowed to be thirty seconds old; the count of results is not.

Back to back on the same 49,998-trip database, with the facets compared for equality on every shape:

| cold search, 12 rows | 00036 | 00038 |
| --- | --- | --- |
| unfiltered — the homepage | 161.6 ms | **12.9 ms** |
| `priceMax: 1234` (matches almost nothing) | 112.6 ms | **3.0 ms** |
| `priceMax: 9000000` (matches everything) | 159.7 ms | 42.0 ms |
| `direct: true` | 155.1 ms | 41.6 ms |

`perf:smoke`'s p95 fell from 112 ms to **5.6 ms**, `perf:db`'s worst case from 316 ms at four callers to 195 ms
at eight, and the per-core capacity statement from ~7 cold searches/second to ~23. The 42 ms rows are the honest
remainder: a filter cannot be answered by an aggregate computed over every filter, so its counts are still one
pass — cached for thirty seconds, shared by every sort and every page of that filter set, and never done twice
for the same one.

The contracts that keep "faster" from meaning "different" are in 0007 rather than in this report: the generated
keys equal `app.trip_rank()` to the digit for all three sorts, the bucketed counts equal `app.trip_matches()`
dimension by dimension with a filter on, the stored counts equal the counting function, a cursor page is the row
after the last one page 1 showed, and a stale aggregate is refreshed by the first request that notices. Ten new
assertions, 113 in that suite.

---

## 2. In flight

1. **The `k6` run.** The suites exist (`docs/perf/k6-search.js`, `k6-booking-race.js`, `k6-ping-ingest.js`,
   `k6-finance-dashboard.js`) with thresholds that fail the run, and the sandbox-runnable harnesses behind them
   (`perf:seed`, `perf:smoke`, `perf:db`) have already found and fixed a 15.7 s search. What has not happened is
   running k6 against a production-sized environment with a real PostgREST and a connection pooler. Payment
   confirmation volume is also unmeasured — it needs a provider fixture.
2. ~~The remaining guides.~~ **Written:** `docs/operator-guide.md`, `docs/admin-guide.md` and
   `docs/passenger-guide.md` (Arabic). §1.7 records what writing them cost — two claims that were wrong in the
   product, not in the prose.
3. **`plpgsql_check`.** The extension is not in the embedded PostgreSQL build, so it is a CI-on-Supabase item.
4. **Mobile release mechanics.** EAS config, store listings, the RTL screenshot set — and the React Native 0.88
   upgrade that closes the toolchain advisories in §6.

---

## 3. Gates, as of this commit

| Gate | Result |
| --- | --- |
| `npm run check:all` | green |
| `npm run sql:check` | 38 migrations · 17 pgTAP suites · **914 assertions** · types in sync · **security posture green** |
| `npm test` | **649 tests**, 26 files |
| `npm run test:coverage` | 95.77 % statements · 87.09 % branches · 96.46 % functions · 96.72 % lines |
| `npm run check:guards` | 31 core files · 176 style files · 38 migrations · 130 commands |
| `npm run check:a11y` | 107 routes, both directions |
| worker against a fresh dev database | 10 jobs, `maintenance: {sent: 2}`, `ops-alerts: {counts: all zero}`, exit 0 |
| `npm run perf:smoke` at 50,000 trips | search 5.6 ms p95 cold / 2.7 ms cached · write 4.2 ms · dashboard 83.5 ms |

---

## 6. What is still open

1. **No load test at production volume has been run.** The p95 targets (search < 300 ms, writes < 250 ms, finance
   dashboard < 500 ms) are verified *at 50,000 trips, one request at a time* — 5.6 ms, 4.2 ms, 83.5 ms — and
   the one linear cost that remains (an unselective filter's facet counts, 42 ms) is documented in
   `docs/perf/README.md`. A k6 run on hardware with the stated
   load has not happened, because there is no such environment yet.
2. **Dependency debt in the mobile toolchain.** `npm audit --omit=dev` reports 19 advisories (18 moderate, 1 high,
   0 critical), all inside Expo/React Native build tooling (`metro`, `@expo/cli`, `image-size`, `@react-native/*`)
   — code that runs on a developer machine and in EAS, not in the web bundle or on a phone at runtime. `npm audit
   fix` was tried and reverted: it closed the high by pulling newer transitives and opened a **critical** in
   `@expo/cli`, which is worse. The fix is the RN 0.88 upgrade during the mobile release, not a blind `audit fix`.
3. **Backups are documented, not drilled.** `docs/runbook.md` §3 has the procedure and the integrity check; the
   first real restore into a scratch project has not happened yet, so the RTO is a target, not a measurement.
4. ~~`cmd_run_integrity_check` writes its alert directly to `notifications`.~~ **Closed in `00037` (§1.6):** the
   alert now goes through `app.enqueue_notification`, deduped per day, with the delivery rows the worker drains.
5. **No pilot UAT.** Three operators, a full cycle each, unaided — that is a calendar item with real people.
6. **Store releases and the tag.** `v1.0.0`, the changelog and the handover session come after the UAT burn-down.
7. **Account deletion has a request and no executor.** `cmd_request_account_deletion` records the request and a
   reason, `/account` shows it and allows a cancel; the column comment says the deletion is a staff action and no
   such command was written. Financial and audit rows must be retained, so the fix is an anonymise-and-close
   command (profile, contact details, device tokens, personal documents) rather than a `delete from auth.users`,
   and it needs a decision on what a retained ledger line refers to afterwards.
8. **Quota warnings come from two places and disagree about Basic.** `app.quota_state()` sets `warning` only for
   soft plans (Pro, Business), so the create-trip response warns at 80 % for those two and never for Basic; the
   `quota` notification job does not read that flag and fires at 80 % and 100 % for every plan with a limit,
   Basic included. Neither is wrong alone — the job's message is informational, the in-flow warning is an
   instruction — but it should be one decision in one place, and making it is a product call rather than a
   documentation one.
9. **Failure alerting for the worker itself.** The workflow fails loudly, which reaches GitHub's notification
   settings; there is no dedicated on-call rotation or pager, and for a launch with three pilots that is the
   right size.
