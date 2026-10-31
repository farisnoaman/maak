'use client';

/**
 * Browser-side gateway client.
 *
 * The only place the web app talks to `functions/v1` — via the same-origin `/api/data` proxy, which
 * holds the bearer token server-side. Every mutation still carries an idempotency key.
 */

import { ApiClient } from '@maak/core';
import { getSupabaseConfig } from './supabase/config';

/**
 * Marker, not a credential. The session cookie is httpOnly, so this file cannot read a token — and
 * must not. `/api/data/...` runs on the server, swaps this header for the caller's real token, and
 * streams the answer back. `ApiClient` only needs a truthy value to know a session exists.
 */
const SESSION_MARKER = 'session-cookie';

export function getApiClient(): ApiClient | null {
  if (!getSupabaseConfig()) return null;

  return new ApiClient({
    baseUrl: '/api/data/functions/v1',
    transport: async ({ method, path, body, headers }) => {
      const response = await fetch(path, {
        method,
        headers,
        body: JSON.stringify(body),
        // `same-origin`, never `omit`: the session is an httpOnly cookie, and omitting credentials
        // would make every authenticated call look anonymous.
        credentials: 'same-origin',
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { code: 'INTERNAL', detail: 'Unreadable response' };
      }
      return { status: response.status, body: parsed };
    },
    getToken: async () => SESSION_MARKER,
    clientVersion: 'web',
  });
}

/**
 * Uploads a verification document to the caller's own folder and returns its object path.
 *
 * Goes through `/api/data/storage/v1/...` for the same reason as every other call: the token stays in
 * an httpOnly cookie, and the server decides which folder that token may write to (the database
 * policies enforce `auth.uid()` as the folder prefix regardless).
 */
export async function uploadVerificationDocument(
  file: File,
  kind: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!getSupabaseConfig()) return { ok: false, error: 'not-configured' };

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
  const path = `${kind}-${Date.now()}-${safeName}`;

  const response = await fetch(`/api/data/storage/v1/object/verification-docs/${path}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-upsert': 'false' },
    body: file,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => 'upload failed');
    return { ok: false, error: detail || 'upload failed' };
  }
  return { ok: true, path };
}

/**
 * Uploads one vehicle photo into `<vehicleId>/…` in the public `vehicle-photos` bucket.
 *
 * The folder is the vehicle id because the storage policy authorises the write by *which vehicle the
 * first path segment names* (`app.owns_vehicle(app.safe_uuid(folder))`). Guessing a different layout
 * would be refused by the database, so the folder is not configurable.
 */
export async function uploadVehiclePhoto(
  file: File,
  vehicleId: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  return uploadToBucket('vehicle-photos', file, vehicleId);
}

/** Same contract, private bucket: insurance, registration, inspection, permit scans. */
export async function uploadVehicleDocument(
  file: File,
  vehicleId: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  return uploadToBucket('vehicle-documents', file, vehicleId);
}

/**
 * Uploads a driver's licence photograph into `<userId>/…` in the private `driver-documents` bucket.
 *
 * The folder is the caller's own user id because `driver_documents_write_self` authorises the write by
 * comparing the first path segment with `auth.uid()` — an operator cannot upload a driver's document on
 * their behalf, and this helper cannot be pointed at somebody else's folder by a bug in the caller.
 */
export async function uploadDriverLicence(
  file: File,
  userId: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  return uploadToBucket('driver-documents', file, userId);
}

/**
 * Uploads one passenger ID into `<bookingId>/…` in the private `passenger-ids` bucket.
 *
 * Same rule as the driver licence, different audience: the folder is the booking id because
 * `passenger_ids_write_own` authorises the write by comparing that first segment with the booking's
 * passenger — an operator cannot upload a passenger's document, and this helper cannot be pointed at
 * somebody else's booking by a bug in the caller.
 */
export async function uploadPassengerId(
  file: File,
  bookingId: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  return uploadToBucket('passenger-ids', file, bookingId);
}

async function uploadToBucket(
  bucket: 'vehicle-photos' | 'vehicle-documents' | 'driver-documents' | 'passenger-ids',
  file: File,
  folder: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!getSupabaseConfig()) return { ok: false, error: 'not-configured' };

  // A file name is user-controlled: strip everything that is not safe in a URL path, and keep the tail
  // so the extension survives. The timestamp keeps two photos of the same name apart.
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60) || 'upload';
  const path = `${folder}/${Date.now()}-${safeName}`;

  const response = await fetch(`/api/data/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-upsert': 'false' },
    body: file,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => 'upload failed');
    return { ok: false, error: detail || 'upload failed' };
  }
  return { ok: true, path };
}
