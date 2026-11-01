# Maak (معك) — Trip Management SaaS

A multi-tenant platform for managing intercity trips in Yemen: individual and company accounts,
vehicles and drivers, verified operators, a public trip marketplace, passenger bookings with ID
verification, live trip tracking, staff/supervisor operations (QR scanning, bulk verification, A4
manifests), payments (cash, e-wallets, agents, bank deposits), a double-entry finance module, and
Basic/Pro/Business subscription plans with enforced quotas.

Bilingual by design: **Arabic (RTL) and English (LTR) are both first-class**, not a translation layer.

## Documentation

| File | What's inside |
|---|---|
| [`specs.md`](./specs.md) | Product & technical specification: roles, domain model, permissions, business rules, payments/finance/subscriptions, architecture, security, NFRs, risks |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | 13 phases with deliverables, tasks, acceptance criteria, dependencies and progress tracker |
| [`docs/dev-database.md`](./docs/dev-database.md) | Running against a real PostgreSQL + RLS locally, demo accounts, what the dev stack does and does not emulate |
| [`docs/runbook.md`](./docs/runbook.md) | On-call: the six platform alerts and how to clear them, the scheduler, the restore drill, symptom → first command |
| [`docs/security-review.md`](./docs/security-review.md) | The RLS matrix, the definer-function review, what the build enforces on every run, what is still open |
| [`docs/perf/README.md`](./docs/perf/README.md) | Performance: the three harnesses, the p95 targets, what 50,000 trips actually costs, and the capacity limit that remains |
| [`docs/operator-guide.md`](./docs/operator-guide.md) | For the person running a transport business: verification, vehicles, drivers, trips, bookings, money, plans, team |
| [`docs/admin-guide.md`](./docs/admin-guide.md) | For the platform side: the four roles, verification decisions, staff and finance consoles, plans and geography, what cannot be done |
| [`docs/passenger-guide.md`](./docs/passenger-guide.md) | **بالعربية** — البحث والحجز والدفع والإلغاء والاسترداد والتتبّع والتنبيهات |
| [`docs/phase-11-report.md`](./docs/phase-11-report.md) | Notifications, preferences and search alerts — including the honest list of what is not done |
| [`docs/phase-12-report.md`](./docs/phase-12-report.md) | Hardening: platform alerts, the security gate, the scheduler, what launch still needs |

## Architecture in one line

Next.js (web) + Expo (iOS/Android) sharing one `@maak/core` package, on top of **Supabase**, where all
business rules live exactly once — in Postgres (RLS policies + RPC functions + a double-entry ledger).
No custom API server, no duplicated validation per client, no card gateway in v1.

```
apps/web      Next.js — public marketplace, operator console, staff/admin consoles, finance
apps/mobile   Expo — driver console + passenger app
packages/core Shared types, zod schemas, RPC client, i18n (AR/EN), pricing, finance math, hooks
supabase/     Migrations, RLS, RPCs, cron, seed geography/plans, pgTAP tests
```

## Local development

```bash
npm install                 # web, mobile and core workspaces
npm test                    # 651 unit tests, ~2s, no database required
npm run lint                # ESLint + 5 custom architecture rules
npm run check:guards        # boundaries, RTL, secrets, migration naming
npm run test:coverage       # coverage thresholds (98% statements, 99% functions)
npm run sql:check           # embedded PostgreSQL: migrations + pgTAP + type drift + security posture (no Docker)
npm run build:functions     # bundle edge functions for deploy
npm run notify:check        # is the notification worker configured? (token, providers, job list)
npm run notify              # one pass: drain the delivery queue, then run every scheduled job
npm run perf:seed -- --trips 50000   # clone a published trip 50,000 times (8 s); --reset undoes it
npm run perf:smoke          # p95 for search, a write and the finance dashboard

# Run the app against a real database (no Docker, no Supabase CLI):
npm run dev:setup           # writes apps/web/.env.local (once)
npm run dev                 # database + API + web in one go; http://localhost:3000/ar
npm run dev:check           # end-to-end smoke: form sign-in, cookie, RLS, gateway command

supabase start              # requires Docker
supabase db reset           # migrations + seed
supabase test db            # the same pgTAP suites on the real stack (auth, storage, PostGIS)
```

> No Docker in the build sandbox: `supabase start` and pgTAP run on your machine and in CI.
> `npm run dev:api` is the way around that — a real PostgreSQL cluster, the real migrations and real
> RLS, sign in with `admin@maak.test` / `Maak!2026`. Details: [`docs/dev-database.md`](./docs/dev-database.md).

## Status

**Phases 0–11 complete; Phase 12 (hardening and launch) in progress.** 39 migrations, 131 commands, 11 edge
functions, **651 unit tests**, **944 pgTAP assertions across 18 suites**, 107 a11y routes, and a bilingual web
app plus the Expo client.

| Gate | What it proves |
|---|---|
| `npm test` / `npm run test:coverage` | 651 tests, coverage 95.8 / 87.1 / 96.5 / 96.7 |
| `npm run sql:check` | migrations apply to a real PostgreSQL, every pgTAP suite passes, types do not drift, RLS + definer posture holds |
| `npm run check:a11y` | 107 routes in both directions: one `<h1>`, landmarks, skip link, labelled controls, no physical margins |
| `npm run check:guards` | boundaries, one write path, no secrets, dictionary keys present in both locales |
| `npm run notify` | the delivery queue and all ten scheduled jobs, idempotent by dedupe key |
| `npm run perf:smoke` | search, a write and the finance dashboard against the running dev stack — p95 against the launch targets |
| `npm run drill:restore` | a hot backup restored into a second cluster and compared with the source: row counts, the ledger, integrity, RLS posture and a search answer |

- [`docs/phase-12-report.md`](./docs/phase-12-report.md) — **where the project stands today**: platform alerts, the security gate, the scheduler, what launch still needs
- [`docs/runbook.md`](./docs/runbook.md) — what to do when something is wrong
- [`docs/phase-11-report.md`](./docs/phase-11-report.md) — notifications, preferences, search alerts
- [`docs/phase-10-report.md`](./docs/phase-10-report.md) — the ledger, invoices, plans and subscriptions
- [`docs/adr/0001-backend-architecture.md`](./docs/adr/0001-backend-architecture.md) — why the write path looks like this

| Phase | Status |
|---|---|
| 0 Foundations & bilingual shell | ✅ complete (audited) |
| 1 Identity & Trust | ✅ complete |
| 2 Geography & Places | ✅ complete |
| 3–8 Vehicles, drivers, trips, bookings, tracking, operations | ✅ complete |
| 9 Payments, agents and the money flow | ✅ complete |
| 10 Finance, ledger, invoices, plans and subscriptions | ✅ complete |
| 11 Notifications, preferences and search alerts | ✅ complete |
| 12 Hardening, security and launch | 🚧 in progress — see the report for what is verified and what is open |
