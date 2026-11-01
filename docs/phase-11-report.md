# Phase 11 — notifications: say it once, on the channel they chose, in their language

**Date:** 2026-11-01 · **Branch:** `arena/e6f329f0-maak`
**Scope:** `IMPLEMENTATION_PLAN.md` Phase 11. What shipped, what was decided differently, what broke when it
was actually run, and what is still open — §6 is the honest list.

Phase 6 shipped a `notifications` table and a bell that nobody rang: `app.notify()` inserted a row and stopped
there. This phase turns that row into a **delivery**: a catalogue of 31 events with a default channel set per
event, a per-person override matrix, quiet hours in Aden time, device tokens, four channels with a real retry
ladder, saved searches that alert once per new matching trip, and six scheduled jobs. The design rule is that
**a notification is a fact plus its deliveries** — the in-app record is written whether or not email was
enabled, and every suppression is a row with a reason, because a silence you cannot explain is a bug report you
cannot close.

---

## 1. What shipped

### Schema (`00032_notifications.sql`, 1 980 lines, 20 commands, 11 helpers)

| Object | Purpose |
| --- | --- |
| `notification_events` | The catalogue: one row per `notification_kind` (31 after this phase), with the default channel set, default title key and priority. Settings screens and `app.enqueue_notification` read the same row, so a new kind cannot be deliverable but unconfigurable. |
| `notification_settings` | Per-person quiet hours (enabled, start, end). Absent row = the documented default (22:00–06:00), not "no preferences". |
| `notification_preferences` | The override matrix `(user, kind, channel) → enabled`. A row exists only when somebody disagreed with the default, which is why the settings screen can label rows "customised". |
| `device_tokens` | Expo push tokens, with `revoked_at` rather than a delete — the audit trail of "why did push stop" is the row. |
| `notification_deliveries` | One row per (notification, channel): `pending → sending → sent | skipped | failed → dead`, with `attempts`, `next_attempt_at`, `provider_ref` and `last_error`. **The queue is a table**, so a stuck send is queryable and a retry is an `update`. |
| `notification_delivery_attempts` | Every outcome, append-only, `unique (delivery_id, attempt)` so a double-record is a duplicate key instead of a second email. |
| `saved_searches` | Filters as `jsonb` (the same keys the trips page uses), a label, `notify`, a fingerprint for de-duplication and `last_matched_at`. |
| `saved_search_matches` | `(search, trip)` unique — the row that makes "once per new matching trip" true rather than hoped for. |

New enums: `notification_channel` (`in_app`, `push`, `email`, `whatsapp`), `notification_priority`
(`critical`, `normal`, `low`), `notification_delivery_status`; five new `notification_kind` values
(`saved_search_match`, `trip_reminder`, `quota_threshold`, `subscription_expiring`, `verification_sla`).

### Helpers that carry the invariants

| Helper | Why it exists |
| --- | --- |
| `app.enqueue_notification(...) → uuid` | The single writer. Creates the notification **and** its delivery rows in one transaction: the in-app record is `sent` immediately, each other channel is `pending`, `skipped` (preference / no device / no phone) or held for the end of quiet hours. Idempotent on `(user_id, dedupe_key)`, so a retried job returns the existing row and creates no second delivery. |
| `app.notify(...)` | Kept with its Phase 6 signature, now a two-line wrapper — 51 existing call sites started getting deliveries without being touched. |
| `app.in_quiet_hours(user, at)` / `app.quiet_resume_at(user, at)` | The window, in `Asia/Aden`, with the wrap-around case (22:00–06:00) and a `timestamptz` parameter so a test can pin 23:00 instead of waiting for it. |
| `app.channel_enabled(user, kind, channel)` / `app.effective_channels(...)` | Preference beats catalogue default; `in_app` is not switchable. |
| `app.notification_backoff(attempts)` | 1 / 5 / 15 / 60 minutes, five attempts, then `dead`. |
| `app.rescue_stuck_deliveries()` | A worker that dies between "sending" and "recorded" leaves a row in `sending`; every claim sweeps rows older than ten minutes back into the retry ladder. |
| `app.saved_search_filters_valid()` | Key-and-type check in SQL, mirroring the zod schema, so a search saved through the gateway and one saved by hand agree. |
| `cmd_claim_notifications` / `cmd_record_notification_delivery` | The worker contract: claim a batch (`for update skip locked`), record one outcome per request. Two calls, not one transaction — the write guard refuses two commands in a request. |

