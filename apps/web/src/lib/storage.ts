import { getServerClient } from '@/lib/supabase/server';

/**
 * Signed reads into the private buckets.
 *
 * Every bucket below is private, and the read policy on `storage.objects` is what authorises a caller —
 * this helper cannot widen that. What it adds is a clock: the URL it returns stops working after a few
 * minutes, so a page cannot hand out a link that outlives the visit. A passenger's ID or a driver's
 * licence should not be sitting in a browser history, a proxy log and a shared screenshot folder a week
 * later.
 *
 * The URL is re-rooted onto the same-origin `/api/data` proxy so the browser keeps talking to one host
 * (and the sandboxed preview keeps working). The signature is the only thing that makes the object
 * readable, and it travels untouched in `?token=`.
 */
export type PrivateBucket =
  | 'passenger-ids'
  | 'driver-documents'
  | 'verification-docs'
  | 'vehicle-documents'
  | 'vehicle-photos';

export const SIGNED_URL_SECONDS = 300;

export async function signedObjectUrl(
  bucket: PrivateBucket,
  path: string,
  expiresIn: number = SIGNED_URL_SECONDS,
): Promise<string | null> {
  const client = await getServerClient();
  if (!client) return null;

  const { data, error } = await client.storage.from(bucket).createSignedUrl(path, expiresIn);
  if (error || !data?.signedUrl) return null;

  const marker = '/storage/v1/';
  const index = data.signedUrl.indexOf(marker);
  return index === -1 ? data.signedUrl : `/api/data${data.signedUrl.slice(index)}`;
}
