import { NextResponse, type NextRequest } from 'next/server';
import { resolveAccessToken } from '@/lib/supabase/server';
import { getSupabaseConfig } from '@/lib/supabase/config';

/**
 * Same-origin data proxy: the browser's only way to reach the API.
 *
 * The session lives in an **httpOnly** cookie, so client code cannot read a token — and that is the
 * point: an XSS bug can neither steal the token nor mint requests for another account. This handler
 * runs on the server, attaches the caller's own bearer token, and streams the answer back.
 *
 * It also removes CORS from the picture and keeps every request on the origin that served the page,
 * which is what makes the hosted preview work at all.
 *
 *   /api/data/rest/v1/places?select=id
 *   /api/data/functions/v1/geography
 *   /api/data/storage/v1/object/verification-docs/<path>
 */

const ALLOWED = new Set(['rest', 'functions', 'storage']);
const PASS_THROUGH = ['accept', 'content-type', 'prefer', 'x-client-info', 'idempotency-key'];
const RESPONSE_HEADERS = ['content-type', 'content-range', 'content-location'];

async function forward(request: NextRequest, path: string[]) {
  const [kind, version] = path;
  if (!kind || !ALLOWED.has(kind) || version !== 'v1' || path.length < 3) {
    return NextResponse.json({ code: 'NOT_FOUND', detail: 'unsupported path' }, { status: 404 });
  }

  const config = getSupabaseConfig();
  if (!config)
    return NextResponse.json({ code: 'INTERNAL', detail: 'not configured' }, { status: 500 });

  // One answer for both session mechanisms: a cookie session, or the token the proxy recovered from
  // `?st=` for a preview where cookies cannot be stored.
  const token = (await resolveAccessToken()) ?? config.anonKey;

  const headers = new Headers({ apikey: config.anonKey, authorization: `Bearer ${token}` });
  for (const name of PASS_THROUGH) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const body =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();

  const upstream = await fetch(`${config.url}/${path.join('/')}${request.nextUrl.search}`, {
    method: request.method,
    headers,
    body: body && body.byteLength > 0 ? body : undefined,
    // The upstream response may be a 4xx the caller must see; never let fetch mask it.
    redirect: 'manual',
    cache: 'no-store',
  });

  const responseHeaders = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set('cache-control', 'no-store');

  return new NextResponse(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forward(request, path);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forward(request, path);
}

export async function PUT(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forward(request, path);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  return forward(request, path);
}
