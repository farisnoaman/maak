import { describe, expect, it } from 'vitest';
import {
  corridorKey,
  osrmRouteUrl,
  parseOsrmRoute,
  routeLooksPlausible,
  type RoutePoint,
} from '../src/domain/routing';

const aden: RoutePoint = { lat: 12.7855, lng: 45.0187 };
const sanaa: RoutePoint = { lat: 15.3694, lng: 44.191 };

const payload = {
  code: 'Ok',
  routes: [
    {
      distance: 312_345.6,
      geometry: {
        coordinates: [
          [45.0187, 12.7855],
          [44.98, 13.2],
          [44.191, 15.3694],
        ],
      },
    },
  ],
};

describe('parseOsrmRoute', () => {
  it('swaps GeoJSON [lng, lat] into the {lat, lng} the database stores', () => {
    const route = parseOsrmRoute(payload);
    expect(route).not.toBeNull();
    expect(route!.points[0]).toEqual({ lat: 12.7855, lng: 45.0187 });
    expect(route!.points.at(-1)).toEqual({ lat: 15.3694, lng: 44.191 });
  });

  it('converts metres to kilometres, rounded to two decimals', () => {
    expect(parseOsrmRoute(payload)!.distanceKm).toBe(312.35);
  });

  it('keeps the provider name the caller passed', () => {
    expect(parseOsrmRoute(payload, { provider: 'ors' })!.provider).toBe('ors');
  });

  it.each([
    ['no route found', { code: 'NoRoute', routes: [] }],
    ['an empty routes array', { code: 'Ok', routes: [] }],
    [
      'a single point',
      { code: 'Ok', routes: [{ distance: 1, geometry: { coordinates: [[1, 2]] } }] },
    ],
    [
      'swapped-but-out-of-range coordinates',
      {
        code: 'Ok',
        routes: [
          {
            distance: 1,
            geometry: {
              coordinates: [
                [181, 2],
                [3, 4],
              ],
            },
          },
        ],
      },
    ],
    [
      'a string distance',
      {
        code: 'Ok',
        routes: [
          {
            distance: '312',
            geometry: {
              coordinates: [
                [1, 2],
                [3, 4],
              ],
            },
          },
        ],
      },
    ],
    ['null', null],
    ['a bare string', 'Ok'],
  ])('returns null for %s', (_label, body) => {
    expect(parseOsrmRoute(body)).toBeNull();
  });
});

describe('routeLooksPlausible', () => {
  it('accepts a road slightly longer than the straight line', () => {
    const route = parseOsrmRoute(payload)!;
    expect(routeLooksPlausible(route, aden, sanaa)).toBe(true);
  });

  it('rejects an answer about a different place', () => {
    const route = { provider: 'osrm', points: [], distanceKm: 12 };
    expect(routeLooksPlausible(route, aden, sanaa)).toBe(false);
  });
});

describe('corridorKey', () => {
  it('rounds to four decimals so a hand-entered pin still hits the cache', () => {
    expect(corridorKey({ lat: 12.78551, lng: 45.01871 }, sanaa)).toBe(
      corridorKey({ lat: 12.78549, lng: 45.01869 }, sanaa),
    );
  });

  it('keeps direction: A→B is not B→A', () => {
    expect(corridorKey(aden, sanaa)).not.toBe(corridorKey(sanaa, aden));
  });
});

describe('osrmRouteUrl', () => {
  it('asks for full GeoJSON geometry, with lng,lat waypoints', () => {
    expect(osrmRouteUrl('https://router.test/osrm/', aden, sanaa)).toBe(
      'https://router.test/osrm/route/v1/driving/45.0187,12.7855;44.191,15.3694?overview=full&geometries=geojson',
    );
  });
});
