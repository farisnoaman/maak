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
| 3 | Trips list (`/trips`) | Strong already (filters, keyset paging, facets) — but nothing showed *what* was filtering, sort was hidden in the panel, and the "no database" banner appeared over real data | `[x]` — visuals in §13 |
| 4 | Trip detail (`/trips/[code]`) | The fare was the twelfth row of a table, below the luggage allowance; the reserve button was at the very bottom | `[x]` — visuals in §13 |
| 5 | Booking + pay (`/book`, `/pay`) | Two flows that work; the pay screen is the one people screenshot when it goes wrong | `[x]` — §15 |
| 6 | Account (`/account`) | Lists are correct, hierarchy is flat — "next departure" should be the first thing | `[x]` — §16 |
| 7 | Auth (`/auth/*`) | Fine, but the sign-in form is the last place a person should meet jargon | `[x]` — §17 |
| 8 | Operator console | Dense tables are right for the job; the **overview** answers nothing at a glance | `[x]` — §18 |
| 9a | **Staff console** (`/staff`, dashboard, scan, verifications, vehicles, trips) | The same five screens under five different sidebars; a phase number above every title; four zeroes and two empty boxes as the dashboard | `[x]` |
| 9b | Finance console | Same: correct, unranked | `[x]` — §19 |
| 9c | **Admin console** (`/admin` + 6 screens) | Two frames around every screen (a card inside a card), five different sidebars, a hub whose second tile apologised for a phase that no longer exists, and UUIDs printed where names belong | `[x]` |
| 9d | Admin — coverage (`/admin/regions`) | A card per region, the hierarchy written out as a sentence, an editor that starts below its own heading, and 22 governorate chips at field width | `[x]` — §20 (flat: table + editor view) |
| 10 | Mobile shell (`apps/mobile`) | Mirrors the same problem: the home screen is a list of links, one of them labelled *المرحلة* | `[ ]` |
| 11 | Empty / error / loading states | The states a demo never shows and a launch always hits | `[x]` — §21 |
| 12 | Console navigation on a phone | Nine destinations wrapped three rows deep above every page title; no way home on a desktop | `[x]` — §21 |
| 13 | **The design layer** — type, accent, header, states | Four identical grey links, no current page, 404s that were not pages, Latin tracking in Arabic | `[x]` — §21 |
| 14 | Marketplace filter panel (`/trips`) | A sidebar with no title, a phone panel that stayed open over the results it had just produced, *Clear* with nothing to clear | `[x]` — §22 |
| 15 | **Staff desk** — trip detail, trip review queue, scan | A trip page that opened with its own code, a review box below the fold, a scanner whose idle state was a blank half-page, a queue whose filter had no fieldset names | `[x]` — §23 |
| 16 | **Admin money and reference** — subscriptions, plans, alert templates, places | Two bare tables with no totals, a plan's eight limits joined into one sentence-cell, 37 template rows and no way in, a rejection-reason field on every queued place | `[x]` — §23 |
| 17 | The skin itself | Warm direction chosen and applied once, as tokens and control rules, rather than page by page | `[x]` — §22 of the stylesheet |
| 18 | `/admin/places`, again | Eleven fields standing open under the queue on every visit, a submission rendered as two runs of text glued with `·`, and two badges that said nothing | `[x]` — §24 |

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

## 12. The visual layer — the foundation pass

The queue above fixed *what* each screen says. This pass is about *how it looks while saying it*, which the product had
never decided at all: there was no icon set, no type scale, and no typeface.

| What it was | Why it is wrong |
| --- | --- |
| Marks were characters: `◆` as a bullet, `✓` as a tick, `→` as a route, `⌄` as a chevron, `☰` as the menu | A character takes the body font's weight and sidebearings, sits on the text baseline instead of the optical centre, changes shape with the fallback face, and cannot say "close" when the menu is open |
| Every font-size was written where it was used: `clamp(1.35rem, 2.6vw, 1.75rem)` here, `1.05rem` there | No scale, so nothing was consistently bigger than anything else; a section title and a card title could swap ranks |
| `--font-arabic` named Cairo first, but Cairo was never loaded | Every Arabic screen rendered in the operating system's fallback — Tahoma on Windows — at a `line-height` chosen for Latin |
| Three "how it works" steps were three bordered boxes | Three boxes read as three things to choose between; a sequence reads as a rule and a number |
| The hero had a radial gradient and one typographic line of defence | The product sells a line between two points and had none of that on its front page |

**What changed**

- **Self-hosted variable fonts.** `@fontsource-variable/cairo` and `@fontsource-variable/inter`, imported once in the
  locale layout, subset by `unicode-range`. No third-party request on first paint, no `next/font` build step, and the
  fallback chain still ends somewhere sane. `--leading-ui` is set per direction: 1.8 for Arabic, 1.65 for Latin.
- **A named type scale** (`--text-2xs … --text-3xl`, `--leading-tight … --leading-ui`) in `tokens.css`, with `h1`–`h3`
  landing on it by default rather than inheriting 16px and being fixed up per page.
- **`Icon`** — 20 paths, one grid, one stroke, `currentColor`, no dependency. `DirectionalIcon` now draws a chevron
  instead of writing `›`, and still flips through `--icon-flip`. The styleguide enumerates the set from the component.
- **`HeroField`** — contour rings and one dashed route with two stops, drawn in SVG and `aria-hidden`. Decoration that
  is honest: it is the shape of the product's subject, not a photograph of a place the trip does not visit.
- Home: trust marks differentiated by icon rather than three identical ticks, destination chips carry a pin, the trip
  card's `→` became a stroked arrow in a disc, the departure rows in the hero aside match it, and the menu button draws
  its own glyphs and changes to *close* when open.

**Why no photography.** A marketplace with no real photos of its own routes cannot borrow stock: an image of a
coastline that is not the one the trip crosses is a small lie told on every page load. The drawing costs bytes and
tells the truth.

**Verified** — `tsc`, `check:responsive` (66 media queries), `check:guards`, and the a11y sweep in slices over
`/trips`, `/ar`, `/admin`, `/staff`, `/styleguide` (all pass). Fonts and icons were confirmed in the served CSS and
markup rather than by eye: 4 Cairo and 8 Inter `@font-face` rules in the stylesheet, 12 `ui-icon` nodes on the home
page. **Still HTML-and-CSS-level verification** — this sandbox has no browser, so nobody has looked at the result.

**Next in this layer** — the screens whose layout has not been revisited for looks at all: `/trips` (the card grid and
filter rail), `/trips/[code]` (the itinerary and the fare panel), then §5 booking and pay.

## 13. The marketplace, drawn