### Commands — 16 actions on the `notifications` edge function

| Action | Function | Notes |
| --- | --- | --- |
| `notifications.list` / `read` | `cmd_list_notifications` / `cmd_mark_notifications_read` | The inbox: keys, params, link and the per-channel state of every row. `ids: null` means "everything unread". |
| `notifications.settings` / `preference.set` / `preference.reset` / `settings.update` | `cmd_get_notification_settings`, `cmd_set_…`, `cmd_reset_…`, `cmd_update_…` | The matrix read and its three writers. Quiet hours are parsed as `HH:MM` and stored as `time`. |
| `notifications.device.register` / `device.revoke` | `cmd_register_device_token` / `cmd_revoke_device_token` | Token + platform; revoking is a flag. |
| `notifications.health` | `cmd_get_notification_health` | Staff: counts per channel and status for seven days, plus the dead letters. |
| `notifications.dispatch` / `delivery.record` | `cmd_claim_notifications` / `cmd_record_notification_delivery` | Staff/service only, 720/h. |
| `notifications.job.run` | `cmd_match_saved_searches`, `cmd_send_trip_reminders`, `cmd_notify_quota_thresholds`, `cmd_notify_subscription_expiring`, `cmd_notify_pending_verifications`, `cmd_retry_notifications` | Six jobs, each returning a one-line summary. |
| `search.save` / `list` / `update` / `delete` | `cmd_save_search`, `cmd_list_saved_searches`, `cmd_update_saved_search`, `cmd_delete_saved_search` | Filters are validated, labelled, fingerprinted. |

### Clients

| Piece | Where |
| --- | --- |
| Contract, 16-action union, dispatch table, quiet-hours maths, `notificationText`, `describeSavedSearch`, `expoPushMessages`, `emailMessage`, `whatsappDeepLink` | `packages/core/src/api/notifications.ts` |
| Four capabilities (`notification.preferences`, `.savedSearch`, `.dispatch`, `.health`) | `packages/core/src/domain/policy.ts` |
| 133 `notifications.*` keys per locale (labels, inbox, matrix, statuses, channels, devices, push outcomes) | `packages/core/src/i18n/dictionaries.ts` |
| Edge function `dispatch` (capability map, rate limit, 404 for unknown actions) | `supabase/functions/dispatch/index.ts` |
| The worker: claim → transport → record → jobs, `--once`, `--dry-run`, `--check` | `scripts/notify-worker.mjs` |
| Server reads | `apps/web/src/lib/notifications.ts` |
| Inbox + preferences + saved-search control | `apps/web/src/components/account/{NotificationInbox,NotificationPreferences}.tsx`, `components/trips/SaveSearchControl.tsx` |
| Routes | `/account/notifications`, `/account/notifications/preferences` (linked from `AccountNav`), and the control on `/trips` |
| Native | `apps/mobile/src/app/notifications.tsx`, `notification-preferences.tsx`, `src/lib/push.ts` |
| Demo data: one device token + one enqueued notification with its deliveries | `scripts/dev-backend/db.mjs` |

---

## 2. Decisions that differ from the plan, and why

1. **The transport is a script, not a cron entry.** The plan says "cron". What shipped is
   `scripts/notify-worker.mjs` with `--once`, driven by any scheduler (Edge cron, GitHub Action, systemd timer).
   The loop is deliberately not a database job: sending is I/O with a third party, it must be retried and
   observed separately from the transaction that created the row, and Phase 12 owns the scheduler plus its
   alerting. `npm run notify` is the one-shot entry point.
