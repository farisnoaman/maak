# Running Maak against a real database (no Docker)

The app ships with a **preview mode**: with no Supabase URL configured, every screen renders
fixtures and shows a banner saying so. That is useful for a design review, useless for testing
behaviour.

This document describes the other mode: a real PostgreSQL cluster, the real migrations, real RLS and
real `cmd_*` commands, started by one command on any machine that can run Node 22.

```bash
npm install
npm run dev:setup     # writes apps/web/.env.local (once)
npm run dev:api       # terminal 1 — Postgres + auth + REST + functions on :54321
npm run dev           # terminal 2 — Next on :3000
```

Open <http://localhost:3000/ar> and sign in with a demo account below.

## Demo accounts

Password for all four: **`Maak!2026`**

| E-mail | Phone | Who |
|---|---|---|
| `admin@maak.test` | `+967733000001` | Platform admin — every console, verification queue, place review |
| `staff@maak.test` | `+967733000002` | Platform staff **with a geo scope** over «إقليم عدن والساحل» |
| `owner@maak.test` | `+967733000003` | Verified individual, owner of «شركة معك للنقل» (Maak Transport) |
| `new@maak.test` | `+967733000004` | Fresh account: unverified, no roles, no organization |

Phone sign-in works too: request a code and enter **`111111`**. There is no SMS provider locally, so
the dev backend accepts that one code for any Yemeni mobile and prints the same code to its console.

## What is real, and what is not

| Real | Notes |
|---|---|
| PostgreSQL 17 (embedded build) | a persistent cluster in `.dev/pgdata`, not an in-memory mock |
| All 11 migrations, in order | the same files CI applies |
| Row-level security | every REST read runs inside `set local role anon\|authenticated` + `request.jwt.claims` |
| `cmd_*` commands | one command per request, exactly like the edge gateway |
| The capability matrix | imported from `@maak/core` — the same function the edge functions call |

| Not real | Why |
|---|---|
| GoTrue | a subset: password, refresh, signup, OTP, `user`, `logout` |
| PostgREST | a subset: `select` (with embedded relations), `eq/neq/gt/gte/lt/lte/in/is`, `order`, `limit`, single-object `Accept` |
| Realtime | not implemented — nothing in Phase 0–2 uses it |
| Storage | local files under `.dev/storage`, no signed URLs (the queue returns paths, not links) |
| Rate limiting | skipped locally; the edge functions keep it |

Writes **only** go through `/functions/v1/*`. `GET /rest/v1/*` is read-only and answers `405` to
anything else, so the "one write path" rule is visible in the dev stack too rather than quietly
bypassed.

## How the browser reaches it

`apps/web/.env.local` sets `NEXT_PUBLIC_SUPABASE_URL=/supabase`, a **same-origin** mount:

```
browser ──► https://<host>/supabase/auth/v1/...   (relative to whatever host served the app)
                 │  Next rewrite  (next.config.mjs)
                 ▼
            http://127.0.0.1:54321/auth/v1/...
```

Two consequences worth knowing:

- **The hosted preview works.** A browser inside the preview iframe cannot resolve `localhost`; a
  relative URL keeps every API call on the origin that served the page.
- **The session cookie name is pinned** (`sb-maak-auth`, see `lib/supabase/config.ts`). `@supabase/ssr`
  would otherwise derive it from the first host label — `3000-abc…` in the browser vs `127` on the
  server — and server renders would always look signed out.

Server code (Server Components, route handlers, the proxy) does not use the rewrite: it talks to
`MAAK_SUPABASE_INTERNAL` directly.

## Resetting

```bash
npm run dev:api:reset   # drops .dev/pgdata, re-applies every migration, reseeds
rm -rf .dev             # or just throw the whole thing away
```

The cluster is persistent, so `Ctrl-C` loses nothing. A schema change (a new migration file) is
detected on start and re-applied onto a fresh cluster only when you pass `--reset`.

## Architecture

