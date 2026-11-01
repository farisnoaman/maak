/**
 * Reading a routing provider's answer without trusting it.
 *
 * `00023` left the seam and `00042` fills it: a worker asks OSRM for the road between two points and stores
 * what comes back. This module is the part that can be tested without a network, a provider or a database —
 * parsing, validation, and the decision to fall back rather than store something malformed.
 *
 * The shape OSRM returns (and ORS can be adapted to) is:
 *
 *   { "code": "Ok", "routes": [ { "distance": 312345.6, "geometry": { "coordinates": [[lng, lat], …] } } ] }
 *
 * Two things are easy to get wrong and are handled here rather than in the script:
 *
 *   · **GeoJSON is [lng, lat]; the database is {lat, lng}.** A swapped pair puts Aden's trips in the Indian
 *     Ocean, 3,000 km away, and nothing downstream would notice — the geometry is only ever drawn or measured.
 *   · **A single-point or empty route is not a route.** Storing it would make `app.trip_route_for` prefer a
 *     two-point answer over the straight line and produce a worse estimate than the fallback it replaced.
 */

export interface RoutePoint {
  readonly lat: number;
  readonly lng: number;
}

export interface ParsedRoute {
  readonly provider: string;
  readonly points: RoutePoint[];
  readonly distanceKm: number;
}

/** ~11 m at the equator; matches `app.route_key()`'s corridor precision. */
export function corridorKey(from: RoutePoint, to: RoutePoint): string {
  const round = (value: number) => Number(value.toFixed(4)).toString();
  return `${round(from.lat)},${round(from.lng)};${round(to.lat)},${round(to.lng)}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/**
 * Turn a provider payload into points the database will accept, or `null`.
 *
 * `null` is a normal answer, not an error: the caller logs it and moves on to the next corridor. Every reason to
 * reject — a changed shape, a 200 with `code: "NoRoute"`, coordinates outside the planet — ends in the same
 * place, which is the straight-line fallback `00023` shipped.
 */
export function parseOsrmRoute(
  payload: unknown,
  options: { readonly provider?: string } = {},
): ParsedRoute | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  if (typeof body.code === 'string' && body.code !== 'Ok') return null;

  const routes = body.routes;
  if (!Array.isArray(routes) || routes.length === 0) return null;

  const first = routes[0] as Record<string, unknown> | undefined;
  if (!first) return null;

  const geometry = first.geometry as Record<string, unknown> | undefined;
  const coordinates = geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

  const points: RoutePoint[] = [];
  for (const pair of coordinates) {
    if (!Array.isArray(pair) || pair.length < 2) return null;
    const [lng, lat] = pair as [unknown, unknown];
    if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return null;
    if (!inRange(lat, -90, 90) || !inRange(lng, -180, 180)) return null;
    points.push({ lat, lng });
  }

  const metres = first.distance;
  if (!isFiniteNumber(metres) || metres < 0) return null;

  return {
    provider: options.provider ?? 'osrm',
    points,
    distanceKm: Math.round((metres / 1000) * 100) / 100,
  };
}

/**
 * The request URL for OSRM's driving profile.
 *
 * `overview=full&geometries=geojson` is deliberate: the alternative (`polyline`) would need a decoder, and a
 * decoder is another parser to get wrong. The waypoints are `lng,lat`, the same order as the answer.
 */
export function osrmRouteUrl(baseUrl: string, from: RoutePoint, to: RoutePoint): string {
  const base = baseUrl.replace(/\/$/, '');
  const points = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  return `${base}/route/v1/driving/${points}?overview=full&geometries=geojson`;
}

/**
 * Is this answer plausibly the same road as the straight line?
 *
 * A provider returning 40 km for a corridor whose endpoints are 400 km apart (or 4,000) is answering about a
 * different place — a swapped pair, a stale cache, the wrong profile. Both bounds matter: a road is never much
 * *shorter* than the great circle either, so a 12 km answer for a 300 km corridor is just as wrong as a 4,000 km
 * one. The band is generous — 0.5× to 1.8× — because the point is to catch nonsense, not to second-guess a
 * mountain road.
 */
export function routeLooksPlausible(
  route: ParsedRoute,
  from: RoutePoint,
  to: RoutePoint,
  ratio = 1.8,
): boolean {
  const km = haversineKm(from, to);
  if (km <= 0) return true;
  return route.distanceKm <= km * ratio + 5 && route.distanceKm >= km * 0.5 - 5;
}

function haversineKm(a: RoutePoint, b: RoutePoint): number {
  const earth = 6371;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}
