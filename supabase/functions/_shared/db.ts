/**
 * The single-write guard (ADR-018).
 *
 * A command handler may call the database exactly ONCE, because that single call must be the
 * atomic unit of work. A second call is either a missing transaction or a bug that will one day
 * leave half a payment committed. This wrapper makes that mistake impossible at runtime and
 * fail loudly in development.
 */

import { serviceClient } from './auth.ts';
import { internal } from './errors.ts';

export interface Db {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
  /** Read-only helper for authorization decisions. Does not count against the single-write rule. */
  select<T = unknown>(query: { table: string; columns?: string; match?: Record<string, unknown> }): Promise<T[]>;
}

export function createDb(options: { requestId: string }): Db {
  const client = serviceClient();
  let writeCalls = 0;

  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      writeCalls += 1;
      if (writeCalls > 1) {
        // This is a programming error, not a user error: refuse rather than risk a partial commit.
        console.error(`[${options.requestId}] second db.rpc() call blocked (${fn})`);
        throw internal('Command attempted more than one database write');
      }
      if (!fn.startsWith('cmd_')) {
        throw internal(`Only cmd_* functions may be invoked as writes (got ${fn})`);
      }

      const { data, error } = await client.rpc(fn, args);
      if (error) throw error;
      return data as T;
    },

    async select<T>(query: { table: string; columns?: string; match?: Record<string, unknown> }): Promise<T[]> {
      let builder = client.from(query.table).select(query.columns ?? '*');
      for (const [column, value] of Object.entries(query.match ?? {})) {
        builder = builder.eq(column, value as string);
      }
      const { data, error } = await builder;
      if (error) throw error;
      return (data ?? []) as T[];
    },
  };
}