§3 and §4 fixed what these two screens *say*. This is the pass that made them look like the product.

**The result card is a ticket, not a tile.** It was a stack: a row of badges, the route, one grey meta line
(`Sat, 14 Nov · 06:30 · 12 seats · Al-Noor`), a price and a button, all with the same weight. The departure time — the
thing a timetable is sorted by, and the reason the page exists — was the third most prominent fact on it.

- The time now has its own edge, the way a ticket has it: large, tabular, with the date under it, separated from the
  rest by a **dashed tear-line**. The remaining facts (seats, operator) are a quieter line below the route, separated
  by a middot drawn in CSS so it follows the reading direction.
- The shadow is gone. Eight shadowed cards on a page are eight shadows competing; a hairline does the work and the
  card lifts on hover/focus instead.
- Home uses the same card, so the three "next departures" gained the same edge.

**The filter panel is an argument, not a form.** Nine labelled controls stacked in a column, all the same size. They
are now three named groups — *Route*, *Ride conditions*, *Date and fare* — each a `<fieldset>` with a `<legend>` (so
the grouping is real to a screen reader, not just a heading), separated by a rule. The disclosure's chevron was
`content: '⌄'`, a character in a pseudo-element where it can never be an icon; it is two borders rotated 45°, which
also mirrors correctly in Arabic.

**Chips**: the remove mark was `✕` — a character again. It is the icon, in a disc that fills on hover, and the chip's
growl still carries the accessible name ("remove filter …").

**The trip page**: a back link at the top, where a reader arriving from a shared link needs it (there was one at the
bottom only); the route is the page title at page-title size with a drawn arrow; the fact list is a table with a
hairline per row instead of eight floating pairs; the itinerary has a **rail** joining the numbered stops, so it reads
as a route and not as a list; the fare panel's price is on the display scale and the seats line carries a seat mark;
the article widened from 48rem to 58rem so the 320px fare panel is not floating in dead space on a desktop.

**Verified** — `check:all` ✓ (676 tests ×2, 45 migrations, pgTAP, guards 32/185/45/135), `check:responsive` ✓
(68 media queries), a11y sweep ✓ over `/en/*` and `/ar/*` (60 and 63 routes). Rendered and read back: three grouped
sections and three filter legends on the list in both locales, the time edge on every card, the chip icons, the back
nav, 14 fact rows and the six-stop rail on the detail page. No browser here, so this is markup and CSS.

**Next** — §5 booking and pay, then §6 account.

## 14. Who is driving, and what the route looks like

The trip page named the operator and the vehicle and stopped there. The one fact a passenger needs at the door —
**who is picking me up** — was not on the page, and could not have been: `get_trip_public` dropped `driver_id`.

**The driver, with a privacy line drawn deliberately.** `00046_public_driver.sql` adds a `driver` object to the public
payload containing exactly two things: a first name (`split_part(full_name, ' ', 1)`) and whether the licence is
verified. The function is `security definer` and reachable by trip code from an unauthenticated page, so everything else
in `driver_profiles` — the invited phone number, the licence number, the licence photo path — stays out of it. A pgTAP
assertion checks the payload does not contain either of those values, so the boundary is a test and not a comment.

The page shows it as a **"Vehicle and driver"** block beside the fact table: an avatar, the driver's name, a *Licence
verified* chip, the vehicle label with its seat count spelled out ("14 seats in the vehicle", not a bare `14`), and only
the amenities the vehicle actually declares — an un-ticked box is not a feature, so an unchecked amenity is not rendered
rather than shown greyed out. `trips.vehicle` left the fact table, which keeps the same fact from appearing twice on one
screen. When no driver is assigned the block says so in a sentence instead of showing an empty value.

**The itinerary, not a list of stops.** The stops section was the intermediate stops alone — numbered, named, with
"after 240 min" and a price — so "the itinerary" was three places between two others, with no clock time and no
terminals.

- It now runs **start → stops → destination**. The start carries the departure date and time; each stop carries the
  **clock time you reach it** and the fare from the start; the destination carries the **estimated arrival**. The times
  are derived from the departure the payload already carries, through the same `departureLabel` the header uses, so the
  itinerary and the header cannot disagree about the day or the timezone.
- A **rail** joins the nodes, brand-coloured behind the start, so the shape says "a line between two points" rather
  than "a list".
- A trip with no intermediate stops says so, in the same rail, instead of disappearing: the destination is still a node.
- Both locales render it; the rail is logical-property positioned, so it sits on the right in Arabic without a second
  rule.

**Verified** — `check:all` ✓ (676 tests ×2, **46 migrations**, pgTAP 122 assertions in the trips suite, guards
32/185/46/135), `check:responsive` ✓ (70 media queries), a11y sweep ✓ over `/ar/*` (63 routes) and every `/en/*` slice
(trips 13, account 19, operator 25, staff 19, admin 18, finance 21) — the full English sweep still OOMs this sandbox's
2GB dev server, so it runs in slices and each slice is reported. Read back from the live server, both locales: the crew
block shows `خالد · Licence verified · Toyota Hiace 2019 · 14 seats in the vehicle · Air conditioning · USB charging`,
and the itinerary reads `عدن — Departs · Wed 4 Nov · 07:24`, `07:24 · YER 5,000`, `11:24 · …`, `15:24 · …`,
`صنعاء — Arrives (estimated) · 15:24`.

**Not done here** — a driver photo (there is none in the schema, and an operator-uploaded portrait of a driver is a
privacy decision for the owner, not a layout decision), and showing the driver's phone number (that belongs behind a
confirmed booking, not on a public page).

## 15. Booking and pay

Two flows that worked and read as forms. Both were single columns of inputs whose only context was a code in the
heading.

**Booking (`/trips/[code]/book`).** A passenger arrives here from a search result or a shared link, and the page asked
them to remember which trip, which day and which vehicle: the heading carried `BK-…`-style codes and nothing else.

- **Fields on one side, the ticket on the other.** From 940px the summary is a sticky panel; on a phone it follows the
  fields, which puts the price and the button exactly where a thumb arrives at the end of the form.
- **The ticket restates the trip**: route, date and time, the vehicle, the driver's first name, and the seats in the
  vehicle — the facts the passenger agreed to when they opened the page. It then shows the live breakdown and the
  total on the display scale, with the reserve button under it.
- **Seats are a stepper**, two 44px buttons and a number, not a `<input type="number">` with spinner arrows a thumb
  cannot hit; the count is an `<output aria-live>` so a screen reader hears the change.
- **Getting off is a list of the trip's own stops**, each with the clock time and the fare from the start, instead of a
  `<select>` — a dropdown hides the fare and the arrival time of every option but the chosen one, which is exactly the
  comparison being made.
