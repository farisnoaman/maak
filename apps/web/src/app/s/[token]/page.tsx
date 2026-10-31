import { redirect } from 'next/navigation';

/**
 * `/s/<token>` — the short link a passenger sends over WhatsApp.
 *
 * The real page lives under `/[locale]/s/<token>`, because language and direction are per-route in this
 * app and the root layout deliberately renders no `<html>`. The share link is sent *before* the
 * recipient's locale is known, so this redirect picks the primary market's language; the page itself
 * offers the other one.
 */
export default async function ShareShortLink({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  redirect(`/ar/s/${token}`);
}
