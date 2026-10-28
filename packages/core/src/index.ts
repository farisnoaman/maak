/**
 * @maak/core — the framework-free shop floor of Maak.
 *
 * Rules of this package (enforced by eslint `core-is-framework-free`):
 *  - no imports of react, react-native, next, expo, deno or supabase clients
 *  - every function is pure unless it lives under `api/`
 *  - all money is integer minor units (see ./domain/money)
 */

export * from './domain/money';
export * from './domain/ledger';
export * from './domain/pricing';
export * from './domain/finance';
export * from './domain/policy';