- **Fields are grouped**: *Who's travelling* and *Contact details*, with a rule between them.
- **The confirmation panel** puts the booking code in a dashed box at display size in a monospace face, `user-select:
  all`: it is the one thing they will be asked for at the desk, and it gets read out, copied, or typed by somebody else.

**Pay (`/pay/[intent]`).** It was one card of `<dl>` rows with the amount in the middle of them.

- **A page, not a card**: header band (title, status badge) → amount → where the money goes.
- **The amount is the size of the thing it is** (`--text-3xl`), with booking, method and reference under a rule. Its
  label changes with the state: *Amount due* while it is owed, *Amount paid* once it is confirmed — and the "transfer
  it, then attach the receipt" subtitle only appears on a payment that is waiting for one.
- **The account number is large, monospaced and direction-locked** (`dir="ltr"`), because it is read aloud and typed
  into another app by somebody who is not looking at this screen.
- **Progress is three steps, not a status word**: *Payment requested → Send the receipt → The company confirms*, done
  / current / todo, with `aria-current="step"` on the one that is waiting. "Waiting for confirmation" is accurate and
  tells a passenger nothing about whether *they* still have to do something, which is the only question the screen
  exists to answer. A rejected payment turns its own step red.
- Instructions moved to the side column with the progress, so the phone order is amount → account → upload, which is
  the order of the job being done in a shop.

**Verified** — `check:all` ✓ (676 tests ×2, 46 migrations, pgTAP, guards 32/185/46/135), `check:responsive` ✓ (74 media
queries), a11y ✓ over `/trips*` (29 routes, including every discovered `/book` page). Both screens were rendered as a
signed-in passenger in both locales: the booking page shows one `.booking-layout`, two grouped sections, one stepper,
four stop options with times, and a summary carrying `Aden → Sana'a · Wed, 4 Nov · 07:24 · Toyota Hiace 2019 · خالد ·
14 seats in the vehicle · YER 5,000`; the payment page was rendered in **both** states — confirmed, and
`awaiting_proof` after temporarily flipping the dev row (then restored) — showing the upload form and the step states
`done / current / todo`.

**Gap, stated plainly**: `/pay/[intent]` is not in the a11y sweep's route list, because the route needs a real intent id
and the seed creates them with random ids. It was checked by rendering both states, not by the automated sweep. Adding
it needs the sweep to discover a payment link for the payer, the way it already discovers trip codes.

## 16. Account

The hub was a stack of equal cards: profile, companies, notifications, every console link in the platform, and a
delete button, all the same size. The order answered "what is in the account" and nobody opens this page to ask that.

- **Who you are, as a band.** Avatar initial, name, email (`dir="ltr"` so it does not scramble inside an Arabic page),
  the identity document type, and the two document doors — verification and licence. A rule above and below instead of
  a card, because it is one fact about the person, not a panel of settings.
- **The next journey is the first block.** `nextJourney` is the soonest booking that has not departed and is still
  `pending`/`accepted`. It carries route, date and time, the booking code, the seat count, the total, the status badge,
  and one primary door into the booking. A passenger opens `/account` to look up a trip they have already paid for;
  that used to be two clicks away under a heading called *Bookings*.
- **When there is nothing ahead, the page says so** — "No upcoming journey" with one sentence and a *Find a trip*
  button, instead of an empty section that looks broken.
- **Companies are rows in one frame**, not a grid of cards (a card inside a page section read as a box inside a box).
  Each row: mark, name, *Current* pill on the organisation the page is scoped to, role · plan, and its two doors on the
  far edge. A company that is not yet verified shows its badge here; a verified one does not, because a row that
  repeats "verified" on every visit is decoration.
- **Consoles appear only if the session can open them**: `/operator` when the person belongs to an organisation,
  `/staff` and `/admin` from the platform roles, `/finance` for staff or admin. The page used to offer everybody the
  verification queue and the roles screen, which answer 403 to a passenger — a door onto a refusal is worse than no
  door. A passenger sees no console block at all rather than an empty heading.
- **Deleting the account is the last block and the only bordered one**, on the muted surface: the one control on the
  page that ends things should look like it.

**Fixed on the way, because the hub exposed it.** `loadMyBookings` read *every booking the caller may see*, and RLS is
deliberately wider than "mine": a driver assigned to a trip may read the bookings on it. A driver account therefore
found a stranger's seat, price and reference under *My bookings* — and the new hub promoted it to *Your next journey*.
The web and mobile readers now filter on `passenger_id`, which is the row's own answer to "is this mine" (the booking
command already sets `booked_by = passenger_id =` the actor).

**Verified** — `check:all` ✓ (676 tests ×2, 46 migrations, pgTAP, guards 32/185/46/135), `check:responsive` ✓ (73 media
queries), a11y ✓ over `/account*` (28 routes). Rendered both locales as four different accounts: `owner@` (journey card
with `BK-525DA6`, one company row marked *Current*, one console door), `staff@` (four doors, no operator row),
`admin@` (same four), `driver@` (empty next-journey state, **no console block**, and no foreign booking — the scoping
fix above). The Arabic page keeps `dir="rtl"` and mirrors the row edges through logical properties.

**Gap, stated plainly**: there is no browser in this sandbox, so phone-width overflow, the sticky/stacked behaviour of
the journey card, and the RTL mirroring were checked by reading the emitted markup and CSS plus `check:responsive`, not
by looking at a screen. The user's preview is the first place they are seen.

## 17. Auth

Two screens, and one of them did not exist. The sign-in page was a 440px card in the middle of an empty page: no
header, no way back to the marketplace, and under it a line that read **New here? Create account** whose link pointed
at `/auth/sign-in` — the door opened onto itself. A new passenger had no way to become one.

**What the page is now.** The form on the near side, and a column that says what is behind the door: *your next
journey*, *your booking code*, *your company*, then a way out — *Browse trips without an account*. Those three are
things the product already does, not promises. From 900px the second column sits on its own rule; on a phone it
follows the form, because it is reassurance, not navigation. There is no card: the form is the page.

- **Two ways in are two links**, not `role="tab"` anchors inside a `role="tablist"` with no tabpanel anywhere. The old
  markup told a screen reader that two panels existed and that arrow keys moved between them, and the stylesheet only
  styled `button[aria-selected]` — so the "selected" tab looked exactly like the other one. `aria-current="page"` on
  two links that load two URLs is both truthful and visible.
- **The password can be read.** A reveal toggle beside the field (`aria-pressed`, label flips with the state). Typing a
  long password blind on a phone keyboard is the most common reason a first sign-in fails.
