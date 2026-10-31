/**
 * The build this process is serving.
 *
 * Set once when the dev stack starts (`scripts/dev.mjs`) and read by both the HTML and
 * `/api/version`. When the two disagree, the browser is holding a document from a previous build and
 * `StaleBuildGuard` reloads it. A tab left open across a rebuild is normal here — the preview is a
 * long-lived iframe — so the app has to be able to notice that about itself.
 */
export const BUILD = process.env.MAAK_BUILD ?? 'dev';
