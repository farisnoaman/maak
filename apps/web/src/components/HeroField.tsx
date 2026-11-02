/**
 * The shape behind the hero.
 *
 * The product has no photographs of the routes it sells, and it should not borrow any: a stock image of a
 * coastline that is not the one the trip crosses is a small lie the page tells on every visit. What it does have is
 * a topology — departure points along a line, a fare per seat between them — so the hero is drawn from that: contour
 * rings, one dashed route across them, two nodes.
 *
 * It is decoration and it says so: `aria-hidden`, no text, no data, no number that could go stale. Everything is
 * `currentColor` and stroke, so it inherits the theme, flips with the document direction for free, and costs a few
 * hundred bytes of markup instead of a photograph.
 */

const CONTOURS = [1, 0.84, 0.68, 0.52, 0.38, 0.26];

/** One blob, traced once; the rings are that trace scaled about its own centre. */
const BLOB = 'M200 40c96 0 162 66 162 168s-66 190-162 190S38 306 38 208 104 40 200 40Z';

export function HeroField({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className ? `hero__art ${className}` : 'hero__art'}
      viewBox="0 0 400 420"
      fill="none"
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMid meet"
    >
      <g className="hero__art-contours">
        {CONTOURS.map((scale, index) => (
          <g key={scale} transform={`translate(200 210) scale(${scale}) translate(-200 -210)`}>
            <path
              d={BLOB}
              stroke="currentColor"
              strokeWidth={index === 0 ? 1.4 : 1}
              strokeOpacity={0.55 - index * 0.07}
            />
          </g>
        ))}
      </g>

      {/* The route: two stops on a contour map, joined by a dashed line — the product's actual subject. */}
      <g className="hero__art-route">
        <path
          d="M96 330C150 300 138 236 196 208s54-58 104-72"
          stroke="var(--brand-500)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray="7 9"
          strokeOpacity={0.75}
        />
        <circle cx="96" cy="330" r="6.5" fill="var(--brand-500)" fillOpacity={0.9} />
        <circle cx="96" cy="330" r="13" stroke="var(--brand-500)" strokeOpacity={0.28} />
        <circle
          cx="300"
          cy="136"
          r="5.5"
          fill="var(--surface-base)"
          stroke="var(--brand-500)"
          strokeWidth={2}
        />
        <circle cx="300" cy="136" r="12" stroke="var(--brand-500)" strokeOpacity={0.28} />
      </g>
    </svg>
  );
}
