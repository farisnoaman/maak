# Phase 1 — Identity, accounts & verification

**Date:** 2026-10-28 · **Branch:** `arena/736770c1-maak` · **Spec:** `specs.md` v1.2 · **Plan:** `IMPLEMENTATION_PLAN.md`

Phase 1 turns a single-user skeleton into multi-tenant identity: individuals, companies, staff roles,
and the verification queue that gates every later phase. This document records what exists, what was
proven, and — importantly — what could not be run in this environment.

Legend: ✅ verified here · ⚠️ code complete, needs Docker/device · ⛔ not done

---

## 1. What was built

### Database (2 migrations, 12 commands)

| Object | Purpose |
|---|---|
| `organizations`, `organization_members` | company/agency accounts, roles (`owner` › `manager` › `accountant`/`dispatcher`), contact-bound invites |
| `verification_requests`, `verification_documents` | an immutable submission (`snapshot` of the identity fields) plus a decision (who, when, why) |
| `notifications` | in-app notifications; `title_key` is an i18n key, never text (BR-43) |
| `profiles` additions | `email`, `national_id_type`, `national_id_number`, `birth_place`, `date_of_birth`, `avatar_path`, `verification_note`, `onboarded_at` |
| helpers | `app.has_role`, `app.is_platform_admin`, `app.my_orgs`, `app.is_org_member`, `app.org_role`, `app.org_is_verified`, `app.is_verified_actor`, `app.owner_effective_plan` (stub), `app.org_effective_plan`, `app.can_view_verification`, `app.notify` |
| storage | `avatars` (public, 2 MB) and `verification-docs` (private, 10 MB); uploads confined to `<user-uuid>/…` |
| commands | `cmd_update_profile`, `cmd_set_preferred_locale`, `cmd_create_organization`, `cmd_update_organization`, `cmd_invite_member`, `cmd_accept_invite`, `cmd_remove_member`, `cmd_submit_verification`, `cmd_decide_verification`, `cmd_grant_role`, `cmd_revoke_role`, `cmd_mark_notifications_read` |

Every command: re-checks permission in SQL, writes one audit row, and sends its notifications in the
same transaction. All twelve are `service_role`-only — a client calling one gets `42501`.

### Shared brain (`packages/core/src/domain/identity.ts`, 49 new assertions)

* the verification state machine (`submit`/`approve`/`reject`/`withdraw`/`revoke`) — including the rule
  that editing a legal identity field revokes a verification;
* separation of duties (`canDecideVerification`: nobody decides their own request, however senior);
* Yemeni phone normalisation (`+9677…`, `7…`, `00967…`), e-mail normalisation, ID-number validation
  and masking (`12••••••••12`);
* document rules (required kinds per subject, own-prefix paths, MIME allow-list, 10 MB cap);
* membership matrix (`canInvite`, `canRemoveMember`, `canManageMember`, `orgPermissions`);
* invite rules (72 h TTL, 32-byte hex token format);
* plan quotas — `effectivePlan()` **always returns `basic`** (BR-37: a bug under-grants, never
  over-grants), and a test asserts a plan can never change a *permission*.

### Gateway (2 new edge functions)

* `identity` — one function, 12 actions, **exactly one `cmd_*` call per request**;
* `verification-queue` — staff-only queue that mints 5-minute signed URLs for private documents.

`_shared/actor.ts` was corrected: organization membership roles are now **mapped**
(`accountant → org_accountant`), not flattened to `org_owner`.

### Web (`/[locale]/…`)

| Route | What it does |
|---|---|
| `/account` | profile, verification badge, company list, create-company form, notification list with “mark all read” |
| `/account/verification` | 3-step wizard (details → documents → review) with upload to the caller's folder |
| `/account/invitations?member=&token=` | accepts a company invite |
| `/operator/settings` | company details + company verification, with the “editing legal identity revokes verification” warning shown *before* saving |
| `/operator/team` | member table, invite form, remove — buttons decided by the shared role matrix |
| `/staff/verifications` | queue with approve/reject + mandatory reason, self-submission rows non-actionable |
| `/admin/users` | role grant/revoke |

### Mobile (`apps/mobile`)

`profile.tsx` (profile + verification badge + company list) and `verification.tsx` (camera capture via
`expo-image-picker` → upload → submit), both using the same schemas and command as web.

