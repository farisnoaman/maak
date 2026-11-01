# Phase 11 — notifications: say it once, on the channel they chose, in their language

**Date:** 2026-11-01 · **Branch:** `arena/e6f329f0-maak`
**Scope:** `IMPLEMENTATION_PLAN.md` Phase 11. What shipped, what was decided differently, what broke when it
was actually run, and what is still open — §6 is the honest list.

Phase 6 shipped a `notifications` table and a bell that nobody rang: `app.notify()` inserted a row and stopped
there. This phase turns that row into a **delivery**: a catalogue of 34 events with a default channel set per
event, a per-person override matrix, quiet hours in Aden time, device tokens, four channels with a real retry
ladder, saved searches that alert once per new matching trip (or once a day in digest mode), and eight scheduled
jobs. The design rule is that **a notification is a fact plus its deliveries** — the in-app record is written
whether or not email was enabled, and every suppression is a row with a reason, because a silence you cannot
explain is a bug report you cannot close.

---

## 1. What shipped

### Schema (`00032_notifications.sql`, 2 354 lines, 23 commands, 16 helpers)

| Object | Purpose |
| --- | --- |
| `notification_events` | The catalogue: one row per `notification_kind` (34 after this phase), with the default channel set, default title key and priority. Settings screens and `app.enqueue_notification` read the same row, so a new kind cannot be deliverable but unconfigurable. |
| `notification_settings` | Per-person quiet hours (enabled, start, end) and the zone they are expressed in. Absent row = the documented default (22:00–06:00), not "no preferences". |
| `notification_preferences` | The override matrix `(user, kind, channel) → enabled`. A row exists only when somebody disagreed with the default, which is why the settings screen can label rows "customised". |
| `device_tokens` | Expo push tokens, with `revoked_at` rather than a delete — the audit trail of "why did push stop" is the row. |
| `notification_deliveries` | One row per (notification, channel): `pending → sending → sent \| skipped \| failed → dead`, with `attempts`, `next_attempt_at`, `claimed_at`, `provider_ref` and `last_error`. **The queue is a table**, so a stuck send is queryable and a retry is an `update`. |
| `notification_delivery_attempts` | Every outcome, append-only, `unique (delivery_id, attempt)` so a double-record is a duplicate key instead of a second email. |
| `saved_searches` | Filters as `jsonb` (the same keys the trips page uses), a label, `notify`, `digest`, a fingerprint for de-duplication and `last_matched_at`. |
| `saved_search_matches` | `(search, trip)` unique plus `digested_at` — the row that makes "once per new matching trip" true rather than hoped for, and that a daily digest marks as summarised. |

New enums: `notification_channel` (`in_app`, `push`, `email`, `whatsapp`), `notification_priority`
(`critical`, `normal`, `low`), `notification_delivery_status`; eight new `notification_kind` values
(`saved_search_match`, `trip_reminder`, `quota_threshold`, `subscription_expiring`, `verification_sla`,
`subscription_plan_changed`, `agent_cash_in_settled`, `no_show_alert`).

### Helpers that carry the invariants

| Helper | Why it exists |
| --- | --- |
| `app.enqueue_notification(...) → uuid` | The single writer. Creates the notification **and** its delivery rows in one transaction: the in-app record is `sent` immediately, each other channel is `pending`, `skipped` (preference / no device / no phone) or held for the end of quiet hours. Idempotent on `(user_id, dedupe_key)`, so a retried job returns the existing row and creates no second delivery. Returns the id either way, so a call site can count a *new* notification without a second query. |
| `app.notify(...)` | Kept with its Phase 6 signature, now a two-line wrapper — 51 existing call sites started getting deliveries without being touched. |
| `app.in_quiet_hours(user, at)` / `app.quiet_resume_at(user, at)` | The window, in `Asia/Aden`, with the wrap-around case (22:00–06:00) and a `timestamptz` parameter so a test can pin 23:00 instead of waiting for it. |
| `app.channel_enabled(user, kind, channel)` | Preference beats catalogue default; `in_app` is not switchable. |
| `app.notification_backoff(attempts)` | 1 / 5 / 15 / 60 minutes, five attempts, then `dead`. |
| `app.rescue_stuck_deliveries()` | A worker that dies between "sending" and "recorded" leaves a row in `sending`; every claim sweeps rows older than ten minutes back into the retry ladder. |
| `app.saved_search_filters_valid()` / `app.saved_search_query()` | Key-and-type check in SQL, mirroring the zod schema, so a search saved through the gateway and one saved by hand agree; the query builder is what the match job and the digest both use. |
| `app.billing_recipients(owner_user, owner_org)` | One definition of "who gets told about this subscription" — the owner, plus the organisation's owners, de-duplicated. |
| `app.notify_plan_change()` / `app.notify_agent_settlement()` | Triggers on `subscription_events` and `agent_transactions`, so an upgrade and a settled cash-in are announced by the *event*, not by whichever code path remembered to call `notify`. |
| `cmd_claim_notifications` / `cmd_record_notification_delivery` | The worker contract: claim a batch (`for update skip locked`), record one outcome per request. Two calls, not one transaction — the write guard refuses two commands in a request. |