2. **Saved-search alerts are per trip, not a digest.** The acceptance criterion is "alerts once per new matching
   trip, not per refresh", and a nightly digest would satisfy neither that sentence nor a person waiting for a
   Friday seat. A digest mode is a preference to add later, not a behaviour to guess now.
3. **WhatsApp is a deep link, not the Cloud API.** `whatsappDeepLink()` builds a `wa.me` URL with the rendered
   text. Sending through the Business API needs pre-approved templates per language and a verified sender; a
   half-configured template silently fails, so the channel is honest about being a hand-off.
4. **Quiet hours hold push only.** Email and WhatsApp are not interruptions. A price drop at 23:00 waits;
   a cancellation never waits, and `critical` events bypass the window entirely — that is the fourth acceptance
   criterion implemented in one branch of `app.enqueue_notification`.
5. **The catalogue is data, the sentence is not.** `notification_events` holds the channel defaults, priority
   and title key. The *body* lives only in the dictionary: a second copy in SQL would drift from the first, and
   an AR sentence edited in two places is how one locale ends up wrong.
6. **History is never deleted; preferences can be.** Deliveries and attempts are append-only and a device token is
   revoked with a flag, because "why did I not get that?" is answerable only if the row survives. A saved search
   *is* deleted for real when its owner asks — it is a standing instruction, not a record of anything — and the
   deletion is audited like any other write.
7. **`dispatch` is one action for the worker and the API.** Rather than a second edge function, the worker calls
   the same function with staff credentials; the capability map decides what a person may do, and
   `notifications.dispatch` is staff-only.

---

## 3. Bugs found by running it, not by reading it

1. **The inbox was prerendered.** `next build` printed `● /ar/account/notifications` — a static page with one
   person's rows baked into the HTML served to everyone. Both account pages now export
   `dynamic = 'force-dynamic'`, and the build shows `ƒ`.
2. **A missing key was a build failure, not a blank screen.** `notifications.inboxTitle` was referenced before it
   existed: `tsc` answered `TS2345 … 'notifications.inboxTitle' is not a valid TranslationKey`. That is the CI
   acceptance criterion working as designed; §4 records the deliberate removal that proves it.
3. **`label` was required after a transform.** `search.save` mapped `''` → `null` and then demanded `label`, so a
   client that omitted it failed to compile. Optional before the transform, `.optional()` after it.
4. **A client component imported an inline spec literal.** The mobile inbox built its own `{ path, mutating }`
   object instead of importing `notificationCommandSpec`; the gateway would have disagreed the day the path
   changed. It imports the spec now.
5. **Arabic digits changed the price.** `describeSavedSearch` formatted «≤ 5,000» as ٥٬٠٠٠ under `ar-YE`, while
   the app's standard is western numerals; a price that renders two ways across two screens is a support call.
   Formatting is pinned to `ar-YE-u-nu-latn` and a test asserts the digit `5`.
6. **`'errors.unknown'` does not exist.** First draft of the mobile error path translated a key that was never in
   the dictionary — `t()` would have printed the key itself. Everything goes through `errorKey(code)`.
7. **`notificationBody.*` would have tripped the dictionary guard.** Keying bodies per event looked tidy until the
   guard's regex read `notifications.body` as a key and failed the build; bodies stayed in the dictionary under
   the existing key names.
8. **A `do … while (true)` failed lint.** The worker loop is `for (;;)` — same loop, no constant-condition rule.
9. **The demo had no deliveries.** The seeded notification was a bare row, so the inbox showed four blank channels
   and the health view counted nothing. The seed now registers a device token and calls
   `app.enqueue_notification`, and the demo shows `in_app: sent · push: sent · email: skipped (preference)`.

---

## 4. Verification

