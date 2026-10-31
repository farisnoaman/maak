import { NextResponse } from 'next/server';
import { redact } from '@/lib/monitoring';

/**
 * Client error sink. Intentionally conservative:
 *  - no PII (redacted again server-side, never trusting the client)
 *  - hard body cap
 *  - always 204 so a failing reporter never surfaces to users
 */
const MAX_BYTES = 32 * 1024;

export async function POST(request: Request) {
  try {
    const body = await request.text();
    if (body.length > MAX_BYTES) return new NextResponse(null, { status: 204 });

    const parsed = JSON.parse(body) as Record<string, unknown>;
    const safe = redact(parsed) as Record<string, unknown>;
    console.error('[maak:client-error]', JSON.stringify(safe).slice(0, 2000));
  } catch {
    // ignore malformed reports
  }
  return new NextResponse(null, { status: 204 });
}