- **Errors are a band above the form**, in the danger tone, not a paragraph of grey.

**Registration (`/auth/sign-up`) is new.** Three fields — name, email, password — because that is everything
`app.handle_new_user` needs; the phone, the identity document and the company are asked for where they are used. It
posts to `/api/auth/sign-up`, which does the same thing the sign-in endpoint does: `signUp` on the server, the cookie
written on the redirect, no JavaScript in the submit path. If the project has confirmations on, `signUp` returns no
session and the page says *check your email*; pretending to sign someone in and bouncing them off `/account` is how
that becomes a support ticket. A signed-in visitor is sent to their account instead of being shown a registration form.

**A CSRF hole found on the way, and fixed.** `isSameOriginRequest` accepted **any** `Origin` when every host the server
could see was loopback — which is every request on a dev server, and the preview proxy whenever it does not forward the
host. A form on `https://evil.example` could therefore create an account, or sign a visitor in to the attacker's
account so that their next booking landed in it. The check now reads `Sec-Fetch-Site` first — a header a page cannot
set — and rejects `cross-site` outright, accepts `same-origin`/`same-site` as the browser's own testimony, and keeps
the loopback escape only for browsers that send no fetch metadata at all (Safari < 16.4), where it logs. Reproduced
before the fix with a `curl` post carrying `Origin: https://evil.example`, which created a user and 303'd to
`/en/account`; after it, the same request 303s to `?error=origin` and nothing is created.

**A test file that had never run.** `apps/web` had no `test` script, so `src/lib/__tests__/legal.test.ts` was outside
`npm test` and never executed. `@maak/web` now runs vitest, and `origin.test.ts` was written for the CSRF cases above
(8 assertions, including the legacy-browser branch that remains).

**Verified** — `check:all` ✓ (691 tests: 676 in `@maak/core` ×2, 15 now in `@maak/web`; 46 migrations, pgTAP, guards
32/189/46/135), `check:responsive` ✓ (74 media queries, 9 tap targets — the method links and the reveal button added),
a11y ✓ over `/auth*` (both locales, both pages). Rendered in both locales: sign-in with the email tab, the phone tab,
and the code step; sign-up in the form state, the *check your email* state, and with `error=exists` / `weak` / `origin`.
A real registration was posted through `/api/auth/sign-up` and the profile row came out of the trigger with the right
name and `preferred_language`, then the throwaway users were deleted; duplicate email, short password and cross-site
posts each returned their own error.

**Gaps, stated plainly**: there is no password reset. The dev backend implements no `/auth/v1/recover` and the stack
has no mail catcher, so a reset flow could not be verified past its first screen — building it and calling it done
would be exactly the kind of unverified claim this file exists to avoid. It also needs mail delivery before it means
anything. The phone OTP path was rendered but not completed end to end (there is no SMS provider locally). The mobile
app's `sign-in.tsx` is untouched: it is not a public page in the web app, and parity is its own job.

## 18. Operator overview

Scope of this slice: `/operator` only. The tables behind it (trips, vehicles, drivers, payments) are dense on purpose
and were left alone — the plan's complaint was the **overview**, and that is what changed.

**What it was.** Five identical tiles, each with an `Open` button and a note that repeated the page you were about to
open. It answered *"what screens exist"*, which the sidebar answers three inches to the left, and it said nothing about
the trips, the money or the people waiting. On a phone, between two departures, it was five taps of nothing.

**What it is now.** Two questions, in the order an operator asks them.

1. **What needs me before I go out again.** Four figures, each a door to the queue behind it:
   *booking requests*, *receipts to confirm*, *vehicles awaiting review*, *drivers awaiting review*. The requests
   figure names the trip they are on and links straight into that trip's inbox, so "1" is one tap from the person
   waiting. A non-zero figure gets the warning edge; **when all four are zero the grid is not rendered at all** and one
   sentence says it instead — four zeroes under a sentence that already says "nothing is waiting" is the same answer
   twice.
2. **What am I running next.** The next four published departures: clock time in its own edge (the fact the list is
   sorted by, so it gets the weight), route, vehicle and trip code, seats taken with a fill bar, and a flag on the row
   that has people waiting to be accepted. A list, not cards — one frame, rows inside it.

Below both, the console's screens are a **framed list of doors** — icon, name, one line about what is behind it — rather
than five tiles. That block is now shared with the account hub (`6.`): `.doorlist` / `.door` replaced
`.account-consoles` / `.account-console`, so one list style exists instead of two that drift.

**Three decisions worth writing down.**

- **The overview is not scoped to one context.** `/operator/trips` makes you choose (personal by default, `?org=` for a
  company), which is right for a list you are editing and wrong for a summary: a screen that says "nothing is waiting"
  while a company trip has three requests is worse than no summary. The overview covers everything the account can act
  on, and when the list mixes owners each row names its company; when every trip belongs to one company the name is
  said once, beside the heading, instead of on all four rows.
- **Requests are counted across every upcoming trip**, not only the four that fit on screen. The figure is a claim
  about the whole account, so it has to be the whole account — and only `pending` rows count, because accepted seats are
  already inside `seats_available` and counting them twice is how a dashboard starts disagreeing with the page it links
  to. `loadTripRequests()` is one query for the set of trips, not one per trip.
- **A driver's own licence is not a queue item.** The first version counted any pending driver profile whose account
  was mine, so a driver signing in saw "Drivers awaiting review 1" — a number they could do nothing about. The queue is
  the company's drivers plus the ones invited by phone (no org, no account); never your own profile.

**Verified** — `check:all` ✓ (692 tests: 677 core ×2 + 15 web, 46 migrations, pgTAP, guards 32/189/46/135),
`check:responsive` ✓ (76 media queries, 11 tap targets — the door rows and departure rows added), a11y ✓ over
`/operator*` (40 routes, both locales). Rendered both locales as `owner@` and as `driver@`, in **both data states**: the
seed's quiet state (one clear sentence, three departures) and a fabricated busy state — booking flipped to `pending`,
receipt to `awaiting_confirmation`, a vehicle and a driver to `pending` — which produced four warning figures
(`1 / AD-TA-BCBD`, `1`, `1`, `1`) and a "1 waiting" flag on the right departure. The dev rows were restored to their
seeded values afterwards and re-rendered to confirm. Links were read back: `/operator`, `/operator/trips`,
`?status=published`, each trip's own page, `/operator/vehicles`, `drivers`, `payments`, `payouts`, `trips/new`.