| Gate | Result |
| --- | --- |
| `npm run sql:check` | 32 migrations applied · **16 pgTAP suites, 852 assertions** (78 new in `0016_notifications.test.sql`) · `database.types.ts` in sync · write lockdown intact |
| `npm test` | **568 tests**, 25 files (46 new in `packages/core/tests/notifications-api.test.ts`) |
| `npm run test:coverage` | thresholds met: 95.5% statements / 86.4% branches (`api/notifications.ts` 91.3% statements) |
| `npm run check:guards` | 30 core files · 170 style files · 32 migrations · **125 commands** · notification keys present · gateway and edge capability maps identical |
| `npm run check:responsive` | 53 media queries, no hidden navigation, no unguarded grid tracks, 7 tap targets, every wide table scrollable |
| `npm run check:a11y` | **105 routes** in both directions, including the four new account screens |
| `npm run lint` · `format:check` · `typecheck` | clean (web, core, mobile) |
| `npm run check:functions` | 11 bundled functions, including `dispatch` |
| `npm run db:types:check` | matches 32 migrations |
| `npm run dev:check` | dev stack healthy (sign-in, RLS-shaped reads, proxy, CSRF, single write path) |

**The missing-key criterion, executed.** Removing `notifications.inboxTitle` from the **English** dictionary only
and re-running the gates produced, in this order:

```
× has the same keys in both locales            packages/core/tests/i18n.test.ts
packages/core/src/i18n/dictionaries.ts(1789,14): error TS2741:
  Property '"notifications.inboxTitle"' is missing in type … but required in type 'Record<TranslationKey, string>'
```

Two independent failures — the parity test and the exhaustive `Record<TranslationKey, string>` type — so a key
cannot go missing while either gate runs. The key was restored immediately and both are green.

End-to-end against the running dev backend (fresh `dev:api:reset`, then the real worker):

1. `notifications.settings` returns 31 events with their default channel matrix, `quietStart 22:00`,
   `quietEnd 06:00`, `timezone Asia/Aden`, and `saved: false`.
2. `search.save` with `{priceMax: 5000}` returns `{id, created: true}`; `search.list` reports `matches: 0`;
   re-saving the same filters returns the same row, not a second one.
3. `notifications.list` shows the seeded notification with `channels: {in_app: sent, push: pending, email: pending}`
   — the in-app record exists before any transport has run, which is the point.
4. `notifications.dispatch` as staff claims the batch (push and email for the admin), and
   `notify-worker.mjs --once` records `skipped` for each missing provider with its reason instead of failing the
   run: `{drained: {claimed: 0 …}, jobs: {saved-searches: {searches: 1}, quota: {sent: 1, period: "2026-11"}, …}}`.
5. `notifications.health` as staff reports the split by channel and status plus an empty dead-letter list.
6. `notifications.preference.set` (`booking_accepted` × `email` × `false`) returns `{enabled: false}`; the next
   enqueue of that kind writes `email: skipped (preference)` and leaves push pending — the third criterion.
7. `notifications.dispatch` as the owner returns `403 FORBIDDEN`: a person cannot drain the platform's queue.
8. `/ar/account/notifications` (40 728 bytes) renders «سجل التنبيهات» and the preferences link;
   `/ar/account/notifications/preferences` (57 695 bytes) renders «ساعات الهدوء» and «ما يصلك وأين»;
   `/en/account/notifications` renders "Notification history".
9. `/ar/trips` has **no** save-search control (there is no predicate to save) and `/ar/trips?priceMax=5000` has
   exactly one — a control that offers to save `{}` would be a button that alerts on everything.

---

## 5. What the pgTAP suite actually promises (78 assertions)

Written in the order a message travels: enqueue → dedupe → channel decisions → quiet hours → claim → record →
retry → saved searches → jobs → RLS.

- accepting a booking writes **one** notification and **one** push delivery; calling the guard again writes
  nothing, `dedupe_key` is `trip:<booking>:<hours>`, and the delivery count does not move;
- the in-app delivery is `sent` at enqueue time, before any worker has run;
- disabling email for `booking_accepted` produces `email: skipped` with reason `preference` while push stays
  `pending`;
- 23:00 in Aden is inside the default window and 12:00 is not; a non-critical push enqueued at 23:00 has
  `next_attempt_at = 06:00` the next morning; a `critical` one is due immediately even at 23:00;
- `cmd_claim_notifications` marks rows `sending`, increments `attempts`, and a second claim in the same second
  gets nothing (`for update skip locked`);
