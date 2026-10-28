/**
 * Chevrons and arrows that must point "forward", not "right".
 *
 * In Arabic the forward direction is leftwards. Rather than sprinkling `rtl:` variants through
 * every feature, the flip lives here once — driven by the `dir` attribute the locale layout sets,
 * so it also works during SSR and without JavaScript.
 */

export type IconDirection = 'forward' | 'back' | 'up' | 'down';

const GLYPH: Record<IconDirection, string> = {
  forward: '›',
  back: '‹',
  up: '⌃',
  down: '⌄',
};

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
  const flips = FLIPS_IN_RTL[direction];
  const style = flips
    ? { display: 'inline-block', transform: 'scaleX(var(--icon-flip, 1))' }
    : undefined;

  return (
    <span className="ui-directional-icon" aria-hidden="true" style={style} data-size={size}>
      {GLYPH[direction]}
    </span>
  );
}
