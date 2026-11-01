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
4. ~~Quota warnings come from two places and disagree about `Basic`.~~ **Closed in `00041`.** The finding was
   right and incomplete: the two paths disagreed twice. They disagreed about *who* — `app.quota_state()` set
   `warning` only for soft plans, so the create-trip response said nothing while the job mailed a Basic owner —
   and about *when*, because the response tested the next unit (`(used + 1) * 5 >= limit * 4`) while the job
   tested the current usage (`used * 100 / limit >= 80`): at a limit of 50, `used = 39` against `used = 40`.
   The product call the finding asked for is made: the 80 % notice is universal and arrives when the next unit
   crosses it. `threshold` is a field of the state — 100 at the limit, 80 when the next unit crosses, null
   otherwise — and the job consumes it instead of computing its own.
5. ~~Account deletion is a request with no executor.~~ **Closed in `00039` (§1.9):** `cmd_delete_account`
   anonymises the person and keeps the books. The gap is worth reading in full, though, because it is the one
   this report found by *writing prose* rather than by running a test: the column comment promised a staff
   action and no such command existed.

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

§1.8 left the remainder honest and the remainder was the *common* case: `direct: true` cost 41.6 ms because its
counts were still a pass over 50,000 trips. `00040_search_bucket_counts.sql` removed it by noticing what the
buckets already are. The dimension filters — origin, destination, gender, booking mode, direct — are the axes of
the bucket tuple, so a count filtered on some of them is a sum over the buckets the rest admit: the buckets
became a table, the stored homepage chips became their projections instead of a second scan, and a
dimension-filtered search is arithmetic over ~30 rows. The exact total is counted from a new covering index
(`trips_search_facets_idx`), and the enum dimensions are compared as enums, because `gender_policy::text =
any(…)` casts 50,000 times (12.3 ms) where `gender_policy = any(enum[])` compares enums (5.5 ms).

| cold search, cache cleared | 00038 | 00040 |
| --- | --- | --- |
| homepage | 12.9 ms | **6.1 ms** |
| `direct: true` | 41.6 ms | **7.7 ms** |
| a selective origin | ~41 ms | **2.7 ms** |
| `destination` + `booking` | ~41 ms | **3.1 ms** |
| `gender: ["any"]` (matches all but one trip) | ~42 ms | **8.6 ms** |
| `priceMax` over every price — the row path | 42.0 ms | 37 ms |

The last row is what remains, and it is the right thing to remain: no aggregate computed over every filter can
answer "under 5,000 riyals", so that search still pays one grouping pass, cached for thirty seconds per filter
set. The capacity sentence moves from ~23 to **~115 cold searches per second per core in the worst dimension
case**, and 160+ for the homepage. `perf:db` grew a second series to keep it honest — measuring the facet path
with the same filter values every call would have measured the cache and reported 0 ms, which this file's
sibling has been fooled by once already.

`0007` gained four assertions: the buckets sum to the public future trips, bucket arithmetic equals row
arithmetic for a gender filter and for three dimensions at once, and a dimension-filtered search's origin facet
equals `app.trip_matches()`'s grouping. 44 migrations, 986 assertions across 19 suites.

The contracts that keep "faster" from meaning "different" are in 0007 rather than in this report: the generated
keys equal `app.trip_rank()` to the digit for all three sorts, the bucketed counts equal `app.trip_matches()`
dimension by dimension with a filter on, the stored counts equal the counting function, a cursor page is the row
after the last one page 1 showed, and a stale aggregate is refreshed by the first request that notices. Ten new
assertions, 113 in that suite.

### 1.9 The deletion that finally has an executor

§1.7 ended with the worst kind of gap: `/account` offers a **delete my account** button, the database records the
request with a reason, and nothing on the platform side could complete it. The column's own comment said "a staff
action (Phase 7)", and Phase 7 shipped without one. A support queue that can accept work it has no tool to
answer is worse than no button at all — and a privacy policy that promises erasure makes it a legal problem, not
a UX one.

Making the decision was the hard part. `delete from auth.users` is not available: `bookings.passenger_id`,
`trips.owner_user_id`, `invoices.owner_user_id` and `payouts.requested_by` are all `ON DELETE RESTRICT`, because
those rows are the books, and a ledger that stops adding up to hide a name is not a trade anybody gets to make.
So `00039` deletes the *person* and keeps the *records*:

