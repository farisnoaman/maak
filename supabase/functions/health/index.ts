/**
 * health — unauthenticated liveness + capability probe.
 *
 * Deliberately reveals nothing about the deployment other than that it is alive:
 * no versions, no stack traces, no database details.
 */

import { z } from 'zod';
import { defineCommand } from '../_shared/handler.ts';

const schema = z.object({ echo: z.string().max(64).optional() });

// `optional`: no token is fine, but a token that IS presented must be valid (bad token => 401).
export default defineCommand({ schema, auth: 'optional' }, async (ctx) => ({
  status: 'ok',
  requestId: ctx.requestId,
  authenticated: ctx.auth !== null,
  ...(ctx.input.echo ? { echo: ctx.input.echo } : {}),
}));
