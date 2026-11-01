import { describe, expect, it } from 'vitest';

import {
  hasMobileRoute,
  mobileRoute,
  normaliseLink,
  parseLinkQuery,
} from '../src/domain/deep-link';
import { readTripFilters } from '../src/domain/trip';

/**
 * The deep-link mapping.
 *
 * The first two blocks are the load-bearing ones: a link written by `app.saved_search_query` must survive the
 * trip to the phone with every filter intact, and a link to a console screen the app does not have must fall
 * back rather than crash the router.
 */

describe('parseLinkQuery', () => {
  it('reads a single value per key', () => {
    expect(parseLinkQuery('origin=YE-AD&priceMax=5000')).toEqual({
      origin: 'YE-AD',
      priceMax: '5000',
    });
  });

  it('collects repeats into an array, which is what a governorate picker produces', () => {
    expect(parseLinkQuery('origin=YE-AD&origin=YE-TZ')).toEqual({
      origin: ['YE-AD', 'YE-TZ'],
    });
  });

  it('decodes percent escapes and plus-as-space', () => {
    expect(parseLinkQuery('q=%D8%B9%D8%AF%D9%86+%D8%B5%D9%86%D8%B9%D8%A7%D8%A1')).toEqual({
      q: 'عدن صنعاء',
    });
  });

  it('keeps an empty value rather than dropping the key', () => {
    // `q=` means "the search box was cleared", which is different from a link that never mentioned it.
    expect(parseLinkQuery('q=&direct=1')).toEqual({ q: '', direct: '1' });
  });

  it('survives a malformed escape instead of throwing on the way to the inbox', () => {
    expect(parseLinkQuery('q=100%')).toEqual({ q: '100%' });
  });

  it('ignores empty pairs, a bare key and a leading question mark', () => {
    expect(parseLinkQuery('?&=&a=1&&')).toEqual({ a: '1' });
    expect(parseLinkQuery('')).toEqual({});
    expect(parseLinkQuery(null)).toEqual({});
    expect(parseLinkQuery(undefined)).toEqual({});
  });

  it('keeps an equals sign that is part of the value', () => {
    expect(parseLinkQuery('q=a=b')).toEqual({ q: 'a=b' });
  });
});

describe('normaliseLink', () => {
  it('strips a locale prefix, because the router owns the locale', () => {
    expect(normaliseLink('/ar/trips?q=x')).toBe('/trips?q=x');
    expect(normaliseLink('/en/account/bookings')).toBe('/account/bookings');
  });

  it('reduces an absolute URL to its path', () => {
    expect(normaliseLink('https://maak.app/ar/trips?q=x')).toBe('/trips?q=x');
    expect(normaliseLink('https://maak.app')).toBe('/');
  });

  it('adds the leading slash a hand-written link forgets', () => {
    expect(normaliseLink('trips/AD-SA-1')).toBe('/trips/AD-SA-1');
  });

  it('drops the preview session token: a credential is not a route', () => {
    expect(normaliseLink('/ar/trips?priceMax=5000&st=abc')).toBe('/trips?priceMax=5000');
    expect(normaliseLink('/ar/trips?st=abc')).toBe('/trips');
  });

  it('is empty for an empty link', () => {
    expect(normaliseLink(null)).toBe('');
    expect(normaliseLink('   ')).toBe('');
  });
});

describe('mobileRoute', () => {
  it('keeps every filter a saved search writes', () => {
    const link = '/trips?origin=YE-AD&destination=YE-SA&direct=1&priceMax=5000';
    expect(mobileRoute(link)).toBe(link);
  });

  it('turns the account screens into the screens the app actually has', () => {
    expect(mobileRoute('/account/notifications')).toBe('/notifications');
    expect(mobileRoute('/account/notifications/preferences')).toBe('/notification-preferences');
    expect(mobileRoute('/account/bookings')).toBe('/bookings');
    expect(mobileRoute('/account/bookings/abc')).toBe('/bookings/abc');
    expect(mobileRoute('/account/verification')).toBe('/verification');
    expect(mobileRoute('/account')).toBe('/profile');
  });

  it('leaves the routes that already match untouched', () => {
    expect(mobileRoute('/trips/AD-SA-HBC6')).toBe('/trips/AD-SA-HBC6');
    expect(mobileRoute('/bookings/abc')).toBe('/bookings/abc');
    expect(mobileRoute('/pay/intent-1')).toBe('/pay/intent-1');
    expect(mobileRoute('/places')).toBe('/places');
  });

  it('falls back to the inbox for a console screen the app does not have', () => {
    expect(mobileRoute('/operator/billing')).toBe('/notifications');
    expect(mobileRoute('/staff/verifications')).toBe('/notifications');
    expect(mobileRoute('/admin/notifications')).toBe('/notifications');
    expect(mobileRoute(null)).toBe('/notifications');
    expect(mobileRoute('')).toBe('/notifications');
  });

  it('honours a caller-chosen fallback', () => {
    expect(mobileRoute('/finance/dashboard', '/trips')).toBe('/trips');
  });

  it('normalises on the way through', () => {
    expect(mobileRoute('/ar/account/bookings/abc')).toBe('/bookings/abc');
    expect(mobileRoute('https://maak.app/en/trips?q=x&st=t0k')).toBe('/trips?q=x');
  });
});

describe('hasMobileRoute', () => {
  it('is true for a screen the app has and false for one it does not', () => {
    expect(hasMobileRoute('/trips?q=x')).toBe(true);
    expect(hasMobileRoute('/account/notifications')).toBe(true);
    expect(hasMobileRoute('/operator/trips/123')).toBe(false);
    expect(hasMobileRoute(null)).toBe(false);
  });
});

describe('the round trip the notification makes', () => {
  it('a saved-search link becomes a search the app can run again', () => {
    // Exactly what `cmd_match_saved_searches` writes: `/trips` plus `app.saved_search_query(filters)`.
    const link = '/trips?destination=YE-SA&origin=YE-AD&priceMax=5000';
    const route = mobileRoute(link);
    const query = parseLinkQuery(route.split('?')[1]);
    const state = readTripFilters(query);

    expect(route.startsWith('/trips?')).toBe(true);
    expect(state.origin).toEqual(['YE-AD']);
    expect(state.destination).toEqual(['YE-SA']);
    expect(state.priceMax).toBe(5000);
  });

  it('a direct-only alert keeps the boolean as the page spells it', () => {
    const state = readTripFilters(parseLinkQuery(mobileRoute('/trips?direct=1').split('?')[1]));
    expect(state.direct).toBe(true);
  });
});