- **Erased:** name, phone, email, national id and its type, birth place and date, avatar, verification status and
  notes, the ID photographs, licence number and photo, bank account number and holder, push tokens, notification
  bodies, saved searches, roles, geo assignments, share tokens. The login in `auth.users` is scrubbed and — where
  the project allows it — banned.
- **Kept, with the person removed from them:** the `profiles` row itself (an unnamed shell every financial row
  still points at), bookings with their amounts and statuses but `محذوف` where a name used to be, invoices,
  payouts, refunds, journal entries, subscriptions, and the audit log.
- **Refused while the answer would be a lie:** live bookings, live trips, a vehicle registered to the account, an
  organization they own, a non-zero available balance. The command is `platform_admin`-only and refuses the
  actor's own account, so a deletion always has a second pair of eyes.

Two details worth the paragraph. The **audit row carries flags, not facts** — `hadEmail: true`, never the email —
because an immutable log is exactly where an erasure could quietly survive. And the command **reports what it
could not do**: `documentsToErase` hands back the Storage paths (the rows are ours, the objects are not) and
`authScrubbed` says whether the login was removed, so a project whose `auth.users` this role cannot write gets a
truthful "outstanding" rather than a false "done".

`0018_account_deletion.test.sql` proves it in 30 assertions: six refusals that leave the account untouched, the
erasure across nine tables, the booking that keeps its 10,000 YER and loses its name, the audit row with no
personal data in it, the storage paths handed back, and a second run that is idempotent instead of destructive.
`docs/admin-guide.md` §6a is the operator's half: what to delete in Storage, and how to read `authScrubbed`.

The command had one gap left after it shipped, and the honest word for it is *findable*: `account.delete` could
act on a user id, and nothing in the product produced one. A request lands in `profiles.deletion_requested_at`,
which meant an operator who read §6a knew the procedure and not the person to run it on. `/admin/users` now
carries the queue — a read through `profiles_select_staff` (so a passenger who reaches the page reads nothing),
the requester's own words beside the reason the operator must type, and the row removed on success rather than
greyed out. Verified against the dev stack in both directions: as `platform_admin` the pending request appears in
`/ar/admin/users` and `/en/admin/users`; as a passenger the same query returns `[]`.

The same screen had a second, quieter gap, and it was the one that made "grant a role" a screen that could only
grant roles to yourself: the directory it rendered was built from the caller's own session, so the only row was
the operator looking at it. `profiles_select_staff` and `user_roles_select_staff` had allowed the read since
`00004`; nothing made it. `/admin/users` now lists the 50 most recent accounts with their verification badge, the
contact each one has, a *Deletion requested* badge, and the roles each holds — a plain RLS read, one query for
profiles and one for roles (two statements rather than an embed, so neither depends on the other's policy), with
the cap stated when it bites and the *User ID* field left as the way to reach anyone past it. `0002` grew the two
assertions that make the read a policy rather than a hope: a passenger cannot read another user's roles, and
platform staff can.

---

### 1.10 The restore that is now a measurement

§6 has said for a phase that "the first real restore into a scratch project has not happened yet, so the RTO is a
target, not a measurement". The runbook had the procedure — `pg_dump`, `pg_restore`, four `psql` commands, "the
target is under an hour" — and a procedure nobody has run is a hypothesis with a checklist.

`scripts/restore-drill.mjs` (`npm run drill:restore`) executes it against whatever database it can reach:

- **back up** — `pg_backup_start()` opens a hot-backup window, the data directory is copied while the server keeps
  serving, `pg_backup_stop()` closes it. That is what a volume snapshot is, and it is the cheapest thing to
  rehearse;
- **restore** — a second embedded PostgreSQL is started *from the copy*, which is crash recovery over the copied
  WAL: the same path a snapshot restore takes;
- **verify** — 24 checks against the source, and any one of them fails the drill: the row counts of the sixteen
  tables whose loss is discovered too late (people, catalogue, books, notification stack, and the two derived
  search structures), the ledger's debit and credit totals, `cmd_run_integrity_check` returning `ok`, RLS on every
  table, every definer pinned to a `search_path`, no `cmd_*` executable by a browser role, Storage copied file for
  file, and a real `search_public_trips()` call whose total has to equal the source's to the row. A restore that
  is not ledger-consistent and does not answer the same search is a directory with files in it;
- **report** — the timings and the verdict, to `docs/perf/restore-drill.txt`, because a drill whose result lives
  in a scrollback is a drill nobody can point at during an incident.

At the launch volume on the dev database: **0.47 s end to end** — backup 0.29 s (81 MB database, a 272 MB data
directory once WAL is counted), restore 0.14 s, verify 0.04 s — 24 of 24 checks, 49,998 trips, ledger
10,000 + 10,000, search answering 49,998.

The drill also caught two things about itself, which is the argument for writing it as a script rather than
running the runbook by hand. Its first run failed on `audit.log` 37 → 38, because verifying the copy calls
`cmd_run_integrity_check`, which appends an audit row — the discrepancy was the *checker*, not the restore, and by
hand that argument costs ten minutes at 02:00. And its first version asked `ledger_entries` for `debit`/`credit`
columns it does not have (the ledger stores `direction` and `amount_yer`): the kind of assumption a paragraph on a
runbook page keeps quietly for years.

What it does not prove is written down in the script's header and in §6: it is dev scale (production adds the
download, the PITR replay and pointing the app at the result), it rehearses the file-copy restore rather than
`pg_dump`/`pg_restore`, and Storage is compared file for file rather than through the bucket API.

