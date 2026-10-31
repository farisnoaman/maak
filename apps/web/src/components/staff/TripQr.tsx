import QRCode from 'qrcode';

/**
 * The trip's code, printable.
 *
 * The payload is the 24-hex token itself, not a URL: staff scan it in the app, and the token is what
 * `staff_scan` understands. A URL would put the token in a browser history and in whatever link preview
 * the device offers, for no benefit — the scanner is ours.
 *
 * Printed at a fixed 38 mm so a laminated sheet at arm's length is still readable, with the code in text
 * beneath it: when the print is smudged or the camera refuses, the human can type what they see.
 */
export async function TripQr({ token, caption }: { token: string; caption: string }) {
  let svg: string;
  try {
    svg = await QRCode.toString(token, {
      type: 'svg',
      margin: 1,
      width: 240,
      errorCorrectionLevel: 'Q',
      color: { dark: '#111111', light: '#ffffff' },
    });
  } catch {
    return null;
  }

  return (
    <figure className="manifest__qr">
      <div
        className="manifest__qr-code"
        role="img"
        aria-label={`${caption}: ${token}`}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <figcaption>
        <span className="manifest__qr-token" dir="ltr">
          {token}
        </span>
      </figcaption>
    </figure>
  );
}
