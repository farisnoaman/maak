/**
 * The one way to write an edge function in Maak.
 *
 * Order of checks (all fail closed):
 *   1. CORS preflight + origin allow-list
 *   2. POST only, JSON only, hard body-size cap
 *   3. zod validation (the same schema the client used)
 *   4. JWT verification (required, optional, or public — optional means "if presented, it must be valid")
 *   5. actor resolution from the database
 *   6. handler: authorize → compute in @maak/core → exactly one cmd_* write
 *   7. error normalisation: internals never leak, denied requests are audited
 */

import type { z } from 'zod';
import { isBodyTooLarge, mapZodIssues } from '@maak/core';
import { corsHeaders, isDisallowedOrigin } from './cors.ts';
import { ApiError, fromPostgres, internal } from './errors.ts';
import { requireUser, type AuthContext } from './auth.ts';
import { resolveActor, type ResolvedActor } from './actor.ts';
import { recordDenied } from './audit.ts';

type AuthMode = 'required' | 'optional' | 'public';

export interface Ctx<TInput> {
  readonly request: Request;
  readonly input: TInput;
  readonly auth: AuthContext | null;
  readonly resolved: ResolvedActor;
  readonly requestId: string;
  readonly idempotencyKey: string | null;
  readonly ip: string | null;
}

export interface HandlerOptions<TInput> {
  readonly schema: z.ZodType<TInput>;
  /** Defaults to `required`. */
  readonly auth?: AuthMode;
}

const ANON_ACTOR: ResolvedActor = {
  actor: { userId: null, roles: [], verification: 'unverified', plan: 'basic' },
  orgIds: [],
  hasGeoScope: false,
  preferredLanguage: 'ar',
};

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
    const mode: AuthMode = options.auth ?? 'required';
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

    if (request.method === 'OPTIONS') {
      if (isDisallowedOrigin(request)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method !== 'POST') {
      return json({ code: 'NOT_FOUND', detail: 'Method not allowed' }, 405, requestId, request);
    }

    if (isDisallowedOrigin(request)) {
      await recordDenied({
        actorId: null,
        action: 'request.rejected',
        entityType: 'gateway',
        reason: 'origin_not_allowed',
        requestId,
        ip,
        context: { origin: request.headers.get('origin') },
      });
      return json({ code: 'FORBIDDEN', detail: 'Origin not allowed' }, 403, requestId, request);
    }

    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (isBodyTooLarge(declaredLength)) {
      return json({ code: 'VALIDATION_FAILED', detail: 'Body too large' }, 413, requestId, request);
    }

    let auth: AuthContext | null = null;

    try {
      const raw = await request.text();
      if (isBodyTooLarge(raw.length)) {
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
        throw new ApiError(400, 'VALIDATION_FAILED', 'Request validation failed', {
          fields: mapZodIssues(parsed.error.issues),
        });
      }

      const hasBearer = (request.headers.get('authorization') ?? '').trim().length > 0;

      if (mode === 'required' || (mode === 'optional' && hasBearer)) {
        // `optional` means: presenting a token is a promise that it is valid.
        // A bad token is rejected rather than silently downgraded to anonymous.
        auth = await requireUser(request);
      }

      const resolved = auth ? await resolveActor(auth.userId) : ANON_ACTOR;

      const result = await handler({
        request,
        input: parsed.data,
        auth,
        resolved,
        requestId,
        idempotencyKey: request.headers.get('idempotency-key'),
        ip,
      });

      return json(result, 200, requestId, request);
    } catch (error) {
      if (error instanceof ApiError) {
        // Denied and invalid requests are logged; users see a localized message only.
        if (error.status === 401 || error.status === 403 || error.status === 429) {
          await recordDenied({
            actorId: auth?.userId ?? null,
            action: 'request.rejected',
            entityType: 'gateway',
            reason: error.body.code,
            requestId,
            ip,
            context: error.body.fields ? { fields: error.body.fields } : undefined,
          });
        }
        return json({ ...error.body, requestId }, error.status, requestId, request);
      }

      if (error && typeof error === 'object' && 'message' in error) {
        const mapped = fromPostgres(error as { message?: string; code?: string });
        if (mapped.status !== 500) {
          return json({ ...mapped.body, requestId }, mapped.status, requestId, request);
        }
        console.error(`[${requestId}]`, (error as Error).message);
        return json({ ...internal().body, requestId }, 500, requestId, request);
      }

      console.error(`[${requestId}] unhandled`, error);
      return json({ ...internal().body, requestId }, 500, requestId, request);
    }
  };
}
