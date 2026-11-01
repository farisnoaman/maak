# Security review

**Date:** 2026-11-01 · **Scope:** RLS matrix, `security definer` functions, storage policies, command grants,
client write surface, dependency audit.

Two kinds of review, and the difference matters:

- **Checks that run on every build.** These are in `npm run sql:check` and `npm run check:guards`, so they cannot
  quietly stop being true. §1 is the list.
- **Findings that needed a human.** §2–§5 are the ones a query cannot decide: what a policy *means*, where a
  definer function trusts its caller, and what is still open.

---

## 1. What the build enforces

`npm run sql:check` now ends with `▶ security posture`, which boots a real PostgreSQL, applies all 37 migrations
and then asserts four things. Each is a hard failure, not a warning.

| Assertion | Query | Why it is the one that matters |
| --- | --- | --- |
| Every table in `public` has row-level security enabled | `pg_class.relrowsecurity` | A table without RLS is readable by anyone holding the anon key, and that key ships in the browser bundle. This is how the ping partition hole (§2) was found. |
| No table grants `SELECT` to `anon`/`authenticated` without a policy | `information_schema.role_table_grants` × `pg_policy` | Not a leak — RLS returns zero rows — but always a bug, and a bug that looks like "the screen is empty". |
| Every `security definer` function pins `search_path` | `pg_proc.proconfig` | Without it, a caller who can create a schema earlier on the path chooses which `public.foo` the body runs. All 190+ are pinned; a new one that forgets is a build failure. |
| No `cmd_*` function is executable by `anon`, `authenticated` or `public` | `has_function_privilege` | The gateway is the only caller and it holds the service role. A grant here would let a browser call any command with a forged actor id. |

`npm run check:guards` enforces the adjacent promises: no `service_role` key outside `supabase/functions`,
no secrets in the tree, one gateway capability map matching the edge function's, and `packages/core` free of
framework imports.

`npm run sql:check` also prints `write lockdown`: `app.audit_client_write_grants()` must be empty, i.e. no
`INSERT`/`UPDATE`/`DELETE` grant to a client role on any table. Writes exist only as `cmd_*` calls.

---

## 2. Finding: partitions had no row-level security

**Severity:** low (no path was open) but structural.

`public.trip_location_pings` is partitioned by month. The parent has RLS and a driver/manager policy, and Phase 7
granted `select` on the parent. `create table … partition of` copies **neither policies nor grants**, so every
child table — `trip_location_pings_default` and each `trip_location_pings_YYYYMM` — was a table with RLS off.

Nothing leaked: a child also inherits no `authenticated` grant, and the ACL refuses before RLS is consulted. That
is one line of defence holding where two were designed.

**Fixed** in `00035_partition_rls.sql`: every existing child gets `enable` + `force row level security`, the same
policy as its parent, and an explicit `revoke` for client roles; `app.ensure_trip_ping_partition()` — the function
that creates next month's partition on the first ping — now applies all three statements on every call, so a
partition created by an older version or by hand is repaired the next time a ping arrives.

**Why it took until now:** the earlier gate checked the *parent* table's grants, which were correct. The new
`security posture` section asks the catalogue instead of the migration, which is the only way to catch an object
that a `do` block created at runtime.

---

## 3. The RLS matrix, in one table

Every row is enforced by a pgTAP assertion somewhere in `supabase/tests/`; the suite column is where to look when
changing the policy.

| Table | Who may read | Enforced by | Suite |
| --- | --- | --- | --- |
| `profiles` | self, staff, finance; public fields via `get_public_profile` | policy + definer read | 0002, 0003 |
| `user_roles` | self; staff/admin for all | policy | 0002 |
| `organizations`, `organization_members` | members; staff | policy (`app.is_org_member`) | 0004, 0011 |
| `vehicles`, `maintenance_*` | owner (user or org); staff; assigned driver for the day's trip | policy | 0005, 0012 |
| `trips` | published and public to everyone; drafts to the owner; staff all | policy | 0007 |
| `bookings` | the booker, the trip's operator, staff; the driver for their manifest | one predicate, three callers | 0008 |
| `trip_location_pings`, `trip_progress`, `trip_route_geometry` | the trip's driver, or someone who can manage the trip | policy **on the parent and every partition** | 0010 |
| `payment_intents`, `refunds`, `payouts`, `invoices`, `ledger_*` | the payer/payee and finance; the ledger itself is append-only | policy + immutability triggers | 0014, 0015 |
| `notifications`, `notification_deliveries`, `device_tokens`, `saved_searches` | each person's own rows; no client reads another's settings | policy, on top of `cmd_*`-only writes | 0016 |
| `notification_events`, `plans`, `plan_limits`, `usage_counters` | everyone (catalogue data) / the owner / staff | policy | 0015, 0016 |
| `audit.log` | staff and finance only; no client write grant at all | policy + revoke | 0001 |

