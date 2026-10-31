# Running Maak against a real database (no Docker)

The app ships with a **preview mode**: with no Supabase URL configured, every screen renders
fixtures and shows a banner saying so. That is useful for a design review, useless for testing
behaviour.

This document describes the other mode: a real PostgreSQL cluster, the real migrations, real RLS and
real `cmd_*` commands, started by one command on any machine that can run Node 22.

```bash
npm install
npm run dev:setup     # writes apps/web/.env.local (once)
npm run dev           # database + API + web, one command, Ctrl-C stops all three
```

`npm run dev` starts PostgreSQL and the API on `:54321`, waits for the port, then starts Next on
`:3000`. They are three processes, and the app is only usable when all three are alive — starting them
separately meant a resumed sandbox could serve a working site that silently could not sign anyone in.
The pieces are still available on their own: `npm run dev:api` and `npm run dev:web`.

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

## Where the browser is (and why the server must not guess)

Every redirect target and every cookie attribute depends on one question: **what address is the
browser using?** The server cannot answer it from `request.url` — that is the address it *listens* on
(`0.0.0.0:3000`), and the preview proxy may rewrite `Host` too. Getting it wrong produced, in order:
a `403 FORBIDDEN`, a redirect to an unreachable `0.0.0.0`, and a `SameSite=Lax` cookie that a
cross-site iframe never sends back.

`lib/origin.ts` answers it from the strongest available evidence:

| # | Evidence | Example | Used for |
|---|---|---|---|
| 1 | `Origin` header | `https://3000-abc.e2b.app` on a form POST | redirect target, cookie `Secure`/`SameSite` |
| 2 | `Referer` header | same, on any navigation | same |
| 3 | `x-forwarded-host` / `x-forwarded-proto` | a proxy that forwards properly | same |
| 4 | remembered value for this `Host` | what we learned earlier | keeps the cookie stable across a refresh |
| 5 | `Host` header | `127.0.0.1:3000` locally | local development |

When only (5) is available **and** it is a loopback address, nobody knows the public origin. Rather
than guess, such a redirect returns a tiny document that navigates itself with a **relative** URL — the
browser resolves it against the address it actually used. That is why a cold start always lands
somewhere sensible, even behind a proxy that forwards nothing.

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

### The CSRF check that broke every preview sign-in

`/api/auth/sign-in` refuses a form post whose `Origin` does not match the request's own host. The first
version compared `Origin` with `request.nextUrl.origin` — which, behind a proxy, is the *internal*
address (`http://localhost:3000`) while the browser honestly says `https://3000-abc.e2b.app`. Every
sign-in in the preview came back `403 FORBIDDEN`.

`lib/origin.ts` now compares hosts from `Host` / `x-forwarded-host`, scheme-agnostic. Two deliberate
choices:

- a request with **no** `Origin` is allowed — that is a same-origin navigation or `curl`, not a
  cross-site form post;
- if every host we can see is loopback, the request cannot be verified, so it is **allowed with a
  warning** rather than breaking sign-in behind a proxy that forwards nothing. An attacker's page still
  cannot forge `Origin` to match a public host.

A refusal is a redirect back to the form with a localized message, never a raw JSON body in the tab.

Check what the server knows about your session at any time: <http://localhost:3000/api/auth/status>

```json
{
  "configured": true,
  "sessionCookiePresent": true,
  "user": "admin@maak.test",
  "browser": { "resolvedOrigin": "https://3000-abc.e2b.app", "scheme": "https:", "evidence": "origin" },
  "received": { "host": "0.0.0.0:3000", "forwardedHost": "0.0.0.0:3000", "forwardedProto": "http", "origin": "https://3000-abc.e2b.app", "referer": null }
}
```

`evidence` says which signal decided the browser's origin; `received` echoes the raw headers the proxy
preserved. Together they explain any redirect or cookie oddity in one request.

`sessionCookiePresent: false` means the browser never sent the cookie (blocked or cross-site);
`true` with `user: null` means it arrived and was rejected — very different bugs. If the API is not
running at all, sign-in says so explicitly ("could not reach the database") instead of blaming the
password.

## When the browser refuses to keep the session at all

**This is the supported escape hatch, and it is on by default outside production.**

If the preview cannot store a cookie — a third-party iframe whose browser blocks third-party storage, or
a proxy that drops `Set-Cookie` — sign-in would otherwise be impossible, and `/api/auth/status` would
report `sessionCookiePresent: false` no matter what you do.

So sign-in also returns the session token *in the redirect* (`/ar/account?st=…`). The proxy forwards it
to the renderer as a request header, which is enough for server-side rendering, the data proxy, RLS and
the gateway — the cookie is never required. A small client component keeps `st` attached to internal
links and forms, so navigating does not silently sign you out.

| | |
|---|---|
| Enabled | everywhere except `NODE_ENV=production` |
| Disable | `MAAK_IFRAME_SESSION=0` |
| Cost | the token appears in the URL (history, logs) — acceptable for a dev preview, not for production |
| Production path | cookies only (`SameSite=None; Secure; Partitioned`); the app must not be embedded, or it must use the Storage Access API |

## Older notes on third-party cookie blocking

Some browsers (Safari and Firefox by default, Chrome for some users) block third-party storage
outright. Inside the preview's iframe that means the session cookie is stored and never sent back, and
nothing server-side can change that — `/api/auth/status` shows it as
`sessionCookiePresent: false` with `secFetchDest: "iframe"`.

Three things are in place, in order of preference:

1. **Storage Access API.** The sign-in form asks `document.requestStorageAccess()` on submit — a click
   is the user gesture it requires — and grants unpartitioned storage. `StorageAccessPrompt` also
   offers an explicit "Allow access in this window" button when the browser reports it is blocked.
   This is progressive enhancement: with JavaScript off, the plain form still posts.
2. **Open in its own tab.** A first-party page has no third-party restrictions. The header shows that
   link whenever the app is embedded, and the sign-in error state repeats it.
3. **A plain explanation.** If neither path applies, the sign-in screen says the browser blocked the
   session instead of pretending the password was wrong.

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