**Gaps, stated plainly**: no browser here, so the phone layout (rows stacking, bar hidden below 720px, the RTL mirror
of the time edge) is read back from the emitted markup and CSS plus `check:responsive`, not seen. The four figures have
no "could not read" state — the loaders return an empty list on error, so an outage would render as "nothing is
waiting" rather than "could not check". The staff dashboard solved that with `null` vs `0`; the payments and fleet
readers do not expose the difference yet, and inventing it here would have meant changing four loaders in a slice
about one screen. The timestamp beside the title is the honest mitigation until then.

## 19. The finance console

Scope: the money desk — `/finance/{dashboard,ledger,statements,invoices,payments,accounts,agents,payouts,reconciliation}`.
The tables and the command forms behind them were already correct; this slice is about what a person sees first, and
about two defects the polish exposed.

**What it was.** The dashboard opened with a subtitle, then ten equal figures in two card grids: commission,
subscription revenue, refunds and payouts at the same weight as profit, and the one number the desk exists for — *what
did the platform make* — nowhere in particular. Below that, a balances table printed the journal's raw account codes
(`platform_bank`, `operator_payable`) and a `Difference` column, which is a bookkeeping check, not an answer. Invoices
repeated its own page title as a section heading, then repeated the subtitle, then printed a balance in a sentence;
agents, payouts and reconciliation each printed their subtitle a second time under the heading. Reconciliation listed
its rails as enum values: `jaib`, `kuraimi`, `tadhamon`, `cash_desk`.

**What it is now.** The dashboard leads with **profit** at display size, red when it is negative, beside the period it
covers as a stamp in the section head (`Nov 1, 2026 → Nov 2, 2026`). Next to it: *collected*, and what is owed or
withdrawable — for the platform, *owed to operators*; for an operator, *withdrawable*. The rest of the period
(commission, subscription revenue, refunds, payouts) drops to a breakdown underneath, where it belongs: the parts
support the answer instead of competing with it. Balances print the chart of accounts in the reader's language
(`Payable to operators`, `بنك المنصة`) and the column is named `Balance`, not `Difference`. The journal editor and the
ledger rows use the same names — the submitted value is still the code, only the label changed. Reconciliation's rails
read as the rails they are (`Jaib`, `Al-Kuraimi Bank`, `Tadhamon Bank`, `Cash at the office`). Invoices puts
**outstanding** in the header band as a figure (`.console-head__figure`), which removed the duplicated heading and the
sentence that explained it.

**Two decisions.**

- **One flow of the month, not ten tiles.** A finance desk asks *how much did we make*, then *what is still owed*.
  `SummaryCards` now skips the three figures the headline already carries and returns `null` when it has nothing left,
  so the same component still serves the operator and platform desks without printing profit twice.
- **Names come from the chart of accounts, not from a map in the component.** `loadLedgerAccounts()` reads
  `ledger_accounts` (10 rows, AR + EN) and `accountName()` falls back to the code only if the chart cannot be read —
  so a new account appears in the journal picker without a code change.

**Two defects found while rendering it. — both fixed here**

1. **Every gateway-backed screen was blank for URL-token sessions.** `callGateway` took the access token from
   `client.auth.getSession()`, which is `null` whenever the session arrives as the proxy's `x-maak-token` header
   (`?st=`, the embedded preview, `persistSession: false`). The finance dashboard and statement rendered *"The ledger
   could not be read"* for anybody signed in that way while the same account worked through the cookie — a whole
   console that looked down. `resolveAccessToken()` asks for the token whichever channel carries it.
2. **`loadAccountContext` returned other people's rows as if they were yours.** The policies are written for the
   platform: a `platform_staff` account may read every row of `user_roles` and `organization_members`, because the staff
   consoles need the roster. The account helper queried neither by `user_id`, so that account's `roles` contained the
   admin's role — and every page that branches on roles (`canReadPlatformFinance`, the admin doors, the finance scope)
   believed a staff member was an admin — while its `organizations` contained a company it does not belong to, which is
   the ledger the finance dashboard would have shown it. All three reads (memberships, notifications, roles) are now
   pinned to the visitor.

**Verified.** `check:all` ✓ (691 tests: 676 core ×2 + 15 web; 46 migrations, pgTAP suites green, guards
32/190/46/135, Edge bundle up to date), `check:responsive` ✓ (77 media queries, 11 tap targets), a11y ✓ (113 routes,
both directions). Rendered all nine screens in both locales as `admin@` (platform scope), and the dashboard in both
locales as `owner@` (org scope), `driver@` (personal, all zeroes) and `staff@`, in both auth channels — cookie and
`?st=` — after the gateway fix. Figures read back from the platform dashboard: `Profit YER 7,600`, `Collected
YER 2,500`, `Owed to operators YER 0`, then `Commission 100 / Subscription revenue 7,500 / Refunds 0 / Payouts 0`;
balances `Platform bank 7,500 · Platform cash 2,500 · Payable to operators 2,400 · Commission revenue 100 ·
Subscription revenue 7,500`; the owner's dashboard read `Profit 2,300 / Collected 2,400 / Withdrawable 2,400`. Arabic
rendered `الربح 7,600 ر.ي` on the headline, `بنك المنصة` / `نقد المنصة` in the balances table, and the journal's
picker `نقد المنصة · بنك المنصة · مستحق من الوكلاء · مستحق على المشغّلين · مستحق للمشغّلين · إيراد العمولة …`.

**Gaps, stated plainly.** No browser here, so the phone layout (the headline stacking above the breakdown, RTL
mirroring of the period stamp) is read back from markup and CSS plus `check:responsive`, not seen. `payableYer` comes
back `null` on a fresh month, which renders as `—` rather than `YER 0`; that is intentional, and the live payload was
checked to confirm it. A `platform_staff` account still sees the finance desk's doors in its sidebar even though the
ledger writes are refused to it (`finance.viewAll` is finance officers and admins) — the pages now render, the actions
answer `FORBIDDEN`; making the navigation capability-aware is its own slice, because it means deciding what the staff
desk *does* with money rather than hiding buttons from it.

## 20. The coverage screen

Asked for by the owner, looking at `/admin/regions` on a phone: *"check how it looks unorganized … user friendly and
informative screen with less spaces, do cards when possible, do groups when possible."*

**What it was.** Four loose blocks of equal weight down one column: the page heading, a section called *The region
tree* with a hint written as a badge, a **card per region** whose parent was appended to the name as a sentence, then —
below a gap of a full section break — a bare *New region* heading followed by fields, two fieldsets and a Save button,
with a `Cancel` in its head that did nothing when there was nothing to cancel. On the phone in the screenshot the
editor started below the fold of its own heading. 22 governorate chips were laid out at field width (two to a row,
eleven rows), and the caption under each region read **"1 extra districts"**.

