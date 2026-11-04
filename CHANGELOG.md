# Changelog

The dated record lives in `docs/phase-*-report.md` — one file per phase, written when the phase closed, with the
numbers and the mistakes. This file groups those phases into releases a human can read, newest first.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · versions: [SemVer](https://semver.org/).

**Status: `1.0.0` is not tagged yet.** Per `docs/phase-12-report.md` §6 it is tagged after pilot UAT
(`docs/uat.md`) and the hosted-project restore run (`docs/runbook.md` §3), not before. Everything below is merged
on `main`; the tag is the last step, not the first.

---

## [Unreleased] — after the last phase report

### Changed — *Find a trip* is a button, not a wall (`docs/polish-plan.md` §37)

- `/staff/trips` opened on the search form: a query field, five status chips, two dates, a governorate select and four
  verification chips, in a card above the queue — so the queue began below the fold.
- The same form now lives behind **[Find a trip]** in one row with the count and the export: the count the page already
  knew, the disclosure, and the CSV of exactly those rows. The `<details>` summary is the button (no JavaScript
  needed), the panel is placed against the row so it covers the results instead of shoving them down, and it closes on
  *Apply*, `Escape` and a press outside. The badge counts the filters in force, so a filtered view cannot be mistaken
  for a plain one.
- The results count was printed in two places; the toolbar is now the one place that says how much there is.

### Changed — the console gets a frame, and the admin console gets its pages back (`docs/polish-plan.md` §36)

- **The rail is the console**: a deep-forest panel in both themes (a fixed brand colour, so the console keeps one
  identity at night while the paper beside it goes dark), cream destinations, group captions on a hairline, and the
  current screen as a cream plate with forest ink — the only high-value surface inside the rail.
- **Glyphs in the rail**: a console may declare an icon per destination; the shell paints them on every row or on
  none. Admin declares eleven.
- **The header band names where you are** — an eyebrow (*Admin / People*) above the title — and the page's **figures are
  one ledger line**: a bordered strip of cells divided by hairlines, values in tabular figures.
- **Tables are a block of paper you scroll inside**: sticky column headings, warm frame, and each row's verb aligned at
  the inline end.
- **One map, rendered twice**: `adminDestinations` drives both the rail and the overview index (group headings now carry
  counts), so the two cannot disagree — and the three orphaned screens (`/admin/users/deletions`,
  `/admin/plans/commissions`, `/admin/subscriptions/overrides`) are finally in the navigation.
- **The active row is resolved by longest prefix**, not annotated by hand per page — child screens now light up their
  own row, or their parent's.
- **`/admin/users/roles` is a page**: grant/revoke, plus the ledger it should always have had — one row per platform
  role with its holder count and names. The directory keeps the read, and each row hands its person over (`?user=`).
  `RoleConsole` is gone, replaced by `UserDirectory` + `RoleGrants`.

### Changed — the trips toolbar: Filters and the sort tabs, one row (`docs/polish-plan.md` §35)

- **`3 trips` · [Filters ②] [Soonest · Cheapest · Featured]`** — the two controls that act on the same list shared
  opposite ends of the page before: the filters in a 16–18rem column (a disclosure up to 900px, a sticky sidebar above),
  the sort tabs in the results toolbar. One row now, both 44px.
- **The panel drops below the row** instead of living in a column: the same three fieldsets, three columns from 720px
  (*Route* / *Ride conditions* / *Date and fare*), scrolling itself at `min(70dvh, 36rem)`. It closes on *Apply*, on
  `Escape` and on a press outside — writing the DOM attribute only, never React state.
- **The list takes the page back**: `.trips-layout` is one shrinking column, so the cards fill two or three columns.
- The panel's duplicate title and its redundant *Reset* link are gone (*Clear* in the actions row does the same thing).
- `FilterDisclosure` is replaced by `FiltersMenu`.

### Changed — the public front door, in warm paper (`docs/polish-plan.md` §33)

- **One card for the whole site**: `.card` (trip results, fare calculator, account panels) takes the warm paper, the warm
  hairline and the light shadow the console already used — the last cold surface in the product.
- **Bands are washes**: `.section--muted` loses its top and bottom rules; the page separates with tint, not borders.
- **Less air between sections, more inside them**: 40→32px on a phone, 64→48px on a desktop, plus a 24px hand-off from
  the hero.
- **The three steps are plates** (paper card, number in a brand disc) instead of a black rule over a paragraph; the
  **operator banner is flat deep green** instead of a diagonal gradient; destinations and console doors are 44px targets;
  the reassurance ticks are 22px discs.

### Changed — the marketplace list on the same paper (`docs/polish-plan.md` §34)

- The filter panel and the toolbar take warm hairlines; an **applied filter chip is a 36px target** with a brand wash
  instead of a 32px label; the sort links are 44px targets with the current one as a pill.
- The marketplace heading band gets its spacing from the page rather than from a card.

### Changed — one card shell and one action row (`docs/polish-plan.md` §31)

- **Four card classes became one look**: `.trip-card`, `.place-card`, `.geo-region-card`, `.supervisor-card` (plus
  `.sub-card`, `.plan-card`) now share the paper, the 1px warm edge, the 20px corner, the 16→20px padding and the
  `--space-3` rhythm — no shadows, no per-screen hairlines. A retired region is the same card with a wash.
- **Dividers inside a card are one dashed warm hairline** everywhere.
- **Action rows are one row**: same gap and wrap, one filled button each, and the legacy `.btn` is brought onto the
  `.ui-btn` scale (inherited font, 20px padding, flat primary, transparent ghost) — the trip page's footer row and its
  fare button now use `.ui-btn` directly, which removes the product's last gradient button.

### Changed — two more console pages split (`docs/polish-plan.md` §32)

- **`/admin/subscriptions`** keeps the payer list; the quota grants moved to **`/admin/subscriptions/overrides`**, with
  its own facts (`Grants`, `Platform-wide`) and empty state. New keys `subs.overridesSubtitle`, `subs.factGrants`.
- **`/admin/users`** keeps the directory and roles; the account-deletion queue moved to **`/admin/users/deletions`**
  with a waiting count in the band. New key `admin.deletionWaiting`.
- Both new routes are in the a11y sweep (117 routes).

### Changed — `/admin/regions`, re-cut (`docs/polish-plan.md` §30)

- **A card per region** instead of a table row: name, kind, status, then the coverage as **counted chips**
  (`10 districts`, `2 governorates`, `1 extra district`) on a hairline, with *Edit* and *Retire* under it. A sub-region's
  card is indented with a brand rule; retired regions are their own muted group with a count.
- **The editor and the supervisor assignment are disclosure rows** (`New region`, `Assign or change`), so the list stays
  on screen while a region is edited; *Edit* opens the same row prefilled, and closing it by hand is a cancel.
- **The coverage picker counts what is covered as you tick it**, using `expandCoverage` — the same call the command
  stores — and the governorate chips spell out how many districts each one brings.
- **Facts in the header band**: live regions, districts covered (the union across the active ones, computed with
  `expandCoverage`), and supervisors — the existing `geo.fact*` keys.

### Changed — one material for every card on the trip page (`docs/polish-plan.md` §29)

- **The facts list is a card** with the same head as the rest (`The trip`, ticket glyph) and the same dashed rows the
  policy card uses, instead of a separately styled `<dl>` with solid rules and no title.
- **The fare panel wears the same shell** — same paper, edge and corner — and loses its shadow and its micro-caps
  heading. It keeps the price at `--text-2xl`, the primary button and its sticky position: hierarchy from the number,
  not from an elevation.
- New key `trips.detail.summary` (`The trip` / `تفاصيل الرحلة`).

### Changed — the trip page, as cards (`docs/polish-plan.md` §28)

- **The itinerary is a card of stops**: four columns in the same order at every stop — clock time, mark, name, fare
  from the origin — instead of a rail of dots with the time buried in a sentence under each name. Filled discs at the
  two ends, numbered rings between them.
- **The operator and the notes are cards of their own**, beside the crew card and under the route; policy rows moved
  into their own card as well.
- **The main column has a rhythm**: it was `.trip-detail__main` with no stylesheet rule at all, so the blocks sat flush
  against each other.

### Fixed — there was no navigation and no *Sign in* on a desktop (`docs/polish-plan.md` §27)

- **Both navigations** (the site header's, and the console sidebar's) live inside a `<details>` and were "opened" above
  the breakpoint with `display: flex/grid !important`. A closed `<details>` hides its children in the user-agent shadow
  DOM, so that rule styled an element the browser had already refused to render: above 720px the header showed the
  brand and the language switch and nothing else — no menu button (hidden by the same media query), no links, no way to
  sign in — and above 900px the console had no sidebar at all.
- `::details-content { content-visibility: visible }` above each breakpoint makes the inline navigation real, and
  `DetailsForDesktop` sets `open` so the links also reach the accessibility tree (skipped `content-visibility` content is
  invisible to screen readers even when painted). An engine without the pseudo-element gets the *Menu* button back
  instead of an invisible nav.
- `check-responsive` now fails a stylesheet that reveals a `<details>` navigation panel with `display: … !important`
  without that declaration — the check that was green while the bug shipped.

### Changed — one job per page in the console (`docs/polish-plan.md` §26)

- **`/admin/regions` keeps the tree.** Editing is `/admin/regions/[id]`, a new region is `/admin/regions/new`, and the
  roster is `/admin/regions/supervisors`. Saving returns to the tree, which is re-fetched rather than shown stale.
- **`/admin/places` keeps the queue.** The submit form is `/admin/places/new` and the lookup is `/admin/places/find`;
  a verified account that cannot review is redirected straight to the form, because it has one job there.
- **`/admin/plans` keeps the prices.** The rules table and the new-rule form are `/admin/plans/commissions`, and the
  rule table's *platform-wide* row now says platform-wide instead of printing the section title in the plan column.

### Changed — the console, in warm paper (`docs/polish-plan.md` §26, stylesheet §26)

- **The page header is a band**: title, sentence and facts in one sand wash with the page's corner; the facts are paper
  chips inside it.
- **Paper tokens** (`--paper`, `--paper-edge`, `--paper-wash`) defined per colour scheme, so warmth does not break the
  dark theme.
- **Empty states are plates** — a dashed warm edge and the icon in a circle; **section counts are pills**; **tables sit
  in a rounded frame** with a wash header.
- **The primary button is flat**: no gradient, no hover glow.


### Changed — `/admin/regions`, re-cut (`docs/polish-plan.md` §25)

- **The region tree is a wall of cards**: name, kind, status badge, and the coverage as counted chips (`10 districts`,
  `2 governorates`, `1 extra district`) instead of one dotted sentence; a sub-region's card is indented with a brand
  rule, and retired regions are their own muted group with a count.
- **The editor and the supervisor assignment are disclosure rows** (`New region`, `Assign or change`), so the list stays
  on screen while a region is edited — *Edit* opens the same row, prefilled, and closing it by hand cancels.
- **Supervisors are cards**: the person, the districts that follow from their regions, and the regions as chips.
- **Three facts in the header band**: live regions, districts covered (computed with the same `expandCoverage` the
  command stores), and supervisors.

### Changed — `/admin/places`, re-cut (`docs/polish-plan.md` §24)

- **The add-a-place form is a row you press.** Eleven fields used to stand open under the queue on every visit; they
  are a `<details>` with a plus, a title and the one line that explains the consequence — opened by `Enter`, working
  with JavaScript off — and inside, two fieldsets (*The place*, *Location*) instead of eleven loose inputs. An
  operator with no queue gets the form as the page, not as a disclosure.
- **A submitted place is a card**: name as a heading, kind as a chip, Latin name beneath, then labelled rows for
  governorate, district, coordinates and submitter, the submission date, and the two decisions — with *Reject*
  opening its reason in sand, *Cancel* beside it, and the confirm disabled under ten characters.
- **The location picker is the same disclosure row**, and two badges that said nothing (`Awaiting review` on the add
  form, `Search` on the picker) are gone.

### Changed — the staff and admin desks (`docs/polish-plan.md` §23)

- **The skin has a direction.** Warm and human, set once as tokens in `globals.css` §22: cream paper, 10/14/20/28
  corners, short warm-tinted shadows, fields that sit on white and lift a ring on focus, one loud brand green. Light
  mode only; the dark theme keeps its own surfaces.
- **`/staff/trips/[id]`** opens with one identity line (route, code, date, time), both actions beside the status
  badges, and the verification decision in its own sand-tinted panel below the detail — with *Reject* disabled until
  the reason is worth reading. The page's hand-rolled nav is gone; it uses `staffNav` again.
- **`/staff/trips`** names its verification filter group, puts the result count and *Export results* on one toolbar,
  shows the queue depth in the header band, and draws its route arrow with `DirectionalIcon` instead of `←`.
- **`/staff/scan`** has an idle state that says what a scan confirms and what it refuses to show, and a verdict panel
  (`scan-verdict is-ok` / `is-deny`) instead of a neutral card led by a trip code.
- **`/admin/subscriptions`** answers the run-rate question (live, active, monthly value in the header band), draws each
  subscription as a card with its end date and pending-change flag, and names whose quota override it is.
- **`/admin/plans`** draws each plan as a card with the same eight limits in the same order — the joined
  `Vehicles 1 · Drivers 1 · …` cell is gone — and stops printing the commission explanation three times.
- **`/admin/notifications`** groups 37 templates into seven named drawers with counts, turns channels into chips, and
  keeps both sentences side by side.
- **`/admin/places`** asks for a rejection reason only once *Reject* was pressed, removes two badges that said nothing
  (`Awaiting review` on the add form, `Search` on the picker), and counts its queue in the section head.
- **`EmptyState`** keeps its brand disc but gains a title/description weight that reads as a state rather than a
  placeholder; `ConsoleShell` gained the optional `facts` band used by the pages above.

### Added

- **Registration** (`/auth/sign-up`, `/api/auth/sign-up`). The sign-in page had always offered *Create account* — the
  link pointed back at the sign-in page, so a new passenger had no way to become one. Three fields (name, email,
  password) post to a server endpoint that calls `signUp` and lets `app.handle_new_user` write the profile; with
  confirmations on, the page says *check your email* instead of pretending there is a session. A signed-in visitor is
  sent to their account.
- **A password reveal** on every password field (`ui/PasswordField.tsx`, `aria-pressed`, label flips with the state).
- **`@maak/web` runs its tests.** The workspace had no `test` script, so `src/lib/__tests__/legal.test.ts` had never
  been executed by `npm test`; `origin.test.ts` covers the CSRF cases below.
- **An `inbox` mark, and empty states that use it.** `EmptyState` defaulted to the character `◇`, so forty screens said
  "nothing here" with the same typed diamond. The set has a drawing for it now, in a brand-tinted disc.
- **A real 404, in the visitor's language.** `app/[locale]/not-found.tsx` is a page — mark, `404`, what happened, and a
  way back to the home page and to the marketplace — and the proxy forwards `x-maak-locale` so it speaks the language
  of the miss (`notFound()` gives a not-found page no route params). `app/not-found.tsx` covers addresses with no
  language at all and carries its own stylesheet, because the root layout renders no `<html>` by design.

### Fixed

- **Every 404 under a language answered `200`, with a skeleton in it.** A streaming boundary at the locale root meant
  `notFound()` could no longer set a status. The boundary moved to `/trips` — the one list that streams — and a
  `[locale]/[...rest]` catch-all keeps a miss inside the locale, where the styled 404 lives. `/en/nope` is a real 404
  in English now; a typo used to reach a bare Next error document with no navigation at all.
- **The error boundary trapped anyone whose failure repeats.** It offered only *retry*; it now offers *retry* and the
  home page, and keeps the digest as the reference to quote to support.
- **Every gateway-backed screen was blank for URL-token sessions.** The server-side gateway client read the access
  token from `client.auth.getSession()`, which is `null` whenever the session arrives as the proxy's `x-maak-token`
  header (`?st=`, the embedded preview, `persistSession: false`). The finance dashboard and statement answered *"The
  ledger could not be read"* for anybody signed in that way, while the same account worked through the cookie — the
  whole finance console looked down. `resolveAccessToken()` asks for the token whichever channel carries it.
- **`loadAccountContext` returned other people's rows as if they were yours.** A `platform_staff` account may read every
  row of `user_roles` and `organization_members`, because the staff consoles need the roster; the account helper
  queried neither by `user_id`. That account's `roles` therefore contained the admin's role — so every page that
  branches on roles (the admin doors, the finance scope) treated a staff member as an admin — and its `organizations`
  contained a company it does not belong to, whose ledger the finance dashboard would have shown it. Memberships,
  notifications and roles are all pinned to the visitor now.
- **A CSRF hole in `isSameOriginRequest`.** Any `Origin` was accepted whenever every host the server could see was
  loopback — every dev-server request, and the preview proxy whenever it does not forward the host. A form on another
  site could create an account or sign a visitor in to the attacker's. The check now reads `Sec-Fetch-Site` first,
  rejects `cross-site` outright, and keeps the loopback escape only for browsers that send no fetch metadata.
- **A driver's own licence no longer appears as an operator queue item.** The overview's first version counted any
  pending driver profile belonging to the signed-in account, so a driver saw `Drivers awaiting review 1` — a number
  they could do nothing about.

### Changed

- **The frontend got a design layer.** One accent (the product's green; sand stays for *featured*), a 32px rule above
  every public section title, balanced display type, a hero with a wash and a raised search card, buttons with depth
  and a press state, cards that lift only when they are links, and motion that stops when `prefers-reduced-motion`
  asks. It is appended to `globals.css` as one commented block, so it is reviewable as a unit (`docs/polish-plan.md`
  §21).
- **The header marks the page you are on, and the way in is a button.** Four identical grey links became three quiet
  destinations with `aria-current` and a 2px rule, plus *Sign in* as the only filled control — a full-width one inside
  the phone sheet.
- **A console's navigation is one list in two presentations.** On a phone it is a single row that names where you are
  ("Administration · Regions") and opens into the same grouped list — a native `<details>`, no JavaScript, keyboard for
  free. Above 900px that row disappears and the list is a sticky sidebar beginning with the product lockup, which is
  also the console's only way back to the public site on a desktop.
- **Arabic stops being typeset as Latin.** Captions read their tracking from a new `--tracking-caps` token, which is
  `0.05em` in Latin and `0` in RTL: letter-spacing on a cursive script prises the joins apart. Display headings lose
  their negative tracking in Arabic for the same reason.
- **The sign-in form is one card**, on a wash, instead of fields floating on bare paper.
- **The marketplace filter panel is designed, not just functional.** On a laptop it begins with a real heading and a
  *Reset* link (it used to open straight into a micro-caps `ROUTE` with no title) and sticks beside the results instead
  of scrolling away from them; on a phone the row is a funnel, the word *Filters* and a count, tinted when filters are
  in force, and **applying closes the panel** so the results are not behind the form that produced them. The button
  says *Apply filters*; *Clear* appears only when there is something to clear; zero-count facets stay, dashed and
  muted. New `trips.search.filtersTitle` / `.apply` / `.reset` keys and a `filter` glyph (`docs/polish-plan.md` §22).

- **The coverage screen (`/admin/regions`) is a flat page, with editing as a view.** It used to be a card per region
  (hierarchy written out as a sentence), a bare editor below it, 22 governorate chips at field width and a caption
  reading "1 extra districts". It is now a heading, a table and a section: *Region* (sub-regions indented), *Coverage*,
  *Status* (retired rows muted in the same table) and the row's actions, with **New region** in the section head — and
  `Edit` swaps the table for the editor (identity left, coverage right, *← Regions* to come back) instead of leaving a
  form in a card beside it. Supervisors follows the same shape: a table, then the assignment form under a rule. Counts
  are grammatical in both languages through `translateCount()` — Arabic dual, broken plural and plural zero included,
  which is where "1 extra districts" went.
- **The finance console opens with the answer.** `/finance/dashboard` led with ten equal figures, so profit — the
  number the desk exists for — had no weight, and the balances below it printed journal codes (`operator_payable`) and
  a `Difference` column. It now leads with profit at display size (red when negative) beside the period it covers,
  then collected and what is owed or withdrawable, with commission, subscription revenue, refunds and payouts as a
  breakdown underneath; balances print the chart of accounts in the reader's language and the column is `Balance`. The
  journal editor and ledger rows use the same names, reconciliation names its rails (`Jaib`, `Al-Kuraimi Bank`) instead
  of enum values, and invoices puts *outstanding* in the header band — which removed a heading that repeated the page
  title and three subtitles that appeared twice.
- **The operator overview answers questions instead of listing screens.** `/operator` was five identical tiles with an
  `Open` button each — a menu that repeated the sidebar. It now opens with the four queues that can need an operator
  (*booking requests* naming the trip they are on, *receipts to confirm*, *vehicles* and *drivers awaiting review*),
  each a door into the queue behind it, and one sentence instead of four zeroes when none of them has anything. Under
  it, the next four published departures: clock time, route, vehicle and trip code, seats taken with a fill bar, and a
  flag on any trip with people waiting to be accepted. The screens dropped to a framed list of doors at the bottom.
- **One list-of-doors style instead of two.** `.doorlist` / `.door` (icon, name, one line about what is behind it)
  replaces `.account-consoles` / `.account-console`; the account hub and the operator overview share it.
- **`loadTripRequests()`** counts pending bookings for a set of trips in one query, so the overview's request figure and
  the trip inbox cannot disagree about the number.

- **The sign-in page is a page.** It was a card in the middle of an empty screen with no header and no way back: now a
  header, the form on the near side, and a column that says what is behind the door (*your next journey*, *your booking
  code*, *your company*) with *Browse trips without an account* under it. The two methods are links with
  `aria-current` instead of `role="tab"` anchors with no tabpanel — which also fixes the "selected" tab having no
  selected style at all. Errors are a band above the form.
- **The product ships its own typefaces** (`@fontsource-variable/cairo`, `@fontsource-variable/inter`): Arabic was
  rendering in whatever the operating system supplied — Tahoma on Windows, never Cairo — which is why the same screen
  looked different on every machine and why Arabic text sat badly in its line box. Both are variable, self-hosted, and
  subset by `unicode-range`, so the browser downloads only the script it draws: no third-party request, no layout
  shift, and `--leading-ui` gives Arabic the 1.8 it needs where Latin is comfortable at 1.65.
- **An icon set** (`components/ui/Icon.tsx`): 20 hand-authored paths on one 24px grid at one stroke weight, drawn in
  `currentColor`. The interface had been using characters (`◆`, `✓`, `→`, `⌄`) as marks — they take the body font's
  weight and sidebearings, change shape with the fallback face, and cannot be centred against text. The styleguide
  enumerates the set from the component, so a mark cannot exist in the app and be missing from the documentation.
- **`HeroField`**: a contour-and-route drawing behind the home hero — the topology the product actually sells, not a
  stock photograph of a coastline it does not cross.

### Added

- **The trip page names the driver** (`00046_public_driver.sql`): `get_trip_public` dropped `driver_id`, so the one fact
  a passenger needs at the door was missing. The public payload now carries a first name and whether the licence is
  verified — and nothing else from `driver_profiles`; a pgTAP assertion fails the build if the licence number or invited
  phone number ever appears in it. The page shows it as a *Vehicle and driver* block with the vehicle's seat count
  spelled out and only the amenities the vehicle actually declares.

### Changed

- **The account hub opens with the next journey.** `/account` was a stack of equal cards — profile, companies,
  notifications, every console link in the platform, delete — which answered "what is in the account" and left the trip
  two clicks away. It now opens with who you are (a band with the email, the document type, and the verification and
  licence doors), then the soonest booking that has not departed: route, date, code, seats, total, status and one
  primary door. With nothing ahead it says so and offers *Find a trip* instead of rendering an empty section. Companies
  are rows in one frame with a *Current* pill rather than cards inside the page's card, and the console links are
  gated by role — a passenger used to be offered the verification queue and the roles screen, both of which answer 403.
- **`loadMyBookings` returns *my* bookings.** Row-level security is deliberately wider: an operator, a driver assigned
  to the trip and platform staff may all read a booking. A driver account therefore saw a stranger's seat, price and
  reference under *My bookings* (web and mobile) — and the new hub promoted it to *Your next journey*. Both readers now
  filter on `passenger_id`.
- **Booking is a ticket beside the fields.** `/trips/[code]/book` was a single column whose only context was a code in
  the heading: it now restates the route, date, vehicle, driver and seats in a sticky summary that carries the live
  total and the reserve button, and on a phone that summary follows the fields so the button lands where the thumb
  ends. Seats are a stepper with 44px targets and an `aria-live` count instead of a number input; getting off is a list
  of the trip's own stops with the time and fare of each, because a `<select>` hides every option's price; the booking
  code at the end is boxed at display size, `user-select: all`.
- **The payment screen is a page with a progress track.** `/pay/[intent]` was one card of `<dl>` rows. It now has a
  header band with the status, the amount at `--text-3xl` (labelled *Amount due* or *Amount paid* depending on the
  state), the account number large and direction-locked for reading aloud, and three steps — *Payment requested → Send
  the receipt → The company confirms* — with `aria-current="step"`. The "transfer it, then attach the receipt"
  instruction no longer appears under a payment that is already settled.
- **The trip page's stops are an itinerary**: start → stops → destination, with the clock time you reach each stop
  derived from the departure, the fare from the start, and the estimated arrival, joined by a rail. It was the
  intermediate stops alone, with "after 240 min" and no terminals.
- **The marketplace card is a ticket.** The departure time — the fact a timetable is sorted by, and the third most
  prominent thing on the card — now has its own edge: large, tabular, date beneath, separated by a dashed tear-line.
  The heavy shadow is gone (a page of eight shadowed cards is eight shadows competing) and the card lifts on hover and
  focus instead. Home's "next departures" use the same card.
- **The filter panel is three named groups**, each a `<fieldset>` with a `<legend>` — *Route*, *Ride conditions*, *Date
  and fare* — separated by a rule, instead of nine identically sized controls in a column. The disclosure chevron and
  the filter chip's remove mark were characters (`⌄`, `✕`) and are now drawn.
- **The trip page**: back link at the top, drawn route arrow at page-title size, fact rows on hairlines instead of
  eight floating pairs, a rail joining the itinerary's numbered stops, the price on the display scale, and a wider
  article so the 320px fare panel is not floating in dead space.
- **A type scale, named.** `--text-2xs … --text-3xl` and `--leading-tight … --leading-ui` replace sizes written by
  hand at the point of use. Headings land on it by default, display sizes tighten their leading, and the home hero,
  section titles and step cards all read from the same three numbers.
- **The home page's steps are a sequence, not three boxes**: a rule above each and the number beside its title,
  instead of three bordered cards that read as three things to choose between.
- **The menu button is drawn, not typed**, and says *close* while the menu is open (`[open]` swaps the glyph in CSS).
- **Install paths, written down** (`docs/apps.md` §"How to install it on a phone"): the web app as a PWA (works
  today, no account), Expo Go for the inner loop, `eas build --profile preview` for an APK a tester keeps, and the
  store route that waits on accounts. `apps/mobile/.env.example` lists the four variables the app reads.
- **The driver can run a trip from the phone** (`apps/mobile/src/app/driver/trips/`): start, share position, mark a
  stop, end — the same `trip.*` commands as the web console, with `expo-location`.

### Changed

- **A console page is a page, not a card.** The console shell used to render `card console-panel` and every screen put
  its own cards inside it — two borders, two paddings and two shadows around one piece of content. It is now a header
  band (title, one sentence, the page's action), a hairline, and one flat content column with sections divided by rules.
  `/admin` was rebuilt on it as an index of destinations instead of two tiles, one of which apologised for a phase that
  no longer exists; its six screens share one grouped navigation (`components/admin/AdminNav.ts`) instead of five
  different lists, two of which pointed into the finance console. Table styling applies the small-caps header to
  `thead` only — `<th scope="row">` was being shrunk and greyed — and subscriptions and the places queue show names
  instead of raw UUIDs. `docs/polish-plan.md` §9c has the accounting.
- **The staff console is one console, not five.** All six staff screens share one navigation
  (`components/staff/StaffNav.ts`), grouped *Work / Review queues / Reference*; the shell marks the current page with
  `aria-current="page"` (styled since the first console, never set until now); the sidebar names the console and the
  `<h1>` names the page instead of both printing the same string; and the `<phase N>` badge — `7` on the dashboard,
  `4` on trip review, `3` on vehicles, `1` on verifications — is gone from all 41 console pages. The dashboard's four
  zeroes are now four doors into the queues behind them, with a real verification count, the patch named rather than
  counted, an "updated HH:MM" stamp and a clear-state line when nothing is waiting; every empty state names its queue
  and offers the next step. `docs/polish-plan.md` §9a has the full accounting.
- **The marketplace list shows what is filtering it.** Applied filters are chips you can remove one at a time;
  sort is a visible row above the results instead of a control buried in the collapsed panel; the card's route is
  the link; a sold-out trip says so before it shows a price.
- **The trip page leads with the fare.** A panel — first on a phone, sticky beside the facts on desktop — with the
  price, the breakdown, seats left and one *reserve* button. It used to be the twelfth row of a table, under the
  luggage allowance.
- **The home page sells the trip instead of the build.** It showed a phase number, a unit-test count, three
  architecture cards and seven console cards of which five said "coming soon" — while `/trips` served real
  departures it never mentioned. Now: a search-first hero with the next three real departures beside it, trips you
  can book now, popular destinations from the search function's own facets, three booking steps, the fare
  calculator, an operator band, and the consoles as one quiet row. `docs/polish-plan.md` has the accounting and the
  queue for the screens after it.
- **Header and footer.** The primary nav went from eight links (including the vehicles console, the component
  styleguide and two legal documents) to four; everything removed is in the new shared `SiteFooter`, which now
  appears on public pages instead of only the home page. The footer's `Phase 2 · Next.js · Expo · Supabase` line is
  gone.
- **Page titles lead with the brand's own name** (`— معك` in Arabic, not `— Maak`), and the default title says what
  the product does rather than who the software is for.

### Fixed

- **The admin screens were cards inside a card, with UUIDs where names belong.** `/admin/subscriptions` printed
  `owner_org_id` in the operator column and the places queue printed `created_by` beside each place; both now resolve
  the company or person, and fall back to an 8-character id. A button that opened the plan editor said *Save*, and
  three section headings repeated their page title. `.data-table thead th` no longer styles row headers.
- **The staff console scrolled sideways on a phone.** `/staff/scan` was wider than a 390px screen because
  `.console-layout` had no `grid-template-columns`: the implicit `auto` column sized itself to the *content minimum* of
  a row of `nowrap` nav chips, and the panel beside it was laid out at that width. The track is now
  `minmax(0, 1fr)`; the console nav wraps its chips on a phone instead of scrolling in a row that was pushed 32px
  past its container; and the audit that followed removed 57 bare `<n>fr` tracks, two `100vw` widths, a
  `calc(100% + …)` row and four uncapped horizontal scrollers across the stylesheet. `npm run check:responsive` gained
  five rules so a page cannot be made wider than the screen again.
- **A renewal could bill nothing at all.** `invoice_subscription_period_uq` was a unique index on
  `(subscription_id, due_on)`; because `due_on` is derived from the period start, a renewal on the day a subscription
  started produced the same key, and `app.issue_subscription_invoice` returned the invoice for the previous,
  already-paid period instead of issuing a new one — a live subscription with no charge and no error. The key is now
  a real `period_start` column, backfilled from the invoice snapshot (`00045`), with a pgTAP assertion stating the
  property. The 0015 suite had been failing only in runs that began just after midnight in Asia/Aden.
- **The sort tabs in the marketplace broke hydration, and every link carried the session token.** The page built
  its own URLs from `searchParams`, which included `?st=` — the cookie-less session token. So every chip and sort
  tab rendered a link containing the visitor's session, and the preview's token keeper then "repaired" those hrefs
  with a regex that turned `?st=…&sort=cheapest` into `&sort=cheapest`: a link with no `?`, whose sort parameter had
  become part of the path. React reported the difference as a hydration mismatch. URL building now goes through
  `filterHref()` in `@maak/core`, which always drops `st` and `cursor`; the repair parses the URL instead of
  regexing it; and `npm run dev:check` fails if any rendered link carries a token or a malformed query.
- **The header rendered `/en/trips??sort=soonest`.** `searchSuffix()` returns a string that already starts with `?`
  and `SiteHeader` prefixed another one, so clicking *Trips* from a filtered list dropped the filters it meant to
  keep. It also no longer pastes trip filters onto `/account` and `/auth/sign-in`.
- **The preview banner appeared over real data.** `/trips` and `/trips/[code]` rendered "no database connected, the
  data below is illustrative" unconditionally — a live marketplace calling its own listings fictional.
  `loadPublicTrips` now reports `configured`, and the banner asks first.
- **`.sr-only` was used but never defined** (the operator calendar caption rendered as visible text); it is now an
  alias of the existing `.visually-hidden`.
- **A finance assertion that had been counting all subscription invoices** — `0015` test 68 failed on a clean
  checkout, and it was the test that was wrong: an upgrade three screens earlier legitimately leaves a prorated
  invoice open, so "issued subscription invoices = 1" was really asserting "nothing else has been billed yet".
- **`eas.json` configured a variable nothing reads.** All three profiles set `EXPO_PUBLIC_API_URL`; the app reads
  `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`, so every build would have installed and then said
  "not configured". Profiles now name an EAS *environment* and the variables live there.
- **`app.json` asked for `ACCESS_BACKGROUND_LOCATION` and the iOS "always" string** while nothing used them —
  removed rather than left as a permission the app does not honour.

- **The route a real road takes** (`00042`, `npm run routes:fill`). A router queue
  (`get_trips_needing_routes`), a validated write (`cmd_store_trip_route`) and a corridor cache keyed to four
  decimals, so 200 departures on one road cost one provider call. `app.trip_route_for()` now prefers the trip's
  geometry, then the corridor, then the straight line — which stays the default when there is no provider, no
  network or a malformed answer. `parseOsrmRoute` / `routeLooksPlausible` in `@maak/core` are unit-tested without a
  network, including the [lng, lat] swap that would otherwise put Yemen's trips in the Indian Ocean.
- **The payment jobs a cron was supposed to run** (`00043`, `00044`). `payments-expiry` finally schedules
  `cmd_expire_stale_payment_intents`; `payment-reminders` tells a passenger their undecided receipt is still being
  checked (and that an unpaid intent is about to expire); `agent-settlements` tells an agent at 90 % of their credit
  limit, and the finance desk, that a settlement is due. Three jobs rather than one, because they fail differently.
- **The dev backend has a service key.** `MAAK_SERVICE_ROLE_KEY` (default `maak-dev-service-key`) executes as
  `service_role`, so a script that calls a service-only function works on a laptop the way it works in production.
- **Privacy policy and terms of use**, Arabic and English, at `/ar|en/privacy` and `/ar|en/terms`, generated from
  `apps/web/src/lib/legal.ts` and checked by a test for section parity, script and date.
- **Store readiness**: `apps/mobile/eas.json` (development / preview / production profiles, submit config with the
  two account ids left as explicit placeholders) and `docs/store-listing.md` (listing copy in both languages,
  privacy answers, pre-submission checklist).
- **UAT**: `docs/uat.md` — the session script, the pass conditions per role, the severity ladder and the burn-down
  table. The sessions themselves are still a calendar item.
- **This file**, plus `docs/handover.md`.

### Changed

- **One rule for "you are close to your quota"** (`00041`). `app.quota_state()` returns `threshold` (100 at the
  limit, 80 when the next unit crosses 80 %, else null) computed once for every plan; `cmd_notify_quota_thresholds`
  reads it instead of its own `used * 100 / limit`. Basic is now warned in-flow at 80 %; the boundary is one unit
  earlier than the job used to send it. `warning` is `threshold is not null`; `soft` now means only "overage is
  charged".
- **`/admin/users` lists the platform, not the caller.** The role console read its own session, so the only row it
  could act on was the operator looking at it. It now lists the 50 most recent accounts with verification badges,
  their roles and a *Deletion requested* mark, through `profiles_select_staff` and `user_roles_select_staff` — with
  the cap stated when it bites and the *User ID* field as the way past it.
- **A filtered search stops scanning** (`00040`). The bucket aggregate answers a dimension-filtered search from
  ~30 rows: `direct: true` 41.6 → 7.7 ms, the worst dimension case 8.6 ms, homepage 6.1 ms — ~115 cold searches/s
  per core where there were 23. The price/date/text path still pays one 37 ms grouping pass, and says so.
- **The deletion queue** (`00039` + the admin screen): a request had an executor and no list.

## [0.12.0] — Phase 12, hardening and launch readiness

- Platform alarms on itself: six named checks (`stale_trips`, `dead_deliveries`, `unbalanced_journals`,
  `verification_backlog`, `payment_sla`, `error_rate`) delivered through the ordinary notification machinery, with
  a runbook page per alert.
- Search: 15,690 ms → 112 ms → 5.6 ms at 50,000 trips (`00036`, `00038`), with the ceiling documented instead of
  hidden.
- A restore drill that executes instead of describing: hot backup → second cluster → 24 checks against the source,
  in 0.47 s at 49,998 trips (`npm run drill:restore`).
- A scheduler that fails loudly, and a security review expressed as a gate.

## [0.11.0] — Phase 11, notifications, preferences and search alerts

- The full v1.1 event matrix, in-app / push / email / WhatsApp deep link, per-event per-channel preferences, quiet
  hours with critical overrides, AR/EN templates, deep links that keep filters, an optional digest, trip reminders
  at 24 h / 2 h / departure, the no-show window, and history for every role.
- CI fails on a missing translation key — proven by removing one.

## [0.10.0] — Phase 10, finance and subscriptions

- Ledger with a trial balance, journal entries, invoices, payouts, statements, reconciliation, agent floats, plans,
  subscriptions and quota, with `cmd_run_integrity_check` as the standing answer to "do the books balance".

## [0.9.0] — Phase 9, payments

- Payment intents, receipt upload and proof hashing, human confirmation, refunds with the four-band ladder, payouts,
  agent cash-in, and a write-only outbox so no money event is ever lost to a crash.

## [0.8.0] — Phases 7 and 8, trip execution and tracking

- Start / stop / end, seat holds and `boarded`-free manifest, staff operations, location pings in monthly partitions,
  `app.recompute_trip_progress`, the live passenger page and the driver console.

## [0.4.0–0.6.0] — Phases 4 to 6

- The vehicle specification and driver management, trip creation with stops and pricing, the public marketplace and
  booking state machine, and the driver's phone: licence, assigned vehicle, fuel and payments.

## [0.1.0–0.3.0] — Phases 1 to 3

- Identity and roles, verification, the geography gazetteer, the design system and the bilingual shell, and the
  write lockdown that makes every mutation a single audited command.

---

## How to read the numbers

Every claim above is reproducible: `npm run check:all`, `npm run sql:check`, `npm run perf:smoke`,
`npm run drill:restore`. The reports say what failed on the way — the drill that reported success on failure, the
benchmark answered by a cache, the enum cast that cost 12 ms — because a changelog that only lists successes is a
marketing page, and the next person needs the mistakes more.