**Writes:** no table has a write grant to a client role. Every mutation is one `cmd_*` executed by the gateway
with the service role, which resolves the actor from the JWT and passes it as `p_actor` — the client cannot name
another person. `0001_write_lockdown.test.sql` asserts the grant state on every table that exists.

---

## 4. Definer functions

**What "definer" buys, and what it costs.** A `security definer` function runs with its owner's rights, so it can
answer a question the caller's RLS would refuse — that is the whole point of `cmd_*`. The cost is that the body
must not trust anything the caller controls except the values it validates.

Reviewed all functions in `public` and `app` for four patterns:

1. **Pinned `search_path`** — every one. Enforced by §1.
2. **Actor resolution** — `coalesce(p_actor, app.uid())`, then a role check. The gateway passes the actor, so a
   forged `p_actor` is only possible if the token is stolen; in that case it is the same attack as any other.
3. **No dynamic SQL with caller text** — the only `execute format(...)` calls are in
   `app.ensure_trip_ping_partition` (a generated table name from a timestamp) and the grant loops in the
   migrations. Both use `%I`/`%L`, never string concatenation.
4. **Not on the RPC surface a client can reach** — every `cmd_*` is `service_role` only (§1), and `app.*` helpers
   are revoked from client roles.

**One pattern worth naming:** `cmd_run_integrity_check` (Phase 10) writes its alert straight into
`public.notifications`, bypassing `app.enqueue_notification`. It therefore has no delivery rows and no dedupe —
an integrity failure produces a bell icon that is never pushed and reappears on every run. Phase 12's
`cmd_run_ops_alerts` does the same detection through the delivery pipeline (`ops_alert`, deduped per day); the
Phase 10 function is left as it is because changing it would restate a 150-line function for a cosmetic gain, and
because two independent readings of "is the ledger consistent" is a feature. Recorded in
`docs/phase-12-report.md` §6 rather than silently patched.

---

## 5. Dependencies and secrets

| Check | State |
| --- | --- |
| `npm audit --omit=dev` | **19 advisories: 18 moderate, 1 high, 0 critical.** All of them are in the Expo/React Native build toolchain (`metro`, `@expo/cli`, `image-size`, `@react-native/*`), which runs on a developer's machine and in EAS — not in the web bundle and not on a phone at runtime. `npm audit fix` was tried and **reverted**: it resolved the high by pulling newer transitives and introduced a critical (`@expo/cli`), so the honest state is "known toolchain debt, fixed by the RN 0.88 upgrade, which is a mobile-release task". Recorded in `docs/phase-12-report.md` §6. |
| Secrets in the tree | none; `check:guards` scans for `service_role` keys, `sk_`, `re_` and long base64 blobs |
| Secrets in the browser bundle | only `NEXT_PUBLIC_SUPABASE_URL` and the anon key, which is designed to be public |
| `service_role` key | exists only inside `supabase/functions/*` at runtime, from the environment |
| Uploads | storage policies scope every path to `auth.uid()`; the DB re-checks the folder prefix |
| Payment proofs | hashed (`sha256`), unique across intents, so one receipt pays once |
| Rate limits | `app.consume_rate_limit` on every command, plus per-IP limits on the gateway |

**Still open** (tracked in `docs/phase-12-report.md`): a third-party penetration checklist, `plpgsql_check` on the
function bodies, and a dependency-freeze policy for the mobile build. None of them is a live exposure; all of them
are launch-week work.
