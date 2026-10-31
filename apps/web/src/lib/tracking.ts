/**
 * Reading `get_trip_progress()` from the web app.
 *
 * The RPC decides visibility itself (driver, operator, platform staff, or a passenger holding a booking
 * on this trip) and answers `FORBIDDEN` to everybody else — so this module's job is not to authorise but
 * to turn PostgREST's three failure modes into something a screen can render:
 *
 *   · no session at all → `UNAUTHENTICATED` (the proxy granted the anon role, which has no execute right)
 *   · a session without a booking → `FORBIDDEN`
 *   · anything else → `INTERNAL`, with the detail kept for the server log rather than the page
 */

import { TRIP_PROGRESS_STALE_SECONDS, type TripProgressSnapshot } from '@maak/core';

import { getServerClient } from './supabase/server';

export type ProgressResult =
  | { readonly ok: true; readonly snapshot: TripProgressSnapshot }
  | {
      readonly ok: false;
      readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'INTERNAL';
    };

function normalise(raw: unknown): TripProgressSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const trip = value.trip as Record<string, unknown> | undefined;
  if (!trip?.id) return null;

  return {
    trip: {
      id: String(trip.id),
      code: String(trip.code ?? ''),
      status: String(trip.status ?? ''),
      departureAt: trip.departureAt == null ? null : String(trip.departureAt),
      arriveEstimateMinutes:
        trip.arriveEstimateMinutes == null ? null : Number(trip.arriveEstimateMinutes),
      startedAt: trip.startedAt == null ? null : String(trip.startedAt),
      lastStopSeq: trip.lastStopSeq == null ? null : Number(trip.lastStopSeq),
    },
    position: (value.position as TripProgressSnapshot['position']) ?? null,
    nextStop: (value.nextStop as TripProgressSnapshot['nextStop']) ?? null,
    destination: (value.destination as TripProgressSnapshot['destination']) ?? null,
    progressPct: value.progressPct == null ? null : Number(value.progressPct),
    distanceRemainingKm:
      value.distanceRemainingKm == null ? null : Number(value.distanceRemainingKm),
    speedKmh: value.speedKmh == null ? null : Number(value.speedKmh),
    stale: Boolean(value.stale),
    staleAfterSeconds: value.staleAfterSeconds
      ? Number(value.staleAfterSeconds)
      : TRIP_PROGRESS_STALE_SECONDS,
    lastPingAt: value.lastPingAt == null ? null : String(value.lastPingAt),
    updatedAt: value.updatedAt == null ? null : String(value.updatedAt),
    stops: Array.isArray(value.stops) ? (value.stops as TripProgressSnapshot['stops']) : [],
    route: Array.isArray(value.route) ? (value.route as TripProgressSnapshot['route']) : [],
  };
}

export async function loadTripProgress(code: string): Promise<ProgressResult> {
  const client = await getServerClient();
  if (!client) return { ok: false, code: 'INTERNAL' };

  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return { ok: false, code: 'UNAUTHENTICATED' };

  const result = await client.rpc('get_trip_progress', { p_code: code });
  if (result.error) {
    const message = `${result.error.message ?? ''} ${result.error.details ?? ''}`;
    if (/permission denied|42501|FORBIDDEN/i.test(message)) return { ok: false, code: 'FORBIDDEN' };
    if (/NOT_FOUND|P0002|no rows/i.test(message)) return { ok: false, code: 'NOT_FOUND' };
    return { ok: false, code: 'INTERNAL' };
  }

  const snapshot = normalise(result.data);
  return snapshot ? { ok: true, snapshot } : { ok: false, code: 'INTERNAL' };
}
