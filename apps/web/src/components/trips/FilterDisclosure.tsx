'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The marketplace's filter panel: a disclosure on a phone, a sidebar on a laptop.
 *
 * The sidebar half is why this component exists. A closed `<details>` hides its own content, and no
 * stylesheet can bring it back — `<details>` is not styled by `display`, and the rendering model that
 * hides the rest of a closed disclosure is not author-overridable in every engine. The page used to
 * render `open={activeCount > 0}`, which meant that a visitor who had not filtered anything got a
 * collapsed panel inside a `.trips-layout` grid whose summary is `display: none` from 900px up: on a
 * desktop the filters were not merely off-screen, they were unreachable. Nothing in the stylesheet can
 * fix that, because the missing thing is an attribute.
 *
 * So the attribute is set here, once the viewport is known, and only then is the summary hidden (CSS
 * keys off `data-enhanced`). Before that — no JavaScript, or a page whose hydration never ran — the
 * summary stays visible and the panel can still be opened by hand. The failure mode is a disclosure one
 * click away, never a form nobody can reach.
 *
 * **`open` is never a React prop, and that is not an accident.** It is mutable DOM state that the *user*
 * owns: tapping the summary flips it with no React involvement. Rendering it from state made React the
 * authority on an attribute anybody can change, so a tap that landed while a slow hydration was still in
 * flight — panel open in the DOM, `open={false}` in props — produced *"a tree hydrated but some attributes
 * of the server rendered HTML didn't match"*. Driving the element through a ref after mount means React
 * never renders the attribute, so there is nothing for hydration to disagree with. Opening the panel on a
 * phone is left entirely to the person holding it: doing it here, a frame after first paint, would shove
 * the results half a screen down for no reason.
 *
 * **`suppressHydrationWarning` is the other half of that decision, not a papered-over error.** Keeping
 * `open` out of props stops React from *setting* it, but React still *compares* every attribute at
 * hydration — and the DOM can legitimately disagree with the server HTML by then:
 *
 *   · the browser restores `<details open>` on a reload or a back/forward navigation, because the element
 *     carries form state, and it does that before hydration runs;
 *   · this effect opens the panel on a wide viewport, so a re-mount (Fast Refresh, or a client-side
 *     navigation back to `/trips`) finds an element that is already open while the new render is not.
 *
 * Both are the same thing the ref is for — the attribute belongs to the DOM — and the warning is React
 * pointing out that it cannot own a comparison it should not be making. Suppressing it on this element is
 * scoped to exactly that: React skips the attribute diff here and nowhere else, and the alternative would be
 * rendering the panel closed on the server and open a frame later, which is the shove described above.
 */
const WIDE = '(min-width: 900px)';

export function FilterDisclosure({ children }: { readonly children: ReactNode }) {
  const details = useRef<HTMLDetailsElement | null>(null);
  const [enhanced, setEnhanced] = useState(false);

  useEffect(() => {
    const element = details.current;
    if (!element) return;

    const query = window.matchMedia(WIDE);
    const sync = () => {
      setEnhanced(true);
      // Wide: always open, because the summary above is hidden and there is nothing left to open it with.
      // Narrow: untouched — it is a disclosure, and the count beside "Filter" already says it has something
      // in it.
      if (query.matches) element.open = true;
    };

    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return (
    <details
      className="trip-filters"
      data-enhanced={enhanced ? 'true' : undefined}
      ref={details}
      // See the comment above: `open` is set by the user, by the browser's form-state restoration and by the
      // effect below — never by React. Comparing it during hydration can only produce a warning.
      suppressHydrationWarning
    >
      {children}
    </details>
  );
}
