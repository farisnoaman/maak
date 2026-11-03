/**
 * The icon set.
 *
 * Before this the product drew its interface with characters that happen to be in the font: `◆` as a bullet,
 * `✓` as a tick, `→` as a route, `⌄` as a chevron, `›` as "forward". That is not iconography, it is
 * typography wearing a hat — the marks carry the body font's weight and sidebearings, they change shape with
 * the font fallback (and Tahoma's `◆` is a different diamond from Cairo's), and none of them can be aligned to
 * a text baseline reliably.
 *
 * These are hand-authored paths on one grid, drawn with a stroke that follows `currentColor` so an icon inherits
 * the colour of the text it stands beside, scales with `em`-adjacent sizes, and never needs a second asset for
 * dark mode. No dependency, no sprite sheet, no font.
 *
 * Direction is not drawn here. Anything that has to point "forward" uses `DirectionalIcon`, which flips with
 * `--icon-flip`; an arrow with a fixed direction is a bug in Arabic.
 */

export type IconName =
  | 'check'
  | 'calendar'
  | 'clock'
  | 'seat'
  | 'price'
  | 'shield'
  | 'ticket'
  | 'pin'
  | 'bus'
  | 'users'
  | 'star'
  | 'search'
  | 'phone'
  | 'route'
  | 'spark'
  | 'wallet'
  | 'chevron'
  | 'arrow'
  | 'menu'
  | 'close'
  | 'plus'
  | 'minus'
  | 'inbox'
  | 'filter';

/**
 * 24×24 grid, 1.7 stroke, round caps and joins. Filled marks are the exception and are documented where used —
 * a solid dot reads as "you are here" at 14px where a ring does not.
 */
/** Every mark in the set, in the order the styleguide lists them. */
export const ICON_NAMES = [
  'check',
  'close',
  'menu',
  'search',
  'calendar',
  'clock',
  'seat',
  'price',
  'wallet',
  'ticket',
  'shield',
  'pin',
  'bus',
  'route',
  'users',
  'star',
  'spark',
  'phone',
  'chevron',
  'arrow',
  'inbox',
  'filter',
] as const satisfies readonly IconName[];