**The first answer was wrong, and this is the record of why.** I rebuilt it as *two large cards side by side* — a tree
card and an editor card — on the reading that "do cards" meant frames. The owner's reply: *"the layouts totally not
good … do cards when it should be cards, maximum nested cards 2, do not make main cards for the whole page, flattened
pages."* Both statements are true at once: cards are for **items** (a row stacked on a phone, a repeated record), not
for **pages and sections**. A card around the whole screen is a frame around a frame, and two cards competing across a
gutter is the page apologising for having two subjects.

**What it is now: a flat page, with the editor as a view.**

- **No card wraps anything.** The screen is a heading, a table, a section, a form. The only frames are the rows (which
  the responsive table turns into cards *on a phone only*, where a card per record is the right shape) and the
  editor's own bands.
- **The list is a table**: *Region* (name, kind as metadata under it, sub-regions indented with a guide mark),
  *Coverage* (districts · governorates · extra), *Status* (Active / Retired, same table — a retired region is a row
  with a muted state, not a second list), and the row's actions right-aligned. **New region** sits in the section's
  heading row, where the action for a list belongs.
- **Editing is a view over the list.** `New region` or `Edit` swaps the table for the editor — identity on the left,
  coverage on the right, from 900px — with a *← Regions* button in the head and Save at the foot beside the recap. On
  a phone the form fills the screen instead of starting below the fold of its own heading, and there is no panel
  sitting in the corner of a page it is not about. The heading takes focus when the view opens.
- **Supervisors is a section, not a card**: a table (user, regions, districts covered) and, under a rule, the
  assignment form — select the user, tick regions, assign or revoke.
- **Counts are sentences in both languages**, through the platform's `pluralCategory()` / `translateCount()` with
  `zero` / `one` / `two` / `few` forms: Arabic reads `محافظتان`, `10 مديريات`, `0 مديريات`; English stops printing
  "1 extra districts". `i18n.test.ts` pins every form in both locales.

**Three rules this slice leaves behind**, and they apply to every console screen:

1. A card is an **item**, not a container for a page or a section. Rows on a desktop, cards on a phone, a panel only
   when the panel *is* the task.
2. **Two frames of nesting is the ceiling** — and on a console page the target is zero for structural chrome, one for
   a record.
3. A console screen is a **document**: heading, section, table, section. Hierarchy comes from size, weight, rules and
   space, not from nested rectangles.

**Verified** — both locales rendered as `admin@`, list state and editor state (the editor was rendered by pinning its
initial state, then reverted): `The region tree 1 · New region`, headers `Region | Coverage | Status | Actions`, the row
`Aden & the Coast / Region / 10 districts · 2 governorates · 1 extra district / Active / Edit region · Retire`, the
editor's `Identity`, `Coverage 0 of 22`, `Hand-picked districts 0 chosen`, recap `0 districts · 0 governorates`, and
`Regional supervisors` with its table and `Assign or change`. Arabic renders `10 مديريات`, `محافظتان`, `0 مديرية`
corrected to `0 مديريات` and `موقوف`. `check:all` ✓ (692 tests: 677 core ×2 + 15 web, 46 migrations, pgTAP, guards
32/190/46/135), `check:responsive` ✓ (80 media queries), `check:a11y` ✓ over `/admin/regions` in both locales (14
routes) — `scripts/check-a11y.mjs` gained `A11Y_FILTER` for exactly this: the full 113-route sweep needs more memory
than this sandbox gives the dev server, and a run that dies half way reports ninety "unreachable" routes that say
nothing about the pages. The last whole-product pass was on the finance slice (§19).

**Gaps, stated plainly.** No browser here, so the phone layout (a stacked row per region, the chips wrapping four
across) is read back from the emitted markup and CSS plus `check:responsive`, not seen. The seed has one region, so the
tree's **indentation and the retired state are exercised by code, not by data**. The counts are covered by
`i18n.test.ts`; the layout is not — these are client islands and the repo has no browser harness — and the editor's
open/close transitions were verified by pinning state, not by clicking.

## 21. The design pass — one skin over the front door, and a menu on a phone

Asked for by the owner, with a screenshot of `/admin/regions` on a phone: *"make the admin page look professional … less
spaces, do cards when possible, do groups when possible, informative, user friendly"* — the same brief as §20, which
means §20 answered the layout and left the *look* unanswered.

**What was actually wrong, once the layout was no longer the complaint.** The screens had a layout rule each and the
browser's idea of everything else: four identical grey words in the header, with no sign of which page you were on; a
console whose nine destinations wrapped three rows deep above every page title, so the first thing on a phone was a tag
cloud; 404s that were not pages at all; forty empty states all showing the character `◇`; Latin micro-caps tracking
applied to Arabic, which prises the joins of a cursive script apart; and an auth form floating on bare paper.

**The direction, in one line:** *one accent, one measure, one way of opening a section, one way of lifting a card.*

- **The accent is the product's own green.** Sand stays reserved for "featured"/premium, because a colour that marks a
  paid placement cannot also mark an action. The signature device is a 32px brand rule above a section title: it costs
  no markup, is identical in both directions, and is the one repeating mark that makes separate screens read as one site.
- **Type**: display lines balance (`text-wrap: balance`), the hero measures 22ch instead of the whole window, and body
  copy gets a readable measure. In RTL, heading tracking is switched off entirely — negative tracking closes Arabic's
  joins — and every capitalised caption now reads its tracking from `--tracking-caps`, which is `0` in Arabic and
  `0.05em` in Latin (`packages/design-tokens/tokens.css`).
- **The header says where you are and what to do.** The current destination carries `aria-current="page"` and a 2px
  rule; *Sign in* is the only filled button in the row (and a full-width one in the phone sheet), so the loudest thing
  in the header is the thing a stranger came for.
- **The console is a place with a door.** On a phone the nine destinations collapse into one 44px row that names where
  you are — "Administration · Regions" — opened by tap into the same grouped list (a native `<details>`, no JavaScript,
  keyboard-operable, and `display: contents` above 900px so the sidebar is the *same* list rather than a second copy).
  On a desktop the sidebar is sticky and begins with the product lockup, because the console had no way home that did
  not involve editing the address bar.
- **States are designed.** `not-found.tsx` is a page — mark, 404, what happened, two ways out — and the error boundary
  offers *retry* **and** home, since a boundary that only retries traps anyone whose failure is deterministic. Both read
  the language from an `x-maak-locale` header the proxy forwards, because `notFound()` passes no route params: an
  English operator opening a deleted trip used to be apologised to in Arabic. `EmptyState` draws the new `inbox` glyph
  in a brand disc instead of a typed diamond. Loading skeletons now have the shape of the page they precede.