### Commands — 17 actions on the `dispatch` edge function

| Action | Function | Notes |
| --- | --- | --- |
| `notifications.list` / `read` | `cmd_list_notifications` / `cmd_mark_notifications_read` | The inbox: keys, params, link and the per-channel state of every row. `ids: null` means "everything unread". |
| `notifications.settings` / `preference.set` / `preference.reset` / `settings.update` | `cmd_get_notification_settings`, `cmd_set_…`, `cmd_reset_…`, `cmd_update_…` | The matrix read and its three writers. Quiet hours are parsed as `HH:MM` and stored as `time`. |
| `notifications.device.register` / `device.revoke` | `cmd_register_device_token` / `cmd_revoke_device_token` | Token + platform; revoking is a flag. |
| `notifications.health` | `cmd_get_notification_health` | Finance and platform staff: counts per channel and status for seven days, plus the dead letters. |
| `notifications.dispatch` / `delivery.record` | `cmd_claim_notifications` / `cmd_record_notification_delivery` | Staff/service only, 720/h. |
| `notifications.job.run` | `cmd_match_saved_searches`, `cmd_digest_saved_searches`, `cmd_send_trip_reminders`, `cmd_notify_no_shows`, `cmd_notify_quota_thresholds`, `cmd_notify_subscription_expiring`, `cmd_notify_pending_verifications`, `cmd_retry_notifications` | Eight jobs, each returning a one-line summary. `trip-reminders` takes the three bands (tomorrow / two hours / departure). |
| `search.save` / `list` / `update` / `delete` | `cmd_save_search`, `cmd_list_saved_searches`, `cmd_update_saved_search`, `cmd_delete_saved_search` | Filters are validated, labelled, fingerprinted; `update` carries the digest switch. |
| `notifications.catalogue` | `cmd_get_notification_catalogue` | Staff: every event with its channels, priority and the AR/EN sentence rendered from the same function the sender uses. Behind the admin preview screen. |

### Clients

| Piece | Where |
| --- | --- |
| Contract, 17-action union, dispatch table, quiet-hours maths, `notificationText`, `translateCount` / `pluralCategory`, `splitBidi`, `describeSavedSearch`, `expoPushMessages`, `emailMessage`, `whatsappDeepLink` | `packages/core/src/api/notifications.ts` |
| Five capabilities (`notification.preferences`, `.savedSearch`, `.dispatch`, `.health`, `.catalogue`) | `packages/core/src/domain/policy.ts` |
| 160 `notifications.*` keys per locale (labels, inbox, matrix, statuses, channels, devices, plurals, push outcomes) + 7 `catalogue.*` | `packages/core/src/i18n/dictionaries.ts` |
| Edge function `dispatch` (capability map, rate limit, 404 for unknown actions) | `supabase/functions/dispatch/index.ts` |
| The worker: claim → transport → record → eight jobs, `--once`, `--dry-run`, `--check` | `scripts/notify-worker.mjs` |
| Server reads | `apps/web/src/lib/notifications.ts` |
| Inbox + preferences + saved-search control | `apps/web/src/components/account/{NotificationInbox,NotificationPreferences}.tsx`, `components/trips/SaveSearchControl.tsx` |
| Routes | `/account/notifications`, `/account/notifications/preferences` (linked from `AccountNav`), `/admin/notifications` (staff preview), and the control on `/trips` |
| Loading / error / skeleton | `loading.tsx` on all three routes, `error.tsx` on the inbox, `components/ui/Skeleton.tsx` + `@keyframes skeleton-shimmer` with a reduced-motion guard |
| Native | `apps/mobile/src/app/notifications.tsx`, `notification-preferences.tsx`, `src/lib/push.ts` |
| Demo data: one device token + one enqueued notification with its deliveries | `scripts/dev-backend/db.mjs` |

