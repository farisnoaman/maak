# Phase 0 — Foundations & Bilingual Shell

**Status:** complete, ready for review · **Date:** 2026-10-28
**Branch:** `arena/736770c1-maak`

---

## What you can do right now

```bash
npm install
npm test                 # 100 unit tests, ~1s, no database
npm run check:guards     # architecture guards
npm run build:functions  # bundle edge functions
npm run dev              # web on http://localhost:3000
```

The web shell is live at `/ar` and `/en`. `/` negotiates the locale from `Accept-Language`
(Arabic by default, English for `en-*` browsers).

---

## Delivered

### 1. Monorepo with one brain

| Path | Purpose |
|---|---|
| `packages/core` | Framework-free TypeScript: money, ledger, pricing, commission/refund, policy, API client, i18n, formatting |
| `packages/design-tokens` | `tokens.css` + `tokens.json` — one palette/scale for web (CSS) and mobile (StyleSheet) |
| `apps/web` | Next.js 16 (App Router, Turbopack), locale-prefixed routes |
| `apps/mobile` | Expo SDK 52 shell, expo-router, Arabic/English from the same dictionaries |
| `supabase/` | CLI-native layout: `migrations/`, `functions/`, `tests/`, `seed.sql` |
| `scripts/` | `build-functions.mjs` (bundle), `check-guards.mjs` (architecture gates) |

`packages/core` imports no React, Next, Expo or Supabase client — enforced by the guard script, so it
compiles unchanged for web, native, the edge runtime and the test runner.

### 2. The domain, tested

`packages/core/tests` — 8 files, **100 assertions**, ~1 second, no database:

- `money` — integer minor units, half-up rounding away from zero, currency mismatch refused
- `ledger` — a journal with ≠ 2 lines, unbalanced sums, zero/negative amounts or a commission above
  gross is rejected; reversals flip direction and stay balanced
- `pricing` — per-seat, whole-trip, per-stop, fixed/percent discounts, scope rules, seat invariants
- `finance` — commission floors/caps/never-exceeds-gross, tiered and full refunds at the 2-hour cutoff
- `policy` — the whole capability matrix: unverified actors blocked, geo scope respected, driver can
  only start their own trip, finance can confirm payments but not verify entities
- `format` — `1,500 ر.ي` vs `YER 1,500`, `Asia/Aden` conversion, invalid dates → `—`, `bdi` isolation
- `i18n` — ar/en key parity (BR-43), no empty strings, prototype-safe interpolation
- `api` — input validated before it leaves the device, idempotency keys sent, unknown server errors
  never leak, responses that fail their own schema are refused

### 3. Web shell (bilingual, RTL/LTR)

- `<html lang dir>` from the route; `ar` = RTL, `en` = LTR; `hreflang` alternates; locale switch
  preserves path **and** query.
- Layout uses logical properties only (`margin-inline`, `inset-inline-*`, `border-block-end`).
- A live fare calculator runs the **same** `computePrice()` the server runs — visible proof of the
  single-brain design.
- Security headers set in `next.config.mjs`; `poweredByHeader` off.
- Next 16 (not the vulnerable 15.1.6 initially scaffolded) — see "security" below.

### 4. Edge gateway (the only write path)

`supabase/functions/_shared/`:

| File | Responsibility |
|---|---|
| `handler.ts` | POST-only, allow-listed CORS, 256 KB body cap, zod validation, auth, error normalisation, request id |
| `auth.ts` | `auth.getUser(token)` — validates against the Auth server, does not merely decode |
| `actor.ts` | Roles re-read from the DB on every request; plan defaults to Basic, never unlimited |
| `db.ts` | **Single-write guard**: a second `db.rpc()` throws; only `cmd_*` functions may be called as writes |
| `errors.ts` | Same error codes as the client; Postgres messages map to the contract |
| `cors.ts` | Explicit origin allow-list, no `*` |

Two reference commands: `health` (unauthenticated liveness that reveals nothing) and `me`
(returns the server-computed capability list from `packages/core`).

### 5. Database hardening

