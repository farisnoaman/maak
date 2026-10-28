/**
 * health — unauthenticated liveness + capability probe.
 *
 * Deliberately reveals nothing about the deployment other than that it is alive:
 * no versions, no stack traces, no database details.
 */

import { z } from 'zod';
import { defineCommand } from '../_shared/handler.ts';

const schema = z.object({ echo: z.string().max(64).optional() });

export default defineCommand({ schema, auth: false }, async (ctx) => ({
  status: 'ok',
  requestId: ctx.requestId,
  ...(ctx.input.echo ? { echo: ctx.input.echo } : {}),
}));
