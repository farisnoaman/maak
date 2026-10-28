import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiClient, defaultIdFactory, type TransportRequest } from '../src/api/client';
import { errorKey, isErrorCode, toApiFailure } from '../src/api/errors';

const inputSchema = z.object({ tripId: z.string().uuid(), seats: z.number().int().min(1) });

const spec = {
  path: 'bookings-create',
  input: inputSchema,
  output: z.object({ bookingId: z.string() }),
  mutating: true,
};

const TRIP_ID = '11111111-1111-4111-8111-111111111111';

function makeClient(handler: (req: TransportRequest) => Promise<{ status: number; body: unknown }>) {
  const calls: TransportRequest[] = [];
  const client = new ApiClient({
    baseUrl: 'https://example.supabase.co/functions/v1',
    getToken: async () => 'token-123',
    idFactory: () => 'idem-fixed',
    transport: async (req) => {
      calls.push(req);
      return handler(req);
    },
  });
  return { client, calls };
}

describe('api client', () => {
  it('validates input before it leaves the device', async () => {
    const { client, calls } = makeClient(async () => ({ status: 200, body: { bookingId: 'b1' } }));
    const result = await client.call(spec, { tripId: 'not-a-uuid', seats: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    expect(calls).toHaveLength(0);
  });

  it('sends auth, idempotency key and content type', async () => {
    const { client, calls } = makeClient(async () => ({ status: 200, body: { bookingId: 'b1' } }));
    const result = await client.call(spec, { tripId: TRIP_ID, seats: 2 });
    expect(result.ok).toBe(true);
    const req = calls[0];
    expect(req?.headers.Authorization).toBe('Bearer token-123');
    expect(req?.headers['Idempotency-Key']).toBe('idem-fixed');
    expect(req?.path).toBe('https://example.supabase.co/functions/v1/bookings-create');
  });

  it('maps a 403 with a known code to that code', async () => {
    const { client } = makeClient(async () => ({ status: 403, body: { code: 'NOT_VERIFIED' } }));
    const result = await client.call(spec, { tripId: TRIP_ID, seats: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_VERIFIED');
      expect(errorKey(result.error.code)).toBe('errors.NOT_VERIFIED');
    }
  });

  it('treats an unknown error body as INTERNAL rather than trusting it', async () => {
    const { client } = makeClient(async () => ({ status: 500, body: { message: 'pg: boom' } }));
    const result = await client.call(spec, { tripId: TRIP_ID, seats: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERNAL');
  });

  it('maps HTTP 429 without a body to RATE_LIMITED', async () => {
    const { client } = makeClient(async () => ({ status: 429, body: null }));
    const result = await client.call(spec, { tripId: TRIP_ID, seats: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('RATE_LIMITED');
  });

  it('never returns a response that fails its own schema', async () => {
    const { client } = makeClient(async () => ({ status: 200, body: { something: 'else' } }));
    const result = await client.call(spec, { tripId: TRIP_ID, seats: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERNAL');
  });

  it('normalises transport failures to NETWORK', async () => {
    const { client } = makeClient(async () => {
      throw new Error('offline');
    });
    const result = await client.call(spec, { tripId: TRIP_ID, seats: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NETWORK');
  });

  it('refuses a mutation without a token', async () => {
    const calls: TransportRequest[] = [];
    const client = new ApiClient({
      baseUrl: 'https://x/functions/v1',
      getToken: async () => null,
      transport: async (req) => {
        calls.push(req);
        return { status: 200, body: { bookingId: 'b1' } };
      },
    });
    const result = await client.call(spec, { tripId: TRIP_ID, seats: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNAUTHENTICATED');
    expect(calls).toHaveLength(0);
  });

  it('generates unique idempotency keys', () => {
    const a = defaultIdFactory();
    const b = defaultIdFactory();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(8);
  });
});

describe('error contract', () => {
  it('recognises only declared codes', () => {
    expect(isErrorCode('FORBIDDEN')).toBe(true);
    expect(isErrorCode('HACKED')).toBe(false);
    expect(isErrorCode(42)).toBe(false);
  });

  it('normalizes unknown throws', () => {
    expect(toApiFailure(new Error('x')).code).toBe('NETWORK');
    expect(toApiFailure('nope').code).toBe('INTERNAL');
    expect(toApiFailure({ code: 'QUOTA_EXCEEDED', context: { limit: 1 } }).code).toBe('QUOTA_EXCEEDED');
  });

  it('every code has a localized message', () => {
    for (const code of ['FORBIDDEN', 'NOT_VERIFIED', 'QUOTA_EXCEEDED', 'PRICE_CHANGED'] as const) {
      expect(errorKey(code)).toMatch(/^errors\./);
    }
  });

  it('is used through vi.fn transports without real network', async () => {
    const transport = vi.fn(async () => ({ status: 200, body: { bookingId: 'b9' } }));
    const client = new ApiClient({
      baseUrl: 'https://x/functions/v1',
      getToken: async () => 't',
      transport,
    });
    await client.call(spec, { tripId: TRIP_ID, seats: 3 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
