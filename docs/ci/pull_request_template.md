# Copy to `.github/pull_request_template.md` to activate.

## What changed

<!-- One paragraph. Link the phase in IMPLEMENTATION_PLAN.md. -->

Phase: <!-- 0 … 12 -->

## Architecture invariants (tick every one)

- [ ] **No client writes.** New mutations go through an edge function + one `cmd_*` call.
- [ ] **One write per handler.** The handler makes exactly one `db.rpc()` call.
- [ ] **Rules in TypeScript.** Pricing, refunds, commission, quotas and policy live in `packages/core`.
- [ ] **Money is integers.** No floats, no `Number` for amounts; currency always attached.
- [ ] **Reads use RLS.** New tables have policies and no write grants (`app.audit_client_write_grants()` empty).
- [ ] **Audit.** New state changes write an `audit.log` row in the same transaction.
- [ ] **`packages/core` is framework-free.** No React/Next/Expo/Supabase imports.

## Bilingual checklist (both directions)

- [ ] Every new string exists in `ar` **and** `en` (parity test passes).
- [ ] Screens checked in Arabic (RTL) and English (LTR).
- [ ] Logical CSS properties only — no `margin-left`, `float`, `left:`.
- [ ] Mixed-direction values (codes, plates, phones) wrapped in `<bdi>`.

## Evidence

- [ ] `npm run check:guards` — passes
- [ ] `npm run lint` — passes
- [ ] `npm test` — passes (tests added for new logic)
- [ ] `npm run test:coverage` — thresholds met
- [ ] `npm run db:types:check` — no drift
- [ ] `npm run check:a11y` — both locales
- [ ] pgTAP (`supabase test db`) — run locally; paste the summary
- [ ] Screenshots: `/ar` and `/en` of each new screen

## Risk and rollback

<!-- What could break, and how do we undo it? Migrations are forward-only:
     for a risky change, describe the compensating migration. -->
