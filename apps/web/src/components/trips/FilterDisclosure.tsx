'use client';

import { useEffect, useState, type ReactNode } from 'react';

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
 */
const WIDE = '(min-width: 900px)';

export function FilterDisclosure({
  defaultOpen,
  children,
}: {
  readonly defaultOpen: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [enhanced, setEnhanced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const sync = () => {
      setEnhanced(true);
      // Wide: always open, because there is no summary left to open it with. Narrow: back to what the
      // server decided, which is "closed unless filters are already on".
      setOpen(query.matches ? true : defaultOpen);
    };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, [defaultOpen]);

  return (
    <details
      className="trip-filters"
      data-enhanced={enhanced ? 'true' : undefined}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      {children}
    </details>
  );
}
