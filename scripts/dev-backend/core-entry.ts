/**
 * Re-exports the shared brain for the dev gateway.
 *
 * The dev backend is plain Node (no Deno), but it must not re-implement the contract: this entry is
 * bundled with esbuild at startup so `geoCommandArgs`, the zod schemas and the policy matrix come
 * from `@maak/core` — the same code the edge functions and the tests use.
 */
export * from '../../packages/core/src/index';
