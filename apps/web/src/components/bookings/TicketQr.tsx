import QRCode from 'qrcode';

/**
 * The boarding QR.
 *
 * The payload is the booking's own page, not a bespoke `MAAK:…` string: an operator who scans it lands on
 * the booking the passenger is holding, and nothing has to be installed to read it. The SVG is generated
 * on the server because that is where the URL is already known — a client-side renderer would be another
 * 40 kB of JavaScript on a page that is mostly text.
 *
 * `role="img"` with a caption is the honest accessibility treatment: a screen reader cannot scan a code,
 * so it announces what the code is for, and the booking code stays visible next to it as text.
 */
export async function TicketQr({ value, caption }: { value: string; caption: string }) {
  let svg: string;
  try {
    svg = await QRCode.toString(value, {
      type: 'svg',
      margin: 1,
      width: 176,
      errorCorrectionLevel: 'M',
      color: { dark: '#111111', light: '#ffffff' },
    });
  } catch {
    // A payload the encoder refuses (never expected: it is a short URL) must not take the page down.
    return null;
  }

  return (
    <figure className="ticket">
      <div
        className="ticket__qr"
        role="img"
        aria-label={caption}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <figcaption className="ticket__caption">{caption}</figcaption>
    </figure>
  );
}
