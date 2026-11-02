/**
 * Chevrons and arrows that must point "forward", not "right".
 *
 * In Arabic the forward direction is leftwards. Rather than sprinkling `rtl:` variants through every feature, the
 * flip lives here once — driven by the `--icon-flip` token, which the locale layout sets from the `dir` attribute,
 * so it works during SSR and without JavaScript.
 *
 * These used to be characters (`›`, `‹`, `⌄`). A character is not a chevron: it takes the body font's weight and
 * sidebearings, it changes shape with the fallback font, and its optical centre never lines up with the text it
 * sits beside. They are paths now, with `stroke-width` tuned to sit next to 700-weight text.
 */

export type IconDirection = 'forward' | 'back' | 'up' | 'down';

/** Drawn pointing down; the other three are that shape rotated, so all four share one curve. */
const D = 'M6 9.5 12 15.5 18 9.5';

const FLIPS_IN_RTL: Record<IconDirection, boolean> = {
  forward: true,
  back: true,
  up: false,
  down: false,
};

export function DirectionalIcon({
  direction,
  size = 18,
}: {
  readonly direction: IconDirection;
  readonly size?: number;
}) {
  // The rotation and the flip are classes, not a `style` object: one stylesheet, one place to change them, and
  // the RTL rule stays in CSS where the rest of the direction logic lives.
  const flip = FLIPS_IN_RTL[direction] ? ` ui-directional-icon--flip-${direction}` : '';

  return (
    <svg
      className={`ui-directional-icon ui-directional-icon--${direction}${flip}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-size={size}
    >
      <path d={D} />
    </svg>
  );
}