| Migration | What it does |
|---|---|
| `00001_schemas_extensions.sql` | PostGIS/trgm/pgcrypto, `app` + `audit` schemas, `app.set_updated_at()`, `app.uid()` |
| `00002_audit_log.sql` | Append-only audit log with triggers that reject UPDATE/DELETE/TRUNCATE |
| `00003_hardening_revoke_writes.sql` | Revokes all client write grants **and sets default privileges** so future tables can't re-open the door; ships `app.audit_client_write_grants()` for CI |
| `00004_identity_core.sql` | `profiles`, `user_roles`, profile-creation trigger, RLS (own row / staff), reads only |

### 6. Guards + CI

`npm run check:guards` fails the build on:

1. a React/Next/Expo/Supabase import inside `packages/core`
2. a physical-direction CSS property (`margin-left`, `float:right`, `left: 4px`, …)
3. `service_role` appearing in a client bundle
4. an edge function importing outside its own folder
5. `select('*')` in an edge function (silent PII leaks when a column is added)
6. migration files not named `NNNNN_name.sql`

The check was verified by deliberately introducing `margin-left: 4px` — it failed with file and line.

CI runs: guards → typecheck (3 workspaces) → unit tests → function bundle + freshness → web build,
plus a security job (audit, service-key grep).

---

## Verification evidence

| Claim | Evidence |
|---|---|
| 100 tests pass, no DB | `npm test` → 8 files, 100 passed, ~1.0 s |
| Three workspaces typecheck under `strict` | `npm run typecheck` → core, web, mobile all clean |
| `/` negotiates locale | `Accept-Language: en` → `/en`; `fr` → `/ar` |
| RTL/LTR actually applied | `/ar` → `<html lang="ar" dir="rtl">`, `/en` → `<html lang="en" dir="ltr">` |
| Shared logic runs in the browser | fare calculator on the landing page uses `computePrice()` from `packages/core` |
| Edge functions bundle for deploy | `npm run build:functions` → 2 functions, ~750 KB each, `--check` compares hashes |
| No runtime dependency vulnerabilities | `npm audit --omit=dev` → 0; full audit after reinstall → 0 |
| Guards catch regressions | deliberate violation produced a failing, file:line-specific error |

---

## Deliberate decisions (and why)

1. **Next 16, not 15.** The first scaffold used 15.1.6, which npm flagged with a published CVE. Removed.
2. **No Tailwind yet.** Design tokens are CSS custom properties + a small stylesheet. RTL correctness is
   visible and dependency-free; a utility framework can be added when UI volume justifies it without
   touching tokens. This keeps the Phase 0 surface auditable.
3. **Own tiny i18n instead of `next-intl`.** Typed keys, parity tests and zero dependencies; adding a
   library later is a mechanical swap because all strings already live in `packages/core`.
4. **Global `verify_jwt = false` in `config.toml`.** The gateway verifies tokens itself with
   `auth.getUser()`. One authorization implementation beats two half-implementations; the handler
   rejects requests without a valid session.
5. **`_bundled/` is gitignored.** It is a build artefact; CI rebuilds it and `--check` proves the
   deployed bundle matches the sources.
6. **No fake seed rows.** A profile must reference `auth.users`; demo accounts come from the Auth admin
   API in Phase 1 (`scripts/seed-demo.mjs`) — no FK violations, no fictional UUIDs.

---

## Known gaps (deliberately out of scope for Phase 0)

- `db push`/pgTAP have **not** been executed: this sandbox has no Docker. Run `supabase start` locally;
  the migrations are written to be re-runnable.
- Storage buckets and policies arrive with the surfaces that use them (Phase 1: avatars/verification docs).
- No auth UI yet; `me` and `health` prove the gateway, sign-in screens land in Phase 1.
- Mobile has not been launched on a device here (Expo toolchain requires a real machine/emulator).
- Locale-prefixed routes are in place but no `sitemap.ts` yet — Phase 4, with the public marketplace.

---

## Review checklist

- [ ] `npm install && npm test` on your machine → 100 passing
- [ ] `npm run dev` → visit `/ar` and `/en`; switch locale on a deep link and confirm the path survives
- [ ] Confirm the Arabic page reads naturally and the English page is not a mirrored afterthought
- [ ] Confirm you agree with decisions 1–6 above
- [ ] Approve the Phase 1 scope (identity: profiles, companies, members, verification workflow)

**Next phase:** Phase 1 — Identity, Accounts & Verification (est. 7 days).