- **Cards are still items, not containers.** The owner's standing rule — *"do cards when it should be cards, maximum
  nested cards 2, do not make main cards for the whole page, flattened pages"* — is why §20's coverage screen keeps its
  shape (a heading, a table, a section, and editing as a view). This pass did not re-card it; it removed the chrome
  around it (the console menu), tightened the chips to three across a phone, gave the table's rows a hover, and let the
  section title carry the hierarchy.

**A bug this found.** `app/[locale]/loading.tsx` put a streaming boundary at the locale root, so `notFound()` could no
longer set a status: every 404 under a language answered **200 with a skeleton in it**. The boundary moved to
`/trips` (the one list that actually streams) and the catch-all `[locale]/[...rest]` keeps misses inside the locale, so
`/en/nope` is a real 404 with the real not-found page, in the right language.

**Verified** — `check:all` ✓ (692 tests: 677 core ×2 + 15 web, 46 migrations, pgTAP, guards 32/190/46/135),
`check:responsive` ✓ (85 media queries), `check:a11y` ✓ over **all 113 routes** in both directions (12 discovered detail
pages), and rendered both locales of `/`, `/trips`, `/admin/regions`, `/auth/sign-in`, plus `/en/nope` and `/ar/nope`
(404 + the right language) and the console sidebar/menu markup.

**Gaps, stated plainly.** There is still no browser in this sandbox: the lift on hover, the hero's gradient and the
motion are read back from the CSS, not seen, and `prefers-reduced-motion` is honoured in code rather than observed. The
design layer is appended to `globals.css` as one commented block (§1–§11) so it can be reviewed — or lifted into
`packages/design-tokens` — as a unit. The sand/brand split is asserted by convention and a single `:has()` selector,
not by a lint rule.

## 22. The marketplace filter panel

The same brief as §21, applied to the one screen in the product whose whole job is *narrowing*: `/trips`.

**What was wrong.** The panel was already correct — a disclosure on a phone, a sidebar on a laptop, a form that
degrades to a plain GET with JavaScript off — and it had never been designed. On a laptop the summary is hidden, so the
column began with a micro-caps **ROUTE** and no title at all: a stack of unlabelled controls beside a page that has a
heading, which is why it read as a form that happened to be there rather than as the tool for the page. On a phone the
row said *Filter* and a chevron, gave no sign it was a panel until tapped, and — the real cost — **stayed open after
you applied it**, so the results you had just asked for were underneath the form you had finished with.

**What it is now.**

- **One control, named once.** The summary is a funnel in a tinted square, the word *Filters*, and a count once
  anything is in force; the square fills with brand green when it is (`data-active`). Above 900px that row disappears
  and the panel opens with a real `h2` and a *Reset* link beside it.
- **The panel sticks.** A result list is longer than a viewport, and a filter column that scrolls away from the list it
  filters is the reason people give up and re-load the page with the URL. It is `position: sticky` under the header,
  capped to the viewport, and scrolls inside itself.
- **Applying puts the panel away on a phone.** The form is a GET, so *Apply filters* navigates; a `submit` listener on
  the disclosure closes it first. On a laptop it stays open, because there it *is* the sidebar.
- ***Clear* exists only when there is something to clear**, and the button says what it does — *Apply filters*, not a
  second *Filter* that means "submit" while the first one means "open".
- **Zero is information, not absence.** A facet with nothing behind it (`Men only 0`) stays, dashed and muted, instead
  of disappearing — and the filter you have chosen does not vanish from under the pointer when it empties the list.
- **Labels are labels.** The field captions were 11px micro-caps with Latin tracking (on a *form field*); they now match
  every other label in the product — 12px, 700, untracked — and the panel's group headings keep the micro-caps.

**Verified** — both locales, idle and filtered: EN `Filters | Route | … | Apply filters` with `data-active` on the
disclosure, AR `الفلاتر | إعادة تعيين | المسار | … | تطبيق الفلاتر`, `data-empty="true"` on the zero facets,
`check:all` ✓ (692 tests: 677 core ×2 + 15 web), `check:responsive` ✓ (87 media queries), `check:a11y` ✓ over all 113
routes. **Gaps:** as in §21 — no browser here, so the sticky offset and the close-on-apply are read back from the code,
not watched.

## 23. The staff and admin desks — six screens, one standard

The brief for this pass was the brief for §21 and §22, applied one page at a time to the screens a person actually
works in: **grouped, carded where a thing is a thing, informative (counts and state, not rows), fewer wasted gaps, one
obvious action, RTL parity**. Everything below was designed against that, not against a screenshot.

### 23a. Staff — trip detail (`/staff/trips/[id]`)

**What was wrong.** The page opened with a 14-character trip code above the route, so the first thing a reviewer read
was an identifier; the navigation above it was hand-rolled in this one file and had already drifted from `staffNav`; the
verification decision sat *below* the trip's own facts, which meant scrolling past the thing you were deciding; and the
same date and time was printed three times in three styles.

**What it is now.**

- **One identity line.** `Sana'a → Aden · SA-AD-6744 · Fri, 6 Nov 2026 · 00:24` in one row with a drawn arrow in a disc
  — the code in `bdi` with tabular figures, because it is the one string on the page that must never reorder.
- **The two doors at the top.** *Passenger manifest* (primary) and *Scan a trip* (ghost) sit beside the status badges
  where the reader's eye lands, instead of mid-page in a paragraph of links.
- **The decision is a panel, not a footnote.** Pending trips render `StaffTripReview variant="panel"` **below** the
  detail in its own labelled section: the sand tint the product already uses for "a human must decide", the reason
  field always open (it is the point of the panel), and *Reject* disabled until the reason is worth reading.
- **One back link, one arrow.** `←` — a character that points the wrong way in Arabic — became the shared
  `DirectionalIcon` in a `.detail-back` disc.

### 23b. Staff — trip review queue (`/staff/trips`)

- The filter block's **second group of checkboxes had no name** (the verification states floated under the date row).
  It has a heading now, and its own `.trip-filters__legend` weight.
- **The result count and *Export results* became a toolbar** — one line, count at the start, the action at the end —
  instead of a count paragraph and a lone button in a paragraph of its own.
- **The header band carries the queue depth** (`Awaiting review 0`), or the result count once a search is in force, so
  the answer to "is there work here" is visible before the empty state says the same thing in more words.
- The route column used `←`; it now uses `DirectionalIcon direction="forward"`, which flips with the document.

### 23c. Staff — scan (`/staff/scan`)

