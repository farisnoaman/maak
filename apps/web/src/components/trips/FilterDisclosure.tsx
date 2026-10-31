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
    <details className="trip-filters" data-enhanced={enhanced ? 'true' : undefined} ref={details}>
      {children}
    </details>
  );
}
