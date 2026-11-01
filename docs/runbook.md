# Runbook — what to do when something is wrong

**Audience:** whoever is on call. Mostly this is one person, so it is written to be read at 02:00 by somebody who
did not build the thing.

The platform tells you about its own problems before it tells you about anyone else's: `cmd_run_ops_alerts()`
runs as part of the notification worker and enqueues one `ops_alert` per failing check per day per recipient.
Every alert below arrives as a push (and an email) on the phone of the staff or finance role that owns it, with
a link to the screen that answers the question. This document says what each one means and what to do.

---

## 0. The five-minute triage

When *anything* is off, this sequence answers most of it:

```bash
npm run notify:check            # is the worker configured? (token, providers, job list)
npm run notify                  # one pass: drain the queue, run every job, print the counts
npm run sql:check               # migrations apply, pgTAP suites pass, security posture holds
```

`npm run notify` prints one JSON line. Worth reading:

```json
{ "drained": {"claimed":4,"sent":0,"skipped":4,"failed":0},
  "jobs": {"saved-searches":{"searches":1,"matches":0}, "ops-alerts":{"counts":{…},"sent":0}, …} }
```

- `drained.claimed` stuck at the batch size (20 by default) means the queue is growing faster than it drains, or
  the worker is looping on the same rows.
- `drained.failed > 0` is a provider problem, not a database one. The row keeps its `last_error`.
- A job showing `{"error": "..."}` is a job that threw; the others still ran, because each is its own request.
- `ops-alerts.counts` is the state of the platform, whether or not anything was sent.

---

## 1. The six platform alerts

Each one is a `notification_kind = 'ops_alert'` row with a dedupe key `ops-alert:<check>:<YYYY-MM-DD>`, so it
speaks once a day while the condition holds. Clearing the condition is what stops it; there is no "dismiss".

### `stale_trips` — a trip still `in_progress` 18 hours after departure

**Means:** a driver started a trip and never finished it. The manifest, the seat counts and the operator's
statement all still treat that trip as running.

**Look:** `/staff/trips`, filter by status.

**Do:** call the operator. If the trip finished, `cmd_end_trip` with the real arrival; if it was cancelled on the road,
`cmd_cancel_trip` with a reason. Both are audited, and the statement picks up the corrected state.

**Do not:** `update public.trips set status = 'completed'` by hand. The state is the history — `completed_at`,
`last_stop_seq` and the audit row are what a dispute is settled with.

### `dead_deliveries` — notifications that exhausted every attempt in the last 7 days

**Means:** five attempts, then `dead`. Usually a provider outage, an expired Expo token, or a Resend key that was
rotated without updating the secret.

