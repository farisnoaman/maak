# Handover — what this is, where it lives, what is still open

For the person who inherits the repository. Read this first, then `README.md`, then
`docs/phase-12-report.md` §6. Everything here is meant to survive a change of maintainer without a meeting.

---

## 1. The shape of the thing

| Layer | Where | What it owns |
| --- | --- | --- |
| Domain + API contracts | `packages/core` | Money, pricing, policy, i18n, every action's zod schema and `cmd_*` mapping. Framework-free by rule (a lint rule enforces it). |
| Database | `supabase/migrations` | 44 migrations; every write is one `cmd_*` command, audited, RLS on every table. `supabase/tests` is 19 pgTAP suites. |
| Edge functions | `supabase/functions` | One function per slice; each maps one action to exactly one command. |
| Web | `apps/web` | Next.js 16, bilingual (AR default, full RTL), 109 routes checked for a11y in both directions. |
| Mobile | `apps/mobile` | Expo SDK 52 / RN 0.76.5, expo-router. Driver and passenger flows. |
| Local stack | `scripts/dev-backend` | Embedded PostgreSQL + a PostgREST/GoTrue/Storage subset. No Docker needed. |
| Jobs | `scripts/notify-worker.mjs`, `scripts/route-fill.mjs` | 13 notification jobs; the route filler. Both are cron-shaped (`--once`, `--check`, exit codes). |

**The invariant that matters:** a client never writes a table. It calls an action; the gateway resolves the actor,
checks the capability, calls one `cmd_*`; the command re-checks inside SQL and writes an audit row. If you find
yourself adding an `insert` grant, stop — you are about to create a second way to do the same thing.

---

## 2. Running it

```bash
npm install
npm run dev:api          # embedded Postgres + API on :54321 (prints the service key too)
npm run dev              # web on :3000
```

Demo accounts, password `Maak!2026`: `admin@`, `staff@`, `owner@`, `driver@`, `finance@maak.test`.

**Gates**, in the order that fails fastest:

```bash
npm run typecheck && npm run lint      # a minute
npm test                               # 658 unit tests
npm run sql:check                      # migrations, 19 pgTAP suites, types in sync, security posture
npm run check:all                      # all of it, plus guards, a11y and coverage
```

`npm run build:functions` is needed once on a fresh clone: the edge bundles are gitignored and `check:functions`
verifies them.

---

## 3. The jobs, and how to tell whether they ran

| Job | Command | What breaks silently if it stops |
| --- | --- | --- |
| `notify` (13 jobs) | `npm run notify -- --once --fail-on-error` | Nothing is delivered; saved-search alerts and reminders stop. Runbook §2. |
| `routes:fill` | `npm run routes:fill -- --fail-on-error` | New trips keep the straight-line route — a worse ETA, not a broken trip. |
| `drill:restore` | `npm run drill:restore` | You learn the RTO is wrong on the day you need it. Run monthly. |
| `perf:smoke` | `npm run perf:smoke` | Search regressions land unnoticed. Run on every schema change. |

Every one of them prints a JSON line and exits non-zero when asked — the exit code is the only monitoring channel a
cron has.

---

## 4. Where the decisions are written down

| Question | File |
| --- | --- |
| Why is it built this way, phase by phase? | `docs/phase-*-report.md` |
| What is still open, and why? | `docs/phase-12-report.md` §6 |
| A production incident, right now | `docs/runbook.md` (triage → six alerts → scheduler → restore) |
| Operating the platform (staff/admin) | `docs/admin-guide.md` |
| Using the product (operators) | `docs/operator-guide.md` |
| Performance: what is fast, what is not, and the numbers | `docs/perf/README.md` |
| Before launch: the human sessions | `docs/uat.md` |
| Store submission | `docs/store-listing.md` |
| Legal text (editable, both languages) | `apps/web/src/lib/legal.ts` |
| Releases | `CHANGELOG.md` |

---

## 5. What is genuinely still open

Copied from `docs/phase-12-report.md` §6 on the day this file was written; that section is the source of truth if
the two ever disagree.

1. **No load test at production volume.** p95 targets are verified at 50,000 trips, one request at a time; the k6
   suites exist and exit non-zero on a missed threshold, but there is no environment with the stated load.
2. **Dependency debt in the mobile toolchain.** `npm audit --omit=dev` reports advisories, all in the Expo/RN tree;
   clearing them means an SDK upgrade whose acceptance criterion is "the driver journey works on a device".
3. **Pilot UAT** — three operators, a full cycle each, using `docs/uat.md`. Calendar, not code.
4. **The hosted-project restore run.** The drill runs against the embedded cluster; production adds the download,
   PITR replay and repointing the app.
5. **`plpgsql_check`** is not in the toolchain. `supabase db lint` needs the CLI. The review that replaced them is a
   gate (`sql:check`'s security posture block) but is not the same thing.
6. **Failure alerting for the workers themselves** is GitHub's notification settings. Right size for three pilots;
   not for a hundred.
7. **`v1.0.0`** is tagged after (3) and (4), never before.

---

## 6. If you are picking this up cold

1. `npm install && npm run dev:api` in one terminal, `npm run dev` in another. Sign in as `owner@maak.test`.
2. Create a trip, publish it, open `/trips` in a private window, and book it. That single path touches the
   permission model, the command pattern, the audit log, the marketplace read path and the notification stack.
3. Break something on purpose: delete a translation key and run `npm run check:all`. The failure that names the key
   is the guard the report calls "a CI failure that is cheaper than a broken sentence".
4. Read `docs/phase-12-report.md` §1.8 before touching search. It has the numbers, the two approaches that did not
   work, and the reason the price path is deliberately left slow.
