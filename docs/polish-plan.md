# Polish plan

The product was built phase by phase and gated on correctness: every command is validated in SQL, every screen has a
test, every string exists in two languages. What no phase owned is how it **reads**. This file is that queue, and it
starts with the page a stranger sees first.

Status: `[x]` done · `[~]` deliberately deferred (reason written out) · `[ ]` queued.

---

## The diagnosis

The home page was a build report wearing a landing page's clothes. Its own output, verbatim:

| What is on the page | Why it is wrong |
| --- | --- |
| `المرحلة 2 — الجغرافيا والأماكن` as the eyebrow | A phase number means something to the people who built it and nothing to a passenger |
| `367 اختبار وحدة ناجح` as a hero stat | The test count grew to 669 and the number on the page did not — a statistic that only ever lies |
| `الأساس التقني` — three cards about one write path, shared logic, i18n | Architecture is a reason to trust the product later; it is not why someone visiting Sana'a→Aden stays |
| `المنصات` — seven console cards, each with a phase pill, five of them `قريبًا` | Two thirds of the first screen promised things that do not exist |
| `جرّب حساب السعر — نفس الدالة التي تعمل على الخادم` | The calculator is a good idea described in the wrong language |
| `المرحلة 2 · Next.js · Expo · Supabase` in the footer | A stack list is a hiring page, not a travel site |

Meanwhile `/trips` was returning six real published trips with real prices and seat counts, and the home page showed
none of them. **The polish job is not a repaint: it is using the data that already exists to answer a traveller's
questions in the order they ask them.**

## The principles

1. **The first screen sells the trip, not the build.** Anything that describes how the software was made belongs in
   `docs/`, not above the fold.
2. **Real data or nothing.** No invented numbers, no placeholder `367`, no "1,200 happy passengers" until there are
   actual bookings to count. A section with no data says so, or does not render.
3. **Every block answers "what do I do next".** Feature, then proof, then a door.
4. **Internal surfaces stay reachable, quietly.** The consoles are not deleted — they move below the product and into
   the footer, without phase pills.
5. **No new dependencies, no new design language.** The tokens (`packages/design-tokens/tokens.css`) and the existing
   class vocabulary already carry the look; polish is hierarchy, copy and data, not a framework.
6. **A11y and RTL are part of polished, not a pass afterwards.** Every new block is logical-property CSS, keyboard
   reachable, and swept by `check:a11y`.

## The queue

| # | Surface | The honest problem | Status |
| --- | --- | --- | --- |
| 1 | **Home** (`/[locale]`) | Reads as a build report; ignores the trips it could show; promises five consoles | `[x]` rebuilt |
| 2 | Header + footer | 8 nav links including *المركبات* and *دليل المكوّنات*; no footer anywhere but home | `[x]` trimmed nav, shared `SiteFooter` |
| 3 | Trips list (`/trips`) | Strong already (filters, keyset paging, facets) — but nothing showed *what* was filtering, sort was hidden in the panel, and the "no database" banner appeared over real data | `[x]` |
| 4 | Trip detail (`/trips/[code]`) | The fare was the twelfth row of a table, below the luggage allowance; the reserve button was at the very bottom | `[x]` |
| 5 | Booking + pay (`/book`, `/pay`) | Two flows that work; the pay screen is the one people screenshot when it goes wrong | `[ ]` |
| 6 | Account (`/account`) | Lists are correct, hierarchy is flat — "next departure" should be the first thing | `[ ]` |
| 7 | Auth (`/auth/*`) | Fine, but the sign-in form is the last place a person should meet jargon | `[ ]` |
| 8 | Operator console | Dense tables are right for the job; the **overview** answers nothing at a glance | `[ ]` |
| 9a | **Staff console** (`/staff`, dashboard, scan, verifications, vehicles, trips) | The same five screens under five different sidebars; a phase number above every title; four zeroes and two empty boxes as the dashboard | `[x]` |
| 9b | Finance console | Same: correct, unranked | `[ ]` |
| 9c | **Admin console** (`/admin` + 6 screens) | Two frames around every screen (a card inside a card), five different sidebars, a hub whose second tile apologised for a phase that no longer exists, and UUIDs printed where names belong | `[x]` |
| 10 | Mobile shell (`apps/mobile`) | Mirrors the same problem: the home screen is a list of links, one of them labelled *المرحلة* | `[ ]` |
| 11 | Empty / error / loading states | The states a demo never shows and a launch always hits | `[ ]` |

## 3–4. Trips list and trip detail — what changed

**The list**

- **Applied filters are visible and removable one at a time.** On a phone the filter panel is collapsed, so the only
  evidence a filter was on was a number on the summary, and the only way to undo one of five was *clear* and start
  again. Each filter is now a chip with its own link, built by one `hrefWith()` that knows how to drop a key, drop
  one value of a repeatable key, or set the sort.