---

## 2. Decisions that differ from the plan, and why

1. **The transport is a script, not a cron entry.** The plan says "cron". What shipped is
   `scripts/notify-worker.mjs` with `--once`, driven by any scheduler (Edge cron, GitHub Action, systemd timer).
   The loop is deliberately not a database job: sending is I/O with a third party, it must be retried and
   observed separately from the transaction that created the row, and Phase 12 owns the scheduler plus its
   alerting. `npm run notify` is the one-shot entry point.
2. **Saved-search alerts are per trip by default, with an optional digest.** The acceptance criterion is
   "alerts once per new matching trip, not per refresh", and a nightly digest would satisfy neither that
   sentence nor a person waiting for a Friday seat. So `saved_searches.digest` defaults to `false`, the per-trip
   job runs for everyone else, and the daily job sends one summary per search to the people who asked for it —
   both paths share `saved_search_matches`, so turning the digest on cannot double-alert on a trip that was
   already announced.
3. **WhatsApp is a deep link, not the Cloud API.** `whatsappDeepLink()` builds a `wa.me` URL with the rendered
   text. Sending through the Business API needs pre-approved templates per language and a verified sender; a
   half-configured template silently fails, so the channel is honest about being a hand-off.
4. **Quiet hours run 22:00–06:00, and hold push only.** `specs.md` §6.10 says 22:00 and the acceptance criterion
   says "suppressed at 23:00" — 23:00 is inside 22:00–06:00, so one window satisfies both, and the window is a
   per-user row rather than a constant so the answer can change without a migration. Email and WhatsApp are not
   interruptions and are not held; a cancellation never waits, because `critical` events bypass the window
   entirely — that is the fourth acceptance criterion implemented in one branch of `app.enqueue_notification`.
5. **The catalogue is data, the sentence is not.** `notification_events` holds the channel defaults, priority
   and title key. The *body* lives only in the dictionary: a second copy in SQL would drift from the first, and
   an AR sentence edited in two places is how one locale ends up wrong. The admin preview therefore renders the
   text through `notificationText()` — the same function the worker uses — instead of storing a copy.
6. **History is never deleted; preferences can be.** Deliveries and attempts are append-only and a device token is
   revoked with a flag, because "why did I not get that?" is answerable only if the row survives. A saved search
   *is* deleted for real when its owner asks — it is a standing instruction, not a record of anything — and the
   deletion is audited like any other write.
7. **`dispatch` is one action for the worker and the API.** Rather than a second edge function, the worker calls
   the same function with staff credentials; the capability map decides what a person may do, and
   `notifications.dispatch` is staff-only.
8. **A no-show is a fact the system already had.** Phase 9 marks attendance at the door; this phase reads it.
   `cmd_notify_no_shows(trip, grace)` alerts the operator about an accepted booking still `accepted` after the
   trip's departure time plus a grace window, deduped per trip per booking per day — no attendance scan, no
   alarm, which is why the job is silent rather than wrong on a trip nobody scanned.

---

## 3. Bugs found by running it, not by reading it

1. **The inbox was prerendered.** `next build` printed `● /ar/account/notifications` — a static page with one
   person's rows baked into the HTML served to everyone. All three account/admin pages now export
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
10. **`loading.tsx` is not a page.** The first version of the three skeletons took `params: Promise<{locale}>` and
    awaited it — a loading segment gets no `params`, so every route with a skeleton threw
    `TypeError: Cannot destructure property 'locale'`, rendered an empty body, and failed the a11y gate with
    "0 `<h1>` elements". The skeletons are client components that read the locale from the path
    (`lib/use-path-locale.ts`), and they deliberately render no `<h1>`: the page owns the one heading, and a
    fallback that also claims it gives the route two.
11. **`getApiClient()` cannot be called from a server component.** It lives in a `'use client'` module, so the
    admin catalogue page compiled, type-checked, and then threw at render time. Server reads go through
    `callGateway()`; the browser client is for event handlers.
12. **Six CSS custom properties did not exist.** The new catalogue table, the digest badges and the skeleton used
    `--ink-050`, `--ink-100`, `--surface-1`, `--radius-full`, `--state-danger-ink` and `--state-success-ink`.
    None is in `packages/design-tokens/tokens.css`, and an undefined `var()` is silently dropped: the page looked
    like a browser default rather than an error. Everything now resolves against the token file, and a scan of
    `globals.css` against `tokens.css` reports no unknown property.
