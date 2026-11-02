import { notFound } from 'next/navigation';

/**
 * Anything under a language that is not a route.
 *
 * Without this, a mistyped address inside `/ar/…` did not reach the locale layout's `not-found.tsx`: Next fell back
 * to the *root* one, and the root layout deliberately renders no `<html>` (language and direction are per-route),
 * so the browser was handed a bare error document — no header, no navigation, no way home, in the wrong language.
 * A catch-all that immediately calls `notFound()` keeps the miss inside the locale, where the real 404 lives.
 */
export default function CatchAll(): never {
  notFound();
}