---

### 1.11 The plan's last boxes, opened one by one

`IMPLEMENTATION_PLAN.md` had fourteen unticked boxes when the merge to `main` happened. Eight of them were **stale**
— the phase had shipped and nobody had ticked the list: the Phase 4 migration, RLS, storage policies, the four web
screens, the two mobile screens and its pgTAP suite; all sixteen Phase 9 payment commands; and all six Phase 12
ops alerts. A plan that misreports its own state is worse than no plan, because the next person budgets for work
that exists. Those are now ticked with the file and suite that prove each one.

The others were real, and four of them are now closed:

**Routing** (`00042`, `npm run routes:fill`). The seam `00023` left — `trip_route_geometry`, the straight-line
fallback, and a comment saying no provider was called — is filled. Three decisions shaped it. A **corridor cache**
keyed on the two endpoints rounded to four decimals (~11 m), because a route is a function of two points and 200
departures on the Aden–Sana'a road are one provider call; a trip still keeps its own copy, so a republished
corridor cannot change a route under a passenger. The **fetch is outside the transaction**: Postgres cannot make an
HTTPS call and should not learn how, so `get_trips_needing_routes()` is the queue and `cmd_store_trip_route()` is
the one write, validated (`ALL` coordinates in range, at least two points, a non-negative distance) because a
network answer is the least trustworthy input in the system. And the **fallback stays the default**: no provider,
no network, a timeout or a malformed answer all mean nothing is stored and the straight line remains. The traps are
covered by 15 unit tests that need no network — the [lng, lat] → {lat, lng} swap that would put every route in the
Indian Ocean, and a plausibility band (0.5×–1.8× the great-circle distance) that rejects an answer about another
place. Verified end to end against a stub OSRM: two trips filled, four-point geometry stored, two audit rows, second
pass empty, and with no provider URL it degrades to `queued: 0`.

**The payment cron** (`00043`, `00044`). The Phase 9 list named three jobs; one command existed (`cmd_expire_stale_
payment_intents`) and nothing called it, and the other two had never been written. Now `payments-expiry` schedules
it, `payment-reminders` tells a payer their receipt is still being checked after 24 h (the sentence that stops a
second payment) and that an unpaid intent expires within 12 h, and `agent-settlements` tells an agent at 90 % of
their credit limit — or with no transaction for three days — that a settlement is due, with one message per agent
to the finance desk. Three jobs rather than one because they fail differently; all registered in
`NOTIFICATION_JOB_FN`, so an unscheduled job is a type error rather than a silent gap. Running the worker live
shows all **13 jobs** and the two new counts.

Two smaller things this found and fixed along the way. The dev backend had no service identity at all, so a script
calling a `service_role`-only function worked in production and 403'd on a laptop; it now accepts
`MAAK_SERVICE_ROLE_KEY` and executes as `service_role`. And `alter type ... add value` cannot be *used* in the same
transaction, which means the two new notification kinds had to land in their own migration (`00043`) before
`00044` could insert their catalogue rows — a bug that only appears on a fresh database, which is the worst kind,
and the reason the split exists rather than a comment saying it works.