13. **A job's "sent" counter counted dedupe hits.** The reminder job incremented per *row visited*, so a second run
    in the same band reported `sent: 1` while writing nothing — a reconciliation number that lies. `app.notify()`
    now returns the id it found or created, the jobs count only rows they created, and the pgTAP suite asserts the
    second run reports zero.

---

## 4. Verification

| Gate | Result |
| --- | --- |
| `npm run sql:check` | 32 migrations applied · **16 pgTAP suites, 868 assertions** (94 new in `0016_notifications.test.sql`) · `database.types.ts` in sync · write lockdown intact |
| `npm test` | **623 tests**, 25 files (101 new in `packages/core/tests/notifications-api.test.ts`) |
| `npm run test:coverage` | thresholds met: 95.6% statements / 86.6% branches / 96.4% functions / 96.6% lines |
| `npm run check:guards` | 30 core files · **176** style files · 32 migrations · **128 commands** · notification keys present · gateway and edge capability maps identical |
| `npm run check:responsive` | 55 media queries, no hidden navigation, no unguarded grid tracks, 7 tap targets, every wide table scrollable, stacked card tables labelled |
| `npm run check:a11y` | **107 routes** in both directions, including the four account screens and `/admin/notifications` |
| `npm run lint` · `format:check` · `typecheck` | clean (web, core, mobile) |
| `npm run check:functions` | 11 bundled functions, including `dispatch` |
| `npm run db:types:check` | matches 32 migrations |
| `npm run dev:check` | dev stack healthy (sign-in, RLS-shaped reads, proxy, CSRF, single write path) |

**The missing-key criterion, executed.** Removing `notifications.inboxTitle` from the **English** dictionary only
and re-running the gates produced, in this order:

```
× has the same keys in both locales            packages/core/tests/i18n.test.ts
packages/core/src/i18n/dictionaries.ts(1789,14): error TS2741:
  Property '\"notifications.inboxTitle\"' is missing in type … but required in type 'Record<TranslationKey, string>'
```

Two independent failures — the parity test and the exhaustive `Record<TranslationKey, string>` type — so a key
cannot go missing while either gate runs. The key was restored immediately and both are green.

End-to-end against the running dev backend (fresh `dev:api:reset`, then the real worker):

1. `notifications.settings` returns 34 events with their default channel matrix, `quietStart 22:00`,
   `quietEnd 06:00`, `timezone Asia/Aden`, and `saved: false`.
2. `search.save` with `{priceMax: 5000}` returns `{id, created: true}`; `search.list` reports `matches: 0`;
   re-saving the same filters returns the same row, not a second one.
3. `notifications.list` shows the seeded notification with `channels: {in_app: sent, push: pending, email: pending}`
   — the in-app record exists before any transport has run, which is the point.
4. `npm run notify` drains the queue and runs all eight jobs in one pass:
   `{claimed: 4, sent: 0, skipped: 4}` (no Expo or Resend key, so each transport records `skipped` with its
   reason rather than failing the run) and
   `{saved-searches: …, search-digest: …, trip-reminders: {bands: [tomorrow, soon, departure]}, no-shows: …,
   quota: {sent: 1, period: "2026-11"}, expiring: …, verification-sla: …, retry: …}`.
5. `notifications.health` as `admin@maak.test` reports the split by channel and status plus an empty dead-letter
   list; as `owner@maak.test` it is `403 FORBIDDEN` — a person cannot drain or audit the platform's queue.
6. `notifications.preference.set` (`booking_accepted` × `email` × `false`) returns `{enabled: false}`; the next
   enqueue of that kind writes `email: skipped (preference)` and leaves push pending — the third criterion.
7. `notifications.catalogue` as `staff@maak.test` returns all 34 events; the admin page renders them as a
   bilingual table (94 074 bytes of HTML), each row showing priority, channels, the Arabic sentence and the
   English one in `dir`-annotated cells.
8. `/ar/account/notifications` renders «سجل التنبيهات» and the preferences link at 42 153 bytes;
   `/ar/account/notifications/preferences` renders «ساعات الهدوء» and «ما يصلك وأين» at 62 588 bytes;
   `/en/account/notifications` renders "Notification centre".
9. `/ar/trips` has **no** save-search control (there is no predicate to save) and `/ar/trips?priceMax=5000` has
   exactly one — a control that offers to save `{}` would be a button that alerts on everything.

