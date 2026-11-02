'use client';

import { useEffect } from 'react';

/**
 * Opens a navigation `<details>` at desktop widths.
 *
 * **The bug this exists for.** The header and the console sidebar render their links inside a `<details>`: on a
 * phone that is a free, keyboard-operable disclosure with no JavaScript, and above the breakpoint the stylesheet
 * hides the `<summary>` and lays the same links out inline. That last step never worked. A closed `<details>` hides
 * its children in the user-agent shadow DOM — Chrome's rendering spec gives the content slot
 * `content-visibility: hidden`, and a slot rule cannot be overridden by author CSS on the light-DOM children. So
 * `.site-menu__links { display: flex !important }` above 720px was a rule that applied to an element nobody could
 * see: on a desktop the header showed the brand and the language switch, and **no menu button, no nav, no sign-in**.
 * The console sidebar had the same shape and the same failure above 900px.
 *
 * **Two halves of the fix.**
 *
 *  1. `::details-content { content-visibility: visible }` in the stylesheet (§27) makes the panel visible above the
 *     breakpoint in engines that expose the pseudo-element (Chrome 131+, Safari 18.4+, Firefox 138+).
 *  2. Setting `open` here does the rest: it is what exposes the links to the accessibility tree — skipped
 *     `content-visibility` content is hidden from screen readers even when a rule paints it — and it is what keeps
 *     the fix working in an engine without the pseudo-element.
 *
 * It is a property set in an effect, not an attribute in the markup, so the server HTML and the first client render
 * agree (a closed menu on a phone) and hydration never mismatches. With JavaScript off, the CSS half still renders
 * the links for a sighted desktop user; nothing is hidden behind a control that has been removed.
 */
export function DetailsForDesktop({
  id,
  breakpoint,
}: {
  /** The `id` of the `<details>` element to open. */
  readonly id: string;
  /** The width, in CSS pixels, above which the panel is always open. Matches the stylesheet's breakpoint. */
  readonly breakpoint: number;
}) {
  useEffect(() => {
    const panel = document.getElementById(id);
    if (!(panel instanceof HTMLDetailsElement)) return undefined;

    const query = window.matchMedia(`(min-width: ${breakpoint}px)`);
    // One function for mount and for resize: a laptop window dragged narrow must close the panel it opened,
    // or the phone layout starts life with a menu already expanded over the page.
    const sync = () => {
      panel.open = query.matches;
    };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, [id, breakpoint]);

  return null;
}