**The launch paperwork** — `/ar|en/privacy` and `/ar|en/terms` generated from one typed source
(`apps/web/src/lib/legal.ts`) with a test for section parity, script and date; `apps/mobile/eas.json` with the two
store account ids as explicit placeholders; `docs/store-listing.md` with the listing copy in both languages and the
privacy answers review asks for; `docs/uat.md` with the session script, the pass conditions, the P1–P4 ladder and
the burn-down gate; `CHANGELOG.md` and `docs/handover.md`. The sessions, the store accounts and the tag remain
what they always were: things that need people.

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
| `npm run sql:check` | 44 migrations · 19 pgTAP suites · **986 assertions** · types in sync · **security posture green** |
| `npm test` | **668 tests**, 27 files |
| `npm run test:coverage` | 95.77 % statements · 87.09 % branches · 96.46 % functions · 96.72 % lines |
| `npm run check:guards` | 32 core files · 180 style files · 44 migrations · 135 commands |
| `npm run check:a11y` | 111 routes, both directions |
| worker against a fresh dev database | 10 jobs, `maintenance: {sent: 2}`, `ops-alerts: {counts: all zero}`, exit 0 |
| `npm run perf:smoke` at 50,000 trips | search 6.0 ms p95 cold / 2.8 ms cached · write 10.2 ms · dashboard 88.3 ms |
| `npm run drill:restore` at 49,998 trips | hot backup → second cluster → 24 checks against the source in 0.47 s |

---

## 6. What is still open

1. **No load test at production volume has been run.** The p95 targets (search < 300 ms, writes < 250 ms, finance
   dashboard < 500 ms) are verified *at 50,000 trips, one request at a time* — 6.0 ms, 10.2 ms, 88.3 ms — and
   the one linear cost that remains (a price/date/text filter's counts, 37 ms; dimension filters are 3–9 ms
   since `00040`) is documented in `docs/perf/README.md`. A k6 run on hardware with the stated load has not
   happened, because there is no such environment yet.
2. **Dependency debt in the mobile toolchain.** `npm audit --omit=dev` reports 19 advisories (18 moderate, 1 high,
   0 critical), all inside Expo/React Native build tooling (`metro`, `@expo/cli`, `image-size`, `@react-native/*`)
   — code that runs on a developer machine and in EAS, not in the web bundle or on a phone at runtime. `npm audit
   fix` was tried and reverted: it closed the high by pulling newer transitives and opened a **critical** in
   `@expo/cli`, which is worse. The fix is the RN 0.88 upgrade during the mobile release, not a blind `audit fix`.
3. ~~Backups are documented, not drilled.~~ **Closed at dev scale (§1.10).** `npm run drill:restore` backs up,
   restores and verifies end to end in **0.47 s** on 49,998 trips, 24 checks against the source. The half that is
   still open is the same drill against the *hosted* project, where the download, the PITR replay and pointing the
   app at the restored database are the parts that cost wall-clock time — `docs/runbook.md` §3 has that path.
4. ~~`cmd_run_integrity_check` writes its alert directly to `notifications`.~~ **Closed in `00037` (§1.6):** the
   alert now goes through `app.enqueue_notification`, deduped per day, with the delivery rows the worker drains.
5. **No pilot UAT.** Three operators, a full cycle each, unaided — that is a calendar item with real people.
6. **Store releases and the tag.** `v1.0.0`, the changelog and the handover session come after the UAT burn-down.
7. ~~Account deletion has a request and no executor.~~ **Closed in `00039`.** The decision the item asked for was
   made rather than deferred: the profile row survives and is anonymised, so a retained ledger line refers to an
   account id with no person behind it. What the command cannot do — delete the files in Storage, or ban a login
   in a project whose `auth.users` it cannot write — it *reports* instead of pretending, and the admin guide
   says to act on both.
8. ~~Quota warnings come from two places and disagree about Basic.~~ **Closed in `00041` (§1.7 finding 4).**
   `app.quota_state()` now returns `threshold` — 100 at the limit, 80 when the *next* unit would cross 80 %,
   null otherwise — computed once, for every plan, and `warning` is `threshold is not null`. The monthly job
   reads that field instead of `used * 100 / limit`, so the two paths cannot drift again. Two consequences
   worth naming: a Basic operator is now warned in-flow at 80 % (the behaviour change the old note was waiting
   on a decision for), and the notice arrives one unit earlier than the job used to send it, because the
   response's rule was the better of the two. The `QUOTA_SOFT_WARNING` code keeps its name — it is a value a
   client may switch on, and renaming it in the same migration as the behaviour would break the screen that
   reads it.
9. **Failure alerting for the worker itself.** The workflow fails loudly, which reaches GitHub's notification
   settings; there is no dedicated on-call rotation or pager, and for a launch with three pilots that is the
   right size.
