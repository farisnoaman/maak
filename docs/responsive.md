# Responsive layout — mobile first

The web app is designed at **320px** and widens. Nothing is "designed for desktop and then squeezed":
the base stylesheet is the phone layout, and every media query adds room.

That was not true before this pass. On a phone there was **no navigation at all** — the header ran
`@media (max-width: 720px) { nav { display: none } }` and offered nothing in its place — and several
grids used `minmax(280px, 1fr)`, which is 8px wider than the 272px panel it sat in at 360px. A page
that scrolls sideways on a phone is usually one of those two bugs.

## Breakpoints

| Width | What changes |
|---|---|
| **320px** (floor) | single column; icon-only menu button; brand without its tagline; 16px gutters |
| **480px** | brand tagline returns; brand selector |
| **560px** | detail table becomes label/value; queue rows put actions beside the text |
| **720px** | header links inline (no menu button); console panel padding; footer padding; wizard step labels |
| **760–940px** | hero two-column, three-up feature grid, console sidebar |
| **≥900px** | console becomes a 240px sidebar + content |

## The rules this codebase follows

1. **Mobile first.** Base rules describe the narrowest layout; `min-width` queries add columns. The
   two `max-width` queries that remain (`479px`, `559px`, `719px`) only *compact* something that is
   already laid out — they never hide content that has no replacement.
2. **No fixed minimum wider than its container.** Every `minmax(<px>, 1fr)` is written
   `minmax(min(100%, <px>), 1fr)`, so a grid collapses to one column instead of overflowing.
3. **Navigation is never removed without a replacement.** Below 720px the links live in a
   `<details>` disclosure — no JavaScript, keyboard-operable, one set of links in the DOM.
4. **Scroll sideways inside a box, never the page.** Tables with four or five columns
   (`.table-scroll`) scroll within their own region, which is focusable for keyboard users.
5. **Tap targets are 44px.** `--tap-target` is applied to buttons, nav links, console chips, wizard
   steps, toggles, language switch and document links.
6. **Inputs are 16px.** Controls inherit the body size (`font: inherit`), which is what stops iOS
   Safari from zooming into a focused field.
7. **Fieldsets and grid items may shrink.** `fieldset { min-inline-size: 0 }` plus
   `min-inline-size: 0` on grid children: a `<fieldset>`'s default `min-content` width is the reason
   "the form is wider than my phone" happens even when the grid is correct.
8. **Safe areas.** `viewportFit: cover` in the exported viewport, and the footer pads with
   `max(var(--space-8), env(safe-area-inset-bottom))` so the home indicator does not sit on the text.
9. **Logical properties only.** RTL is the same stylesheet: `padding-inline`, `inset-inline-start`,
   `border-inline-start`. `check:guards` fails a build that uses `padding-left` or `float: left`.

## The guard — `npm run check:responsive`

Static facts about the CSS, asserted without a browser, because these bugs are invisible to unit tests:

| Assertion | The bug it prevents |
|---|---|
| The locale layout exports `viewport` with `width: 'device-width'` | a page designed at 980px and zoomed out on phones |
| No media query sets `display: none` on `nav` / `.site-nav` / `.site-menu*` | the header that vanished below 720px |
| Every `minmax(<px>, …)` is wrapped in `min(100%, …)` | the grid that made the page scroll sideways |
| `--tap-target ≥ 44px`, and `.btn`, `.nav-link`, `.console-nav a`, `.fleet-step`, `.site-menu__toggle`, `.fleet-toggle` all use it | links that are 22px tall on a phone |

It runs in `npm run check:all` (and therefore in CI), next to the accessibility smoke test.

## What was verified, and what was not

**Verified here**

- `npm run check:responsive` — passes (20 media queries scanned).
- `npm run check:a11y` — 30 routes in AR/RTL and EN/LTR still pass after the header rewrite, including
  the `<details>` menu.
- Server HTML confirms the contract: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
  and a single `<details class="site-menu">` with one link set.
- `npm test` 303, `typecheck`, `lint`, `format:check`, `check:guards`, `dev:check` — all clean.

**Not verified here**

- **No pixel rendering.** This sandbox has no browser and cannot download one (no Chromium/Firefox,
  and Playwright's browser CDN is unreachable), so the layout was reasoned from the stylesheet and
  guarded statically, not looked at. A pass in Chrome DevTools' device toolbar (320 / 375 / 414 /
  768 / 1280) and on a real Android phone is still worth doing before this is called done.
- The Expo app (`apps/mobile`) is native and flex-based; it uses the same design tokens but was not
  re-verified on a device either.

## Trying it

```bash
npm run dev
# then open the preview, and use the browser's device toolbar at 320px and 375px
```

The screens worth walking at 320px: `/ar/operator/vehicles`, `/ar/operator/vehicles/new` (the wizard),
`/ar/operator/vehicles/<id>` (the spec table), `/ar/operator/drivers`, `/ar/staff/vehicles`,
`/ar/account/team` (the scrolling table).
