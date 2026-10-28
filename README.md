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
pnpm install
supabase start          # requires Docker
pnpm db:reset           # migrations + seed
pnpm dev                # web :3000, mobile via Expo
```

> No Docker in the current build sandbox: full pgTAP suites run in CI and on developer machines.

## Status

Planning complete (v1.1) — Phase 0 (foundations & bilingual shell) is next, pending go-ahead.
See the progress tracker in `IMPLEMENTATION_PLAN.md`.