const PATHS: Record<IconName, { d: string; fill?: boolean }[]> = {
  check: [{ d: 'M4.5 12.5 9.5 17.5 19.5 6.5' }],
  calendar: [
    { d: 'M4 9.5h16M7.5 4v3M16.5 4v3' },
    {
      d: 'M5.5 6.5h13a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5Z',
    },
  ],
  clock: [{ d: 'M12 7.5V12l3 1.8' }, { d: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' }],
  seat: [
    { d: 'M8 4.5h5.5A2.5 2.5 0 0 1 16 7v6H8Z' },
    { d: 'M8 13h10a2 2 0 0 1 2 2v4.5' },
    { d: 'M8 8v11.5M5 20.5h5' },
  ],
  price: [
    {
      d: 'M12.6 3.6h5.9a1.9 1.9 0 0 1 1.9 1.9v5.9a1.9 1.9 0 0 1-.56 1.34l-7.6 7.6a1.9 1.9 0 0 1-2.69 0l-5.9-5.9a1.9 1.9 0 0 1 0-2.69l7.6-7.6a1.9 1.9 0 0 1 1.35-.55Z',
    },
    { d: 'M16.4 7.6h.01' },
  ],
  shield: [
    { d: 'M12 3.5 5 6.4v5.1c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6.4Z' },
    { d: 'm9 12 2.2 2.2L15.5 10' },
  ],
  ticket: [
    {
      d: 'M3.5 9.2V7.5A1.5 1.5 0 0 1 5 6h14a1.5 1.5 0 0 1 1.5 1.5v1.7a2.8 2.8 0 0 0 0 5.6v1.7A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5v-1.7a2.8 2.8 0 0 0 0-5.6Z',
    },
    { d: 'M14 6v12' },
  ],
  pin: [
    { d: 'M12 21c4-4.3 6-7.4 6-10a6 6 0 1 0-12 0c0 2.6 2 5.7 6 10Z' },
    { d: 'M14.4 10.8a2.4 2.4 0 1 1-4.8 0 2.4 2.4 0 0 1 4.8 0Z' },
  ],
  bus: [
    { d: 'M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z' },
    { d: 'M5 11.5h14M8 17.5V20M16 17.5V20' },
    { d: 'M8.5 14h.01M15.5 14h.01' },
  ],
  users: [
    { d: 'M9.5 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z' },
    { d: 'M3.8 19.5a5.8 5.8 0 0 1 11.4 0' },
    { d: 'M16.2 5.2a3.4 3.4 0 0 1 0 6.6M17.6 14.4a5.4 5.4 0 0 1 3 5.1' },
  ],
  star: [{ d: 'm12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 9.7l5.4-.8Z' }],
  search: [{ d: 'M19.5 11.5a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z' }, { d: 'm17.4 17.4 3.1 3.1' }],
  phone: [
    {
      d: 'M6.4 3.9h2.6l1.6 4-2 1.4a11.5 11.5 0 0 0 5.7 5.7l1.4-2 4 1.6v2.6a2.4 2.4 0 0 1-2.6 2.4C10.5 19 5 13.5 4 6.5a2.4 2.4 0 0 1 2.4-2.6Z',
    },
  ],
  route: [
    { d: 'M6 19.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z', fill: true },
    { d: 'M18 10a2.75 2.75 0 1 0 0-5.5A2.75 2.75 0 0 0 18 10Z', fill: true },
    { d: 'M8.5 15.5c3 0 3-7 6.5-7' },
  ],
  spark: [{ d: 'M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.7l-1.6-5.5L5 10.6 10.4 9Z' }],
  wallet: [
    {
      d: 'M4 8.2A2.2 2.2 0 0 1 6.2 6h11.6A2.2 2.2 0 0 1 20 8.2v9.6a2.2 2.2 0 0 1-2.2 2.2H6.2A2.2 2.2 0 0 1 4 17.8Z',
    },
    { d: 'M4 9.5h13.5a2.5 2.5 0 0 1 0 5H4' },
  ],
  chevron: [{ d: 'm9.5 5.5 7 6.5-7 6.5' }],
  arrow: [{ d: 'M4 12h15.5' }, { d: 'm13.5 5.5 6.5 6.5-6.5 6.5' }],
  menu: [{ d: 'M4 7h16M4 12h16M4 17h16' }],
  close: [{ d: 'm6 6 12 12M18 6 6 18' }],
  plus: [{ d: 'M12 5v14M5 12h14' }],
  minus: [{ d: 'M5 12h14' }],
  /* A tray, for "there is nothing in it yet". The empty state used to draw the character `◇`, which is not a
     mark in this set and not a word in any language — the same diamond stood in for "no trips", "no
     notifications" and "no results" on forty screens. */
  /* A funnel: the one mark that says "narrow this list" without a word, for the marketplace's panel row. */
  filter: [{ d: 'M4 5.5h16l-6.2 7.3v6.3l-3.6-1.9v-4.4Z' }],
  inbox: [
    { d: 'M3.5 13.5 6 5.5h12l2.5 8v4a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z' },
    { d: 'M3.5 13.5H9l1.2 2h3.6l1.2-2h5.5' },
  ],
};

export function Icon({
  name,
  size = 20,
  className,
  /** Only pass a label when the icon is the *only* thing carrying the meaning; otherwise it is decoration. */
  label,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
  readonly label?: string;
}) {
  const solid = name === 'route' ? false : undefined;
  return (
    <svg
      className={className ? `ui-icon ${className}` : 'ui-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-solid={solid}
    >
      {PATHS[name].map((part, index) => (
        <path
          key={index}
          d={part.d}
          fill={part.fill ? 'currentColor' : 'none'}
          stroke={part.fill ? 'none' : undefined}
        />
      ))}
    </svg>
  );
}
