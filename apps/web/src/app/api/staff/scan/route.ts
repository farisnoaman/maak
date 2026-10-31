import { NextResponse } from 'next/server';
import { runScan } from '@/lib/staff-ops';

/**
 * Scan, from the browser.
 *
 * A route handler rather than a direct RPC because `staff_scan` needs the caller's session cookie, and
 * the anon key must never be shipped to the client to make the same call. It answers with the function's
 * own shape — refusals included, since a refusal is an answer a supervisor needs to read.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === 'string' ? body.token.trim() : '';

  if (!/^[0-9a-f]{24}$/i.test(token)) {
    return NextResponse.json(
      { allowed: false, reason: 'NOT_FOUND', route: null },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }

  const result = await runScan(token);
  return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
}
