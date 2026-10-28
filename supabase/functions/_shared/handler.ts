/**
 * The one way to write an edge function in Maak.
 *
 * Guarantees, in order:
 *   1. CORS allow-list + preflight
 *   2. POST only, JSON body, hard size limit
 *   3. zod validation (same schemas the client used)
 *   4. authentication + actor resolution
 *   5. your handler: authorize → compute → exactly one db.rpc
 *   6. errors normalised to the shared contract, internals never leaked
 *   7. a request id on every response, for support and audit correlation
 */

import type { z } from 'zod';
import { corsHeaders, rejectDisallowedOrigin } from './cors.ts';
import { ApiError, internal, fromPostgres, unauthorized } from './errors.ts';
import { requireUser, type AuthContext } from './auth.ts';
import { resolveActor, type ResolvedActor } from './actor.ts';

const MAX_BODY_BYTES = 256 * 1024;

export interface Ctx<TInput> {
  readonly request: Request;
  readonly input: TInput;
  readonly auth: AuthContext;
  readonly resolved: ResolvedActor;
  readonly requestId: string;
  readonly idempotencyKey: string | null;
  readonly ip: string | null;
}

export interface HandlerOptions<TInput> {
  readonly schema: z.ZodType<TInput>;
  /** Set false for unauthenticated commands (health, public search). Default true. */
  readonly auth?: boolean;
}

function json(body: unknown, status: number, requestId: string, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Request-Id': requestId,
      ...corsHeaders(request),
    },
  });
}

export function defineCommand<TInput>(
  options: HandlerOptions<TInput>,
  handler: (ctx: Ctx<TInput>) => Promise<Record<string, unknown>>,
) {
  return async function serve(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      if (rejectDisallowedOrigin(request)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method !== 'POST') {
      return json({ code: 'NOT_FOUND', detail: 'Method not allowed' }, 405, requestId, request);
    }

    if (rejectDisallowedOrigin(request)) {
      // Explicitly refused rather than silently allowed: a leaked origin must not become a write path.
      return json({ code: 'FORBIDDEN', detail: 'Origin not allowed' }, 403, requestId, request);
    }

    const contentLength = Number(request.headers.get('content-length') ?? '0');
    if (contentLength > MAX_BODY_BYTES) {
      return json({ code: 'VALIDATION_FAILED', detail: 'Body too large' }, 413, requestId, request);
    }

    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) {
        throw new ApiError(413, 'VALIDATION_FAILED', 'Body too large');
      }

      let parsedJson: unknown;
      try {
        parsedJson = raw.length === 0 ? {} : JSON.parse(raw);
      } catch {
        throw new ApiError(400, 'VALIDATION_FAILED', 'Invalid JSON');
      }

      const parsed = options.schema.safeParse(parsedJson);
      if (!parsed.success) {
        const fields: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          fields[issue.path.join('.') || '_'] = issue.message;
        }
        throw new ApiError(400, 'VALIDATION_FAILED', 'Request validation failed', { fields });
      }

      const needsAuth = options.auth ?? true;
      const auth = needsAuth ? await requireUser(request) : null;

      if (needsAuth && !auth) throw unauthorized();

      const resolved = auth
        ? await resolveActor(auth.userId)
        : ({
            actor: { userId: null, roles: [], verification: 'unverified', plan: 'basic' },
            orgIds: [],
            hasGeoScope: false,
          } as ResolvedActor);

      const result = await handler({
        request,
        input: parsed.data,
        auth: auth ?? { userId: '', email: null, token: '' },
        resolved,
        requestId,
        idempotencyKey: request.headers.get('idempotency-key'),
        ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      });

      return json(result, 200, requestId, request);
    } catch (error) {
      if (error instanceof ApiError) {
        return json(
          { ...error.body, requestId },
          error.status,
          requestId,
          request,
        );
      }
      if (error && typeof error === 'object' && 'message' in error) {
        const mapped = fromPostgres(error as { message?: string; code?: string });
        if (mapped.status !== 500) {
          return json({ ...mapped.body, requestId }, mapped.status, requestId, request);
        }
        console.error(`[${requestId}] ${url.pathname}`, error);
        return json({ ...internal().body, requestId }, 500, requestId, request);
      }
      console.error(`[${requestId}] unhandled`, error);
      return json({ ...internal().body, requestId }, 500, requestId, request);
    }
  };
}
