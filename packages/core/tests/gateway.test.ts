import { describe, expect, it } from 'vitest';
import {
  codeFromStatus,
  createWriteGuard,
  evaluateRateLimit,
  isBodyTooLarge,
  isOriginAllowed,
  mapZodIssues,
  MAX_BODY_BYTES,
  NonCommandError,
  WriteGuardError,
} from '../src/api/gateway';

describe('origin allow-list', () => {
  const allow = ['https://app.maak.ye', 'http://localhost:3000'];

  it('accepts a listed origin', () => {
    expect(isOriginAllowed('https://app.maak.ye', allow)).toBe(true);
  });

  it('rejects an unlisted origin', () => {
    expect(isOriginAllowed('https://evil.example', allow)).toBe(false);
  });

  it('rejects a lookalike origin', () => {
    expect(isOriginAllowed('https://app.maak.ye.evil.example', allow)).toBe(false);
    expect(isOriginAllowed('https://app.maak.ye:8443', allow)).toBe(false);
  });

  it('allows missing Origin (native apps, server-to-server)', () => {
    expect(isOriginAllowed(null, allow)).toBe(true);
    expect(isOriginAllowed(undefined, allow)).toBe(true);
  });

  it('never treats a wildcard entry as a match for a specific origin', () => {
    expect(isOriginAllowed('https://anything.example', ['*'])).toBe(false);
  });
});

describe('body size', () => {
  it('accepts up to the limit', () => {
    expect(isBodyTooLarge(MAX_BODY_BYTES)).toBe(false);
  });

  it('rejects one byte over', () => {
    expect(isBodyTooLarge(MAX_BODY_BYTES + 1)).toBe(true);
  });

  it('rejects nonsense lengths rather than trusting them', () => {
    expect(isBodyTooLarge(Number.NaN)).toBe(true);
  });
});

describe('validation error mapping', () => {
  it('flattens nested paths into dotted keys', () => {
    expect(
      mapZodIssues([
        { path: ['stops', 0, 'placeId'], message: 'Required' },
        { path: [], message: 'Invalid body' },
      ]),
    ).toEqual({ 'stops.0.placeId': 'Required', _: 'Invalid body' });
  });

  it('keeps only the first message per field', () => {
    expect(
      mapZodIssues([
        { path: ['seats'], message: 'Too small' },
        { path: ['seats'], message: 'Not an integer' },
      ]),
    ).toEqual({ seats: 'Too small' });
  });
});

describe('single-write guard (ADR-018)', () => {
  it('allows exactly one cmd_* call', () => {
    const guard = createWriteGuard();
    guard.use('cmd_booking_create');
    expect(guard.count()).toBe(1);
  });

  it('refuses a second write', () => {
    const guard = createWriteGuard();
    guard.use('cmd_booking_create');
    expect(() => guard.use('cmd_audit_append')).toThrow(WriteGuardError);
  });

  it('refuses non-command functions (arbitrary table access)', () => {
    const guard = createWriteGuard();
    expect(() => guard.use('exec_sql')).toThrow(NonCommandError);
    expect(() => guard.use('bookings_update')).toThrow(NonCommandError);
  });
});

describe('status to error-code mapping', () => {
  it('maps the codes the client understands', () => {
    expect(codeFromStatus(401)).toBe('UNAUTHENTICATED');
    expect(codeFromStatus(403)).toBe('FORBIDDEN');
    expect(codeFromStatus(429)).toBe('RATE_LIMITED');
    expect(codeFromStatus(503)).toBe('INTERNAL');
    expect(codeFromStatus(400)).toBe('VALIDATION_FAILED');
  });
});

describe('rate limiting', () => {
  it('allows while under the limit', () => {
    expect(
      evaluateRateLimit({ used: 3, limit: 5, windowSeconds: 600, elapsedSeconds: 30 }).allowed,
    ).toBe(true);
  });

  it('blocks at the limit and reports a retry delay', () => {
    const decision = evaluateRateLimit({
      used: 5,
      limit: 5,
      windowSeconds: 600,
      elapsedSeconds: 120,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(480);
  });

  it('never returns a zero-second retry (which would invite a hot loop)', () => {
    const decision = evaluateRateLimit({
      used: 5,
      limit: 5,
      windowSeconds: 10,
      elapsedSeconds: 10,
    });
    expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});