- **Sort moved out of the panel.** It is not a filter — it does not narrow the list — and burying it made the
  cheapest trip three taps away. It is a row of links above the results (`aria-current` on the active one), with a
  hidden input keeping the choice when the panel is submitted.
- **Two empty answers, told apart.** `items: []` means "nothing matches" *or* "there is no database", and the page
  printed the preview banner for both — a live marketplace telling visitors its data was illustrative. `loadPublicTrips`
  now returns `configured`, and the banner only appears when it is false.
- **The empty state says what to do**: widen the dates or remove a filter, rather than repeating the page subtitle.
- **The card's route is the link.** A card whose only target was a small button at the bottom asked a thumb to aim.
  Sold-out trips say so before the price, and their button stops claiming a booking is possible.

**The detail page**

- **The fare has its own panel**, first on a phone and sticky beside the facts from 940px: the price, what it is per
  (seat or whole vehicle), the breakdown, seats left, one primary *reserve*, and the sentence that the server
  recomputes it. It used to be the last row of a twelve-row table, under luggage and payment policy.
- **The twelve-row table is now what it always was**: vehicle, booking mode, gender policy, payment policy, luggage,
  arrival estimate — facts, not the pitch.
- The preview banner on this page was unconditional too; it now asks whether a backend is configured.

**Deliberately not done here**

- `[~]` **Map on the trip page.** There is no tile server and no browser in the sandbox to judge one; a broken map is
  worse than a stop list that renders everywhere.
- `[~]` **Filter counts that update without a page load.** They are correct, just server-rendered; making them live
  is a client island with a cache to invalidate, and the page works before JavaScript today.

## 1. Home — what changed

**Structure, top to bottom**

1. **Hero** — an eyebrow that describes the product (*حجز مقاعد بين المحافظات*), a headline about the traveller's
   trip, the search form, then three trust lines instead of three test statistics. The aside is *أقرب الانطلاقات*:
   up to three real departures with time, seats left and price, linking to the trip.
2. **Trips you can book now** — up to six real `PublicTripCard`s from `search_public_trips`, sorted featured. Empty
   means an honest sentence, not a fake card.
3. **Popular destinations** — the destination facets the search function already computes, as chips with counts.
   Hidden entirely when there is nothing to show.
4. **How booking works** — three steps: search, book and pay, travel and follow.
5. **Know the price before you book** — the fare calculator, kept, because it is a real feature, with its dev-facing
   caption replaced by the passenger's question.
6. **Operator band** — the one place the product speaks to a supply-side visitor, in their words.
7. **For teams** — the consoles, as one quiet row of links, no phases, no `قريبًا`.
8. **Footer** — brand, three link groups (travel / platform / information), a rights line.

**Deliberately not done here**

- `[~]` **A marketing hero image or illustration.** Generated art on a travel home page is a taste decision for the
  owner, and a placeholder gradient would be worse than the current token-driven gradient.
- `[~]` **Testimonials / passenger counts.** There is no data behind either. Inventing them is the `367` mistake
  again with a friendlier face.
- `[~]` **Dark-mode redesign.** The tokens already flip; the audit is a pass of its own.

**Verification** — `npm run check:all` (guards, lint, format, types, 669 tests), `npm run check:a11y` over every route
including both locales of the home page, and the rendered HTML read back with the tags stripped, because a home page's
job is its text.

## 9a. The staff console — what changed

Six screens read as six apps. The defects, in the order they were found by reading the rendered HTML as a supervisor:

| What it did | Why it is wrong |
| --- | --- |
| Every page hand-wrote its own `items` array: overview seven links, dashboard/scanner four, trip review three, verifications two — one of them *Account* | The sidebar changes shape as you move, so nothing is where you left it. From vehicle review you could not reach verification review without going back through the hub |
| `<Badge>` `المرحلة 7` on the dashboard, `4` on trip review, `3` on vehicles, `1` on verifications | Build bookkeeping shown to the person doing the work — and it could not even agree with itself |
| The sidebar heading, the `<h1>` and a nav link all came from the same string (`مراجعة التوثيق` three times on one screen) | A sidebar that repeats the page title reads as a breadcrumb of itself |
| `aria-current` was styled in `globals.css` since the first console and never set | The one affordance a console has — *where am I* — was missing on every screen |
| The vehicles page linked `staff.queue` ("Queue") to `/staff/verifications` | A link that names one thing and opens another |
| Dashboard: `0 · 0 · 0 · 3`, a bulk panel saying "no requests in this list", and "no scans yet" | Four zeroes with no door to the queue behind each, no way to tell *nothing is waiting* from *nothing loaded*, and no idea how fresh it was — on the screen whose only job is "what needs me now" |
| Every empty state repeated the page subtitle | The states a launch always hits, written as an afterthought |
| `/staff/scan`'s `<h1>` said *Check a trip* while the nav called it *Scan*, and a `visually-hidden` `<h2>` repeated the `<h1>` | One screen with two names and its title announced twice |

