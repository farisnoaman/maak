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

What is still true, and written down rather than implied: cold search is O(public trips) at ~100–145 ms, so the
capacity is ~7 cold searches/second/core and four concurrent cold searches on this two-core sandbox reach
p95 316 ms. The 30 s cache is doing real work. `docs/perf/README.md` lists the three changes that would remove
the limit — a maintained facet aggregate, cache warming, per-dimension partial indexes — in order of value.

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

---

## 2. In flight

1. **The `k6` run.** The suites exist (`docs/perf/k6-search.js`, `k6-booking-race.js`, `k6-ping-ingest.js`,
   `k6-finance-dashboard.js`) with thresholds that fail the run, and the sandbox-runnable harnesses behind them
   (`perf:seed`, `perf:smoke`, `perf:db`) have already found and fixed a 15.7 s search. What has not happened is
   running k6 against a production-sized environment with a real PostgREST and a connection pooler. Payment
   confirmation volume is also unmeasured — it needs a provider fixture.
2. **The remaining guides.** `docs/admin-guide.md`, `docs/operator-guide.md` and the Arabic passenger guide are
   open. The runbook covers emergencies; these cover the day-to-day journeys.
3. **`plpgsql_check`.** The extension is not in the embedded PostgreSQL build, so it is a CI-on-Supabase item.
4. **Mobile release mechanics.** EAS config, store listings, the RTL screenshot set — and the React Native 0.88
   upgrade that closes the toolchain advisories in §6.

---

## 3. Gates, as of this commit

| Gate | Result |
| --- | --- |
| `npm run check:all` | green |
| `npm run sql:check` | 37 migrations · 17 pgTAP suites · **904 assertions** · types in sync · **security posture green** |
| `npm test` | **649 tests**, 26 files |
| `npm run test:coverage` | 95.77 % statements · 87.09 % branches · 96.46 % functions · 96.72 % lines |
| `npm run check:guards` | 31 core files · 176 style files · 37 migrations · 130 commands |
| `npm run check:a11y` | 107 routes, both directions |
| worker against a fresh dev database | 10 jobs, `maintenance: {sent: 2}`, `ops-alerts: {counts: all zero}`, exit 0 |
| `npm run perf:smoke` at 50,000 trips | search 112 ms p95 cold / 3 ms cached · write 5 ms · dashboard 79 ms |

---

## 6. What is still open

1. **No load test at production volume has been run.** The p95 targets (search < 300 ms, writes < 250 ms, finance
   dashboard < 500 ms) are verified *at 50,000 trips, one request at a time* — 112 ms, 5 ms, 79 ms — and the
   concurrency limit that remains is documented in `docs/perf/README.md`. A k6 run on hardware with the stated
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
7. **Failure alerting for the worker itself.** The workflow fails loudly, which reaches GitHub's notification
   settings; there is no dedicated on-call rotation or pager, and for a launch with three pilots that is the
   right size.