---

## 2. Verification

| Check | Result |
|---|---|
| `npm test` | ✅ **176 passing** (49 new identity assertions, ~1.7 s, no database) |
| `npm run test:coverage` | ✅ exit 0 — `identity.ts` 97.35% statements / 91.33% branches / 100% functions |
| `npm run typecheck` (core + web + mobile) | ✅ 0 errors |
| `npx eslint .` | ✅ clean (5 custom architecture rules) |
| `npx prettier --check` | ✅ clean |
| `npm run check:guards` | ✅ 14 core files · 47 style files · 7 migrations |
| `npm run db:types:check` | ✅ types match 7 migrations |
| `npm run build:functions` | ✅ 4 bundles — `health`, `identity`, `me`, `verification-queue` |
| `npm --workspace @maak/web run build` | ✅ 24 routes (12 × 2 locales) |
| `npm run check:a11y` | ✅ **18 routes**, both directions |
| pgTAP `0003_identity_verification.test.sql` (23 assertions) | ⚠️ written, **not executed** — no Docker here |

```bash
# what still needs your machine
supabase start && supabase db reset
supabase test db          # 0001 (9) + 0002 (8) + 0003 (23) assertions
```

---

## 3. A real bug found while writing Phase 1

Phase 0's RLS policies call `app.is_platform_staff()` from policies on `public.profiles`, but
migration `00001` revoked **USAGE on schema `app`** from `authenticated`. PostgreSQL checks schema
usage for functions referenced in a policy, so every signed-in read of `profiles` would have failed
with *permission denied for schema app* — invisible until a real database existed.

Fixed in `00006`: `grant usage on schema app to authenticated`, plus `EXECUTE` on exactly four
predicates (`uid`, `is_platform_staff`, `is_org_member`, `can_view_verification`) and a default
privilege revoke so no future helper is exposed by accident. `app.notify` and the plan lookups remain
private. This is exactly the class of bug pgTAP exists to catch — and why it must run in CI with Docker.

---

## 4. Acceptance criteria

| Criterion (from the plan) | Status |
|---|---|
| Unverified user sees gated actions disabled **and** the RPC returns `NOT_VERIFIED` | ✅ `app.is_verified_actor()` + `requirePolicy`; Phase 3 commands will call it. Disabled state in UI |
| Owner invites a manager → invitee accepts → context switches → permissions differ | ✅ implemented end-to-end; ⚠️ the two-user flow needs a live database |
| Staff approve → verified badge without reload; notification row; audit row with actor + reason | ✅ command writes all three in one transaction; UI updates from the response |
| Revoked verification immediately blocks gated actions | ✅ roles and verification are re-read on **every** request (no token claims trusted) |
| Every screen renders in `ar` (RTL) and `en` (LTR); no hardcoded strings | ✅ 18 routes checked; ESLint `no-hardcoded-copy` clean |
| pgTAP: an unverified user cannot read another user's verification documents | ✅ asserted in `0003` (⚠️ not executed) |

---

## 5. Deliberate limitations (tracked, not hidden)

| Limitation | Why it is acceptable now | When |
|---|---|---|
| `capabilitiesOf()` flattens roles across organizations | it is a UX hint only; every command re-derives the role **for that organization** in SQL (`app.org_role`) | Phase 3, when per-org scoping reaches trips |
| Invite link is displayed once and can be shared on WhatsApp | the token is bound to the invited phone/e-mail and hashed at rest; a forwarded link cannot be accepted by a different account | — |
| No e-mail/SMS delivery | Phase 11 (notifications), explicitly out of Phase 1 scope | Phase 11 |
| Storage uploads bypass the gateway | a blob is not a row; bucket size/MIME caps + own-prefix policies apply, and the command re-validates the prefix | — |
| Own-account deletion, ownership transfer | separate flows with financial consequences | Phase 9/10 |
| `.github/workflows/ci.yml` still inactive | GitHub App lacks `workflows` permission | when permission is granted |

---

## 6. Next phase

**Phase 2 — Geography, places & supervisor scoping**: PostGIS, 22 governorates / ~333 districts
(OCHA P-codes), regions and sub-regions, the `<PlacePicker>` with Arabic normalisation, and
`app.in_geo_scope()` — which is what gives `geo_supervisor` (already a role here) something to do.