**What was wrong.** The scanner worked and the page said nothing: a form, then blank paper until you scanned. A staff
member meeting it for the first time had no idea whether it checked the trip, the passenger, or both.

- **The verdict is a panel now.** *Cleared to board* is a green-tinted sheet with a check in a disc, the route, and the
  trip's facts beneath a hairline; a refusal is the same shape in danger red with `role="alert"`. The neutral card it
  replaced gave the 14-character code the largest type on the screen.
- **The idle state explains itself**: three lines for what a scan confirms, and one that says what it will *not* show
  (passenger names), because a checkpoint tool that hides its rules gets used wrongly.

### 23d. Admin — subscriptions (`/admin/subscriptions`)

- **Three facts in the band**: live subscriptions, active, monthly value — the question an admin opens a billing page
  with is the run rate, and the table never answered it.
- **A subscription is a card**: who pays, the plan, the price at display size, the period, and — separately, in sand —
  the two states that change the answer (*cancels at period end*, *moves to Pro next period*), which were previously
  not shown at all.
- **Quota overrides say whose they are** (a short id, or *Platform-wide* — the row previously showed nothing but the
  metric, so an override looked like a global setting), and the empty state explains what an override would do.

### 23e. Admin — plans and limits (`/admin/plans`)

- **The eight limits left the table.** They were joined into one cell — `Vehicles 1 · Drivers 1 · Team members 1 · Trips
  per month 5…` — which is a paragraph pretending to be a column. Each plan is a card with a price and the same eight
  rows in the same order, so three plans can be compared by moving your eyes sideways.
- **Commission rules got a heading, a count, and their own form heading.** The section previously printed the same
  explanatory sentence three times (heading hint, field hint, rules table) and titled the form *Add a rule* while its
  submit button also said *Add a rule*; the field hint now says the useful thing — *leave blank to apply it
  platform-wide* — and a platform rule's row reads *Platform-wide* instead of repeating the section title.

### 23f. Admin — alert templates (`/admin/notifications`)

- **Seven drawers instead of 37 rows.** Kind names are machine words (`agent_cash_in_settled` next to
  `booking_accepted`); the prefixes became families — trips and bookings, money, plans and quota, verifications, people,
  access, fleet, platform ops — each a `<details>` with its count, open by default.
- **Channels are chips, not a list inside a cell**, and both sentences are rendered by `notificationText` with the sample
  payload in a two-up comparison, because the question is whether the Arabic and the English say the same thing.

### 23g. Admin — places (`/admin/places`)

- **The rejection-reason field is not furniture.** It sat on every queued place, eleven fields tall; *Reject* now opens
  it, in sand, with *Reject* disabled under ten characters — the same rule as the trip decision panel.
- **Two meaningless badges removed**: the add-form's header badge said *Awaiting review* and the picker's said *Search*.
- Counts moved into `.console-section__head`, and an empty queue is an `EmptyState` with a drawn mark instead of a
  sentence.

### 23h. The skin, set once (§22 of `globals.css`)

The direction chosen for the product is **warm and human**, and it is applied as tokens and control rules rather than
per page: paper is a cream rather than a cool grey; corners are 10 / 14 / 20 / 28; shadows are short and warm-tinted;
fields sit on white and lift their border on focus; buttons keep one loud brand green; headings balance and prose does
not strand a word. Light-mode only — the dark theme keeps its own surfaces.

**Verified.** `/en` and `/en/trips` (200), `/en/staff/trips` (facts `Awaiting review | 0`, toolbar, named verification
group), `/en/staff/trips/04332a29-…` (single identity line, both actions, `.detail-back`), `/en/staff/scan` (idle checks
block in both locales), `/en/admin/{plans,subscriptions,notifications,places}` (cards, three facts, seven drawers,
labels), plus their Arabic counterparts. `check:all` ✓, `check:responsive` ✓ (94 media queries), `check:a11y` ✓ (113
routes), `check:guards` ✓. **Gaps:** no browser, so geometry at 375/768/1280, hover/focus, and the RTL of the new arrow
discs are read back from CSS, not watched.

## 24. Places, re-cut: a queue of cards, and two rows you press

The second pass on `/admin/places`, after the desk pass made the rest of the console consistent. The complaint was
specific and fair: *the add-a-place form is standing open, and the submitted places do not look like anything.*

**What was wrong.**

- **Eleven fields, always open.** The form was a section in the page flow, so every visit — including the nine in ten
  where nobody is adding a place — ended in a wall of inputs below the thing you came for.
- **A submission was two grey runs.** `نقطة تجمع الشارع الخامس` then
  `كريتر · عدن · مقدّم الطلب: …` then `نقطة تجمع · 12.7801, 45.0302`: the kind, the district, the governorate, the
  coordinates and the submitter all carried the same weight, so deciding a place meant re-reading the line.
- **Two badges said nothing.** *بانتظار المراجعة* sat in the header of the add form (which is not pending — it is empty)
  and *بحث* sat in the header of the picker (a badge is not a search box).

**What it is now.**

- **The queue is a wall of cards** (one column on a phone, `auto-fill` 21rem above 880px). Each card: the name as an
  `h3` with the kind as a chip beside it, the Latin name underneath when there is one, then **four labelled rows** —
  governorate, district, coordinates, submitter — a hairline, the submission date, and the two decisions. *Reject*
  opens the reason in sand with a *Cancel* beside it, and the confirm button stays disabled under ten characters.
- **The form is a row you press.** `<details class="panel-disclosure">` with a plus in a disc, the title, and the one
  line that explains the consequence (*gathering points stay visible to you only until the platform approves them*).
  It opens without JavaScript and the keyboard reaches it as a normal summary. Inside, the eleven fields are two
  fieldsets — **The place** (Arabic name, Latin name, kind) and **Location** (governorate, district, latitude,
  longitude) — so the form reads as two questions rather than eleven.
- **The picker is the same row**, with a magnifier instead of a plus, because it is a tool you reach for rather than a
  section you read.
- **An operator with no queue sees the form as the page**, not as a disclosure to open: the disclosure only exists
  where there is something above it to keep out of the way.

**Verified.** `/en/admin/places` and `/ar/admin/places`: card with the four labelled rows and the date, the *Add a
place* summary with its hint, the two fieldsets inside, the *Find a place* summary, empty queue as an `EmptyState`.
`check:all` ✓ (692 tests), `check:responsive` ✓ (95 media queries), `check:guards` ✓, `check:a11y` ✓ (105 routes this
run — the discovered detail-page count varies with the seeded data). **Gaps:** no browser, so the open/close motion and
the card grid at 375/768 are read from CSS.