**Look:** `notifications.health` as staff (the inbox's dead-letter list), or:

```sql
select channel, last_error, count(*)
  from public.notification_deliveries
 where status = 'dead' and created_at > now() - interval '7 days'
 group by 1, 2 order by 3 desc;
```

**Do:** fix the cause, then re-arm the rows — the `retry` job does it automatically once a day
(`attempts` resets to 0, so the backoff starts over):

```sql
select public.cmd_retry_notifications('<staff-uuid>', '7 days');
```

If the error says `no device`, the person simply has no registered phone; that is a skip, not a failure.

### `unbalanced_journals` — the ledger does not balance

**Means:** the one condition that must never be true. The deferred trigger makes it nearly impossible; "nearly"
is why it is checked.

**Look:** `/finance/dashboard`, then `/finance/ledger` for the journal id.

**Do:** **stop confirming payments and payouts** until finance has looked. A correction is a *reversing* journal
with a reason — never an `update`, never a `delete` (the table refuses both, by design).

**Escalate:** this is a code bug. Keep the journal, the request id from `audit.log`, and the time.

### `verification_backlog` — pending requests older than 48 hours

**Means:** people cannot publish or get paid because nobody has looked at their papers.

**Look:** `/staff/verifications`, oldest first.

**Do:** work the queue. If the queue is long because a document type was added, that is a staffing decision, not
a bug — the alert is the argument for it.

### `payment_sla` — a receipt uploaded and undecided for six hours

**Means:** a passenger has paid and the money is sitting on a screenshot nobody has confirmed.

**Look:** `/finance/payments`.

**Do:** confirm or reject. Rejecting requires a reason, and the passenger is told it. If the receipt is
unreadable, reject with "receipt unclear" rather than leaving it open — an open intent blocks the seat.

### `error_rate` — 20+ denied or failed commands in the last hour

**Means:** something is being refused that should not be. `audit.log` writes a row for every denial, so the
answer is a query:

```sql
select action, outcome, count(*)
  from audit.log
 where created_at > now() - interval '1 hour' and outcome in ('denied', 'failed')
 group by 1, 2 order by 3 desc;
```

**Do:** if it is one action, it is a client bug or a policy regression — read the `detail` column. If it is one
actor, it is abuse; `app.consume_rate_limit` already throttles, and the actor id is in the row.

---

## 2. The scheduler

The worker is `scripts/notify-worker.mjs`. It is driven by `docs/ci/notify.yml` (a GitHub Actions schedule, to be
activated with `npm run ci:install`) or by any timer that can run `npm run notify`:

```cron
*/5 * * * *  cd /srv/maak && MAAK_WORKER_TOKEN=… npm run notify >> /var/log/maak-notify.log 2>&1
```

Use `node scripts/notify-worker.mjs --once --fail-on-error` in a scheduler: the flag makes a run with a failed
delivery or a throwing job exit non-zero, which is how the scheduler's own failure notification works.

**If the scheduler stops:** every job stops with it. Nothing is lost — the reminder bands, the saved-search
window and the digest are all defined against the last run, not against "every 5 minutes" — but nothing is sent
either. The `outbox_drained` check inside `cmd_run_integrity_check` catches a payment outbox that is not being
consumed, and `ops-alerts` catches a queue that is not being drained. The gap is the window between the cron
dying and the next manual `npm run notify`; that window is why the workflow's failure notification must go to a
human who knows what this file is.

**Cadence:** five minutes for the reminder bands and the matcher. The daily jobs (maintenance, digest, ops
alerts) dedupe themselves to once a day, so a faster cron does not mean more messages.

**The marketplace counts are not a job.** The filter chips on `/trips` read `public.search_counts`, which any
search request refreshes when it is more than thirty seconds old (`app.ensure_search_counts()`, one refresher at
a time). No scheduler is involved, so nothing to restart — but after a bulk import, a restore, or a `search_counts`
change by hand, force it rather than waiting for traffic:

```sql
select app.refresh_search_counts();   -- rewrites the chips; the result total is always exact and unaffected
```

---

## 3. Backups and the restore drill

**What to back up:** the database (nightly `pg_dump`, plus PITR/WAL if the plan has it) and the storage bucket
(verification documents, payment proofs, vehicle photos). Those two are the entire state; everything else —
edge functions, web, migrations — is in git.

**A restore is only real once it has been executed**, so it is a script rather than a page to read at 02:00:

```bash
npm run dev:api                  # the drill rehearses against a running database
npm run drill:restore            # back up, restore, verify, report
npm run drill:restore -- --keep  # leave the restored cluster on :54323 to inspect it
```

It takes a hot backup (`pg_backup_start` → copy the data directory → `pg_backup_stop`), starts a second
PostgreSQL from that copy — crash recovery over the copied WAL, which is the snapshot-restore path — and then
refuses to call it a restore unless the checks agree with the source: row counts for the sixteen tables that
matter, the ledger's two sides, `cmd_run_integrity_check`, the RLS / definer / command-grant posture, and a real
`search_public_trips()` answer. Timings and the verdict go to `docs/perf/restore-drill.txt`, because a drill
whose result lives in a scrollback is a drill nobody can point at during an incident.

Last run: **0.47 s end to end** on 81 MB / 49,998 trips (backup 0.29, restore 0.14, verify 0.04), 24 checks
green. That is *dev scale* and it is a floor, not the RTO: production adds the download, replay to a point in
time, and pointing the app at the restored project.

**On the hosted project**, where the tooling is not the embedded one:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=maak-$(date +%F).dump
createdb maak_restore_drill
pg_restore --dbname=maak_restore_drill --no-owner --role=postgres maak-$(date +%F).dump
# then the same verification block the script runs, against maak_restore_drill
```

**Integrity checks after a restore:** `cmd_run_integrity_check` must return `status: ok`. If it returns
`alert`, do not point the app at the restored database — a restore that is not ledger-consistent is a restore
that will pay somebody twice.

---

## 4. Common failures, by symptom

| Symptom | Likely cause | First command |
| --- | --- | --- |
| Nobody received anything for an hour | scheduler stopped, or `MAAK_WORKER_TOKEN` expired | `npm run notify:check` then `npm run notify` |
| Push arrives, email does not | `RESEND_API_KEY` missing/rotated; DNS/DKIM | `select * from notification_deliveries where channel='email' and status <> 'sent' limit 20` |
| Everyone gets everything | a preference reset, or `notification_events.default_channels` changed | `select kind, default_channels from notification_events order by kind` |
| A saved search alerts on every trip | the filters were saved empty (`{}` matches everything) | `select id, filters from saved_searches where filters = '{}'::jsonb` |
| An alert repeats every day | by design: the condition still holds | clear the condition, not the notification |
| Sign-in "does nothing" in the preview | `apps/web/.env.local` missing → fixture mode | `npm run dev:setup` |

---

## 5. Who to call

| Area | Owns | Escalate when |
| --- | --- | --- |
| Money (journal, payouts, refunds) | finance officer | an `unbalanced_journals` alert fires |
| Verification and accounts | platform staff | the backlog is over 48 h for more than a week |
| Trips and operators | platform staff | a trip has been `in_progress` for a day |
| Database and deploy | engineering | any of `npm run sql:check`, `npm run check:all` fails on `main` |

Every command in this document is audited. If you do something not written here, write it here afterwards — the
next person is the same person, at 02:00, with less context.
