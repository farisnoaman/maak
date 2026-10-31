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
npm test                    # 214 unit tests, ~2s, no database required
npm run lint                # ESLint + 5 custom architecture rules
npm run check:guards        # boundaries, RTL, secrets, migration naming
npm run test:coverage       # coverage thresholds (98% statements, 99% functions)
npm run sql:check           # embedded PostgreSQL: migrations + pgTAP + type drift (no Docker)
npm run build:functions     # bundle edge functions for deploy

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

**Phase 2 complete** — geography, places and supervisor scoping, on top of identity and the
verification queue. Shared domain, **268 passing tests**, hardened database migrations (11),
edge gateway (auth, validation, rate limits, single-write guard, audit), ESLint + Prettier with five
custom architecture rules, UI primitives, auth shell and error boundaries.

- [`docs/phase-2-report.md`](./docs/phase-2-report.md) — 22 governorates, regions, places, scope, what was proven
- [`docs/phase-1-report.md`](./docs/phase-1-report.md) — accounts, verification, what was proven
- [`docs/phase-0-audit.md`](./docs/phase-0-audit.md) — every Phase 0 task and acceptance criterion, verified
- [`docs/phase-0-report.md`](./docs/phase-0-report.md) — narrative walkthrough and decisions
- [`docs/adr/0001-backend-architecture.md`](./docs/adr/0001-backend-architecture.md) — why the write path looks like this

| Phase | Status |
|---|---|
| 0 Foundations & bilingual shell | ✅ complete (audited) |
| 1 Identity & Trust | ✅ complete |
| 2 Geography & Places | ✅ complete (starter district/place data — see the report) |
| 3–12 | see [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) |
