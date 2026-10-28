# Maak (معك) — Trip Management SaaS

A multi-tenant platform for managing intercity trips in Yemen: individual and company accounts,
vehicles and drivers, verified operators, a public trip marketplace, passenger bookings with ID
verification, live trip tracking, and staff/supervisor operations (QR scanning, bulk verification,
A4 manifests).

## Documentation

| File | What's inside |
|---|---|
| [`specs.md`](./specs.md) | Product & technical specification: roles, domain model, permissions, business rules, architecture, non-functional requirements, risks |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | 11 phases with deliverables, tasks, acceptance criteria, dependencies and progress tracker |

## Architecture in one line

Next.js (web) + Expo (iOS/Android) sharing one `@maak/core` package, on top of **Supabase**, where all
business rules live exactly once — in Postgres (RLS policies + RPC functions). No custom API server,
no duplicated validation per client.

```
apps/web      Next.js — public marketplace, operator console, staff/admin consoles
apps/mobile   Expo — driver console + passenger app
packages/core Shared types, zod schemas, RPC client, i18n, pricing, hooks
supabase/     Migrations, RLS, RPCs, cron, seed geography, pgTAP tests
```

## Status

Phase 0 not started — awaiting go-ahead. See the progress tracker in `IMPLEMENTATION_PLAN.md`.
