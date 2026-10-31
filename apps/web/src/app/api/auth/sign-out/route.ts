import type { NextRequest } from 'next/server';
import { redirectTo } from '@/lib/redirect';
import { isSameOriginRequest } from '@/lib/origin';
import { getServerClient } from '@/lib/supabase/server';

/**
 * Sign-out as a plain form POST.
 *
 * The session lives in httpOnly cookies, so only the server can clear them. Same reasoning as
 * `sign-in/route.ts`: one path, no client-side auth state to get out of sync.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const locale = String(form.get('locale') ?? 'ar');

  // Same rule as sign-in: only this site may sign you out of this site.
  if (!isSameOriginRequest(request)) {
    return redirectTo(request, `/${locale}`, 303);
  }

  const client = await getServerClient();
  await client?.auth.signOut();

  return redirectTo(request, `/${locale}`, 303);
}
