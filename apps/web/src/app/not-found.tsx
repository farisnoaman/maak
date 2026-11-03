import { LOCALE_LABEL, DEFAULT_LOCALE, translate } from '@maak/core';

/**
 * The 404 for a URL that is not even language-prefixed (`/trips-typo`, `/favicon.ico` outside the app, `/xx`).
 *
 * It cannot use the locale layout — there is no locale to lay out — and the root layout renders only `children`
 * on purpose (see `app/layout.tsx`), so this file has to be the document: `<html>`, `<body>`, styles and all. It
 * speaks Arabic, the default, and offers both language homes, because the one thing known about this visitor is
 * that the address they typed does not exist.
 *
 * Styling is inline and tiny on purpose: a 404 that waits for the whole application stylesheet is a 404 that
 * flashes unstyled paper first.
 */
const CSS = `
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: #fff;
    color: #0b1220;
    font-family: 'Cairo Variable', 'Cairo', 'Inter Variable', 'Inter', system-ui, sans-serif;
    line-height: 1.8;
  }
  main {
    max-inline-size: 34rem;
    inline-size: 100%;
    padding: 32px 24px;
    border: 1px solid #eef2f0;
    border-radius: 26px;
    background: radial-gradient(90% 120% at 50% 0%, #ecfdf5, transparent 70%), #fff;
    box-shadow: 0 6px 24px rgba(11, 18, 32, 0.08);
    text-align: center;
  }
  .code { margin: 0; color: #5b6b80; font-size: 12px; font-weight: 800; letter-spacing: 0.08em; }
  h1 { margin: 8px 0 0; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.015em; }
  p.body { margin: 8px 0 0; color: #5b6b80; font-size: 0.875rem; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-block-start: 20px; }
  a {
    display: inline-grid;
    place-items: center;
    min-block-size: 44px;
    padding-inline: 24px;
    border-radius: 12px;
    border: 1px solid transparent;
    font-weight: 700;
    font-size: 0.95rem;
    text-decoration: none;
  }
  a.primary { background: #0b7f60; color: #fff; }
  a.ghost { background: #fff; color: #16202f; border-color: #eef2f0; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b1220; color: #f4f7fa; }
    main { background: #121c2b; border-color: #0f1724; }
    p.body, .code { color: #8497ae; }
    a.ghost { background: #0b1220; color: #f4f7fa; border-color: #0f1724; }
  }
`;

export default function RootNotFound() {
  const t = (key: 'errors.NOT_FOUND' | 'page.notFoundBody' | 'common.appName') =>
    translate(DEFAULT_LOCALE, key);

  return (
    <html lang={DEFAULT_LOCALE} dir="rtl">
      <head>
        <title>{`404 — ${t('common.appName')}`}</title>
        <style>{CSS}</style>
      </head>
      <body>
        <main>
          <p className="code">404</p>
          <h1>{t('errors.NOT_FOUND')}</h1>
          <p className="body">{t('page.notFoundBody')}</p>
          <div className="actions">
            <a className="primary" href="/ar">
              {LOCALE_LABEL.ar}
            </a>
            <a className="ghost" href="/en">
              {LOCALE_LABEL.en}
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
