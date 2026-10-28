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
npm install                 # installs web, mobile and core workspaces
npm test                    # 100 unit tests, ~1s, no database required
npm run check:guards        # architecture guards (boundaries, RTL, secrets)
npm run build:functions     # bundle edge functions for deploy
npm run dev                 # web on http://localhost:3000  (/ar and /en)

supabase start              # requires Docker
supabase db reset           # migrations + seed
```

> No Docker in the build sandbox: `supabase start` and pgTAP run on your machine and in CI.

## Status

**Phase 0 complete** — monorepo, bilingual web + mobile shells, shared domain with 100 passing
tests, hardened database migrations, edge gateway, architecture guards and CI.
See [`docs/phase-0-report.md`](./docs/phase-0-report.md) for the review checklist and the evidence.

| Phase | Status |
|---|---|
| 0 Foundations & bilingual shell | ✅ awaiting review |
| 1 Identity & Trust | next |
| 2–12 | see [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) |