**What changed**

- **One navigation, defined once** (`components/staff/StaffNav.ts`), grouped the way a shift thinks: *Work* (overview,
  dashboard, scan), *Review queues* (trips, verifications, vehicles), *Reference* (places). Used by all six screens.
- **`ConsoleShell` now knows where it is.** It takes a locale-less `pathname`, marks the matching link with
  `aria-current="page"`, and names the console (`consoleTitle`) separately from the page (`title`). The phase badge is
  gone from the shell and from all 41 console pages that used it.
- **The dashboard is a dashboard.** A clear-state line when the queues are empty (a supervisor's best morning, said
  out loud); four figures, each a door into the queue that produced it; the patch named (`لحج · عدن · حضرموت`) instead
  of counted; an "updated 01:22" stamp; the bulk panel and recent scans as titled bands with a way into the full list.
  The verification figure is a **real** count (`verification-queue` → `queue.list`, the same read the queue page uses)
  and prints **—** rather than `0` when the count cannot be read.
- **Every empty state names its queue and offers the next step** — verifications, vehicles, trip search, the bulk
  panel — and the trip review's quiet-day answer is a card, not a footnote.
- **Trip review**: the filter block became a titled card (*Find a trip*) with the "includes drafts and cancelled trips"
  hint at its top instead of a bare grid floating under the panel edge; a zero count no longer prints a line that the
  empty state then repeats.
- **The scanner** takes the nav's name (*Scan a trip*) and keeps the sentence for its subtitle, which no longer repeats
  the field hint word for word.
- **`/staff`** is five tiles that answer a question each, whole-card links (a thumb should not have to find a button),
  the two queues the console exists for first.

**Found while running the gates, not part of the console** — `supabase/migrations/00045_subscription_invoice_period.sql`.
`invoice_subscription_period_uq` was a unique index on `(subscription_id, due_on)`, and `due_on` is derived from the
period start, so a renewal on the day a subscription started produced the same key: `app.issue_subscription_invoice`
deduplicated on it and returned the invoice for the **previous, already-paid** period, billing nothing. The 0015 suite
only caught it in runs that began just after midnight in Asia/Aden. The index now sits on a real `period_start` column,
backfilled from the snapshot every period invoice already carried, and a pgTAP assertion states the property directly.

**Verification** — `npm run check:all` (676 tests ×2, 45 migrations, 986 → 987 pgTAP assertions), `npm run check:a11y`
111 routes, `npm run check:responsive`, `npm run dev:check`, and all six screens read back from the live server with the
tags stripped, in Arabic and English, as `staff@maak.test`: exactly one `aria-current="page"` per page, no phase badge,
no stuttered titles.

**The horizontal scrollbar (found on a phone, same day)** — `/staff/scan` scrolled sideways on a 390px screen, and
the cause was two lines of CSS, not a wide element:

- `.console-layout` is a grid with no `grid-template-columns`. The implicit column is `auto`, whose *minimum* is the
  content minimum — and its first child was a row of `white-space: nowrap` nav chips. The track became as wide as the
  whole chip row, so the panel beside it was laid out at that width and ran off the screen. It is now
  `grid-template-columns: minmax(0, 1fr)`, with `min-inline-size: 0` on the shell's grid children.
- `.console-nav` was a horizontal scroller pushed to the screen edges with `margin-inline: -16px` — 32px wider than a
  container that has no padding of its own — and it cut the last destination off with no hint that it scrolled. On a
  phone the chips now **wrap**, so every destination is visible and nothing scrolls sideways.

The same audit removed four more ways to make a document wider than the screen: 57 bare `<n>fr` tracks across the
stylesheet (a bare `1fr` cannot shrink below its content), `inline-size: calc(100% + …)` on the fleet chip row, two
`100vw` widths (which count a scrollbar the page does not have), and every horizontal scroller that did not cap itself
with `max-inline-size: 100%`. `scripts/check-responsive.mjs` gained four rules so none of them can come back: no bare fr
tracks, no shrinking-less layout container, no fixed width above 360px without a cap, no horizontal scroller without a
cap, and no `100vw` in a width.

**Deliberately not done here**

- `[~]` **A `overflow-x: hidden` band-aid on `body`.** It hides the symptom and makes the next overflow a cut-off card
  instead of a visible bug. The guard is the fix; if a page still scrolls sideways, it is a rule the guard does not
  know yet, and it should be added there.
