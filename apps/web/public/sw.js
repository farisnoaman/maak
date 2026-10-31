/*
 * The service worker exists for two reasons: without one a phone will not offer to install the app, and
 * without one a dead network shows the browser's own error page instead of a sentence in the right
 * language.
 *
 * It caches **nothing**. This app ships several times a week and a cached shell is how a user ends up
 * looking at yesterday's JavaScript under today's build stamp; the build stamp in `data-build` and the
 * stale-build banner already exist to make a stale tab visible, and a cache would fight them. So:
 * navigations go to the network, always, and only a failed navigation gets the offline page below.
 */

const OFFLINE = `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>معك — لا يوجد اتصال | Maak — offline</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100dvh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: system-ui, -apple-system, 'Segoe UI', Tahoma, sans-serif;
        background: #ffffff;
        color: #0b1220;
        text-align: center;
      }
      @media (prefers-color-scheme: dark) {
        body { background: #0b1220; color: #f6f8f7; }
      }
      .mark { font-size: 2rem; color: #0b7f60; font-weight: 800; }
      h1 { font-size: 1.25rem; margin: 12px 0 8px; }
      p { margin: 0 0 8px; color: #3d4d61; max-width: 34ch; }
      @media (prefers-color-scheme: dark) { p { color: #8592a5; } }
      button {
        margin-top: 16px;
        min-height: 44px;
        padding: 0 20px;
        border: 0;
        border-radius: 12px;
        background: #0b7f60;
        color: #ffffff;
        font: inherit;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">معك</div>
      <h1>لا يوجد اتصال بالإنترنت</h1>
      <p>تحقّق من الشبكة ثم أعد المحاولة. الرحلات التي حفظتها تبقى في حسابك.</p>
      <p lang="en" dir="ltr">You are offline. Check your connection and try again.</p>
      <button type="button" onclick="location.reload()">إعادة المحاولة · Retry</button>
    </main>
  </body>
</html>`;

self.addEventListener('install', () => {
  // Take over as soon as the browser allows it: there is no cache to migrate.
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.mode !== 'navigate') return;

  event.respondWith(
    fetch(request).catch(
      () =>
        new Response(OFFLINE, {
          status: 503,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        }),
    ),
  );
});
