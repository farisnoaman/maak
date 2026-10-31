# ADR-0001 — Backend architecture: edge gateway vs. edge orchestration

- **Status:** Proposed (awaiting sign-off)
- **Date:** 2026-10-28
- **Supersedes:** the "business logic in plpgsql" premise of specs.md v1.0
- **Related:** specs.md §5.4, §9.4, §11, §14; ADR-17…20

## Context

Three options were on the table for where Maak's business rules live and how writes reach Postgres.

| | A — original (v1.0) | B — reviewed proposal | C — v1.2 |
|---|---|---|---|
| Brain | PL/pgSQL functions | TypeScript in `packages/core` | TypeScript in `packages/core` |
| Write path | client → PostgREST RPC | client → Edge Function → *(pull rows → compute → write batch)* | client → Edge Function → **one named SQL command** |
| Transaction | inside the RPC | "a single, safe database transaction" (open tx from Deno) | inside the SQL command |
| RLS | business rules in RLS | identity-only | identity-only (reads) + defense in depth |
| Reads | PostgREST | through edge (per diagram) | PostgREST + RLS |

B and C share the same philosophy. The differences are operational, and they decide whether money stays correct under load.

## Comparison

| Dimension | B — edge orchestration | C — edge gateway + atomic command | Verdict |
|---|---|---|---|
| **Atomicity** | Requires an explicit DB transaction held open across a network round trip (or several) from Deno. Easy to write a handler that does `select` … `compute` … `insert` without a transaction and never notice. | The whole operation is one `select … for update` + writes inside a single `SECURITY DEFINER` function. Impossible to write half of it. | **C** |
| **Race safety** | Read-modify-write across two round trips: two passengers can both read "1 seat left" and both write. Needs optimistic locking discipline in every handler. | `FOR UPDATE` on the trip row inside the command; the second booking sees zero seats. Proven by a pgTAP concurrency test. | **C** |
| **Connection cost** | Direct Postgres from edge needs the pooler + a `postgres` client per invocation (~50–120 ms overhead, prepared-statement caveats in transaction pooling, pool exhaustion at peak). | One `db.rpc()` over HTTP; no pooled connection held, no driver in the function bundle. | **C** |
| **Testability** | Best-in-class for pure math (same in C). Handler tests need a fake DB adapter either way. | Same, plus the SQL command can be tested with pgTAP in isolation. | Tie |
| **Simplicity of the DB** | Truly minimal SQL: tables + RLS. | A 30–60 line `cmd_*` per action (insert + invariants + audit). | **B** (slightly) |
| **Security posture** | Gateway authorizes, then writes with `service_role`. If a handler forgets a check, the DB accepts anything — there is no last line of defense. | Gateway authorizes *and* the command re-asserts the invariants that cost money (balance, quota, seats, verification). Two independent checks. | **C** |
| **Auditability** | Audit row is one more insert the handler may forget. | Audit is written inside the same transaction, so an action without a trace cannot commit. | **C** |
| **Blast radius of the service key** | Needed by every handler for arbitrary reads/writes. | Needed only to `EXECUTE` a fixed set of commands — the key cannot express "drop a table" or "update any row". | **C** |
| **Public search latency** | Diagram routes reads through edge too: +1 hop on the hottest page, invocations billed per view. | Reads hit PostgREST directly with RLS; no business logic to protect. | **C** |
| **Geospatial work** | Justification for moving math out of SQL also gets applied to distances → pull coordinates into TS. That is slower and re-implements PostGIS badly. | Keep PostGIS for KNN snap (`<->`), `ST_DWithin`, route progress along a polyline; only *display* formatting happens in TS. | **C** |
| **Tooling friction** | `supabase/migrations` (CLI default) — zero friction. | v1.2 used `supabase/database/migrations`, which fights the CLI. | **B** |
| **Deploy mechanics** | "Edge functions import `packages/core` directly" — true locally (`supabase functions serve`), **false on deploy**: only the function folder is uploaded, so workspace imports outside it fail. | Same problem; solved by a build step. | Both need a **bundle step** |
| **Coverage claim** | "100% covered by Vitest" — 100% line coverage is gameable and does not prove ledger correctness. | 90% threshold on `domain/` + property-based tests (fast-check) for money invariants + pgTAP for constraints. | **C** |

## Decision

**Adopt C (edge gateway + one atomic command per action), with four corrections adopted from B:**

1. **Keep RLS dead simple and identity-based** — as B says. No pricing, no ledger, no state machines in policies.
   Membership and geo scope are the only joins allowed, expressed once as `app.is_org_member()` /
   `app.in_geo_scope()` and reused, not re-implemented per table.
2. **Use the Supabase CLI's native layout** — `supabase/migrations`, `supabase/functions`,
   `supabase/tests`, `supabase/seed.sql`. B is right that fighting the CLI is a maintenance tax.
3. **Shared zod + shared types** across web, mobile and edge — as B says. Server validation reuses the
   exact schemas the client validates with.
4. **The ledger logic lives in `packages/core`** — as B says. `bookingPaidLines()`, `computeRefund()`,
   `computeCommission()` are pure and already covered by 63 Vitest assertions.

**And four corrections that B needs before it is safe:**

1. **"Write the batch in one transaction" must mean one named SQL command, not an open transaction from Deno.**
   Otherwise the last-seat race and the half-posted journal are one bug away.
2. **Never accept client-computed prices.** The gateway recomputes from trip/stop rows inside the command;
   a client-sent `total` is treated as a claim to verify, never as the amount to charge.
3. **Edge functions must be bundled before deploy.** `esbuild` (or `deno bundle`) inlines `packages/core`
   into each function; otherwise deployment silently ships a broken import. Add it to CI and to Phase 0.
4. **Geospatial math stays in PostGIS.** Ledger, pricing, quotas, policy → TypeScript.
   Nearest stop, distance along route, "is this trip in Aden" → SQL with GIST indexes.

## Consequences

**Positive**
- One language for the rules; Vitest is the primary feedback loop (< 1 s, no database).
- Money cannot half-apply: every command is all-or-nothing and audit-atomic.
- No long-running server, no ORM, no second API layer to version.
- Reads stay cheap and cacheable; edge invocations scale with writes, not page views.

**Negative / accepted costs**
- Two artifacts per action (handler + `cmd_*`), deliberately thin, both greppable by the same name.
- A bundle step in the deploy pipeline (mitigated: one esbuild call, checked in CI).
- Edge cold starts (~50–150 ms first invoke) — acceptable for writes, invisible for reads.
- The gateway is a single point of *authorization*: it must have near-100% test coverage on `policy.ts`,
  and the command must keep re-asserting invariants. This is why both layers exist.

**Rejected:** generic "write batch" RPC (becomes an unvalidated universal write API), business rules inside
RLS (untestable, invisible, and easy to bypass when a new table is added), business logic in PL/pgSQL (option A).

## Verification

This decision is considered correctly implemented when:
- `packages/core` has zero framework imports and ≥ 90% line coverage, including property tests for money.
- Every write command is `service_role`-only and `anon`/`authenticated` hold no write grants on any table.
- A pgTAP concurrency test proves two simultaneous last-seat bookings yield exactly one winner.
- CI fails if a handler makes two `db.rpc()` calls, if `service_role` appears in a client bundle, or if an
  edge function is deployed without a fresh `packages/core` bundle.