- `[~]` **Live refresh of the dashboard figures.** They are correct at render time and the page says when that was;
  a polling island is a cache to invalidate and a decision about what "live" means for a supervisor.
- `[~]` **Bulk verification for vehicle documents.** The trip queue has it; the vehicle queue is one decision at a time
  because each record needs its documents opened. A bulk approve there would be a button that means "I did not look".

## 9c. The admin console — what changed

Asked for by the owner, in their words: *"I do not want nested cards, it takes a lot of space with no meaning."*

| What it did | Why it is wrong |
| --- | --- |
| `<section class="card console-panel">` wrapped every console page, and each screen put its own cards inside | Two borders, two paddings and two shadows around one piece of content; 24px of chrome on each edge for nothing. On `/admin/regions` that was three cards inside a fourth |
| Five screens, five hand-written nav lists, none the same — and plans/subscriptions swapped in a list pointing at `/finance/invoices` and `/finance/payouts` | Which destinations you could see depended on where you already were; two of them left the console |
| The hub was two tiles, one of them *"this screen is under construction — you will see it working in the phase mentioned above"* | A phase badge that no longer exists, and an apology where a link should be. Plans had shipped two phases earlier |
| `.data-table th` styled **every** `th`, including `<th scope="row">` | The cell holding a record's own name was rendered at 0.74rem in muted grey, uppercased in Latin tables — a header rule applied to the data |
| `/admin/subscriptions` printed `owner_org_id` | `aaaaaaaa-0000-4000-8000-000000000001` in the "Operator" column names nobody and is not a thing a person can search |
| The same, in the places queue: `submittedBy` | A 36-character UUID beside a place name |
| A button that opened the plan editor was labelled **Save** | The label described the wrong verb, so the row read as an action already taken |
| Section headings repeated the page title (`Plans and limits` twice, `Subscriptions` twice) | The heading of a section should say what the section *is*, not what the page is |

**What changed**

- **The console shell is a page, not a card.** A header band (title, one sentence, the page's action), a hairline, then
  the content in one column divided by rules. `.console-panel` remains for the account screens, where it is a card on a
  page of cards; the shell no longer uses it. `npm run check:responsive` now fails if a `card`/`console-panel` class
  reappears in the shell — reverse-verified by putting it back.
- **Sections, not boxes.** A new `.console-section` primitive: heading, hint, table or list, no border, a hairline
  between siblings. `PlaceConsole`, `RegionConsole`, `SupervisorPanel` and the staff bulk panel moved from
  `class="card"` to it, so the page has one frame — the window.
- **One navigation for the admin console** (`components/admin/AdminNav.ts`), grouped *Platform / Geography / People /
  Money / Operations*, used by all seven screens; `adminMoneyNav` is deleted.
- **The hub is an index**: every destination as a row — name, what is behind it, an arrow — grouped by subject, two
  columns on a wide screen. No cards, no placeholder, no phase.
- **Tables**: only `thead` gets the small-caps header treatment; row headers keep the record's own type; the header row
  has the muted band; rows have a hairline and a hover. `.data-table` is shared, so every console table inherits it.
- **Names where names belong**: subscriptions resolve `organizations.name` / `profiles.full_name`, the places queue
  resolves the submitter, and the fallback is an 8-character monospace id (`#aaaaaaaa`), not a UUID.
- **Copy and hierarchy**: plan rows say *Edit*; section headings are their own words (`The region tree`, `Plans and
  prices`, `Live subscriptions`); `/admin/users` is titled what the nav calls it; the notifications screen is
  *Alert templates* in both places instead of a 30-character sentence in the sidebar.
- Inline `style={{ … }}` in these components became four classes (`.unit-title`, `.unit-meta`, `.console-subhead`,
  `.row-actions`) — the design system was living in JSX where it could not be themed or found.

**Verification** — `npm run check:all` (676 tests ×2, 45 migrations, 987 pgTAP assertions), `npm run check:responsive`
(65 media queries, the new card-in-card rule), `check:guards`, and the a11y sweep over every route in both directions.
All seven admin screens were read back from the live server with the tags stripped, in Arabic and English: zero
`.console-panel`, zero `card` in a console body, one `h1` per page, no repeated headings. No browser in this sandbox,
so this is HTML-and-CSS-level verification, not a screenshot.

**Deliberately not done here**

- `[~]` **Sticky console sidebar.** It is the right answer for a long table, and it needs a scroll container and an
  offset measured against the sticky site header — a layout change to make with a browser open.
- `[~]` **Dark-mode audit of the new surfaces.** The tokens flip, but the new hairlines and the muted table header were
  chosen against the light theme.
