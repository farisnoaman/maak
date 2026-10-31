/**
 * The cookie-less session token, in one place.
 *
 * Sign-in also returns the session token in the redirect (`/ar/account?st=…`) for the case where the
 * browser will not keep a cookie — an embedded preview in a third-party frame, or a proxy that drops
 * `Set-Cookie`. The proxy forwards that token to the renderer, so **pages** render signed in.
 *
 * They rendered signed in while **writes** did not: every browser call goes through `fetch` to
 * `/api/data`, which carries no token unless the page it was called from happens to be in the address
 * bar with `?st=` still attached. So a passenger could fill the booking form on a page that knew who
 * they were, press reserve, and be told "Please sign in first." — by a server that had never heard of
 * them.
 *
 * The fix is to give the browser its own copy: the URL when it has one, `sessionStorage` when it does
 * not, and `x-maak-token` on every call. `sessionStorage` rather than `localStorage` because the token
 * is nobody's business after the tab is closed.
 *
 * This is development-only machinery (`URL_SESSION_ENABLED` in `lib/supabase/server.ts`): in production
 * the URL never carries a token, so nothing is ever stored here.
 */

export const SESSION_TOKEN_KEY = 'maak.session-token';

/** The `st` parameter of the current URL, if this page was loaded with one. */
export function readSessionTokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('st') || null;
}

/**
 * The token the browser holds: the address bar first, because that is the copy the server just
 * rendered with, then the stored one so a page whose URL has since lost `st` can still write.
 */
export function readSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  const fromUrl = readSessionTokenFromUrl();
  if (fromUrl) return fromUrl;
  try {
    return window.sessionStorage.getItem(SESSION_TOKEN_KEY) || null;
  } catch {
    // Storage can be denied outright (lockdown modes, some embedded frames). A missing token is the
    // same failure as an empty one: the cookie channel has to carry the session.
    return null;
  }
}

export function rememberSessionToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // Nothing to do — the URL still has it for this page.
  }
}

/** Called on sign-out: a stored token would otherwise keep the tab signed in after the POST. */
export function forgetSessionToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Same as above: no storage, nothing stored.
  }
}

/**
 * Headers for a same-origin call to `/api/data`.
 *
 * Empty when there is no token, so the cookie channel is never second-guessed.
 */
export function sessionHeaders(): Record<string, string> {
  const token = readSessionToken();
  return token ? { 'x-maak-token': token } : {};
}

/**
 * Goes to `href` as a real document request, carrying the stored token when there is one.
 *
 * `router.push()` asks the server for the next screen with an RSC fetch, and an RSC fetch carries no
 * custom headers — in a cookie-less preview that render is anonymous, so a redirect straight after a
 * successful save lands on a sign-in screen. That is the "it says sign in first although I signed in"
 * bug one screen later. A full navigation puts the token back in the URL where the proxy can see it.
 *
 * With no token (every cookie-backed session, and every production build) this is a plain `assign`.
 */
export function navigateWithSession(href: string): void {
  if (typeof window === 'undefined') return;
  const token = readSessionToken();
  if (!token) {
    window.location.assign(href);
    return;
  }
  try {
    const url = new URL(href, window.location.origin);
    url.searchParams.set('st', token);
    window.location.assign(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    window.location.assign(href);
  }
}
