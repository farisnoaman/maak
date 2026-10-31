import { ImageResponse } from 'next/og';

/**
 * The app icons, drawn instead of checked in.
 *
 * A phone that installs the web app needs 192px and 512px PNGs; iOS wants its own; a maskable icon must
 * survive being cropped to a circle. Rendering them from one description means they can never disagree
 * with each other or with the brand colour, and there is no binary in the repository to regenerate by
 * hand.
 *
 * The mark is pure geometry — a route between two stops on the brand field — because text in an icon would
 * need an Arabic font shipped to the renderer, and a missing font renders as a box.
 */
export const dynamic = 'force-static';

const SIZES = new Set(['180', '192', '512']);

export async function GET(request: Request, { params }: { params: Promise<{ size: string }> }) {
  const { size: raw } = await params;
  const size = SIZES.has(raw) ? Number(raw) : 512;
  // A maskable icon is cropped to ~80% of its box on Android, so its content is inset while the field
  // still fills the whole square.
  const maskable = new URL(request.url).searchParams.has('maskable');
  const inset = maskable ? size * 0.22 : size * 0.16;
  const stroke = Math.max(2, size * 0.055);

  return new ImageResponse(
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0b7f60',
      }}
    >
      <div
        style={{
          width: size - inset * 2,
          height: size - inset * 2,
          display: 'flex',
          position: 'relative',
        }}
      >
        {/* The route: a diagonal road, then its two stops. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            borderLeft: `${stroke}px solid rgba(255,255,255,0.35)`,
          }}
        />
        <svg
          width={size - inset * 2}
          height={size - inset * 2}
          viewBox="0 0 100 100"
          fill="none"
          stroke="#ffffff"
          strokeWidth={stroke * (100 / (size - inset * 2))}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 82C18 52 34 44 50 40s32-10 32-22" />
          <circle cx="18" cy="82" r="7" fill="#ffffff" stroke="none" />
          <circle cx="82" cy="18" r="10" fill="#c9a227" stroke="none" />
        </svg>
      </div>
    </div>,
    { width: size, height: size },
  );
}
