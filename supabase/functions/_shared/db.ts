/**
 * Database access for commands.
 *
 * Writes go through the shared `createWriteGuard` from @maak/core: exactly one `cmd_*` call per
 * request, enforced before the network round trip (ADR-018). Reads use the service role only for
 * authorization facts the RLS layer cannot express for a service connection.
 */

import { createWriteGuard } from '@maak/core';
import { serviceClient } from './auth.ts';
import { internal } from './errors.ts';

export interface Db {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
  select<T = unknown>(query: {
    table: string;
    columns: string;
    match?: Record<string, unknown>;
  }): Promise<T[]>;
}

export function createDb(options: { requestId: string }): Db {
  const client = serviceClient();
  const guard = createWriteGuard();

  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      try {
        guard.use(fn);
      } catch (error) {
        console.error(`[${options.requestId}] write guard:`, (error as Error).message);
        throw internal((error as Error).message);
      }

      const { data, error } = await client.rpc(fn, args);
      if (error) throw error;
      return data as T;
    },

    async select<T>(query: {
      table: string;
      columns: string;
      match?: Record<string, unknown>;
    }): Promise<T[]> {
      let builder = client.from(query.table).select(query.columns);
      for (const [column, value] of Object.entries(query.match ?? {})) {
        builder = builder.eq(column, value as string);
      }
      const { data, error } = await builder;
      if (error) throw error;
      return (data ?? []) as T[];
    },
  };
}
