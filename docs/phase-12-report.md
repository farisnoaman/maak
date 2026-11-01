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

`npm run sql:check` now ends with `▶ security posture`, which applies all 35 migrations to a real PostgreSQL and
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

---

## 2. In flight

1. **Performance (`k6`) suites and a query-plan review.** Deliverable in the plan; the harness needs a seeded
   database at volume (100k trips, 200 live), which is the next piece of work. Nothing under `docs/perf/` yet.
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
| `npm run sql:check` | 35 migrations · 17 pgTAP suites · **893 assertions** · types in sync · **security posture green** |
| `npm test` | **649 tests**, 26 files |
| `npm run test:coverage` | 95.77 % statements · 87.09 % branches · 96.46 % functions · 96.72 % lines |
| `npm run check:guards` | 31 core files · 176 style files · 35 migrations · 130 commands |
| `npm run check:a11y` | 107 routes, both directions |
| worker against a fresh dev database | 10 jobs, `maintenance: {sent: 2}`, `ops-alerts: {counts: all zero}`, exit 0 |

---

## 6. What is still open

1. **No load test has been run.** The p95 targets (search < 300 ms, writes < 250 ms, finance dashboard < 500 ms)
   are unverified until the `k6` suites exist and a database at production volume exists to run them against.
2. **Dependency debt in the mobile toolchain.** `npm audit --omit=dev` reports 19 advisories (18 moderate, 1 high,
   0 critical), all inside Expo/React Native build tooling (`metro`, `@expo/cli`, `image-size`, `@react-native/*`)
   — code that runs on a developer machine and in EAS, not in the web bundle or on a phone at runtime. `npm audit
   fix` was tried and reverted: it closed the high by pulling newer transitives and opened a **critical** in
   `@expo/cli`, which is worse. The fix is the RN 0.88 upgrade during the mobile release, not a blind `audit fix`.
3. **Backups are documented, not drilled.** `docs/runbook.md` §3 has the procedure and the integrity check; the
   first real restore into a scratch project has not happened yet, so the RTO is a target, not a measurement.
4. **`cmd_run_integrity_check` (Phase 10) still writes its alert directly to `notifications`.** It bypasses the
   delivery pipeline, so an integrity failure produces a bell that is never pushed and repeats on every run.
   `cmd_run_ops_alerts` covers the same condition properly (deduped, delivered), which is why this is not urgent;
   fixing it means restating a 150-line function, so it is scheduled rather than rushed.
5. **No pilot UAT.** Three operators, a full cycle each, unaided — that is a calendar item with real people.
6. **Store releases and the tag.** `v1.0.0`, the changelog and the handover session come after the UAT burn-down.
7. **Failure alerting for the worker itself.** The workflow fails loudly, which reaches GitHub's notification
   settings; there is no dedicated on-call rotation or pager, and for a launch with three pilots that is the
   right size.