---

## 5. What the pgTAP suite actually promises (94 assertions)

Written in the order a message travels: enqueue → dedupe → channel decisions → quiet hours → claim → record →
retry → saved searches → digest → jobs → catalogue → RLS.

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
- a search with `digest = true` gets no per-trip message and exactly one summary for the day, whose dedupe key is
  `search-digest:<search>:<date>`; running the digest job twice sends one message;
- the alert's deep link carries the search's filters, so opening it re-runs the search rather than a generic list;
- the reminder job alerts an accepted booking 24 h before departure once, and the second run is silent; a trip in
  two hours and a departing trip are the other two bands of the same job;
- the no-show job alerts an operator about an accepted booking after departure plus grace, once per day;
- the quota job fires at 80% and at 100% with `quota:<owner>:<metric>:<threshold>:<YYYY-MM>` dedupe keys, and the
  same month's second run writes nothing;
- the subscription job fires at 7/3/1 days with `subscription:<id>:<YYYYMMDD>:<days>`, and inside the same day it
  fires once;
- the verification-SLA job alerts staff about a request older than 48 hours, once per day per subject;
- a plan upgrade writes `subscription_plan_changed` through the trigger with
  `plan:<subscription_event_id>` dedupe, and a settled agent cash-in writes `agent_cash_in_settled` with
  `agent-settlement:<agent_transaction_id>` — both once, even when the row is touched twice;
- `cmd_get_notification_catalogue` returns every kind for staff and raises `FORBIDDEN` for a passenger;
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
4. **The admin preview shows the catalogue, not a test send.** It renders every event's AR/EN sentence through
   `notificationText()`; sending a fake notification to yourself to see it in the inbox is not a button.
5. **Saved searches cannot be edited beyond notify/label/digest.** Filters are immutable — re-saving is the edit
   path, and the fingerprint de-duplicates. Changing a filter is a new search, which is deliberate: an "edited"
   search whose `last_matched_at` is old would re-alert on trips the person already ignored.
6. **The bell in the site header does not show an unread count.** The inbox has one, the mobile tab has one; the
   header is a server component shared by 40 routes and adding a query to it is a Phase 12 performance item.
7. **Pagination is a page, not a scroll.** `notifications.list` returns 50 rows and `nextCursor`; the web inbox
   renders the first page only.
8. **Nothing is deleted.** Delivery rows and attempts grow without a retention policy; a monthly archive table is
   Phase 12 work (and needs a decision on how long a support case must be answerable).
9. **The history deliverables of §6.10 live in earlier phases, and this is where they were checked.** Passenger
   booking history is `/account/bookings` (Phase 4's `cmd_list_my_bookings`), operator trips and revenue are
   `/operator/trips` and `/finance/dashboard` (Phase 10 reads the ledger), staff all-trips with CSV export is
   `/staff/trips` plus `GET /api/staff/trips/export`, finance statements and invoices are `/finance/statements` (with the CSV
   `StatementExport`) and `/finance/invoices` (Phase 10's `cmd_get_statement` / `issue_invoice`), and nothing is hard-deleted: every
   table in the schema either has no `delete` grant (the write lockdown test asserts this) or is a preference
   (`saved_searches`, `notification_preferences`) that belongs to the person deleting it. Phase 11 added *links*
   into those screens from the notification bodies; it did not rebuild them.
10. **The quiet-hours preview is static.** The preferences screen says "23:00 → 06:00" from the saved window and
    the `inQuietWindow()` helper, but it does not live-update as the user drags the time inputs; saving and
    re-reading is the loop.
11. **Plurals are per rule, not per ICU message.** `translateCount` picks `zero/one/two/few/many/other` from a
    hand-written `pluralCategory()` (Hermes has no reliable `Intl.PluralRules`) and the dictionary holds one key
    per form. That is enough for the counts this product shows (unread items, matching trips) and is not a
    general message-format system; complex sentences still avoid agreement instead of encoding it.
12. **Mixed-direction strings are split, not merely wrapped.** `splitBidi()` returns the Latin runs separately
    (and keeps sentence punctuation with the Arabic side) so a component can wrap them in `<bdi>`; the inbox does
    that (a trip code inside an Arabic sentence is the common case), and the admin preview solves the same problem
    one level up — one `lang`-and-`dir`-annotated cell per language rather than a mixed sentence. A new screen has
    to pick one of the two, and neither happens automatically.