| File | Job |
|---|---|
| `db.mjs` | boots the cluster, applies `scripts/sql-check/bootstrap.sql` + every migration, seeds demo rows |
| `auth.mjs` | `/auth/v1/*` — password, refresh, signup, OTP, user, logout |
| `rest.mjs` | `/rest/v1/*` — PostgREST subset, executed **as the caller** so RLS applies |
| `gateway.mjs` | `/functions/v1/*` — mirrors the Deno edge functions argument for argument |
| `server.mjs` | wires the four surfaces into one HTTP server |

`gateway.mjs` imports `@maak/core` (bundled with esbuild at startup) instead of re-implementing the
schemas, the command→argument map or the policy matrix. If a change lands in the edge function and
not here, the dev stack is wrong in the same way a stale client would be — not "correct but
different".

## How sign-in works

Sign-in is a **plain form POST** to `/api/auth/sign-in`. The route handler calls the auth API from the
server and sets the session cookie on the redirect response.

That single decision removes a whole class of bugs:

- the cookie is `httpOnly`, so no script — in this app or injected into it — can read the session;
- the browser never holds a token, so there is no client/​server session drift and nothing to
  desynchronise after a refresh;
- it works with JavaScript disabled, and it works when a stale bundle is cached;
- it can be tested end-to-end with `curl`, which is why `npm run dev:check` covers it.

Because the token never reaches the browser, client-side data access goes through **`/api/data/*`**
(a same-origin proxy that attaches the caller's bearer token server-side). `/api/data/rest/v1/...`,
`/api/data/functions/v1/...` and `/api/data/storage/v1/...` are the three allowed mounts; nothing else
is forwarded. Client code therefore uses `fetch('/api/data/...')` instead of a Supabase browser client.

Two rules that cost an afternoon each and are now enforced by tests:

| Rule | Why |
|---|---|
| Redirects are absolute, built from the **`Host` header** | `request.url` is the address the server *listens* on (`0.0.0.0`), which no browser can follow. Next also rejects a relative `Location` from the proxy. |
| A non-loopback host is treated as **https** | `next dev` supplies `x-forwarded-proto: http` describing the hop to itself, not the browser; trusting it wrote `SameSite=Lax` cookies into an https preview |

Check what the server knows about your session at any time: <http://localhost:3000/api/auth/status>

```json
{ "configured": true, "sessionCookiePresent": true, "user": "admin@maak.test" }
```

`sessionCookiePresent: false` means the browser never sent the cookie (blocked or cross-site);
`true` with `user: null` means it arrived and was rejected — very different bugs.

## Signing in inside a preview frame

The hosted preview renders the app in a **cross-site iframe**, and that changes cookie rules: a
document inside a third-party frame counts as cross-site even when it calls its own origin, so a
`SameSite=Lax` session cookie is written but never sent back. The symptom is distinctive — the
sign-in call succeeds, the app navigates, and the server immediately bounces back to `/sign-in`.

Both sides therefore derive the attributes from the real scheme (`authCookieFlags`): over https the
session is `SameSite=None; Secure; Partitioned`, over http (localhost) it stays `SameSite=Lax`.
`Partitioned` (CHIPS) is what lets the cookie exist in a third-party frame at all.

If a browser still refuses, you come back to the sign-in screen with an explanation and an
**Open the app in its own tab** button — a top-level page has no third-party restrictions. The proxy
only shows that automatically when it can prove the case: the request came from the sign-in page and
carried no session cookie at all.

The proxy also logs the reason on every bounce:

```
[auth] /en/account → sign-in (session cookie absent)
```

`absent` = the cookie never arrived (blocked or cross-site); `present` = it arrived and the token was
rejected, which is a completely different bug.

## Troubleshooting

- **`EADDRINUSE :54321`** — a previous backend is still running.
- **Sign-in works, server pages look signed out** — the cookie name drifted; keep
  `AUTH_COOKIE_NAME` as the single source for browser, server and proxy.
- **`relation "public.driver_profiles" does not exist`** — that table arrives in Phase 3. The edge
  `_shared/actor.ts` tolerates its absence (`42P01`) instead of failing every request; do not paper
  over it with an empty table.
- **Arabic comes out as `?`** — the cluster must be UTF8; `db.mjs` passes
  `--encoding=UTF8 --locale=C` and `client_encoding=UTF8`. A SQL_ASCII cluster cannot store the
  schema's Arabic text.
