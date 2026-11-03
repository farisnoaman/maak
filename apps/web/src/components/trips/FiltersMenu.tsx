'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';

/**
 * The marketplace's filter button — one row with the sort tabs, panel below it.
 *
 * **What it replaced.** The panel used to be a `<details>` in its own column: a disclosure on a phone, and a sticky
 * 16–18rem sidebar on a laptop with the summary hidden by CSS. That put the two controls a visitor actually reaches for
 * — *Filters* and *Soonest / Cheapest / Featured* — on opposite sides of the page, in two different shapes, one of them
 * a column and one of them a row. The results, meanwhile, were squeezed into whatever was left of the width.
 *
 * Now there is one toolbar: the count, then **Filters** and the three sort tabs side by side, and the panel drops below
 * that row, full width, over the results. The list keeps the whole page width, which is what it needed: the trip cards
 * fill two or three columns instead of one and a half.
 *
 * **Why still a `<details>`.** It is the only disclosure that is keyboard-operable and works with no JavaScript at all,
 * and the state belongs to the user — so `open` is never a React prop (see `docs` and the guard in
 * `scripts/check-guards.mjs` §15). What this component adds is the behaviour a native disclosure does not have:
 *
 *   · **closing after Apply** — the form is a plain GET, so without this the panel stays open over the results the
 *     person just asked for;
 *   · **Escape** — closes it and puts focus back on the button;
 *   · **a press outside** — a panel that covers the list must not require a second, precise target to dismiss.
 *
 * All three only write the DOM attribute, never React state, so hydration has nothing to disagree with.
 */
export function FiltersMenu({
  label,
  activeCount = 0,
  children,
}: {
  /** The button's text — *Filters* / *الفلاتر*. */
  readonly label: string;
  /** How many filters are in force. Shown as a badge; never used to open the panel. */
  readonly activeCount?: number;
  /** The panel: its head and the form. */
  readonly children: ReactNode;
}) {
  const details = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    const element = details.current;
    if (!element) return;

    const close = () => {
      element.open = false;
    };

    const onSubmit = () => close();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !element.open) return;
      close();
      element.querySelector('summary')?.focus();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!element.open || !(target instanceof Node) || element.contains(target)) return;
      close();
    };

    element.addEventListener('submit', onSubmit);
    element.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      element.removeEventListener('submit', onSubmit);
      element.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);

  return (
    <details
      className="trip-filters"
      data-active={activeCount > 0 ? 'true' : undefined}
      ref={details}
      // `open` is the user's: the browser restores it on reload and back/forward, and no React render sets it.
      suppressHydrationWarning
    >
      <summary className="trip-filters__toggle">
        <span className="trip-filters__summary-icon" aria-hidden="true">
          <Icon name="filter" size={16} />
        </span>
        <span className="trip-filters__summary-label">{label}</span>
        {activeCount > 0 ? <span className="trip-filters__count">{activeCount}</span> : null}
      </summary>
      <div className="trip-filters__panel">{children}</div>
    </details>
  );
}