- `cmd_record_notification_delivery` refuses a row that is not `sending` (`CONFLICT`), records `sent` once, and a
  duplicate record of the same attempt is a unique violation rather than a second attempt row;
- a failure at attempt 1 schedules 1 minute, attempt 2 five minutes, and attempt 5 is `dead`;
- `rescue_stuck_deliveries` returns a row stuck in `sending` for 20 minutes to `failed` with a backoff;
- a saved search matches a newly published trip **once**: the first run writes one match and one notification,
  the second run (same data) writes neither — "once per new matching trip, not per refresh";
- a trip published before the search existed does not alert (the window is `last_matched_at`, seeded from
  `created_at`);
- the reminder job alerts an accepted booking 24 h before departure once, and the second run is silent;
- the quota job fires at 80% and at 100% with `quota:<owner>:<metric>:<threshold>:<YYYY-MM>` dedupe keys, and the
  same month's second run writes nothing;
- the subscription job fires at 7/3/1 days with `subscription:<id>:<YYYYMMDD>:<days>`, and inside the same day it
  fires once;
- the verification-SLA job alerts staff about a request older than 48 hours, once per day per subject;
- RLS: a person reads only their own notifications, deliveries, saved searches and device tokens; another
  person's `notification_settings` is invisible; the `cmd_*` functions are `service_role`-only.

---

## 6. What is still open

1. **No scheduler.** `scripts/notify-worker.mjs` must be driven (cron, Edge schedule, or a container). Phase 12
   owns the schedule **and** the alert when it stops running — a job nobody watches is a silent failure mode.
2. **Email and push credentials are not provisioned.** `RESEND_API_KEY`, `EXPO_ACCESS_TOKEN` and `MAAK_MAIL_FROM`
   are read from the environment; with none set the worker records `skipped` with a reason, which is visible in
   the health view. No domain, DKIM or sender verification exists yet.
3. **WhatsApp is a deep link.** Business API templates, a verified sender and per-language approval are Phase 12
   (or a product decision to skip the channel).
4. **No admin template preview screen.** The plan asked for one. What exists is the notification centre, which
   renders every row with the text it actually carried, and the AR/EN parity test, which fails on a missing key.
   A preview screen would show the *same* strings through the *same* function; the honest gap is a preview of
   *unsent* rows, which needs a fake enqueue and is not built.
5. **Saved searches cannot be edited beyond notify/label.** Filters are immutable — re-saving is the edit path,
   and the fingerprint de-duplicates. Changing a filter is a new search, which is deliberate: an "edited"
   search whose `last_matched_at` is old would re-alert on trips the person already ignored.
6. **The bell in the site header does not show an unread count.** The inbox has one, the mobile tab has one; the
   header is a server component shared by 40 routes and adding a query to it is a Phase 12 performance item.
7. **Pagination is a page, not a scroll.** `notifications.list` returns 50 rows and `nextCursor`; the web inbox
   renders the first page only.
8. **Nothing is deleted.** Delivery rows and attempts grow without a retention policy; a monthly archive table is
   Phase 12 work (and needs a decision on how long a support case must be answerable).
9. **Four of the plan's reminder jobs collapsed into one.** "Trip in 2 h", "departure" and "tomorrow" are the same
   job with a different lead time — `cmd_send_trip_reminders(hours)` takes it as a parameter. The **no-show
   window** is not shipped: defining no-show needs the attendance scan from Phase 9 to mark a booking, and a
   reminder about a passenger who was never marked absent would be a false alarm. Maintenance reminders already
   exist in Phase 8's vehicle job and were not duplicated here.
10. **No ICU plurals.** Strings are phrased so they do not inflect — «{count} غير مقروء», and seats are spelled
    out in the event text. A sentence that must agree with 1 / 2 / 3–10 in Arabic needs a `plural()` helper in
    `@maak/core`, and `<bdi>` isolation for mixed AR/Latin runs (trip codes inside Arabic sentences) is not
    applied yet either; both are i18n work that belongs with the Phase 12 content pass.
