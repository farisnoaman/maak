/**
 * Deep links — one href, two clients.
 *
 * A notification stores a `link`, and the link is written by the code that knows what the event is about:
 * `/trips?origin=…&destination=…&priceMax=5000` for a saved-search alert, `/account/bookings/<id>` for a
 * payment. The web app hands it to `<Link>` and gets the filters back because `readTripFilters` reads the
 * same query string the SQL built (see `app.saved_search_query` in `00032_notifications.sql`).
 *
 * The native app has none of those paths: its router has `/trips`, `/bookings/<id>`, `/notifications`. Until
 * now a push about a saved search opened the inbox and stopped — the one tap a passenger is most likely to
 * make landed on a screen that could not answer it. So the mapping lives here, in one table, next to the
 * parser, because "which screen is this on the phone" is a product fact and not a platform one.
 *
 * Everything in this file is pure and hand-rolled: `URLSearchParams` exists in Hermes but its `getAll`
 * behaviour has changed between React Native versions, and a deep link that silently drops a filter is the
 * bug this file exists to prevent.
 */

/** Query parameters as the router receives them: one string, or several when a filter repeats. */
export type LinkQuery = Record<string, string | string[]>;

/**
 * `a=1&b=2&b=3` → `{ a: '1', b: ['2', '3'] }`.
 *
 * Percent-decoding uses `decodeURIComponent` with a try, because a hand-edited or truncated link can carry a
 * lone `%` and a crash on the way to the inbox is worse than a filter that reads literally.
 */
export function parseLinkQuery(query: string | null | undefined): LinkQuery {
  const out: LinkQuery = {};
  if (!query) return out;
  const trimmed = query.startsWith('?') ? query.slice(1) : query;

  for (const pair of trimmed.split('&')) {
    if (pair === '') continue;
    const [rawKey = '', ...rest] = pair.split('=');
    const rawValue = rest.join('=');
    const key = decode(rawKey);
    if (key === '') continue;
    const value = decode(rawValue);
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) out[key] = [...existing, value];
    else out[key] = [existing, value];
  }

  return out;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/** `https://maak.app/ar/trips?q=…` → `/trips?q=…`: absolute URLs and a locale prefix come off first. */
export function normaliseLink(link: string | null | undefined): string {
  if (!link) return '';
  let value = link.trim();
  if (value === '') return '';

  // An absolute URL is reduced to its path and query. `new URL` is available in Node and Hermes, but the
  // scheme check is what keeps a `wa.me` or `mailto:` link from becoming a route.
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (absolute) {
    const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const slash = withoutScheme.indexOf('/');
    value = slash === -1 ? '/' : withoutScheme.slice(slash);
  } else if (!value.startsWith('/')) {
    value = `/${value}`;
  }

  // `/ar/trips` and `/trips` are the same page; the router owns the locale.
  value = value.replace(/^\/(ar|en)(\/|$)/, '/');

  // The preview's `?st=` token is a credential for the web proxy and means nothing to the app.
  const [path, query] = splitOnce(value, '?');
  const filtered = (query ?? '')
    .split('&')
    .filter((pair) => pair !== '' && !pair.startsWith('st=') && pair !== 'st')
    .join('&');

  return filtered ? `${path}?${filtered}` : path;
}

function splitOnce(value: string, separator: string): [string, string | null] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, null];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

/** The screen to open when the app is not the web app. `null` means "no opinion" — callers pick a default. */
function mapPath(path: string): string | null {
  if (path === '/trips') return '/trips';
  if (/^\/trips\/[^/]+$/.test(path)) return path;

  if (path === '/account' || path === '/account/') return '/profile';
  if (path === '/account/bookings') return '/bookings';
  if (/^\/account\/bookings\/[^/]+$/.test(path)) return path.replace('/account', '');
  if (path === '/account/notifications') return '/notifications';
  if (path === '/account/notifications/preferences') return '/notification-preferences';
  if (path === '/account/verification') return '/verification';

  // Booking detail links are written both ways: `/bookings/<id>` from the payments side and
  // `/account/bookings/<id>` from the account side.
  if (/^\/bookings\/[^/]+$/.test(path)) return path;
  if (/^\/pay\/[^/]+$/.test(path)) return path;
  if (path === '/places') return '/places';

  // Staff and operator console links have no native screen yet. Sending the phone to the inbox is honest:
  // there is a message waiting, and the web app is where the work is.
  return null;
}

/**
 * Where a notification's link should open *on the device*.
 *
 * The filter query survives verbatim, which is the whole point: a saved-search alert opens the search the
 * person saved, not a generic list they then have to re-enter. An unmapped link falls back to the inbox.
 */
export function mobileRoute(link: string | null | undefined, fallback = '/notifications'): string {
  const normalised = normaliseLink(link);
  if (normalised === '') return fallback;

  const [path, query] = splitOnce(normalised, '?');
  const mapped = mapPath(path);
  if (!mapped) return fallback;
  return query ? `${mapped}?${query}` : mapped;
}

/** Does this link already point at a native screen? The inbox uses it to decide whether a row is tappable. */
export function hasMobileRoute(link: string | null | undefined): boolean {
  const normalised = normaliseLink(link);
  if (normalised === '') return false;
  const [path] = splitOnce(normalised, '?');
  return mapPath(path) !== null;
}
